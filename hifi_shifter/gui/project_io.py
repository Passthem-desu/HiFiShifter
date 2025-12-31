from __future__ import annotations

import json
import os

import numpy as np
from PyQt6.QtWidgets import QFileDialog, QMessageBox

from ..track import Track
from utils.i18n import i18n


class ProjectIOMixin:
    def _set_dirty(self, dirty: bool):
        """Set dirty flag and reflect it in the window title."""
        self.is_dirty = bool(dirty)

        try:
            base_title = i18n.get("app.title")
        except Exception:
            base_title = "HiFiShifter"

        proj = os.path.basename(self.project_path) if self.project_path else i18n.get("project.untitled")
        title = f"{proj} - {base_title}"
        if self.is_dirty:
            title = "*" + title

        try:
            self.setWindowTitle(title)
        except Exception:
            pass

    def open_project_dialog(self):
        file_path, _ = QFileDialog.getOpenFileName(self, i18n.get("menu.file.open"), "", "HifiShifter Project (*.hsp *.json)")
        if file_path:
            self.open_project(file_path)

    def open_project(self, file_path):
        if self._is_bg_busy():
            return

        # Clear current UI state quickly (UI thread)
        try:
            self.stop_playback(reset=True)
        except Exception:
            pass

        self.tracks = []
        self.current_track_idx = -1
        try:
            self.timeline_panel.refresh_tracks(self.tracks)
        except Exception:
            pass
        self.clear_selection(hide_box=True)
        self.update_plot()

        project_dir = os.path.dirname(os.path.abspath(file_path))

        def _work(progress):
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # Resolve & load model (heavy)
            loaded_model_path = None
            model_path = data.get('model_path')
            if model_path:
                if not os.path.exists(model_path):
                    rel_path = os.path.join(project_dir, model_path)
                    if os.path.exists(rel_path):
                        model_path = rel_path

                if os.path.exists(model_path):
                    # Direct call to avoid spawning nested background tasks
                    self.processor.load_model(model_path)
                    loaded_model_path = model_path

            params = data.get('params', {}) if isinstance(data, dict) else {}

            tracks: list[Track] = []
            missing_audio: list[str] = []

            if 'tracks' in data:
                t_list = data.get('tracks') or []
                total = len(t_list)
                for idx, t_data in enumerate(t_list):
                    file_p = t_data.get('file_path')
                    if not file_p:
                        continue

                    if not os.path.exists(file_p):
                        rel_p = os.path.join(project_dir, file_p)
                        if os.path.exists(rel_p):
                            file_p = rel_p

                    if not os.path.exists(file_p):
                        missing_audio.append(str(file_p))
                        progress(idx + 1, total)
                        continue

                    track = Track(t_data.get('name', os.path.basename(file_p)), file_p, t_data.get('type', 'vocal'))
                    track.load(self.processor)

                    track.shift_value = t_data.get('shift', 0.0)
                    track.muted = t_data.get('muted', False)
                    track.solo = t_data.get('solo', False)
                    track.volume = t_data.get('volume', 1.0)
                    track.start_frame = t_data.get('start_frame', 0)

                    if 'f0' in t_data and track.f0_edited is not None:
                        saved_f0 = np.array(t_data['f0'])
                        min_len = min(len(saved_f0), len(track.f0_edited))
                        track.f0_edited[:min_len] = saved_f0[:min_len]
                        for state in track.segment_states:
                            state['dirty'] = True

                    if 'tension' in t_data and getattr(track, 'tension_edited', None) is not None:
                        saved_tension = np.array(t_data['tension'], dtype=np.float32)
                        min_len = min(len(saved_tension), len(track.tension_edited))
                        track.tension_edited[:min_len] = saved_tension[:min_len]
                        track.tension_version += 1
                        track._tension_processed_audio = None
                        track._tension_processed_key = None

                    tracks.append(track)
                    progress(idx + 1, total)

            # Backward compatibility for v1.0
            elif 'audio_path' in data:
                audio_path = data['audio_path']
                if not os.path.exists(audio_path):
                    rel_p = os.path.join(project_dir, audio_path)
                    if os.path.exists(rel_p):
                        audio_path = rel_p

                if os.path.exists(audio_path):
                    track = Track(os.path.basename(audio_path), audio_path, 'vocal')
                    track.load(self.processor)

                    if 'f0' in data and track.f0_edited is not None:
                        saved_f0 = np.array(data['f0'])
                        min_len = min(len(saved_f0), len(track.f0_edited))
                        track.f0_edited[:min_len] = saved_f0[:min_len]
                        for state in track.segment_states:
                            state['dirty'] = True

                    if 'tension' in data and getattr(track, 'tension_edited', None) is not None:
                        saved_tension = np.array(data['tension'], dtype=np.float32)
                        min_len = min(len(saved_tension), len(track.tension_edited))
                        track.tension_edited[:min_len] = saved_tension[:min_len]
                        track.tension_version += 1
                        track._tension_processed_audio = None
                        track._tension_processed_key = None

                    if 'params' in data and 'shift' in data['params']:
                        track.shift_value = data['params']['shift']

                    tracks.append(track)

            return {
                'data': data,
                'loaded_model_path': loaded_model_path,
                'params': params,
                'tracks': tracks,
                'missing_audio': missing_audio,
            }

        def _ok(result: dict):
            loaded_model_path = result.get('loaded_model_path')
            if loaded_model_path:
                self.model_path = loaded_model_path
            else:
                # Keep previous model_path (if any), but warn user if project had a model path
                data = result.get('data', {})
                mp = (data.get('model_path') if isinstance(data, dict) else None)
                if mp:
                    QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.model_not_found") + f": {mp}")

            params = result.get('params', {}) or {}
            if 'bpm' in params:
                self.bpm_spin.setValue(params['bpm'])
            if 'beats' in params:
                self.beats_spin.setValue(params['beats'])

            self.tracks = result.get('tracks', []) or []

            # Update Timeline
            try:
                if self.processor.config:
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
            except Exception:
                pass
            self.timeline_panel.refresh_tracks(self.tracks)

            # Auto-select first track
            if self.tracks:
                self.timeline_panel.select_track(0)
                self.on_track_selected(0)

            self.project_path = file_path
            self._set_dirty(False)
            self.status_label.setText(i18n.get("status.project_loaded") + f": {file_path}")

            missing = result.get('missing_audio', []) or []
            if missing:
                preview = "\n".join(missing[:8])
                if len(missing) > 8:
                    preview += f"\n... (+{len(missing) - 8})"
                QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.audio_not_found") + ":\n" + preview)

        def _fail(err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.open_project_failed") + f":\n{err_text}")

        self._start_bg_task(
            kind='open_project',
            status_text=i18n.get("status.loading_project"),
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )

    def save_project(self) -> bool:
        if self.project_path:
            return self._save_project_file(self.project_path)
        return self.save_project_as()

    def save_project_as(self) -> bool:
        file_path, _ = QFileDialog.getSaveFileName(self, i18n.get("menu.file.save_as"), "project.hsp", "HifiShifter Project (*.hsp *.json)")
        if not file_path:
            return False
        return self._save_project_file(file_path)

    def _save_project_file(self, file_path) -> bool:
        try:
            project_dir = os.path.dirname(os.path.abspath(file_path))

            tracks_data = []
            for track in self.tracks:
                # Try to make path relative
                try:
                    rel_path = os.path.relpath(track.file_path, project_dir)
                except ValueError:
                    rel_path = track.file_path  # Different drive or cannot be relative

                t_data = {
                    'name': track.name,
                    'file_path': rel_path,
                    'type': track.track_type,
                    'shift': track.shift_value,
                    'muted': track.muted,
                    'solo': track.solo,
                    'volume': track.volume,
                    'start_frame': track.start_frame,
                }
                if track.track_type == 'vocal' and track.f0_edited is not None:
                    t_data['f0'] = track.f0_edited.tolist()
                if track.track_type == 'vocal' and getattr(track, 'tension_edited', None) is not None:
                    t_data['tension'] = track.tension_edited.tolist()
                tracks_data.append(t_data)

            # Model path relative
            model_path_save = self.model_path
            if self.model_path:
                try:
                    model_path_save = os.path.relpath(self.model_path, project_dir)
                except ValueError:
                    model_path_save = self.model_path

            data = {
                'version': '2.1',
                'model_path': model_path_save,
                'params': {
                    'bpm': self.bpm_spin.value(),
                    'beats': self.beats_spin.value(),
                },
                'tracks': tracks_data,
            }

            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4)

            self.project_path = file_path
            self._set_dirty(False)
            self.status_label.setText(i18n.get("status.project_saved") + f": {file_path}")
            return True

        except Exception as e:
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.save_project_failed") + f": {str(e)}")
            return False

    def closeEvent(self, event):
        """Prompt to save when closing a modified (dirty) project."""
        accept_close = True

        if getattr(self, 'is_dirty', False):
            proj_name = os.path.basename(self.project_path) if self.project_path else i18n.get("project.untitled")

            msg = QMessageBox(self)
            msg.setIcon(QMessageBox.Icon.Question)
            msg.setWindowTitle(i18n.get("dialog.unsaved_changes_title"))
            msg.setText(i18n.get("dialog.unsaved_changes_text").format(proj_name))

            btn_save = msg.addButton(i18n.get("btn.save"), QMessageBox.ButtonRole.AcceptRole)
            btn_discard = msg.addButton(i18n.get("btn.dont_save"), QMessageBox.ButtonRole.DestructiveRole)
            btn_cancel = msg.addButton(i18n.get("btn.cancel"), QMessageBox.ButtonRole.RejectRole)
            msg.setDefaultButton(btn_save)

            msg.exec()
            clicked = msg.clickedButton()

            if clicked == btn_cancel:
                accept_close = False
            elif clicked == btn_save:
                # Save-as may be cancelled or save failed.
                accept_close = bool(self.save_project())
            else:
                # btn_discard
                accept_close = True

        if not accept_close:
            event.ignore()
            return

        # Stop playback/streams on exit
        try:
            if getattr(self, 'is_playing', False):
                self.stop_playback(reset=False)
        except Exception:
            pass

        event.accept()
