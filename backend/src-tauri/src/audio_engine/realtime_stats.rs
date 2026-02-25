use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub(crate) struct RealtimeRenderStats {
    // Callback-level events
    pub(crate) callbacks_total: AtomicU64,
    pub(crate) callbacks_silenced_not_playing: AtomicU64,

    // Pitch stream events
    pub(crate) pitch_callbacks_total: AtomicU64,
    pub(crate) pitch_callbacks_silenced_waiting: AtomicU64, // hard-start: not covered yet
    pub(crate) pitch_callbacks_prime_waiting: AtomicU64,    // hard-start: priming window not satisfied
    pub(crate) pitch_callbacks_fallback_mixed: AtomicU64,   // hard-start disabled: used legacy mix

    // Base stream events
    pub(crate) base_callbacks_total: AtomicU64,
    pub(crate) base_callbacks_covered: AtomicU64,
    pub(crate) base_callbacks_fallback_mixed: AtomicU64,

    // Pure legacy path (no streams)
    pub(crate) legacy_callbacks_mixed: AtomicU64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct RealtimeRenderStatsSnapshot {
    pub callbacks_total: u64,
    pub callbacks_silenced_not_playing: u64,

    pub pitch_callbacks_total: u64,
    pub pitch_callbacks_silenced_waiting: u64,
    pub pitch_callbacks_prime_waiting: u64,
    pub pitch_callbacks_fallback_mixed: u64,

    pub base_callbacks_total: u64,
    pub base_callbacks_covered: u64,
    pub base_callbacks_fallback_mixed: u64,

    pub legacy_callbacks_mixed: u64,
}

impl RealtimeRenderStats {
    pub(crate) fn snapshot(&self) -> RealtimeRenderStatsSnapshot {
        RealtimeRenderStatsSnapshot {
            callbacks_total: self.callbacks_total.load(Ordering::Relaxed),
            callbacks_silenced_not_playing: self.callbacks_silenced_not_playing.load(Ordering::Relaxed),

            pitch_callbacks_total: self.pitch_callbacks_total.load(Ordering::Relaxed),
            pitch_callbacks_silenced_waiting: self.pitch_callbacks_silenced_waiting.load(Ordering::Relaxed),
            pitch_callbacks_prime_waiting: self.pitch_callbacks_prime_waiting.load(Ordering::Relaxed),
            pitch_callbacks_fallback_mixed: self.pitch_callbacks_fallback_mixed.load(Ordering::Relaxed),

            base_callbacks_total: self.base_callbacks_total.load(Ordering::Relaxed),
            base_callbacks_covered: self.base_callbacks_covered.load(Ordering::Relaxed),
            base_callbacks_fallback_mixed: self.base_callbacks_fallback_mixed.load(Ordering::Relaxed),

            legacy_callbacks_mixed: self.legacy_callbacks_mixed.load(Ordering::Relaxed),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn reset(&self) {
        self.callbacks_total.store(0, Ordering::Relaxed);
        self.callbacks_silenced_not_playing.store(0, Ordering::Relaxed);

        self.pitch_callbacks_total.store(0, Ordering::Relaxed);
        self.pitch_callbacks_silenced_waiting.store(0, Ordering::Relaxed);
        self.pitch_callbacks_prime_waiting.store(0, Ordering::Relaxed);
        self.pitch_callbacks_fallback_mixed.store(0, Ordering::Relaxed);

        self.base_callbacks_total.store(0, Ordering::Relaxed);
        self.base_callbacks_covered.store(0, Ordering::Relaxed);
        self.base_callbacks_fallback_mixed.store(0, Ordering::Relaxed);

        self.legacy_callbacks_mixed.store(0, Ordering::Relaxed);
    }
}