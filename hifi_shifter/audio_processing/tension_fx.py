import numpy as np
import torch


def apply_tension_tilt_pd(
    audio_np: np.ndarray,
    sr: int,
    f0_midi: np.ndarray,
    tension: np.ndarray,
    hop_size_f0: int,
    *,
    n_fft: int = 2048,
    hop_length: int = 1024,
    win_length: int = 2048,
    max_db: float = 17.0,
) -> np.ndarray:
    """Apply a Pd-style "tension" spectral tilt driven by per-frame F0.

    - tension range: [-100, 100]
    - mapping: gain_db = tension/100 * max_db
    - pivot: pivot_hz = 2 * clip(mtof(f0_midi), 100..1000)

    Notes:
    - f0_midi and tension are aligned to hop_size_f0 (usually model hop_size).
    - Processing hop_length is independent (defaults to 1024 to match the Pd patch).
    """
    if audio_np is None or len(audio_np) == 0:
        return audio_np

    if f0_midi is None or tension is None:
        return audio_np

    # Quick exit if all-zero tension
    try:
        if np.nanmax(np.abs(tension)) < 1e-6:
            return audio_np
    except Exception:
        pass

    audio_np = np.asarray(audio_np, dtype=np.float32)
    f0_midi = np.asarray(f0_midi, dtype=np.float32)
    tension = np.asarray(tension, dtype=np.float32)

    # STFT
    x = torch.from_numpy(audio_np).float().unsqueeze(0)  # [1, T]
    window = torch.hann_window(win_length, periodic=True)
    S = torch.stft(
        x,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window=window,
        center=True,
        pad_mode='reflect',
        return_complex=True,
    )  # [1, F, N]

    S = S[0]  # [F, N]
    n_frames = S.shape[1]

    # Resample f0/tension to STFT frame rate.
    # Use nearest-neighbor for voiced mask to avoid bleeding pitch into silence.
    src_len = int(min(len(f0_midi), len(tension)))
    if src_len <= 0 or n_frames <= 0:
        return audio_np

    f0_midi = f0_midi[:src_len]
    tension = tension[:src_len]

    idx_float = (np.arange(n_frames, dtype=np.float32) * (hop_length / float(hop_size_f0)))
    idx_float = np.clip(idx_float, 0.0, float(src_len - 1))
    idx_nn = np.clip(np.rint(idx_float).astype(np.int64), 0, src_len - 1)

    voiced_src = ~np.isnan(f0_midi)
    voiced = voiced_src[idx_nn]

    valid = np.where(voiced_src)[0]
    if len(valid) >= 2:
        midi_valid = f0_midi[valid]
        midi_rs = np.interp(idx_float, valid.astype(np.float32), midi_valid.astype(np.float32)).astype(np.float32)
    else:
        midi_rs = np.zeros(n_frames, dtype=np.float32)
        voiced[:] = False

    tension_rs = np.interp(
        idx_float,
        np.arange(src_len, dtype=np.float32),
        tension.astype(np.float32),
    ).astype(np.float32)

    gain_db = (tension_rs / 100.0) * float(max_db)
    gain_db[~voiced] = 0.0

    # MIDI -> Hz
    f0_hz = 440.0 * (2.0 ** ((midi_rs - 69.0) / 12.0))
    f0_hz[~voiced] = 0.0

    # Pd patch: clip then *2
    f0_hz = np.clip(f0_hz, 100.0, 1000.0) * 2.0
    f0_hz[~voiced] = 0.0

    # Build per-bin gain matrix
    freqs = torch.fft.rfftfreq(n_fft, d=1.0 / float(sr)).float()  # [F]
    freqs = freqs.unsqueeze(0)  # [1, F]

    gain_db_t = torch.from_numpy(gain_db).float().unsqueeze(1)  # [N, 1]
    pivot = torch.from_numpy(f0_hz).float().unsqueeze(1)  # [N, 1]
    voiced_t = torch.from_numpy(voiced.astype(np.bool_)).unsqueeze(1)

    pivot_safe = torch.where(pivot > 1e-6, pivot, torch.ones_like(pivot))
    ratio = (freqs / pivot_safe) - 1.0  # [N, F] via broadcast
    db = gain_db_t * ratio

    abs_db = gain_db_t.abs()
    db = torch.maximum(torch.minimum(db, abs_db), -abs_db)
    db = torch.where(voiced_t, db, torch.zeros_like(db))

    gain_lin = torch.pow(10.0, db / 20.0)  # [N, F]

    # Apply (transpose to [F, N])
    S_out = S * gain_lin.transpose(0, 1)

    y = torch.istft(
        S_out.unsqueeze(0),
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=win_length,
        window=window,
        center=True,
        length=audio_np.shape[0],
    )[0]

    return y.detach().cpu().numpy().astype(np.float32)
