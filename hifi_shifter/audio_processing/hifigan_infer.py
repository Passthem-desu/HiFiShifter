import pathlib
from typing import Tuple

import numpy as np
import onnxruntime as ort

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


from utils.wav2mel import PitchAdjustableMelSpectrogram




def build_model_and_mel_transform(
    config: dict,
    model_dir: str | pathlib.Path,
    device: str,
) -> Tuple[ort.InferenceSession, PitchAdjustableMelSpectrogram]:
    """Build ONNX session + mel transform for inference."""
    model_dir = pathlib.Path(model_dir)

    onnx_path = _find_onnx_model(model_dir)
    session = _build_onnx_session(onnx_path, device)

    mel_transform = PitchAdjustableMelSpectrogram(
        sample_rate=config['audio_sample_rate'],
        n_fft=config['fft_size'],
        win_length=config['win_size'],
        hop_length=config['hop_size'],
        f_min=config['fmin'],
        f_max=config['fmax'],
        n_mels=config['audio_num_mel_bins'],
    )

    return session, mel_transform


def _find_onnx_model(model_dir: pathlib.Path) -> pathlib.Path:
    preferred = [
        model_dir / 'pc_nsf_hifigan.onnx',
        model_dir / 'generator.onnx',
        model_dir / 'model.onnx',
    ]
    for p in preferred:
        if p.exists():
            return p

    all_onnx = sorted(model_dir.glob('*.onnx'))
    if len(all_onnx) == 1:
        return all_onnx[0]
    if len(all_onnx) > 1:
        return all_onnx[0]

    raise FileNotFoundError(f'未在目录中找到 ONNX 文件: {model_dir}')


def _build_onnx_session(onnx_path: pathlib.Path, device: str) -> ort.InferenceSession:
    providers = ['CPUExecutionProvider']
    if device == 'cuda':
        providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
    return ort.InferenceSession(str(onnx_path), providers=providers)


def _midi_to_hz(f0_midi: np.ndarray) -> np.ndarray:
    f0_midi = np.asarray(f0_midi, dtype=np.float32)
    f0_hz = np.zeros_like(f0_midi, dtype=np.float32)
    mask = ~np.isnan(f0_midi)
    f0_hz[mask] = 440.0 * (2.0 ** ((f0_midi[mask] - 69.0) / 12.0))
    f0_hz[~mask] = 0.0
    return f0_hz


def synthesize_full(
    model: ort.InferenceSession,
    mel: np.ndarray,
    f0_midi: np.ndarray,
    *,
    device: str,
) -> np.ndarray:
    """Synthesize full audio from mel + MIDI f0 using ONNXRuntime."""
    del device
    mel_np = _to_mel_numpy(mel)
    f0_hz = _midi_to_hz(f0_midi)
    f0_np = np.asarray(f0_hz, dtype=np.float32).reshape(1, -1)

    output = model.run(None, {'mel': mel_np, 'f0': f0_np})[0]

    synthesized_audio = output[0]
    if synthesized_audio.ndim == 2 and synthesized_audio.shape[0] == 1:
        synthesized_audio = synthesized_audio.squeeze(0)
    return synthesized_audio


def synthesize_segment_with_padding(
    model: ort.InferenceSession,
    mel: np.ndarray,
    segment: tuple[int, int],
    f0_midi_segment: np.ndarray,
    *,
    device: str,
    hop_size: int,
    pad_frames: int = 64,
) -> np.ndarray:
    """Synthesize a segment with context padding to reduce boundary artifacts."""
    del device
    start, end = segment

    # Calculate padded range
    p_start = max(0, start - pad_frames)
    p_end = min(mel.shape[2], end + pad_frames)

    mel_slice = _to_mel_numpy(mel[:, :, p_start:p_end])

    pre_pad = start - p_start
    post_pad = p_end - end

    expected_len = end - start
    if len(f0_midi_segment) != expected_len:
        if len(f0_midi_segment) < expected_len:
            f0_midi_segment = np.pad(
                f0_midi_segment,
                (0, expected_len - len(f0_midi_segment)),
                constant_values=np.nan,
            )
        else:
            f0_midi_segment = f0_midi_segment[:expected_len]

    f0_padded = np.pad(f0_midi_segment, (pre_pad, post_pad), constant_values=np.nan)
    f0_hz = _midi_to_hz(f0_padded)
    f0_np = np.asarray(f0_hz, dtype=np.float32).reshape(1, -1)

    output = model.run(None, {'mel': mel_slice, 'f0': f0_np})[0]

    audio_padded = output[0]
    if audio_padded.ndim == 2:
        audio_padded = audio_padded.squeeze(0)

    trim_start = pre_pad * hop_size
    trim_end = len(audio_padded) - (post_pad * hop_size)

    if trim_end <= trim_start:
        return audio_padded

    return audio_padded[trim_start:trim_end]


def _to_mel_numpy(mel: np.ndarray) -> np.ndarray:
    """Ensure mel is a numpy array with float32 dtype."""
    return np.asarray(mel, dtype=np.float32)
