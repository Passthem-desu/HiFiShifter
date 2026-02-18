#!/usr/bin/env python3
"""Export pc_nsf_hifigan Generator to ONNX.

Usage:
  python tools/export_pc_nsf_hifigan_to_onnx.py --ckpt PATH/TO/model.ckpt --out model.onnx

If a config JSON/YAML is next to the checkpoint (same folder, named config.json), it will be used.
Optionally supply --config to point to a config file.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import torch

try:
    import yaml
except Exception:
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from training.nsf_HiFigan_task import nsf_HiFigan


def load_config(ckpt_path: Path | str, config_path: Path | None):
    ckpt_path = Path(ckpt_path)
    if config_path is not None:
        p = Path(config_path)
        text = p.read_text(encoding='utf8')
        if p.suffix.lower() in ('.yml', '.yaml') and yaml is not None:
            return yaml.safe_load(text)
        return json.loads(text)

    # try checkpoint-embedded config
    try:
        ckpt = torch.load(str(ckpt_path), map_location='cpu')
        if isinstance(ckpt, dict) and 'config' in ckpt:
            return ckpt['config']
    except Exception:
        pass

    # try config.json next to checkpoint
    candidate = ckpt_path.parent / 'config.json'
    if candidate.exists():
        return json.loads(candidate.read_text(encoding='utf8'))

    raise FileNotFoundError('No config found: provide --config or place config.json next to checkpoint')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ckpt', required=True, help='Path to model checkpoint (model.ckpt)')
    parser.add_argument('--config', required=False, help='Path to config json/yaml (optional)')
    parser.add_argument('--out', required=False, default='generator.onnx', help='Output ONNX path')
    parser.add_argument('--opset', type=int, default=16, help='ONNX opset version')
    parser.add_argument('--time-frames', type=int, default=64, help='Dummy input time frames for export')
    args = parser.parse_args()

    ckpt_path = Path(args.ckpt)
    out_path = Path(args.out)

    print('Loading config...')
    raw_cfg = load_config(ckpt_path, Path(args.config) if args.config else None)

    # The repository uses a training-style config with top-level keys
    # like 'audio_sample_rate' and nested 'model_args'. If user passed
    # a model-only config (common for checkpoints), wrap it into a
    # minimal task config with sensible defaults so nsf_HiFigan can be
    # constructed without the full training pipeline.
    if 'model_args' in raw_cfg or 'upsample_rates' in raw_cfg:
        model_args = raw_cfg if 'model_args' not in raw_cfg else raw_cfg['model_args']
        # prefer explicit names used by training task
        top_cfg = {
            'model_args': model_args,
            'audio_sample_rate': model_args.get('sampling_rate', model_args.get('sampling_rate', 44100)),
            'audio_num_mel_bins': model_args.get('num_mels', model_args.get('n_mels', 128)),
            'fft_size': model_args.get('n_fft', model_args.get('fft_size', 2048)),
            'win_size': model_args.get('win_size', model_args.get('win_length', 2048)),
            'hop_size': model_args.get('hop_size', 512),
            'fmin': model_args.get('fmin', 40),
            'fmax': model_args.get('fmax', 16000),
            # minimal training keys required by GanBaseTask
            'clip_grad_norm': None,
            'aux_step': None,
            'freezing_enabled': False,
            'finetune_enabled': False,
            'work_dir': '.',
            'frozen_params': [],
            'finetune_strict_shapes': False,
            # preserve pc_aug if present
            'pc_aug': model_args.get('pc_aug', False),
        }
        config = top_cfg
    else:
        config = raw_cfg

    # small diagnostic print
    print('Config prepared. audio_sample_rate=%s, n_mels=%s' % (config.get('audio_sample_rate'), config.get('audio_num_mel_bins')))

    print('Building nsf_HiFigan model...')
    model_task = nsf_HiFigan(config)
    model_task.build_model()

    print('Loading checkpoint...')
    checkpoint = torch.load(str(ckpt_path), map_location='cpu')
    state_dict = checkpoint.get('state_dict', checkpoint)
    if 'generator' in state_dict and isinstance(state_dict['generator'], dict) and len(state_dict) == 1:
        model_task.generator.load_state_dict(state_dict['generator'])
    else:
        # try load whole task state or nested generator
        try:
            model_task.load_state_dict(state_dict, strict=False)
        except Exception:
            # fallback: if checkpoint contains generator key
            if 'generator' in state_dict:
                model_task.generator.load_state_dict(state_dict['generator'], strict=False)
            else:
                raise

    generator = model_task.generator
    generator.eval()
    # avoid stochasticity during export
    try:
        generator.noise_sigma = 0.0
    except Exception:
        pass

    # optionally remove weight norm for stability
    try:
        generator.remove_weight_norm()
    except Exception:
        pass

    # prepare dummy inputs
    # n_mels: prefer top-level audio_num_mel_bins, else model_args.num_mels
    n_mels = None
    if isinstance(config, dict):
        n_mels = config.get('audio_num_mel_bins') or config.get('model_args', {}).get('num_mels')
    if n_mels is None:
        raise RuntimeError('Cannot determine n_mels from config')

    T = int(args.time_frames)
    mel = torch.randn(1, int(n_mels), T, dtype=torch.float32)
    f0 = torch.zeros(1, T, dtype=torch.float32)

    # export
    print(f'Exporting ONNX to {out_path} (opset={args.opset})...')
    torch.onnx.export(
        generator,
        (mel, f0),
        str(out_path),
        export_params=True,
        opset_version=args.opset,
        do_constant_folding=True,
        input_names=['mel', 'f0'],
        output_names=['audio'],
        dynamic_axes={
            'mel': {0: 'batch', 2: 'time'},
            'f0': {0: 'batch', 1: 'time'},
            'audio': {0: 'batch', 2: 'time'},
        },
    )

    print('ONNX export finished.')


if __name__ == '__main__':
    main()
