from __future__ import annotations

import numpy as np
import librosa
import soundfile as sf

# Prefer relative import (normal package usage). Fall back only for direct execution.
try:
    from ._bootstrap import ensure_project_root_on_sys_path
except ImportError:  # pragma: no cover
    import sys
    from pathlib import Path

    _repo_root = Path(__file__).resolve().parents[2]
    _repo_root_str = str(_repo_root)
    if _repo_root_str not in sys.path:
        sys.path.insert(0, _repo_root_str)

    from hifi_shifter.audio_processing._bootstrap import ensure_project_root_on_sys_path

ensure_project_root_on_sys_path()


from utils.wav2F0 import get_pitch


def dynamic_range_compression_torch(x, C=1, clip_val=1e-9):
    """Apply dynamic range compression using numpy."""
    return np.log(np.clip(x, a_min=clip_val, a_max=None) * C)




def load_audio_mono_resample(file_path: str, target_sr: int) -> tuple[np.ndarray, int]:
    """Load audio as mono numpy array and resample to target_sr.
    
    Returns:
        audio: numpy array of shape (n_samples,)
        sr: sample rate
    """
    try:
        # Try soundfile first (faster)
        audio, sr = sf.read(file_path, dtype='float32')
    except:
        # Fallback to librosa
        audio, sr = librosa.load(file_path, sr=None, mono=False, dtype=np.float32)
    
    # Convert to mono if stereo
    if audio.ndim > 1:
        audio = np.mean(audio, axis=-1 if audio.shape[-1] <= 2 else 0)
    
    # Resample if needed
    if sr != target_sr:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)
        sr = target_sr
    
    return audio, sr


def extract_mel_f0_segments(
    audio: np.ndarray,
    *,
    config: dict,
    mel_transform,
    key_shift: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, list[tuple[int, int]]]:
    """Extract mel, f0 (MIDI, NaN for unvoiced), and speech segments.
    
    Args:
        audio: numpy array of audio samples, shape (n_samples,)
        config: configuration dict
        mel_transform: PitchAdjustableMelSpectrogram instance
        key_shift: pitch shift in semitones
        
    Returns:
        mel: mel spectrogram, shape (1, n_mels, n_frames)
        f0_midi: f0 in MIDI notes, shape (n_frames,)
        segments: list of (start_frame, end_frame) tuples
    """
    mel = dynamic_range_compression_torch(mel_transform(audio, key_shift=key_shift))

    f0_np, _uv = get_pitch(
        'parselmouth',
        audio if audio.ndim == 1 else audio[0],
        hparams=config,
        speed=1,
        interp_uv=True,
        length=mel.shape[2],
    )

    f0_midi = np.zeros_like(f0_np, dtype=np.float32)
    mask = f0_np > 0
    f0_midi[mask] = 69.0 + 12.0 * np.log2(f0_np[mask] / 440.0)
    f0_midi[~mask] = np.nan

    segments = segment_audio_by_mel_energy(mel)

    return mel, f0_midi, segments


def segment_audio_by_mel_energy(
    mel: np.ndarray,
    threshold_db: float = -60,
    min_silence_frames: int = 100,
) -> list[tuple[int, int]]:
    """Segment audio based on mel energy; returns list of (start_frame, end_frame)."""
    mel_np = mel.squeeze()  # mel is already numpy array
    energy = np.mean(mel_np, axis=0)

    energy_db = 20 * np.log10(np.maximum(energy, 1e-5))
    energy_db = energy_db - np.max(energy_db)

    is_speech = energy_db > threshold_db

    # Import lazily (scipy is not always needed during startup)
    from scipy.ndimage import binary_dilation

    struct = np.ones(min_silence_frames)
    is_speech = binary_dilation(is_speech, structure=struct)

    segments: list[tuple[int, int]] = []
    start = None
    for i, active in enumerate(is_speech):
        if active and start is None:
            start = i
        elif (not active) and start is not None:
            segments.append((start, i))
            start = None
    if start is not None:
        segments.append((start, len(is_speech)))

    if not segments:
        segments = [(0, len(is_speech))]

    segments = [(max(0, s), max(s, e)) for s, e in segments]
    return segments
