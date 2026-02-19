"""
工程管理器

统一管理工程的生命周期和各个子管理器
"""

from __future__ import annotations
from typing import TYPE_CHECKING
import json
import pathlib

from .models import Project, Track, Clip
from .track_manager import TrackManager
from .clip_manager import ClipManager
from .audio_renderer import AudioRenderer

if TYPE_CHECKING:
    from ..audio_processor import AudioProcessor


class ProjectManager:
    """工程管理器
    
    统一入口，管理：
    - 工程的创建、加载、保存
    - 各个子管理器（TrackManager, ClipManager, AudioRenderer）
    - 工程状态的序列化和反序列化
    """
    
    def __init__(self, audio_processor: AudioProcessor):
        self.audio_processor = audio_processor
        self.project: Project | None = None
        
        # 子管理器（在创建工程后初始化）
        self.track_manager: TrackManager | None = None
        self.clip_manager: ClipManager | None = None
        self.audio_renderer: AudioRenderer | None = None
    
    def create_project(self, name: str = "Untitled Project") -> Project:
        """创建新工程
        
        Args:
            name: 工程名称
            
        Returns:
            创建的工程对象
        """
        self.project = Project(
            name=name,
            sample_rate=self.audio_processor.config.get('audio_sample_rate', 44100),
        )
        
        # 初始化子管理器
        self._init_managers()
        
        # 创建一个默认轨道
        if self.track_manager:
            self.track_manager.add_track("Track 1")
        
        return self.project
    
    def load_project(self, file_path: str) -> Project:
        """从文件加载工程
        
        Args:
            file_path: 工程文件路径（.json）
            
        Returns:
            加载的工程对象
        """
        path = pathlib.Path(file_path)
        
        if not path.exists():
            raise FileNotFoundError(f"工程文件不存在: {file_path}")
        
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # 反序列化工程
        self.project = self._deserialize_project(data)
        
        # 初始化子管理器
        self._init_managers()
        
        return self.project
    
    def save_project(self, file_path: str) -> bool:
        """保存工程到文件
        
        Args:
            file_path: 保存路径（.json）
            
        Returns:
            是否保存成功
        """
        if not self.project:
            return False
        
        path = pathlib.Path(file_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        
        try:
            # 序列化工程
            data = self._serialize_project(self.project)
            
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            
            print(f"工程已保存到: {file_path}")
            return True
        
        except Exception as e:
            print(f"保存工程失败: {e}")
            return False
    
    def get_state(self) -> dict:
        """获取工程的完整状态（用于前端）
        
        Returns:
            工程状态字典
        """
        if not self.project:
            return {
                'error': 'No project loaded',
            }
        
        return self.project.to_dict()
    
    def _init_managers(self) -> None:
        """初始化子管理器"""
        if not self.project:
            return
        
        self.track_manager = TrackManager(self.project)
        self.clip_manager = ClipManager(self.project, self.audio_processor)
        self.audio_renderer = AudioRenderer(self.project, self.audio_processor)
    
    def _serialize_project(self, project: Project) -> dict:
        """序列化工程为 JSON 数据
        
        Args:
            project: 工程对象
            
        Returns:
            可序列化的字典
        """
        data = {
            'version': '1.0',
            'name': project.name,
            'sample_rate': project.sample_rate,
            'cursor_position': project.cursor_position,
            'selected_track_id': project.selected_track_id,
            'tracks': [],
        }
        
        # 序列化轨道
        for track in project.tracks:
            track_data = {
                'id': track.id,
                'name': track.name,
                'parent_id': track.parent_id,
                'order': track.order,
                'volume': track.volume,
                'pan': track.pan,
                'muted': track.muted,
                'solo': track.solo,
                'color': track.color,
                'clips': [],
            }
            
            # 序列化 Clips
            for clip in track.clips:
                clip_data = {
                    'id': clip.id,
                    'audio_file': clip.audio_file,
                    'start_time': clip.start_time,
                    'duration': clip.duration,
                    'offset': clip.offset,
                    'volume': clip.volume,
                    'pitch_shift': clip.pitch_shift,
                    'fade_in': clip.fade_in,
                    'fade_out': clip.fade_out,
                    'playback_rate': clip.playback_rate,
                }
                
                # 保存编辑后的 f0（如果存在）
                if clip.edited_f0_midi is not None:
                    clip_data['edited_f0_midi'] = clip.edited_f0_midi.tolist()
                
                track_data['clips'].append(clip_data)
            
            data['tracks'].append(track_data)
        
        return data
    
    def _deserialize_project(self, data: dict) -> Project:
        """反序列化工程数据
        
        Args:
            data: JSON 数据字典
            
        Returns:
            工程对象
        """
        import numpy as np
        
        project = Project(
            name=data.get('name', 'Untitled Project'),
            sample_rate=data.get('sample_rate', 44100),
            cursor_position=data.get('cursor_position', 0.0),
            selected_track_id=data.get('selected_track_id'),
        )
        
        # 反序列化轨道
        for track_data in data.get('tracks', []):
            track = Track(
                id=track_data['id'],
                name=track_data['name'],
                parent_id=track_data.get('parent_id'),
                order=track_data.get('order', 0),
                volume=track_data.get('volume', 1.0),
                pan=track_data.get('pan', 0.0),
                muted=track_data.get('muted', False),
                solo=track_data.get('solo', False),
                color=track_data.get('color', '#4a90e2'),
            )
            
            # 反序列化 Clips
            for clip_data in track_data.get('clips', []):
                clip = Clip(
                    id=clip_data['id'],
                    track_id=track.id,
                    audio_file=clip_data['audio_file'],
                    start_time=clip_data['start_time'],
                    duration=clip_data['duration'],
                    offset=clip_data.get('offset', 0.0),
                    volume=clip_data.get('volume', 1.0),
                    pitch_shift=clip_data.get('pitch_shift', 0.0),
                    fade_in=clip_data.get('fade_in', 0.0),
                    fade_out=clip_data.get('fade_out', 0.0),
                    playback_rate=clip_data.get('playback_rate', 1.0),
                )
                
                # 恢复编辑后的 f0
                if 'edited_f0_midi' in clip_data:
                    clip.edited_f0_midi = np.array(clip_data['edited_f0_midi'], dtype=np.float32)
                
                track.clips.append(clip)
            
            project.tracks.append(track)
        
        return project
