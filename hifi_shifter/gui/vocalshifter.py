from __future__ import annotations


class VocalShifterMixin:
    # 这些方法体积较大且与二进制解析强耦合；先从 `main_window.py` 拆分出来，
    # 后续如需进一步提升可维护性，可再把纯解析逻辑下沉到 importers/parser 模块。

    def paste_vocalshifter_clipboard_data(self):
        """读取并应用 VocalShifter 剪贴板数据"""
        import os
        import struct
        import tempfile

        from PyQt6.QtWidgets import QApplication, QMessageBox
        from utils.i18n import i18n

        track = self.current_track
        if not track or track.track_type != 'vocal':
            QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.no_vocal_track_selected"))
            return

        if track.f0_edited is None:
            QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.no_pitch_data"))
            return

        temp_dir = os.path.join(tempfile.gettempdir(), 'vocalshifter_tmp')
        file_path = os.path.join(temp_dir, 'vocalshifter_id.clb')

        if not os.path.exists(file_path):
            QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.vocalshifter_file_not_found") + f": {file_path}")
            return

        try:
            self.status_label.setText(i18n.get("status.loading_vocalshifter_clipboard_data"))
            QApplication.processEvents()

            with open(file_path, 'rb') as f:
                data = f.read()

            if len(data) == 0:
                QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.vocalshifter_file_empty"))
                return

            if len(data) % 0x80 != 0:
                QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.vocalshifter_invalid_format"))
                return

            num_samples = len(data) // 0x80
            vocalshifter_clipboard_data = []

            for i in range(num_samples):
                sample_start = i * 0x80
                sample_data = data[sample_start:sample_start + 0x80]

                doubles = []
                for j in range(16):
                    double_start = j * 8
                    double_bytes = sample_data[double_start:double_start + 8]
                    if len(double_bytes) == 8:
                        value = struct.unpack('<d', double_bytes)[0]
                        doubles.append(value)

                if len(doubles) >= 4:
                    start_time = doubles[0]
                    disable_edit = doubles[1]
                    pitch_cents = doubles[2]
                    vocalshifter_clipboard_data.append((start_time, disable_edit, pitch_cents))

            if not vocalshifter_clipboard_data:
                QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.no_valid_vocalshifter_clipboard_data"))
                return

            disabled_count = sum(1 for _, disable_edit, _ in vocalshifter_clipboard_data if disable_edit == 1.0)

            self.apply_vocalshifter_clipboard_to_track(track, vocalshifter_clipboard_data)

            self.status_label.setText(i18n.get("status.vocalshifter_clipboard_data_applied"))
            QMessageBox.information(
                self,
                i18n.get("msg.success"),
                i18n.get("msg.vocalshifter_clipboard_data_loaded")
                + f": {len(vocalshifter_clipboard_data)} {i18n.get('label.samples')}\n"
                + i18n.get("msg.vocalshifter_disabled_samples")
                + f": {disabled_count}",
            )

        except Exception as e:
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.load_vocalshifter_failed") + f": {str(e)}")
            self.status_label.setText(i18n.get("status.vocalshifter_clipboard_data_load_failed"))

    def apply_vocalshifter_clipboard_to_track(self, track, vocalshifter_clipboard_data):
        """将 VocalShifter 数据应用到音轨。"""
        from PyQt6.QtWidgets import QApplication

        # 推入撤销栈
        self.push_undo()

        # 获取音频参数
        sr = track.sr if track.sr else self.processor.config['audio_sample_rate']
        hop_size = self.processor.config['hop_size']

        vocalshifter_clipboard_data.sort(key=lambda x: x[0])

        for i in range(len(track.f0_edited)):
            frame_time = (i * hop_size) / sr

            closest_sample = None
            min_time_diff = float('inf')

            for sample_time, disable_edit, sample_pitch in vocalshifter_clipboard_data:
                time_diff = abs(frame_time - sample_time)
                if time_diff < min_time_diff:
                    min_time_diff = time_diff
                    closest_sample = (sample_time, disable_edit, sample_pitch)

            if closest_sample and min_time_diff < (hop_size / sr):
                _, disable_edit, target_pitch = closest_sample

                if disable_edit == 1.0:
                    if track.f0_original is not None and i < len(track.f0_original):
                        track.f0_edited[i] = track.f0_original[i]
                else:
                    midi_pitch = target_pitch / 100.0
                    track.f0_edited[i] = midi_pitch

        for state in track.segment_states:
            state['dirty'] = True

        self.update_plot()

    def open_vocalshifter_project_dialog(self):
        from PyQt6.QtWidgets import QFileDialog
        from utils.i18n import i18n

        file_path, _ = QFileDialog.getOpenFileName(
            self,
            i18n.get("dialog.open_vocalshifter_project"),
            "",
            "VocalShifter Project (*.vshp *.vsp)",
        )
        if file_path:
            self.load_vocalshifter_project(file_path)

    def load_vocalshifter_project(self, file_path):
        import locale
        import os
        import struct

        from PyQt6.QtWidgets import QApplication, QMessageBox
        from utils.i18n import i18n

        from ..track import Track

        try:
            self.status_label.setText(i18n.get("status.loading_vocalshifter_project"))
            QApplication.processEvents()

            with open(file_path, 'rb') as f:
                header = f.read(16)
                if header[:4] != b'VSPD':
                    QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.vocalshifter_invalid_header"))
                    return

                file_size = struct.unpack('<I', header[12:16])[0]
                project_dir = os.path.dirname(os.path.abspath(file_path))

                project_info = {}
                tracks = []
                audio_blocks = []

                current_offset = 16

                f.seek(current_offset)
                while current_offset < file_size:
                    chunk_header = f.read(8)

                    if len(chunk_header) < 8:
                        break

                    chunk_type = chunk_header[:4]

                    if chunk_type == b'PRJP':
                        prjp_data = f.read(0x108 - 8)
                        sample_rate = struct.unpack('<I', prjp_data[16:20])[0]
                        beats_per_bar = struct.unpack('<I', prjp_data[20:24])[0]
                        beat_unit = struct.unpack('<I', prjp_data[24:28])[0]
                        bpm = struct.unpack('<d', prjp_data[32:40])[0]

                        project_info = {
                            'sample_rate': sample_rate,
                            'beats_per_bar': beats_per_bar,
                            'beat_unit': beat_unit,
                            'bpm': bpm,
                        }

                        current_offset += 0x108

                    elif chunk_type == b'TRKP':
                        trkp_data = f.read(0x108 - 8)

                        track_name_bytes = trkp_data[0:64]
                        null_pos = track_name_bytes.find(b'\x00')
                        if null_pos != -1:
                            track_name_bytes = track_name_bytes[:null_pos]

                        track_name = track_name_bytes.decode(locale.getpreferredencoding())

                        volume = struct.unpack('<d', trkp_data[64:72])[0]
                        muted = struct.unpack('<I', trkp_data[80:84])[0] == 1
                        solo = struct.unpack('<I', trkp_data[84:88])[0] == 1

                        track_info = {
                            'name': track_name,
                            'volume': volume,
                            'muted': muted,
                            'solo': solo,
                        }

                        tracks.append(track_info)
                        current_offset += 0x108

                    elif chunk_type == b'ITMP':
                        itmp_data = f.read(0x208 - 8)

                        path_bytes = bytearray()
                        for i in range(0, 0x108):
                            byte = itmp_data[i:i+1]
                            if byte == b'\x00':
                                break
                            path_bytes.extend(byte)

                        file_path_str = path_bytes.decode(locale.getpreferredencoding())

                        track_index = struct.unpack('<I', itmp_data[0x108:0x10C])[0]
                        start_position_samples = struct.unpack('<d', itmp_data[0x110:0x118])[0]
                        start_position_seconds = start_position_samples / project_info.get('sample_rate', 44100)

                        hop_size = self.processor.config.get('hop_size', 512) if self.processor.config else 512
                        start_frame = int(start_position_seconds * project_info.get('sample_rate', 44100) / hop_size)

                        audio_block = {
                            'file_path': file_path_str,
                            'track_index': track_index,
                            'start_position_samples': start_position_samples,
                            'start_position_seconds': start_position_seconds,
                            'start_frame': start_frame,
                            'tuning_samples': [],
                        }

                        audio_blocks.append(audio_block)
                        current_offset += 0x208

                    else:
                        current_offset += 8
                        f.seek(current_offset)

                # 第二轮：收集所有 Itmp/Ctrp（保持原实现逻辑）
                current_offset = 16
                f.seek(current_offset)
                itmp_block_index = 0

                while current_offset < file_size:
                    chunk_header = f.read(8)
                    if len(chunk_header) < 8:
                        break

                    chunk_type = chunk_header[:4]

                    if chunk_type == b'Itmp':
                        _ = f.read(0x108 - 8)

                        itmp_block = {
                            'index': itmp_block_index,
                            'tuning_samples': [],
                        }

                        if itmp_block_index < len(audio_blocks):
                            audio_blocks[itmp_block_index]['itmp_block'] = itmp_block

                        current_offset += 0x108
                        f.seek(current_offset)

                        while current_offset < file_size:
                            next_chunk_header = f.read(8)
                            if len(next_chunk_header) < 8:
                                break

                            next_chunk_type = next_chunk_header[:4]

                            if next_chunk_type == b'Ctrp':
                                ctrp_data = f.read(0x68 - 8)

                                disabled = struct.unpack('<h', ctrp_data[18:20])[0] == 1
                                pitch_cents = struct.unpack('<h', ctrp_data[22:24])[0]
                                midi_pitch = pitch_cents / 100.0

                                tuning_sample = {
                                    'disabled': disabled,
                                    'pitch_cents': pitch_cents,
                                    'midi_pitch': midi_pitch,
                                }

                                itmp_block['tuning_samples'].append(tuning_sample)

                                if itmp_block_index < len(audio_blocks):
                                    audio_blocks[itmp_block_index]['tuning_samples'].append(tuning_sample)

                                current_offset += 0x68
                                f.seek(current_offset)
                            else:
                                f.seek(current_offset)
                                break

                        itmp_block_index += 1
                    else:
                        current_offset += 8
                        f.seek(current_offset)

                # 应用到当前工程
                self.tracks = []
                self.current_track_idx = -1
                self.timeline_panel.refresh_tracks([])

                if project_info:
                    self.bpm_spin.setValue(project_info.get('bpm', 120))
                    beats_per_bar = project_info.get('beats_per_bar', 4)
                    beat_unit = project_info.get('beat_unit', 4)

                    if beat_unit == 4:
                        self.beats_spin.setValue(beats_per_bar)
                    else:
                        self.beats_spin.setValue(beats_per_bar)
                        QMessageBox.information(
                            self,
                            i18n.get("msg.info"),
                            i18n.get("msg.time_signature_converted") + f" {beats_per_bar}/{beat_unit} -> {beats_per_bar}/4",
                        )

                unsupported_files = []

                for i, audio_block in enumerate(audio_blocks):
                    raw_path = audio_block['file_path']

                    if not os.path.isabs(raw_path):
                        abs_path = os.path.join(project_dir, raw_path)
                    else:
                        abs_path = raw_path

                    if not os.path.exists(abs_path):
                        file_name = os.path.basename(raw_path)
                        alt_path = os.path.join(project_dir, file_name)
                        if os.path.exists(alt_path):
                            abs_path = alt_path
                        else:
                            unsupported_files.append(f"{raw_path} ({i18n.get('msg.file_not_found')})")
                            continue

                    file_ext = os.path.splitext(abs_path)[1].lower()
                    supported_extensions = {'.wav', '.flac', '.mp3'}

                    if file_ext not in supported_extensions:
                        unsupported_files.append(f"{raw_path} ({i18n.get('msg.unsupported_format')})")
                        continue

                    track_info = None
                    if audio_block['track_index'] < len(tracks):
                        track_info = tracks[audio_block['track_index']]

                    if track_info:
                        track_count_in_track = sum(
                            1 for ab in audio_blocks if ab['track_index'] == audio_block['track_index']
                        )
                        if track_count_in_track > 1:
                            track_name = f"{track_info['name']}_{i+1}"
                        else:
                            track_name = track_info['name']
                    else:
                        track_name = f"Track_{i+1}"

                    try:
                        track = Track(track_name, abs_path, track_type='vocal')
                        track.load(self.processor)

                        if track_info:
                            track.volume = track_info.get('volume', 1.0)
                            track.muted = track_info.get('muted', False)
                            track.solo = track_info.get('solo', False)

                        track.start_frame = audio_block['start_frame']

                        if audio_block['tuning_samples'] and track.f0_edited is not None:
                            self.apply_vocalshifter_tuning_samples(track, audio_block['tuning_samples'])

                        self.tracks.append(track)

                    except Exception as e:
                        unsupported_files.append(f"{raw_path} ({str(e)})")

                if self.processor.config:
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
                self.timeline_panel.refresh_tracks(self.tracks)

                if unsupported_files:
                    warning_msg = i18n.get("msg.unsupported_files_found") + ":\n\n"
                    warning_msg += "\n".join(unsupported_files[:10])
                    if len(unsupported_files) > 10:
                        warning_msg += f"\n\n...{len(unsupported_files) - 10} more"

                    QMessageBox.warning(self, i18n.get("msg.warning"), warning_msg)

                self.status_label.setText(i18n.get("status.vocalshifter_project_loaded"))

        except Exception as e:
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.load_vocalshifter_project_failed") + f": {str(e)}")
            import traceback

            traceback.print_exc()
            self.status_label.setText(i18n.get("status.vocalshifter_load_failed"))

    def apply_vocalshifter_tuning_samples(self, track, tuning_samples):
        """将 VocalShifter 调音采样点应用到音轨（保持原逻辑）。"""
        if not tuning_samples or track.f0_edited is None:
            return

        # 推入撤销栈
        self.push_undo()

        sr = track.sr if track.sr else self.processor.config['audio_sample_rate']
        hop_size = self.processor.config['hop_size']

        time_pitch_pairs = []
        for i, sample in enumerate(tuning_samples):
            sample_time = i * 0.005

            if sample.get('disabled', False):
                time_pitch_pairs.append((sample_time, None, True))
            else:
                midi_pitch = sample.get('midi_pitch', 0)
                time_pitch_pairs.append((sample_time, midi_pitch, False))

        if not time_pitch_pairs:
            return

        audio_duration = len(track.audio) / sr if track.audio is not None else 0

        for i in range(len(track.f0_edited)):
            frame_time = (i * hop_size) / sr

            if frame_time > audio_duration:
                continue

            sample_index = int(frame_time / 0.005)
            next_sample_index = sample_index + 1

            if sample_index >= len(time_pitch_pairs):
                last_time, last_pitch, last_disabled = time_pitch_pairs[-1]
                if last_disabled:
                    if track.f0_original is not None and i < len(track.f0_original):
                        track.f0_edited[i] = track.f0_original[i]
                elif last_pitch is not None:
                    track.f0_edited[i] = last_pitch
                continue

            if sample_index < 0:
                first_time, first_pitch, first_disabled = time_pitch_pairs[0]
                if first_disabled:
                    if track.f0_original is not None and i < len(track.f0_original):
                        track.f0_edited[i] = track.f0_original[i]
                elif first_pitch is not None:
                    track.f0_edited[i] = first_pitch
                continue

            current_time, current_pitch, current_disabled = time_pitch_pairs[sample_index]

            if next_sample_index >= len(time_pitch_pairs):
                if current_disabled:
                    if track.f0_original is not None and i < len(track.f0_original):
                        track.f0_edited[i] = track.f0_original[i]
                elif current_pitch is not None:
                    track.f0_edited[i] = current_pitch
                continue

            next_time, next_pitch, next_disabled = time_pitch_pairs[next_sample_index]

            time_ratio = (frame_time - current_time) / (next_time - current_time)

            if current_disabled and next_disabled:
                if track.f0_original is not None and i < len(track.f0_original):
                    track.f0_edited[i] = track.f0_original[i]
                continue

            if current_disabled:
                if track.f0_original is not None and i < len(track.f0_original):
                    track.f0_edited[i] = track.f0_original[i]
                continue

            if next_disabled:
                if current_pitch is not None:
                    track.f0_edited[i] = current_pitch
                continue

            if current_pitch is not None and next_pitch is not None:
                interpolated_pitch = current_pitch + (next_pitch - current_pitch) * time_ratio
                track.f0_edited[i] = interpolated_pitch

        for state in track.segment_states:
            state['dirty'] = True

        self.update_plot()
