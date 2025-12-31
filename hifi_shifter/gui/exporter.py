from __future__ import annotations

import os

import numpy as np
import scipy.io.wavfile as wavfile
from PyQt6.QtWidgets import QFileDialog, QMessageBox

from utils.i18n import i18n


class ExportMixin:
    def export_audio_dialog(self):
        # Ensure everything is synthesized (async) before exporting
        if self._has_dirty_segments():
            self.synthesize_audio_async(after=self.export_audio_dialog)
            return

        msg_box = QMessageBox(self)
        msg_box.setWindowTitle(i18n.get("dialog.export_audio"))
        msg_box.setText(i18n.get("msg.select_export_mode"))

        btn_mixed = msg_box.addButton(i18n.get("btn.export_mixed"), QMessageBox.ButtonRole.AcceptRole)
        btn_separated = msg_box.addButton(i18n.get("btn.export_separated"), QMessageBox.ButtonRole.AcceptRole)
        btn_cancel = msg_box.addButton(i18n.get("btn.cancel"), QMessageBox.ButtonRole.RejectRole)

        msg_box.exec()

        clicked_button = msg_box.clickedButton()
        if clicked_button == btn_cancel:
            return

        if clicked_button == btn_mixed:
            file_path, _ = QFileDialog.getSaveFileName(self, i18n.get("dialog.export_mixed"), "output.wav", "WAV Audio (*.wav)")
            if file_path:
                self.export_audio(file_path)

        elif clicked_button == btn_separated:
            dir_path = QFileDialog.getExistingDirectory(self, i18n.get("dialog.select_export_dir"))
            if dir_path:
                self.export_separated_tracks(dir_path)

    def export_separated_tracks(self, dir_path):
        """Export all active vocal tracks to separate WAV files (background thread)."""
        if self._is_bg_busy():
            return

        # Estimate total export count for progress
        total = 0
        for track in self.tracks:
            if track.track_type == 'vocal' and not track.muted and track.synthesized_audio is not None:
                total += 1

        def _work(progress):
            count = 0
            sr = self.processor.config['audio_sample_rate'] if self.processor.config else 44100
            hop_size = self.processor.config['hop_size'] if self.processor.config else 512

            for i, track in enumerate(self.tracks):
                if track.muted or track.track_type == 'bgm':
                    continue
                if track.synthesized_audio is None:
                    continue

                safe_name = "".join([c for c in track.name if c.isalnum() or c in (' ', '-', '_')]).strip()
                if not safe_name:
                    safe_name = f"track_{i+1}"

                file_path = os.path.join(dir_path, f"{safe_name}.wav")

                audio = self._get_track_audio_for_mix(track)
                if audio is None:
                    continue
                if audio.dtype != np.float32:
                    audio = audio.astype(np.float32)

                start_sample = track.start_frame * hop_size
                if start_sample > 0:
                    pad = np.zeros(start_sample, dtype=np.float32)
                    audio_to_save = np.concatenate((pad, audio))
                elif start_sample < 0:
                    start_idx = -start_sample
                    if start_idx < len(audio):
                        audio_to_save = audio[start_idx:]
                    else:
                        audio_to_save = np.array([], dtype=np.float32)
                else:
                    audio_to_save = audio

                wavfile.write(file_path, sr, audio_to_save)
                count += 1
                progress(count, total)

            return count

        def _ok(count: int):
            QMessageBox.information(self, i18n.get("msg.success"), i18n.get("msg.export_separated_success").format(count, dir_path))

        def _fail(_err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.export_failed"))

        self._start_bg_task(
            kind='export_separated',
            status_text=i18n.get("status.exporting") + f" {dir_path}...",
            fn=_work,
            total=total if total > 0 else None,
            on_success=_ok,
            on_failed=_fail,
        )

    def export_audio(self, file_path):
        """Export mixed audio to a single WAV file (background thread)."""
        if self._is_bg_busy():
            return

        def _work(_progress):
            mixed_audio = self.mix_tracks()
            if mixed_audio is None:
                return None

            if mixed_audio.dtype != np.float32:
                mixed_audio = mixed_audio.astype(np.float32)

            sr = self.processor.config['audio_sample_rate'] if self.processor.config else 44100
            wavfile.write(file_path, sr, mixed_audio)
            return file_path

        def _ok(result_path):
            if result_path is None:
                QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.no_audio_to_export"))
                return
            self.status_label.setText(i18n.get("status.export_success") + f": {result_path}")
            QMessageBox.information(self, i18n.get("msg.success"), i18n.get("msg.export_success") + f":\n{result_path}")

        def _fail(_err_text: str):
            self.status_label.setText(i18n.get("status.export_failed"))
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.export_failed"))

        self._start_bg_task(
            kind='export_mixed',
            status_text=i18n.get("status.exporting") + f" {file_path}...",
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )
