"""Audio processing submodules.

This package is intentionally split into small, testable units.
`hifi_shifter.audio_processor.AudioProcessor` is the public entrypoint.
"""

from .tension_fx import apply_tension_tilt_pd  # re-export
