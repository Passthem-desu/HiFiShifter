"""
数据模型定义

包含工程、轨道、音频块的数据类定义
"""

from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any
import uuid
import numpy as np


@dataclass
class Clip:
    """音频块（Item）
    
    代表轨道上的一个音频片段，包含源文件引用、位置、特效参数等
    """
    id: str
    track_id: str
    audio_file: str  # 源音频文件路径
    start_time: float  # 在轨道上的起始位置（秒）
    duration: float  # 持续时间（秒）
    offset: float = 0.0  # 音频文件内的偏移（秒）
    volume: float = 1.0  # 音量倍数 (0-2)
    pitch_shift: float = 0.0  # 音高偏移（半音）
    fade_in: float = 0.0  # 淡入时长（秒）
    fade_out: float = 0.0  # 淡出时长（秒）
    playback_rate: float = 1.0  # 播放速度 (0.5-2.0)
    
    # 缓存的音频特征（不序列化到文件）
    mel: np.ndarray | None = field(default=None, repr=False)
    f0_midi: np.ndarray | None = field(default=None, repr=False)
    edited_f0_midi: np.ndarray | None = field(default=None, repr=False)
    
    @staticmethod
    def generate_id() -> str:
        """生成唯一ID"""
        return f"clip-{uuid.uuid4().hex[:8]}"
    
    def to_dict(self, include_cache: bool = False) -> dict[str, Any]:
        """转换为字典，用于序列化"""
        data = {
            'id': self.id,
            'track_id': self.track_id,
            'audio_file': self.audio_file,
            'start_time': self.start_time,
            'duration': self.duration,
            'offset': self.offset,
            'volume': self.volume,
            'pitch_shift': self.pitch_shift,
            'fade_in': self.fade_in,
            'fade_out': self.fade_out,
            'playback_rate': self.playback_rate,
        }
        
        if include_cache:
            if self.edited_f0_midi is not None:
                data['edited_f0_midi'] = self.edited_f0_midi.tolist()
        
        return data
    
    @property
    def end_time(self) -> float:
        """计算结束时间"""
        return self.start_time + self.duration
    
    def overlaps(self, other: Clip) -> bool:
        """检查是否与另一个 Clip 重叠"""
        return not (self.end_time <= other.start_time or self.start_time >= other.end_time)


@dataclass  
class Track:
    """轨道
    
    支持嵌套的轨道系统，每个轨道可以包含多个音频块
    """
    id: str
    name: str
    parent_id: str | None = None  # 父轨道ID，None表示顶层轨道
    order: int = 0  # 同层级内的排序序号
    volume: float = 1.0  # 音量 (0-2)
    pan: float = 0.0  # 声像 (-1左 到 1右)
    muted: bool = False  # 静音
    solo: bool = False  # 独奏
    color: str = "#4a90e2"  # 轨道颜色
    clips: list[Clip] = field(default_factory=list)
    
    @staticmethod
    def generate_id() -> str:
        """生成唯一ID"""
        return f"track-{uuid.uuid4().hex[:8]}"
    
    def to_dict(self, include_clips: bool = True) -> dict[str, Any]:
        """转换为字典，用于序列化"""
        data = {
            'id': self.id,
            'name': self.name,
            'parent_id': self.parent_id,
            'order': self.order,
            'volume': self.volume,
            'pan': self.pan,
            'muted': self.muted,
            'solo': self.solo,
            'color': self.color,
        }
        
        if include_clips:
            data['clips'] = [clip.to_dict() for clip in self.clips]
        
        return data
    
    def get_clip_by_id(self, clip_id: str) -> Clip | None:
        """根据ID查找音频块"""
        for clip in self.clips:
            if clip.id == clip_id:
                return clip
        return None
    
    def add_clip(self, clip: Clip) -> None:
        """添加音频块"""
        clip.track_id = self.id
        self.clips.append(clip)
        # 按起始时间排序
        self.clips.sort(key=lambda c: c.start_time)
    
    def remove_clip(self, clip_id: str) -> bool:
        """删除音频块"""
        for i, clip in enumerate(self.clips):
            if clip.id == clip_id:
                self.clips.pop(i)
                return True
        return False
    
    def get_duration(self) -> float:
        """计算轨道的有效时长（最后一个 Clip 的结束时间）"""
        if not self.clips:
            return 0.0
        return max(clip.end_time for clip in self.clips)


@dataclass
class Project:
    """工程
    
    顶层数据结构，包含所有轨道和全局设置
    """
    name: str = "Untitled Project"
    sample_rate: int = 44100
    cursor_position: float = 0.0  # 光标位置（秒）
    selected_track_id: str | None = None  # 当前选中的轨道
    tracks: list[Track] = field(default_factory=list)
    
    def to_dict(self) -> dict[str, Any]:
        """转换为字典，用于序列化和前端传输"""
        return {
            'name': self.name,
            'sample_rate': self.sample_rate,
            'duration': self.get_duration(),
            'cursor_position': self.cursor_position,
            'selected_track_id': self.selected_track_id,
            'tracks': [track.to_dict() for track in self.tracks],
        }
    
    def get_duration(self) -> float:
        """计算工程总时长（所有轨道的最大时长）"""
        if not self.tracks:
            return 0.0
        return max((track.get_duration() for track in self.tracks), default=0.0)
    
    def get_track_by_id(self, track_id: str) -> Track | None:
        """根据ID查找轨道"""
        for track in self.tracks:
            if track.id == track_id:
                return track
        return None
    
    def get_clip_by_id(self, clip_id: str) -> Clip | None:
        """根据ID查找音频块（遍历所有轨道）"""
        for track in self.tracks:
            clip = track.get_clip_by_id(clip_id)
            if clip:
                return clip
        return None
    
    def add_track(self, track: Track) -> None:
        """添加轨道"""
        self.tracks.append(track)
        # 按 order 排序
        self._sort_tracks()
    
    def remove_track(self, track_id: str) -> bool:
        """删除轨道"""
        for i, track in enumerate(self.tracks):
            if track.id == track_id:
                self.tracks.pop(i)
                return True
        return False
    
    def _sort_tracks(self) -> None:
        """对轨道进行排序（先按父子关系，再按 order）"""
        # 简单排序：先顶层轨道，再子轨道
        self.tracks.sort(key=lambda t: (t.parent_id or '', t.order))
    
    def get_child_tracks(self, parent_id: str) -> list[Track]:
        """获取指定轨道的所有子轨道"""
        return [t for t in self.tracks if t.parent_id == parent_id]
    
    def get_top_level_tracks(self) -> list[Track]:
        """获取所有顶层轨道（没有父轨道）"""
        return [t for t in self.tracks if t.parent_id is None]
