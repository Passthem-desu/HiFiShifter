from __future__ import annotations

from utils.i18n import i18n


class SynthesisMixin:
    def _count_dirty_segments(self) -> int:
        total = 0
        for track in self.tracks:
            if getattr(track, 'track_type', None) != 'vocal':
                continue
            for state in getattr(track, 'segment_states', []) or []:
                if state.get('dirty'):
                    total += 1
        return total

    def _has_dirty_segments(self) -> bool:
        return self._count_dirty_segments() > 0

    def synthesize_audio_async(self, *, after=None):
        """Synthesize dirty segments in a background thread.

        `after` will be called on the UI thread after synthesis finishes.
        """
        total_segments = self._count_dirty_segments()
        if total_segments <= 0:
            if after is not None:
                after()
            return

        if self._is_bg_busy():
            # Coalesce repeated requests (e.g. multiple clicks)
            self._pending_synthesis = True
            return

        # Stop playback while mutating track audio buffers
        try:
            if self.is_playing:
                self.stop_playback(reset=False)
        except Exception:
            pass

        def _work(progress):
            hop_size = self.processor.config['hop_size'] if self.processor.config else 512
            processed = 0
            for track in self.tracks:
                if track.track_type != 'vocal':
                    continue
                for i, state in enumerate(track.segment_states):
                    if state.get('dirty'):
                        track.synthesize_segment(self.processor, i)
                        processed += 1
                        progress(processed, total_segments)
                track.update_full_audio(hop_size)
            return processed

        def _ok(_processed_count):
            self.status_label.setText(i18n.get("status.synthesis_complete"))

            if self._pending_synthesis:
                self._pending_synthesis = False
                # Re-run once more to pick up new dirty segments
                self.synthesize_audio_async(after=after)
                return

            if after is not None:
                after()

        def _fail(_err_text: str):
            self.status_label.setText(i18n.get("status.auto_synthesis_failed"))

        self._start_bg_task(
            kind='synthesize',
            status_text=i18n.get("status.synthesizing"),
            fn=_work,
            total=total_segments,
            on_success=_ok,
            on_failed=_fail,
        )
