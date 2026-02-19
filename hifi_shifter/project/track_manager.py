"""
轨道管理器

负责轨道的增删改查、排序、层级管理等操作
"""

from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import Project, Track


class TrackManager:
    """轨道管理器
    
    提供轨道相关的所有操作，包括：
    - CRUD 操作
    - 层级管理（父子关系）
    - 排序和拖拽
    - Solo/Mute 逻辑
    """
    
    def __init__(self, project: Project):
        self.project = project
    
    def add_track(self, name: str, parent_id: str | None = None) -> Track:
        """添加新轨道
        
        Args:
            name: 轨道名称
            parent_id: 父轨道ID，None表示顶层轨道
            
        Returns:
            创建的轨道对象
        """
        from .models import Track
        
        # 计算新轨道的 order（在同层级的最后）
        siblings = self._get_siblings(parent_id)
        max_order = max((t.order for t in siblings), default=-1)
        
        track = Track(
            id=Track.generate_id(),
            name=name,
            parent_id=parent_id,
            order=max_order + 1,
        )
        
        self.project.add_track(track)
        return track
    
    def delete_track(self, track_id: str) -> bool:
        """删除轨道
        
        注意：如果轨道有子轨道，会将子轨道提升为顶层轨道
        
        Args:
            track_id: 轨道ID
            
        Returns:
            是否删除成功
        """
        track = self.project.get_track_by_id(track_id)
        if not track:
            return False
        
        # 将子轨道提升为顶层或移到被删除轨道的父级
        children = self.project.get_child_tracks(track_id)
        for child in children:
            child.parent_id = track.parent_id
        
        # 删除轨道
        result = self.project.remove_track(track_id)
        
        # 重新整理 order
        self._reorder_siblings(track.parent_id)
        
        return result
    
    def update_track(self, track_id: str, **params) -> Track | None:
        """更新轨道属性
        
        Args:
            track_id: 轨道ID
            **params: 要更新的属性（name, volume, pan, muted, solo, color）
            
        Returns:
            更新后的轨道对象
        """
        track = self.project.get_track_by_id(track_id)
        if not track:
            return None
        
        # 更新允许的属性
        allowed_params = {'name', 'volume', 'pan', 'muted', 'solo', 'color'}
        for key, value in params.items():
            if key in allowed_params and hasattr(track, key):
                setattr(track, key, value)
        
        return track
    
    def move_track(self, track_id: str, new_order: int, new_parent_id: str | None = None) -> bool:
        """移动轨道（拖拽）
        
        Args:
            track_id: 要移动的轨道ID
            new_order: 新的排序位置
            new_parent_id: 新的父轨道ID（None表示移为顶层）
            
        Returns:
            是否移动成功
        """
        track = self.project.get_track_by_id(track_id)
        if not track:
            return False
        
        # 防止循环嵌套（不能移动到自己的子轨道下）
        if new_parent_id and self._is_descendant(new_parent_id, track_id):
            return False
        
        old_parent_id = track.parent_id
        
        # 更新父级和 order
        track.parent_id = new_parent_id
        track.order = new_order
        
        # 重新整理原层级和新层级的 order
        self._reorder_siblings(old_parent_id)
        self._reorder_siblings(new_parent_id)
        
        # 重新排序整个轨道列表
        self.project._sort_tracks()
        
        return True
    
    def get_track_tree(self) -> list[dict]:
        """获取轨道树形结构
        
        返回嵌套的树形数据，用于前端渲染
        
        Returns:
            树形结构的轨道列表
        """
        def build_tree(parent_id: str | None) -> list[dict]:
            tracks = [t for t in self.project.tracks if t.parent_id == parent_id]
            tracks.sort(key=lambda t: t.order)
            
            result = []
            for track in tracks:
                track_dict = track.to_dict(include_clips=False)
                track_dict['children'] = build_tree(track.id)
                result.append(track_dict)
            
            return result
        
        return build_tree(None)
    
    def should_play_track(self, track: Track) -> bool:
        """判断轨道是否应该播放（考虑 solo 和 mute）
        
        规则：
        1. 如果有任何轨道处于 solo 状态，则只播放 solo 的轨道
        2. 否则播放所有未静音的轨道
        
        Args:
            track: 轨道对象
            
        Returns:
            是否应该播放
        """
        # 检查是否有 solo 轨道
        has_solo = any(t.solo for t in self.project.tracks)
        
        if has_solo:
            return track.solo
        else:
            return not track.muted
    
    def get_all_descendants(self, track_id: str) -> list[Track]:
        """获取轨道的所有后代（子轨道、孙轨道等）
        
        Args:
            track_id: 轨道ID
            
        Returns:
            所有后代轨道列表
        """
        descendants = []
        children = self.project.get_child_tracks(track_id)
        
        for child in children:
            descendants.append(child)
            descendants.extend(self.get_all_descendants(child.id))
        
        return descendants
    
    def _get_siblings(self, parent_id: str | None) -> list[Track]:
        """获取同层级的轨道"""
        return [t for t in self.project.tracks if t.parent_id == parent_id]
    
    def _reorder_siblings(self, parent_id: str | None) -> None:
        """重新整理同层级轨道的 order 序号（0, 1, 2, ...）"""
        siblings = self._get_siblings(parent_id)
        siblings.sort(key=lambda t: t.order)
        
        for i, track in enumerate(siblings):
            track.order = i
    
    def _is_descendant(self, potential_descendant_id: str, ancestor_id: str) -> bool:
        """检查一个轨道是否是另一个轨道的后代
        
        用于防止循环嵌套
        """
        current = self.project.get_track_by_id(potential_descendant_id)
        
        while current:
            if current.parent_id == ancestor_id:
                return True
            current = self.project.get_track_by_id(current.parent_id) if current.parent_id else None
        
        return False
