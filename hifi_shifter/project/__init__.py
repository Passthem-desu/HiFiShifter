"""
HiFiShifter Project Module

多轨道音频工程管理模块，包括：
- 数据模型（Project, Track, Clip）
- 工程管理器（ProjectManager）
- 轨道管理器（TrackManager）
- 音频块管理器（ClipManager）
- 音频渲染器（AudioRenderer）
"""

from .models import Project, Track, Clip
from .project_manager import ProjectManager

__all__ = ['Project', 'Track', 'Clip', 'ProjectManager']
