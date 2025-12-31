from __future__ import annotations

import os
import pathlib

import numpy as np
from PyQt6.QtWidgets import QFileDialog, QMessageBox

from .. import config_manager
from ..track import Track
from utils.i18n import i18n


class TracksMixin:
    def load_model_dialog(self):
        folder = QFileDialog.getExistingDirectory(self, i18n.get("dialog.select_model_dir"))
        if folder:
            self.load_model(folder)

    def load_default_model(self):
        default_path = config_manager.get_default_model_path()
        if default_path and os.path.exists(default_path):
            try:
                self.processor.load_model(default_path)
                self.model_path = default_path
                if hasattr(self, 'status_label'):
                    self.status_label.setText(i18n.get("status.default_model_loaded") + f": {pathlib.Path(default_path).name}")
            except Exception as e:
                if hasattr(self, 'status_label'):
                    self.status_label.setText(i18n.get("status.default_model_failed") + f": {e}")

    def set_default_model_dialog(self):
        folder_path = QFileDialog.getExistingDirectory(self, i18n.get("dialog.select_default_model_dir"))
        if folder_path:
            config_manager.set_default_model_path(folder_path)
            QMessageBox.information(self, i18n.get("msg.success"), i18n.get("msg.default_model_set") + f": {folder_path}")
            # Optionally load it now if no model is loaded
            if self.model_path is None:
                self.load_model(folder_path)

    def load_model(self, folder):
        if self._is_bg_busy():
            return

        def _work(_progress):
            self.processor.load_model(folder)
            return folder

        def _ok(_folder):
            self.model_path = folder
            self.status_label.setText(i18n.get("status.model_loaded") + f": {pathlib.Path(folder).name}")

            # Update timeline hop_size if possible
            try:
                if self.processor.config and hasattr(self, 'timeline_panel'):
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
            except Exception:
                pass

        def _fail(err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.load_model_failed") + f":\n{err_text}")
            self.status_label.setText(i18n.get("status.model_load_failed"))

        self._start_bg_task(
            kind='load_model',
            status_text=i18n.get("status.loading_model") + f" {folder}...",
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )

    def load_audio_dialog(self):
        file_path, _ = QFileDialog.getOpenFileName(self, i18n.get("dialog.select_audio"), "", i18n.get("filter.audio_files"))
        if file_path:
            self.add_track_from_file(file_path)

    def on_files_dropped(self, files):
        for file_path in files:
            self.add_track_from_file(file_path)

    def add_track_from_file(self, file_path):
        if not os.path.exists(file_path):
            return

        # If a background task is running, queue the request.
        if self._is_bg_busy():
            self._pending_track_paths.append(file_path)
            try:
                self.status_label.setText(i18n.get("status.loading_track") + f" {os.path.basename(file_path)}... (queued)")
            except Exception:
                pass
            return

        name = os.path.basename(file_path)

        def _work(_progress):
            track = Track(name, file_path, track_type='vocal')
            track.load(self.processor)
            return track

        def _continue_queue():
            if self._pending_track_paths:
                next_path = self._pending_track_paths.pop(0)
                self.add_track_from_file(next_path)

        def _ok(track: Track):
            self.tracks.append(track)

            # Update Timeline
            try:
                if self.processor.config:
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
            except Exception:
                pass

            self.timeline_panel.refresh_tracks(self.tracks)
            self.timeline_panel.select_track(len(self.tracks) - 1)

            # Trigger selection logic manually since select_track doesn't emit signal
            self.on_track_selected(len(self.tracks) - 1)

            self.status_label.setText(i18n.get("status.track_loaded") + f": {name}")
            _continue_queue()

        def _fail(err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.load_track_failed") + f":\n{err_text}")
            self.status_label.setText(i18n.get("status.load_failed"))
            _continue_queue()

        self._start_bg_task(
            kind='add_track',
            status_text=i18n.get("status.loading_track") + f" {name}...",
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )

    def on_track_selected(self, index):
        self.current_track_idx = index

        # Clear selection when switching tracks
        self.clear_selection(hide_box=True)

        self.update_plot()

    def on_track_mix_settings_changed(self, *_args):
        """Mark project as dirty when track-level mix/arrangement settings change."""
        self._set_dirty(True)

    def on_timeline_cursor_moved(self, x_frame):
        # Update playback position
        if self.processor.config:
            hop_size = self.processor.config['hop_size']
            sr = self.processor.config.get('audio_sample_rate', 44100)

            time_sec = x_frame * hop_size / sr
            self.current_playback_time = time_sec
            self.playback_start_time = time_sec

            self.play_cursor.setValue(x_frame)

            # If playing, restart from new position?
            if self.is_playing:
                self.stop_playback(reset=False)
                self.start_playback()

    def convert_track_type(self, track, new_type):
        if track.track_type == new_type:
            return

        if self._is_bg_busy():
            return

        track.track_type = new_type

        def _work(_progress):
            track.load(self.processor)
            return track

        def _ok(_track):
            self.status_label.setText(i18n.get("status.reloaded") + f": {track.name}")
            self.update_plot()

            # Update Timeline
            try:
                if self.processor.config:
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
            except Exception:
                pass

            self.timeline_panel.refresh_tracks(self.tracks)
            self.timeline_panel.select_track(self.current_track_idx)

        def _fail(err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.reload_track_failed") + f":\n{err_text}")
            self.status_label.setText(i18n.get("status.audio_load_failed"))

        self._start_bg_task(
            kind='reload_track',
            status_text=i18n.get("status.reloading_track") + f" {track.name}...",
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )

    def delete_track(self, index):
        if 0 <= index < len(self.tracks):
            # Deleting tracks while playing can lead to confusing audio state.
            try:
                if self.is_playing:
                    self.stop_playback(reset=True)
            except Exception:
                pass

            reply = QMessageBox.question(
                self,
                i18n.get("track.delete_confirm_title"),
                i18n.get("track.delete_confirm_msg").format(self.tracks[index].name),
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )

            if reply == QMessageBox.StandardButton.Yes:
                del self.tracks[index]
                if self.current_track_idx == index:
                    self.current_track_idx = -1
                elif self.current_track_idx > index:
                    self.current_track_idx -= 1

                self.timeline_panel.refresh_tracks(self.tracks)
                self.update_plot()

    def copy_pitch(self, index):
        if 0 <= index < len(self.tracks):
            track = self.tracks[index]
            if track.f0_edited is not None:
                self.pitch_clipboard = track.f0_edited.copy()
                self.status_label.setText(f"Copied pitch from track '{track.name}'")
            else:
                self.status_label.setText("No pitch data to copy")

    def paste_pitch(self, index):
        if 0 <= index < len(self.tracks) and self.pitch_clipboard is not None:
            track = self.tracks[index]
            if track.f0_original is None:
                QMessageBox.warning(self, "Paste Error", "Target track has no audio/pitch data.")
                return

            target_len = len(track.f0_original)
            source_len = len(self.pitch_clipboard)

            if target_len != source_len:
                reply = QMessageBox.question(
                    self,
                    'Paste Pitch',
                    f"Pitch length mismatch (Source: {source_len}, Target: {target_len}). Paste anyway? (Will be truncated/padded)",
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                    QMessageBox.StandardButton.No,
                )
                if reply != QMessageBox.StandardButton.Yes:
                    return

            new_f0 = np.zeros(target_len)
            copy_len = min(target_len, source_len)
            new_f0[:copy_len] = self.pitch_clipboard[:copy_len]

            if copy_len < target_len:
                new_f0[copy_len:] = track.f0_original[copy_len:]

            track.f0_edited = new_f0
            track.is_edited = True

            # Mark all segments as dirty
            for state in track.segment_states:
                state['dirty'] = True

            self.update_plot()
            self.status_label.setText(f"Pasted pitch to track '{track.name}'")
        else:
            self.status_label.setText("Clipboard empty or invalid index")
