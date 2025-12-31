from __future__ import annotations

import time

import numpy as np
import sounddevice as sd
from PyQt6.QtCore import QTimer

from utils.i18n import i18n


class PlaybackMixin:
    def toggle_playback(self):
        if self.is_playing:
            self.stop_playback()
        else:
            self.start_playback()

    def _close_playback_stream(self):
        stream = getattr(self, '_playback_stream', None)
        self._playback_stream = None

        if stream is None:
            return

        try:
            stream.stop()
        except Exception:
            pass

        try:
            stream.close()
        except Exception:
            pass

    def _on_stream_finished(self):
        """Called on the UI thread when the sounddevice stream finishes."""
        try:
            self._close_playback_stream()
        except Exception:
            pass

        if self.is_playing:
            self.is_playing = False
            self.playback_timer.stop()
            self.status_label.setText(i18n.get("status.stopped"))

    def _prepare_stream_playback_async(self):
        """Prepare per-track float32 buffers for callback mixing in a background thread."""
        if self._is_bg_busy():
            return

        def _work(_progress):
            sr = int(self.processor.config['audio_sample_rate']) if self.processor.config else 44100
            hop_size = int(self.processor.config['hop_size']) if self.processor.config else 512

            items = []
            max_len = 0

            for track in self.tracks:
                audio = self._get_track_audio_for_mix(track)
                if audio is None:
                    continue
                if len(audio) <= 0:
                    continue
                if audio.dtype != np.float32:
                    audio = audio.astype(np.float32)
                audio = np.ascontiguousarray(audio)

                start_sample = int(track.start_frame) * hop_size
                end_sample = start_sample + int(len(audio))
                if end_sample > max_len:
                    max_len = end_sample

                items.append((track, audio, start_sample))

            if max_len <= 0 or not items:
                return None

            return {
                'sr': sr,
                'hop_size': hop_size,
                'total_samples': int(max_len),
                'items': items,
            }

        def _ok(prep):
            self._start_stream_playback(prep)

        def _fail(_err_text: str):
            self.status_label.setText(i18n.get("status.load_failed"))

        self._start_bg_task(
            kind='prepare_playback',
            status_text=i18n.get("status.mixing"),
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )

    def _start_stream_playback(self, prep):
        if prep is None:
            return

        # Stop any existing playback first
        try:
            self._close_playback_stream()
        except Exception:
            pass
        try:
            sd.stop()
        except Exception:
            pass

        sr = int(prep.get('sr', 44100))
        hop_size = int(prep.get('hop_size', 512))
        total_samples = int(prep.get('total_samples', 0))
        items = prep.get('items', [])

        if total_samples <= 0 or not items:
            return

        # Mark where "stop(reset=False)" returns to
        self.playback_start_time = self.current_playback_time

        if self.current_playback_time < 0:
            self.current_playback_time = 0.0

        start_sample = int(self.current_playback_time * sr)
        if start_sample >= total_samples:
            start_sample = 0
            self.current_playback_time = 0.0
            self.play_cursor.setValue(0)

        self._playback_sr = sr
        self._playback_hop_size = hop_size
        self._playback_total_samples = total_samples
        self._playback_items = items
        with self._playback_lock:
            self._playback_sample_pos = int(start_sample)

        def _finished_callback():
            # sounddevice thread -> marshal to UI thread
            try:
                QTimer.singleShot(0, self._on_stream_finished)
            except Exception:
                pass

        def _callback(outdata, frames, _time_info, _status):
            outdata.fill(0)

            with self._playback_lock:
                pos = int(self._playback_sample_pos)
                total = int(self._playback_total_samples)

            if total <= 0 or pos >= total:
                raise sd.CallbackStop()

            n_avail = total - pos
            n = frames if frames <= n_avail else n_avail
            if n <= 0:
                raise sd.CallbackStop()

            items_local = self._playback_items

            # If any track is solo, only solo tracks are audible.
            solo_any = False
            for t, _buf, _start in items_local:
                if getattr(t, 'solo', False):
                    solo_any = True
                    break

            mix = np.zeros(n, dtype=np.float32)

            for t, buf, start in items_local:
                if getattr(t, 'muted', False):
                    continue
                if solo_any and (not getattr(t, 'solo', False)):
                    continue

                vol = float(getattr(t, 'volume', 1.0))
                if vol == 0.0:
                    continue

                src0 = pos - int(start)

                # No overlap with this output block
                if src0 >= len(buf) or src0 + n <= 0:
                    continue

                out0 = 0
                if src0 < 0:
                    out0 = -src0
                    src0 = 0

                take = min(n - out0, len(buf) - src0)
                if take <= 0:
                    continue

                mix[out0:out0 + take] += buf[src0:src0 + take] * vol

            np.clip(mix, -1.0, 1.0, out=mix)
            outdata[:n, 0] = mix

            with self._playback_lock:
                self._playback_sample_pos += int(n)

            if n < frames:
                raise sd.CallbackStop()

        try:
            self._playback_stream = sd.OutputStream(
                samplerate=sr,
                channels=1,
                dtype='float32',
                callback=_callback,
                finished_callback=_finished_callback,
            )
            self._playback_stream.start()
        except Exception as e:
            print(f"Playback error: {e}")
            self._close_playback_stream()
            return

        self.is_playing = True
        self.playback_timer.start()
        self.status_label.setText(i18n.get("status.playing"))

    def start_playback(self):
        # Ensure synthesis happens off the UI thread; playback itself is stream/callback mixed.
        if not self.tracks:
            return

        if self._is_bg_busy():
            self._pending_playback = True
            return

        if self._has_dirty_segments():
            self.synthesize_audio_async(after=self.start_playback)
            return

        self._prepare_stream_playback_async()

    def pause_playback(self):
        if not self.is_playing:
            return

        try:
            sr = int(self._playback_sr) if getattr(self, '_playback_sr', None) else 44100
            with self._playback_lock:
                self.current_playback_time = float(self._playback_sample_pos) / float(sr)
        except Exception:
            pass

        try:
            self._close_playback_stream()
        except Exception:
            pass

        try:
            sd.stop()
        except Exception:
            pass

        self.is_playing = False
        self.playback_timer.stop()
        self.status_label.setText(i18n.get("status.paused"))

    def stop_playback(self, reset=False):
        try:
            sr = int(self._playback_sr) if getattr(self, '_playback_sr', None) else 44100
            with self._playback_lock:
                self.current_playback_time = float(self._playback_sample_pos) / float(sr)
        except Exception:
            pass

        try:
            self._close_playback_stream()
        except Exception:
            pass

        try:
            sd.stop()
        except Exception:
            pass

        self.is_playing = False
        self.playback_timer.stop()

        if reset:
            self.current_playback_time = 0
            try:
                with self._playback_lock:
                    self._playback_sample_pos = 0
            except Exception:
                pass
            self.play_cursor.setValue(0)
            self.playback_start_time = 0
        else:
            # Return to start position
            self.current_playback_time = self.playback_start_time
            try:
                with self._playback_lock:
                    self._playback_sample_pos = int(self.current_playback_time * sr)
            except Exception:
                pass

            if self.processor.config:
                hop_size = self.processor.config['hop_size']
                sr_cfg = self.processor.config.get('audio_sample_rate', 44100)
                self.play_cursor.setValue(self.current_playback_time * sr_cfg / hop_size)
                self.timeline_panel.set_cursor_position(self.current_playback_time * sr_cfg / hop_size)

        self.status_label.setText(i18n.get("status.stopped"))

    def set_playback_position(self, x_frame):
        if x_frame < 0:
            x_frame = 0

        # Update cursor visual
        self.play_cursor.setValue(x_frame)
        self.timeline_panel.set_cursor_position(x_frame)

        # Update internal time
        if self.processor.config:
            hop_size = self.processor.config['hop_size']
            sr = self.processor.config.get('audio_sample_rate', 44100)
            self.current_playback_time = x_frame * hop_size / sr
            self.playback_start_time = self.current_playback_time  # Update start time on seek

            if self.is_playing:
                # Pause playback on seek
                self.pause_playback()

    def update_cursor(self):
        if not self.is_playing:
            return

        # When using OutputStream callback playback, derive time from sample position.
        if getattr(self, '_playback_stream', None) is not None:
            try:
                sr = int(self._playback_sr) if getattr(self, '_playback_sr', None) else 44100
                with self._playback_lock:
                    self.current_playback_time = float(self._playback_sample_pos) / float(sr)
            except Exception:
                pass
        else:
            # Fallback (should rarely happen now)
            now = time.time()
            dt = now - self.last_wall_time
            self.last_wall_time = now
            self.current_playback_time += dt

        # Convert time to x (frames)
        if self.processor.config:
            hop_size = self.processor.config['hop_size']
            sr_cfg = self.processor.config.get('audio_sample_rate', 44100)
            x = self.current_playback_time * sr_cfg / hop_size
            self.play_cursor.setValue(x)
            self.timeline_panel.set_cursor_position(x)

    def play_original(self):
        track = self.current_track
        if track and track.audio is not None:
            # Avoid fighting with the real-time stream
            try:
                if self.is_playing:
                    self.stop_playback(reset=False)
            except Exception:
                pass

            sd.stop()
            sd.play(track.audio, track.sr)

    def synthesize_and_play(self):
        # Start playback pipeline: synthesize (if needed) -> mix -> play
        self.stop_playback(reset=True)
        self.start_playback()

    def stop_audio(self):
        self.stop_playback()
