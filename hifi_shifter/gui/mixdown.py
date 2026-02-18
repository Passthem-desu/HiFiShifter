from __future__ import annotations

import numpy as np

from ..audio_processor import apply_tension_tilt_pd
from ..track import Track


class MixdownMixin:
    def _get_track_audio_for_mix(self, track: Track):
        """Return audio buffer for mixing/export, applying tension post-FX for vocal tracks."""
        if track is None or track.synthesized_audio is None:
            return None

        audio = track.synthesized_audio

        if track.track_type != 'vocal':
            return audio

        tension = getattr(track, 'tension_edited', None)
        f0 = getattr(track, 'f0_edited', None)
        if tension is None or f0 is None:
            return audio

        # Skip if neutral
        try:
            if np.nanmax(np.abs(tension)) < 1e-6:
                return audio
        except Exception:
            return audio

        sr = self.processor.config['audio_sample_rate'] if self.processor.config else 44100
        hop_size = self.processor.config['hop_size'] if self.processor.config else 512

        key = (getattr(track, 'synth_version', 0), getattr(track, 'tension_version', 0), int(len(audio)))
        if getattr(track, '_tension_processed_key', None) == key and getattr(track, '_tension_processed_audio', None) is not None:
            return track._tension_processed_audio

        try:
            processed = apply_tension_tilt_pd(audio, sr, f0, tension, hop_size)
        except Exception as e:
            # Fail-safe: don't break playback/export
            print(f"Tension post-FX failed: {e}")
            processed = audio

        track._tension_processed_audio = processed
        track._tension_processed_key = key
        return processed

    def mix_tracks(self):
        max_len = 0
        active_tracks = [t for t in self.tracks if not t.muted]
        solo_tracks = [t for t in self.tracks if t.solo]
        if solo_tracks:
            active_tracks = solo_tracks

        if not active_tracks:
            return None

        hop_size = self.processor.config['hop_size'] if self.processor.config else 512

        for track in active_tracks:
            audio = self._get_track_audio_for_mix(track)
            if audio is not None:
                start_sample = track.start_frame * hop_size
                end_sample = start_sample + len(audio)
                max_len = max(max_len, end_sample)

        if max_len == 0:
            return None

        mixed_audio = np.zeros(max_len, dtype=np.float32)

        for track in active_tracks:
            audio = self._get_track_audio_for_mix(track)
            if audio is None:
                continue

            start_sample = track.start_frame * hop_size
            l = len(audio)
            mixed_audio[start_sample:start_sample + l] += audio * track.volume

        return mixed_audio
