import json
import pathlib

import numpy as np
import torch

from .audio_processing._bootstrap import ensure_project_root_on_sys_path

ensure_project_root_on_sys_path()

from utils.config_utils import read_full_config

from .audio_processing.features import load_audio_mono_resample, extract_mel_f0_segments
from .audio_processing.hifigan_infer import (
    build_model_and_mel_transform,
    synthesize_full,
    synthesize_segment_with_padding,
)
from .audio_processing.tension_fx import apply_tension_tilt_pd



class AudioProcessor:
    """Public entrypoint for model loading, feature extraction, and synthesis.

    Heavy-lifting is delegated into `hifi_shifter.audio_processing.*` submodules
    so each part can be debugged independently.
    """

    def __init__(self):
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        self.model = None
        self.config: dict = {}
        self.mel_transform = None

    def load_model(self, folder_path):
        """Load model and configuration from the specified folder."""
        folder_path = pathlib.Path(folder_path)

        # Check for config
        config_path = folder_path / 'config.yaml'
        if not config_path.exists():
            config_path = folder_path / 'config.json'

        if not config_path.exists():
            raise FileNotFoundError("目录中未找到 config.yaml 或 config.json。")

        # Load config
        if config_path.suffix == '.yaml':
            self.config = read_full_config(config_path)
        else:
            with open(config_path, 'r', encoding='utf-8') as f:
                self.config = json.load(f)

        # Patch config
        self._patch_config()

        # Check for checkpoint
        ckpt_path = folder_path / 'model.ckpt'
        if not ckpt_path.exists():
            ckpts = list(folder_path.glob('*.ckpt'))
            if ckpts:
                ckpt_path = ckpts[0]
            else:
                raise FileNotFoundError("目录中未找到 .ckpt 文件。")

        self.model, self.mel_transform = build_model_and_mel_transform(
            self.config,
            ckpt_path,
            self.device,
        )

        return self.config

    def _patch_config(self):
        if 'clip_grad_norm' not in self.config:
            self.config['clip_grad_norm'] = 1.0

        key_mapping = {
            'sampling_rate': 'audio_sample_rate',
            'num_mels': 'audio_num_mel_bins',
            'n_fft': 'fft_size',
        }
        for old_key, new_key in key_mapping.items():
            if old_key in self.config and new_key not in self.config:
                self.config[new_key] = self.config[old_key]

        if 'f0_min' not in self.config:
            self.config['f0_min'] = 40
        if 'f0_max' not in self.config:
            self.config['f0_max'] = 1600

        if 'model_args' not in self.config:
            model_arg_keys = [
                'mini_nsf',
                'upsample_rates',
                'upsample_kernel_sizes',
                'upsample_initial_channel',
                'resblock_kernel_sizes',
                'resblock_dilation_sizes',
                'resblock',
                'discriminator_periods',
            ]
            self.config['model_args'] = {}
            for key in model_arg_keys:
                if key in self.config:
                    self.config['model_args'][key] = self.config[key]

    def process_audio(self, file_path):
        """Load audio, resample, and extract features (Mel, F0).

        Returns:
            audio_np: numpy array of audio data (mono)
            sr: sample rate
            mel: Mel spectrogram tensor
            f0_midi: numpy array of F0 (MIDI, NaN for unvoiced)
            segments: list of (start, end) tuples in frames
        """
        if self.model is None or self.mel_transform is None:
            raise RuntimeError("请先加载模型以确保采样率正确。")

        target_sr = int(self.config['audio_sample_rate'])
        audio_t, sr = load_audio_mono_resample(file_path, target_sr)

        mel, f0_midi, segments = extract_mel_f0_segments(
            audio_t,
            config=self.config,
            mel_transform=self.mel_transform,
            key_shift=0.0,
        )

        return audio_t[0].numpy(), sr, mel, f0_midi, segments

    def synthesize_segment(self, mel, segment, f0_midi_segment):
        """Synthesize a specific segment with context padding to avoid artifacts."""
        if self.model is None:
            raise RuntimeError("模型未加载")

        hop_size = int(self.config['hop_size'])
        return synthesize_segment_with_padding(
            self.model,
            mel,
            segment,
            f0_midi_segment,
            device=self.device,
            hop_size=hop_size,
            pad_frames=64,
        )

    def synthesize(self, mel, f0_midi):
        """Synthesize full audio using the modified F0."""
        if self.model is None:
            raise RuntimeError("模型未加载")

        return synthesize_full(
            self.model,
            mel,
            f0_midi,
            device=self.device,
        )
