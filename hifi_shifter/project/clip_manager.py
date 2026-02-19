"""
音频块管理器

负责音频块的导入、删除、更新、特征提取等操作
"""

from __future__ import annotations
from typing import TYPE_CHECKING
import pathlib
import hashlib
import pickle
import numpy as np

if TYPE_CHECKING:
    from .models import Project, Clip
    from ..audio_processor import AudioProcessor


class ClipManager:
    """音频块管理器
    
    提供音频块相关的所有操作，包括：
    - 导入音频文件创建 Clip
    - 提取和缓存音频特征（mel, f0）
    - 更新 Clip 参数
    - 分割 Clip
    """
    
    def __init__(self, project: Project, audio_processor: AudioProcessor):
        self.project = project
        self.audio_processor = audio_processor
        self._cache_dir = pathlib.Path('.cache')  # 私有属性,避免 pywebview 序列化
        self._cache_dir.mkdir(exist_ok=True)
    
    def import_audio(
        self,
        file_path: str,
        track_id: str,
        start_time: float = 0.0,
    ) -> Clip | None:
        """导入音频文件创建 Clip
        
        Args:
            file_path: 音频文件路径
            track_id: 目标轨道ID
            start_time: 在轨道上的起始位置（秒）
            
        Returns:
            创建的 Clip 对象，失败返回 None
        """
        from .models import Clip
        from ..audio_processing.features import load_audio_mono_resample
        
        track = self.project.get_track_by_id(track_id)
        if not track:
            return None
        
        # 加载音频获取时长
        try:
            audio, sr = load_audio_mono_resample(file_path, self.project.sample_rate)
            duration = len(audio) / sr
        except Exception as e:
            print(f"加载音频文件失败: {e}")
            return None
        
        # 创建 Clip
        clip = Clip(
            id=Clip.generate_id(),
            track_id=track_id,
            audio_file=file_path,
            start_time=start_time,
            duration=duration,
        )
        
        # 添加到轨道
        track.add_clip(clip)
        
        # 异步提取特征（后台任务，不阻塞）
        try:
            self.extract_features(clip)
        except Exception as e:
            print(f"提取特征失败: {e}")
        
        return clip
    
    def delete_clip(self, clip_id: str) -> bool:
        """删除音频块
        
        Args:
            clip_id: Clip ID
            
        Returns:
            是否删除成功
        """
        clip = self.project.get_clip_by_id(clip_id)
        if not clip:
            return False
        
        track = self.project.get_track_by_id(clip.track_id)
        if not track:
            return False
        
        return track.remove_clip(clip_id)
    
    def update_clip(self, clip_id: str, **params) -> Clip | None:
        """更新 Clip 参数
        
        Args:
            clip_id: Clip ID
            **params: 要更新的参数
            
        Returns:
            更新后的 Clip 对象
        """
        clip = self.project.get_clip_by_id(clip_id)
        if not clip:
            return None
        
        # 允许更新的参数
        allowed_params = {
            'start_time', 'duration', 'offset', 'volume',
            'pitch_shift', 'fade_in', 'fade_out', 'playback_rate'
        }
        
        # 检测是否需要重新提取特征
        needs_reextract = False
        if any(key in params for key in ['pitch_shift', 'playback_rate']):
            needs_reextract = True
        
        # 更新参数
        for key, value in params.items():
            if key in allowed_params and hasattr(clip, key):
                setattr(clip, key, value)
        
        # 重新提取特征
        if needs_reextract:
            try:
                self.extract_features(clip)
            except Exception as e:
                print(f"重新提取特征失败: {e}")
        
        return clip
    
    def split_clip(self, clip_id: str, split_time: float) -> tuple[Clip, Clip] | None:
        """在指定时间点分割 Clip
        
        Args:
            clip_id: 要分割的 Clip ID
            split_time: 分割时间点（轨道时间，不是 Clip 内部时间）
            
        Returns:
            分割后的两个 Clip，失败返回 None
        """
        from .models import Clip
        
        clip = self.project.get_clip_by_id(clip_id)
        if not clip:
            return None
        
        track = self.project.get_track_by_id(clip.track_id)
        if not track:
            return None
        
        # 检查分割点是否在 Clip 内部
        if split_time <= clip.start_time or split_time >= clip.end_time:
            return None
        
        # 计算分割点在 Clip 内部的相对位置
        clip_offset = split_time - clip.start_time
        
        # 创建第二个 Clip
        clip2 = Clip(
            id=Clip.generate_id(),
            track_id=clip.track_id,
            audio_file=clip.audio_file,
            start_time=split_time,
            duration=clip.duration - clip_offset,
            offset=clip.offset + clip_offset,
            volume=clip.volume,
            pitch_shift=clip.pitch_shift,
            fade_in=0.0,  # 第二段不保留淡入
            fade_out=clip.fade_out,  # 继承淡出
            playback_rate=clip.playback_rate,
        )
        
        # 修改原 Clip
        clip.duration = clip_offset
        clip.fade_out = 0.0  # 第一段不保留淡出
        
        # 添加新 Clip 到轨道
        track.add_clip(clip2)
        
        # 提取特征
        try:
            self.extract_features(clip)
            self.extract_features(clip2)
        except Exception as e:
            print(f"提取特征失败: {e}")
        
        return (clip, clip2)
    
    def extract_features(self, clip: Clip) -> tuple[np.ndarray, np.ndarray]:
        """提取 Clip 的音频特征（mel, f0）
        
        会先尝试从缓存加载，如果缓存不存在则重新提取
        
        Args:
            clip: Clip 对象
            
        Returns:
            (mel, f0_midi) 元组
        """
        from ..audio_processing.features import load_audio_mono_resample, extract_mel_f0_segments
        
        # 生成缓存键（基于文件路径、偏移、时长、音高、速度）
        cache_key = self._get_cache_key(clip)
        cache_path = self._cache_dir / f"{cache_key}.pkl"
        
        # 尝试从缓存加载
        if cache_path.exists():
            try:
                with open(cache_path, 'rb') as f:
                    cached_data = pickle.load(f)
                clip.mel = cached_data['mel']
                clip.f0_midi = cached_data['f0_midi']
                print(f"从缓存加载特征: {clip.id}")
                return clip.mel, clip.f0_midi
            except Exception as e:
                print(f"缓存加载失败，重新提取: {e}")
        
        # 加载音频
        audio, sr = load_audio_mono_resample(clip.audio_file, self.project.sample_rate)
        
        # 计算音频片段（考虑 offset 和 duration）
        start_sample = int(clip.offset * sr)
        end_sample = int((clip.offset + clip.duration) * sr)
        audio_segment = audio[start_sample:end_sample]
        
        # 提取 mel 和 f0（使用 AudioProcessor 的 mel_transform 和 config）
        if not self.audio_processor.mel_transform:
            raise RuntimeError("AudioProcessor 未加载模型，无法提取特征")
        
        mel, f0_midi, _ = extract_mel_f0_segments(
            audio_segment,
            config=self.audio_processor.config,
            mel_transform=self.audio_processor.mel_transform,
            key_shift=clip.pitch_shift,
        )
        
        # 保存到 Clip
        clip.mel = mel
        clip.f0_midi = f0_midi
        
        # 如果没有编辑过的 f0，使用原始 f0
        if clip.edited_f0_midi is None:
            clip.edited_f0_midi = f0_midi.copy()
        
        # 缓存到文件
        try:
            cache_data = {
                'mel': mel,
                'f0_midi': f0_midi,
            }
            with open(cache_path, 'wb') as f:
                pickle.dump(cache_data, f)
            print(f"特征已缓存: {clip.id}")
        except Exception as e:
            print(f"缓存保存失败: {e}")
        
        return mel, f0_midi
    
    def update_clip_f0(self, clip_id: str, f0_midi: np.ndarray) -> Clip | None:
        """更新 Clip 的编辑后 f0
        
        Args:
            clip_id: Clip ID
            f0_midi: 编辑后的 f0 数据（MIDI 音高）
            
        Returns:
            更新后的 Clip 对象
        """
        clip = self.project.get_clip_by_id(clip_id)
        if not clip:
            return None
        
        clip.edited_f0_midi = np.array(f0_midi, dtype=np.float32)
        return clip
    
    def get_clip_features(self, clip_id: str) -> dict | None:
        """获取 Clip 的特征数据（用于前端展示）
        
        Args:
            clip_id: Clip ID
            
        Returns:
            包含 mel 和 f0 的字典
        """
        clip = self.project.get_clip_by_id(clip_id)
        if not clip:
            return None
        
        # 如果特征未提取，先提取
        if clip.mel is None or clip.f0_midi is None:
            try:
                self.extract_features(clip)
            except Exception as e:
                print(f"提取特征失败: {e}")
                return None
        
        return {
            'mel': clip.mel.tolist() if clip.mel is not None else None,
            'f0_midi': clip.f0_midi.tolist() if clip.f0_midi is not None else None,
            'edited_f0_midi': clip.edited_f0_midi.tolist() if clip.edited_f0_midi is not None else None,
        }
    
    def _get_cache_key(self, clip: Clip) -> str:
        """生成缓存键
        
        基于文件路径、偏移、时长、音高偏移、播放速度生成唯一哈希
        """
        key_str = f"{clip.audio_file}_{clip.offset}_{clip.duration}_{clip.pitch_shift}_{clip.playback_rate}"
        return hashlib.md5(key_str.encode()).hexdigest()
