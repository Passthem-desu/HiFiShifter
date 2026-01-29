import pathlib
from typing import Tuple

import numpy as np
import torch

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


from training.nsf_HiFigan_task import nsf_HiFigan
from utils.wav2mel import PitchAdjustableMelSpectrogram




def build_model_and_mel_transform(
    config: dict,
    ckpt_path: str | pathlib.Path,
    device: str,
) -> Tuple[torch.nn.Module, PitchAdjustableMelSpectrogram]:
    """Build HiFiGAN model + mel transform and load checkpoint."""
    ckpt_path = pathlib.Path(ckpt_path)

    model = nsf_HiFigan(config)
    model.build_model()

    checkpoint = torch.load(ckpt_path, map_location='cpu')
    state_dict = checkpoint.get('state_dict', checkpoint)

    # Handle nested generator checkpoint
    if 'generator' in state_dict and isinstance(state_dict['generator'], dict) and len(state_dict) == 1:
        model.generator.load_state_dict(state_dict['generator'])
    else:
        model.load_state_dict(state_dict, strict=False)

    model.to(device)
    model.eval()

    mel_transform = PitchAdjustableMelSpectrogram(
        sample_rate=config['audio_sample_rate'],
        n_fft=config['fft_size'],
        win_length=config['win_size'],
        hop_length=config['hop_size'],
        f_min=config['fmin'],
        f_max=config['fmax'],
        n_mels=config['audio_num_mel_bins'],
    )

    return model, mel_transform


def _midi_to_hz(f0_midi: np.ndarray) -> np.ndarray:
    f0_midi = np.asarray(f0_midi, dtype=np.float32)
    f0_hz = np.zeros_like(f0_midi, dtype=np.float32)
    mask = ~np.isnan(f0_midi)
    f0_hz[mask] = 440.0 * (2.0 ** ((f0_midi[mask] - 69.0) / 12.0))
    f0_hz[~mask] = 0.0
    return f0_hz


def synthesize_full(
    model: torch.nn.Module,
    mel: torch.Tensor,
    f0_midi: np.ndarray,
    *,
    device: str,
) -> np.ndarray:
    """Synthesize full audio from mel + MIDI f0."""
    mel_tensor = mel.to(device)
    f0_hz = _midi_to_hz(f0_midi)
    f0_tensor = torch.from_numpy(f0_hz).float().unsqueeze(0).to(device)

    with torch.no_grad():
        output = model.Gforward(sample={'mel': mel_tensor, 'f0': f0_tensor})['audio']

    synthesized_audio = output[0].cpu().numpy()
    if synthesized_audio.ndim == 2 and synthesized_audio.shape[0] == 1:
        synthesized_audio = synthesized_audio.squeeze(0)
    return synthesized_audio


def synthesize_segment_with_padding(
    model: torch.nn.Module,
    mel: torch.Tensor,
    segment: tuple[int, int],
    f0_midi_segment: np.ndarray,
    *,
    device: str,
    hop_size: int,
    pad_frames: int = 64,
) -> np.ndarray:
    """Synthesize a segment with context padding to reduce boundary artifacts."""
    start, end = segment

    # Calculate padded range
    p_start = max(0, start - pad_frames)
    p_end = min(mel.shape[2], end + pad_frames)

    mel_slice = mel[:, :, p_start:p_end].to(device)

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
    f0_tensor = torch.from_numpy(f0_hz).float().unsqueeze(0).to(device)

    with torch.no_grad():
        output = model.Gforward(sample={'mel': mel_slice, 'f0': f0_tensor})['audio']

    audio_padded = output[0].cpu().numpy()
    if audio_padded.ndim == 2:
        audio_padded = audio_padded.squeeze(0)

    trim_start = pre_pad * hop_size
    trim_end = len(audio_padded) - (post_pad * hop_size)

    if trim_end <= trim_start:
        return audio_padded

    return audio_padded[trim_start:trim_end]
