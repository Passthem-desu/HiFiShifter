# 安装: pip install onnxruntime soundfile numpy
import onnxruntime as ort
import numpy as np
import soundfile as sf
from pathlib import Path

_repo_root = Path(__file__).resolve().parents[1]
_candidates = [
    _repo_root / "pc_nsf_hifigan_44.1k_hop512_128bin_2025.02" / "pc_nsf_hifigan.onnx",
    Path(__file__).resolve().parent / "pc_nsf_hifigan.onnx",
]
onnx_path = None
for _p in _candidates:
    if _p.exists():
        onnx_path = str(_p)
        break
if onnx_path is None:
    raise FileNotFoundError("未找到 pc_nsf_hifigan.onnx")
n_mels = 128           # 来自 config.json
hop_size = 512         # 来自 config.json
sr = 44100             # 来自 config.json

T = 64                 # 导出时用的 time-frames，或任意帧数
mel = np.random.randn(1, n_mels, T).astype(np.float32)
f0 = np.zeros((1, T), dtype=np.float32)  # 或填真实 f0(Hz)

sess = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
out = sess.run(None, {'mel': mel, 'f0': f0})[0]  # 返回 list，取第0个输出
# out 形状可能是 (1,1,L)
audio = out[0]
if audio.ndim == 2 and audio.shape[0] == 1:
    audio = audio.squeeze(0)
# ONNX 输出应在 [-1,1]，直接保存为 wav
sf.write('pc_nsf_hifigan_out.wav', audio, sr)
print('Saved pc_nsf_hifigan_out.wav, samples=', audio.shape[-1])