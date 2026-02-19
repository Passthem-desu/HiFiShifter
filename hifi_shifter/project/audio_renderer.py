"""
音频渲染器

负责渲染音频块、轨道混音、多轨道合成等操作
"""

from __future__ import annotations
from typing import TYPE_CHECKING
import numpy as np
import scipy.signal as signal

if TYPE_CHECKING:
    from .models import Project, Track, Clip
    from ..audio_processor import AudioProcessor


class AudioRenderer:
    """音频渲染器
    
    提供音频渲染功能，包括：
    - 单个 Clip 渲染（应用特效）
    - 单轨道混音 - 多轨道总混音- 淡入淡出处理
    - 音量和声像处理
    """
    
    def __init__(self, project: Project, audio_processor: AudioProcessor):
        self.project = project
        self.audio_processor = audio_processor
        self.sample_rate = project.sample_rate
    
    def render_clip(
        self,
        clip: Clip,
        apply_fades: bool = True,
        apply_volume: bool = True,
    ) -> np.ndarray:
        """渲染单个 Clip
        
        使用 AudioProcessor 进行合成，应用音高编辑和特效
        
        Args:
            clip: Clip 对象
            apply_fades: 是否应用淡入淡出
            apply_volume: 是否应用音量
            
        Returns:
            渲染后的音频数据
        """
        from ..audio_processing.hifigan_infer import synthesize_full
        
        # 确保特征已提取
        if clip.mel is None or clip.edited_f0_midi is None:
            raise RuntimeError(f"Clip {clip.id} 的特征未提取")
        
        # 使用编辑后的 f0 进行合成
        synthesized = synthesize_full(
            model=self.audio_processor.model,
            mel=clip.mel,
            f0_midi=clip.edited_f0_midi,
            device=self.audio_processor.device,
        )
        
        # 应用淡入淡出
        if apply_fades and (clip.fade_in > 0 or clip.fade_out > 0):
            synthesized = self._apply_fades(
                synthesized,
                clip.fade_in,
                clip.fade_out,
                self.sample_rate,
            )
        
        # 应用音量
        if apply_volume:
            synthesized = synthesized * clip.volume
        
        return synthesized
    
    def render_track(
        self,
        track: Track,
        start_time: float,
        duration: float,
    ) -> np.ndarray:
        """渲染单个轨道（混合该轨道上的所有 Clips）
        
        Args:
            track: 轨道对象
            start_time: 起始时间（秒）
            duration: 持续时间（秒）
            
        Returns:
            混合后的音频
        """
        # 初始化输出缓冲区
        total_samples = int(duration * self.sample_rate)
        output = np.zeros(total_samples, dtype=np.float32)
        
        # 找出在时间范围内的 Clips
        end_time = start_time + duration
        active_clips = [
            clip for clip in track.clips
            if clip.end_time > start_time and clip.start_time < end_time
        ]
        
        # 渲染每个 Clip 并混合
        for clip in active_clips:
            try:
                # 渲染 Clip
                clip_audio = self.render_clip(clip)
                
                # 计算插入位置
                clip_start_in_buffer = int((clip.start_time - start_time) * self.sample_rate)
                clip_end_in_buffer = clip_start_in_buffer + len(clip_audio)
                
                # 裁剪到有效范围
                buffer_start = max(0, clip_start_in_buffer)
                buffer_end = min(total_samples, clip_end_in_buffer)
                
                audio_start = buffer_start - clip_start_in_buffer
                audio_end = audio_start + (buffer_end - buffer_start)
                
                if buffer_end > buffer_start:
                    # 混合到输出缓冲区
                    output[buffer_start:buffer_end] += clip_audio[audio_start:audio_end]
            
            except Exception as e:
                print(f"渲染 Clip {clip.id} 失败: {e}")
                continue
        
        # 应用轨道音量和声像
        output = self._apply_track_effects(output, track)
        
        return output
    
    def render_mix(
        self,
        start_time: float,
        duration: float,
        tracks: list[Track] | None = None,
    ) -> np.ndarray:
        """渲染多轨道混音（总混音）
        
        考虑轨道的 solo、mute 状态
        
        Args:
            start_time: 起始时间（秒）
            duration: 持续时间（秒）
            tracks: 要渲染的轨道列表，None 表示所有轨道
            
        Returns:
            混合后的音频
        """
        if tracks is None:
            tracks = self.project.tracks
        
        # 初始化输出缓冲区
        total_samples = int(duration * self.sample_rate)
        output = np.zeros(total_samples, dtype=np.float32)
        
        # 判断 solo 模式
        has_solo = any(t.solo for t in tracks)
        
        # 渲染每个轨道
        for track in tracks:
            # 检查是否应该播放
            should_play = track.solo if has_solo else not track.muted
            
            if not should_play:
                continue
            
            try:
                track_audio = self.render_track(track, start_time, duration)
                output += track_audio
            except Exception as e:
                print(f"渲染轨道 {track.name} 失败: {e}")
                continue
        
        # 防止爆音（软限幅）
        output = self._soft_clip(output)
        
        return output
    
    def export_to_file(
        self,
        file_path: str,
        start_time: float = 0.0,
        end_time: float | None = None,
    ) -> bool:
        """导出音频到文件
        
        Args:
            file_path: 输出文件路径
            start_time: 起始时间（秒）
            end_time: 结束时间（秒），None 表示工程结尾
            
        Returns:
            是否导出成功
        """
        import soundfile as sf
        
        if end_time is None:
            end_time = self.project.get_duration()
        
        duration = end_time - start_time
        
        if duration <= 0:
            print("导出时长无效")
            return False
        
        try:
            # 渲染混音
            audio = self.render_mix(start_time, duration)
            
            # 写入文件
            sf.write(file_path, audio, self.sample_rate)
            print(f"音频已导出到: {file_path}")
            return True
        
        except Exception as e:
            print(f"导出失败: {e}")
            return False
    
    def _apply_fades(
        self,
        audio: np.ndarray,
        fade_in: float,
        fade_out: float,
        sample_rate: int,
    ) -> np.ndarray:
        """应用淡入淡出
        
        Args:
            audio: 音频数据
            fade_in: 淡入时长（秒）
            fade_out: 淡出时长（秒）
            sample_rate: 采样率
            
        Returns:
            应用淡入淡出后的音频
        """
        audio = audio.copy()
        total_samples = len(audio)
        
        # 淡入
        if fade_in > 0:
            fade_in_samples = int(fade_in * sample_rate)
            fade_in_samples = min(fade_in_samples, total_samples // 2)
            
            if fade_in_samples > 0:
                fade_in_curve = np.linspace(0, 1, fade_in_samples) ** 2  # 平方曲线（更平滑）
                audio[:fade_in_samples] *= fade_in_curve
        
        # 淡出
        if fade_out > 0:
            fade_out_samples = int(fade_out * sample_rate)
            fade_out_samples = min(fade_out_samples, total_samples // 2)
            
            if fade_out_samples > 0:
                fade_out_curve = np.linspace(1, 0, fade_out_samples) ** 2
                audio[-fade_out_samples:] *= fade_out_curve
        
        return audio
    
    def _apply_track_effects(self, audio: np.ndarray, track: Track) -> np.ndarray:
        """应用轨道级别的效果（音量、声像）
        
        Args:
            audio: 音频数据（单声道）
            track: 轨道对象
            
        Returns:
            处理后的音频
        """
        # 应用音量
        audio = audio * track.volume
        
        # 声像处理（如果需要立体声，这里可以扩展）
        # 目前保持单声道
        # TODO: 实现立体声声像
        
        return audio
    
    def _soft_clip(self, audio: np.ndarray, threshold: float = 0.95) -> np.ndarray:
        """软限幅，防止爆音
        
        Args:
            audio: 音频数据
            threshold: 阈值（0-1）
            
        Returns:
            限幅后的音频
        """
        # 使用 tanh 进行软限幅
        max_val = np.abs(audio).max()
        
        if max_val > threshold:
            scale = threshold / max_val
            audio = np.tanh(audio / threshold) * threshold
        
        return audio
