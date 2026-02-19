import numpy as np
import librosa

from librosa.filters import mel as librosa_mel_fn
# from loguru import logger


class PitchAdjustableMelSpectrogram:
    def __init__(
        self,
        sample_rate=44100,
        n_fft=2048,
        win_length=2048,
        hop_length=512,
        f_min=40,
        f_max=16000,
        n_mels=128,
        center=False,
    ):
        self.sample_rate = sample_rate
        self.n_fft = n_fft
        self.win_size = win_length
        self.hop_length = hop_length
        self.f_min = f_min
        self.f_max = f_max
        self.n_mels = n_mels
        self.center = center

        self.mel_basis = {}
        self.hann_window = {}

    def __call__(self, y, key_shift=0, speed=1.0):
        """
        Extract mel spectrogram from audio using numpy/librosa instead of torch.
        
        Args:
            y: numpy array of audio samples, shape (n_samples,) or (1, n_samples)
            key_shift: pitch shift in semitones
            speed: time stretch factor
            
        Returns:
            mel: numpy array of mel spectrogram, shape (n_mels, n_frames)
        """
        # Ensure y is 1D numpy array
        if isinstance(y, np.ndarray):
            if y.ndim == 2:
                y = y.squeeze()
        else:
            raise TypeError(f"Expected numpy array, got {type(y)}")
            
        factor = 2 ** (key_shift / 12)
        n_fft_new = int(np.round(self.n_fft * factor))
        win_size_new = int(np.round(self.win_size * factor))
        hop_length = int(np.round(self.hop_length * speed))

        # Get or create mel filterbank
        mel_basis_key = f"{self.f_max}_cpu"
        if mel_basis_key not in self.mel_basis:
            mel = librosa_mel_fn(
                sr=self.sample_rate,
                n_fft=self.n_fft,
                n_mels=self.n_mels,
                fmin=self.f_min,
                fmax=self.f_max,
            )
            self.mel_basis[mel_basis_key] = mel.astype(np.float32)

        # Get or create hann window
        hann_window_key = f"{key_shift}_cpu"
        if hann_window_key not in self.hann_window:
            self.hann_window[hann_window_key] = np.hanning(win_size_new).astype(np.float32)

        # Pad audio for STFT
        pad_left = int((win_size_new - hop_length) // 2)
        pad_right = int((win_size_new - hop_length + 1) // 2)
        y = np.pad(y, (pad_left, pad_right), mode='reflect')

        # Compute STFT using librosa
        spec = librosa.stft(
            y,
            n_fft=n_fft_new,
            hop_length=hop_length,
            win_length=win_size_new,
            window=self.hann_window[hann_window_key],
            center=self.center,
        )
        
        # Get magnitude
        spec = np.abs(spec)

        # Handle pitch shift by resampling frequency bins
        if key_shift != 0:
            size = self.n_fft // 2 + 1
            resize = spec.shape[0]
            if resize < size:
                spec = np.pad(spec, ((0, size - resize), (0, 0)), mode='constant')

            spec = spec[:size, :] * self.win_size / win_size_new

        # Apply mel filterbank
        spec = np.dot(self.mel_basis[mel_basis_key], spec)

        # Add batch dimension to match expected output shape (1, n_mels, n_frames)
        spec = spec[np.newaxis, :, :]
        
        return spec

    def dynamic_range_compression_torch(self, x, C=1, clip_val=1e-5):
        """Apply dynamic range compression (log scaling)."""
        return np.log(np.clip(x, a_min=clip_val, a_max=None) * C)

if __name__=='__main__':
    import glob
    import torchaudio
    from tqdm import tqdm
    # from concurrent.futures import ProcessPoolExecutor
    # import random

    # import re
    # from torch.multiprocessing import Manager, Process, current_process, get_context
    #
    # is_main_process = not bool(re.match(r'((.*Process)|(SyncManager)|(.*PoolWorker))-\d+', current_process().name))


    lll = glob.glob(r'D:\propj\Disa\data\opencpop\raw\wavs/**.wav')
    torch.set_num_threads(1)

    for i in tqdm(lll):
        audio, sr = torchaudio.load(i)
        audio = torch.clamp(audio[0], -1.0, 1.0)

        mel_spec_transform=PitchAdjustableMelSpectrogram()
        with torch.no_grad():
            spectrogram = mel_spec_transform(audio.unsqueeze(0).cuda())*0.434294
            # spectrogram = 20 * torch.log10(torch.clamp(spectrogram, min=1e-5)) - 20  #ds 是log10
            # spectrogram = torch.log(torch.clamp(spectrogram, min=1e-5))