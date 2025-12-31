from __future__ import annotations

import numpy as np
import pyqtgraph as pg
from PyQt6.QtCore import Qt, QRectF
from PyQt6.QtGui import QBrush, QColor
from PyQt6.QtWidgets import QMainWindow

from .. import theme
from utils.i18n import i18n


class EditorMixin:
    def toggle_mode(self):
        current = self.mode_combo.currentIndex()
        # 0: Edit, 1: Select
        new_index = 1 if current == 0 else 0
        self.mode_combo.setCurrentIndex(new_index)

    def keyPressEvent(self, ev):
        if ev.key() == Qt.Key.Key_Space:
            self.toggle_playback()
        elif ev.modifiers() & Qt.KeyboardModifier.ControlModifier:
            if ev.key() == Qt.Key.Key_Z:
                if ev.modifiers() & Qt.KeyboardModifier.ShiftModifier:
                    self.redo()
                else:
                    self.undo()
            elif ev.key() == Qt.Key.Key_Y:
                self.redo()
        else:
            QMainWindow.keyPressEvent(self, ev)

    def push_undo(self):
        track = self.current_track
        if not track or track.track_type != 'vocal':
            return

        if getattr(self, 'edit_param', 'pitch') == 'tension':
            if getattr(track, 'tension_edited', None) is None:
                return
            track.tension_undo_stack.append(track.tension_edited.copy())
            if len(track.tension_undo_stack) > 16:
                track.tension_undo_stack.pop(0)
            track.tension_redo_stack.clear()
        else:
            if track.f0_edited is None:
                return
            track.undo_stack.append(track.f0_edited.copy())
            if len(track.undo_stack) > 16:
                track.undo_stack.pop(0)
            track.redo_stack.clear()

    def undo(self):
        track = self.current_track
        if not track or track.track_type != 'vocal':
            return

        if getattr(self, 'edit_param', 'pitch') == 'tension':
            if getattr(track, 'tension_edited', None) is None:
                return
            if not track.tension_undo_stack:
                self.status_label.setText(i18n.get("status.no_undo"))
                return

            track.tension_redo_stack.append(track.tension_edited.copy())
            track.tension_edited = track.tension_undo_stack.pop()
            track.tension_version += 1
            track._tension_processed_audio = None
            track._tension_processed_key = None

            self.update_plot()
            self.status_label.setText(i18n.get("status.undo"))
            return

        # Pitch undo
        if track.f0_edited is None:
            return
        if not track.undo_stack:
            self.status_label.setText(i18n.get("status.no_undo"))
            return

        track.redo_stack.append(track.f0_edited.copy())
        track.f0_edited = track.undo_stack.pop()

        for state in track.segment_states:
            state['dirty'] = True

        self.update_plot()
        self.status_label.setText(i18n.get("status.undo"))

    def redo(self):
        track = self.current_track
        if not track or track.track_type != 'vocal':
            return

        if getattr(self, 'edit_param', 'pitch') == 'tension':
            if getattr(track, 'tension_edited', None) is None:
                return
            if not track.tension_redo_stack:
                self.status_label.setText(i18n.get("status.no_redo"))
                return

            track.tension_undo_stack.append(track.tension_edited.copy())
            track.tension_edited = track.tension_redo_stack.pop()
            track.tension_version += 1
            track._tension_processed_audio = None
            track._tension_processed_key = None

            self.update_plot()
            self.status_label.setText(i18n.get("status.redo"))
            return

        # Pitch redo
        if track.f0_edited is None:
            return
        if not track.redo_stack:
            self.status_label.setText(i18n.get("status.no_redo"))
            return

        track.undo_stack.append(track.f0_edited.copy())
        track.f0_edited = track.redo_stack.pop()

        for state in track.segment_states:
            state['dirty'] = True

        self.update_plot()
        self.status_label.setText(i18n.get("status.redo"))

    # ---- Selection abstraction / highlight (works for all params) ----
    def clear_selection(self, *, hide_box: bool = True):
        """Clear selection state and remove highlight overlay."""
        self.selection_mask = None
        self.selection_param = None
        self.is_selecting = False
        self.is_dragging_selection = False
        self.drag_param = None
        self.drag_start_values = None
        if hide_box and hasattr(self, 'selection_box_item'):
            self.selection_box_item.setVisible(False)
        if hasattr(self, 'selected_param_curve_item'):
            self.selected_param_curve_item.clear()

    def set_selection(self, mask: np.ndarray | None, *, param: str | None = None):
        """Set selection mask for a given param and refresh highlight."""
        self.selection_mask = mask
        self.selection_param = (param or getattr(self, 'edit_param', 'pitch')) if mask is not None else None
        self.update_selection_highlight()

    def update_selection_highlight(self):
        """Render the selected portion of the selected param as an overlay curve."""
        if not hasattr(self, 'selected_param_curve_item'):
            return

        track = getattr(self, 'current_track', None)
        if not track or track.track_type != 'vocal':
            self.selected_param_curve_item.clear()
            return

        if self.selection_mask is None or self.selection_param is None:
            self.selected_param_curve_item.clear()
            return

        curve_y = self.get_param_curve_y(track, self.selection_param)
        if curve_y is None:
            self.selected_param_curve_item.clear()
            return

        if len(self.selection_mask) != len(curve_y):
            self.selected_param_curve_item.clear()
            return

        x = np.arange(len(curve_y)) + track.start_frame
        y = np.array(curve_y, copy=True)
        y[~self.selection_mask] = np.nan
        self.selected_param_curve_item.setData(x, y, connect="finite")

        # Theme-aware pen
        current_theme = theme.get_current_theme()
        sel_color = current_theme['graph'].get('f0_selected_pen', '#0099ff')
        c_sel = pg.mkColor(sel_color)
        c_sel.setAlpha(240)
        self.selected_param_curve_item.setPen(pg.mkPen(color=c_sel, width=4))

    def on_mode_changed(self, index):
        if index == 0:
            self.tool_mode = 'draw'
            self.plot_widget.setCursor(Qt.CursorShape.CrossCursor)
            self.status_label.setText(i18n.get("status.tool.edit").format(self._current_param_display_name()))

            # Clear selection
            self.clear_selection(hide_box=True)
            self.update_plot()

        elif index == 1:
            self.tool_mode = 'select'
            self.plot_widget.setCursor(Qt.CursorShape.ArrowCursor)
            self.status_label.setText(i18n.get("status.tool.select"))

    def on_viewbox_mouse_release(self, ev):
        if self.tool_mode == 'move':
            self.move_start_x = None
            self.plot_widget.setCursor(Qt.CursorShape.OpenHandCursor)

        if self.tool_mode == 'select':
            if self.is_selecting:
                self.is_selecting = False
                self.selection_box_item.setVisible(False)

                # Calculate Selection Mask (for current parameter)
                rect = self.selection_box_item.rect()
                track = self.current_track
                if track and track.track_type == 'vocal':
                    arr = self.get_param_array(track)
                    curve_y = self.get_param_curve_y(track)
                    if arr is None or curve_y is None:
                        return

                    x_min = rect.left() - track.start_frame
                    x_max = rect.right() - track.start_frame
                    y_min = rect.top()
                    y_max = rect.bottom()

                    indices = np.arange(len(arr))
                    x_mask = (indices >= x_min) & (indices <= x_max)
                    y_mask = (curve_y >= y_min) & (curve_y <= y_max)

                    self.set_selection(x_mask & y_mask, param=getattr(self, 'edit_param', 'pitch'))
                    self.update_plot()

            elif self.is_dragging_selection:
                self.is_dragging_selection = False
                self.plot_widget.setCursor(Qt.CursorShape.ArrowCursor)

                # Commit drag: pitch needs re-synthesis, tension is post-FX only
                track = self.current_track
                if track and self.selection_mask is not None:
                    if getattr(self, 'drag_param', getattr(self, 'edit_param', 'pitch')) == 'pitch':
                        indices = np.where(self.selection_mask)[0]
                        if len(indices) > 0:
                            min_x, max_x = indices[0], indices[-1]
                            for i, (seg_start, seg_end) in enumerate(track.segments):
                                if not (max_x < seg_start or min_x >= seg_end):
                                    track.segment_states[i]['dirty'] = True

                        self._set_dirty(True)
                        self.status_label.setText(i18n.get("status.pitch_modified_unsynth"))

                    else:
                        track.tension_version += 1
                        track._tension_processed_audio = None
                        track._tension_processed_key = None
                        self._set_dirty(True)
                        self.status_label.setText(i18n.get("status.tension_modified_live"))

                self.drag_start_f0 = None
                self.drag_param = None
                self.drag_start_values = None

        self.last_mouse_pos = None

    def on_viewbox_mouse_move(self, ev):
        """处理来自 ViewBox 的鼠标移动事件 (拖拽/绘制)"""
        track = self.current_track
        if not track:
            return

        pos = ev.scenePos()
        vb = self.plot_widget.plotItem.vb
        mouse_point = vb.mapSceneToView(pos)

        buttons = ev.buttons()
        is_left = bool(buttons & Qt.MouseButton.LeftButton)
        is_right = bool(buttons & Qt.MouseButton.RightButton)

        if self.tool_mode == 'move' and is_left and getattr(self, 'move_start_x', None) is not None:
            delta = mouse_point.x() - self.move_start_x
            new_start = int(self.move_start_frame + delta)
            if new_start < 0:
                new_start = 0

            if new_start != track.start_frame:
                track.start_frame = new_start
                self.update_plot()
                self.status_label.setText(f"移动音轨: {new_start} 帧")

        elif self.tool_mode == 'draw' and track.track_type == 'vocal' and (
            track.f0_edited is not None or getattr(track, 'tension_edited', None) is not None
        ):
            if is_left or is_right:
                self.handle_draw(mouse_point, is_left, is_right)

        elif self.tool_mode == 'select':
            if self.is_selecting:
                # Update Selection Box
                rect = QRectF(self.selection_start_pos, mouse_point).normalized()
                self.selection_box_item.setRect(rect)
                self.selection_box_item.update()
            elif self.is_dragging_selection:
                # Drag Selection
                dy = mouse_point.y() - self.drag_start_pos.y()

                track = self.current_track
                if self.selection_mask is not None and self.drag_start_values is not None and track:
                    param = self.drag_param or getattr(self, 'edit_param', 'pitch')
                    base = self.drag_start_values.copy()
                    base[self.selection_mask] = self.apply_param_drag_delta(base[self.selection_mask], dy, param)

                    if param == 'tension':
                        if getattr(track, 'tension_edited', None) is not None:
                            track.tension_edited = base
                            track._tension_processed_audio = None
                            track._tension_processed_key = None
                    else:
                        if track.f0_edited is not None:
                            track.f0_edited = base

                    self.update_plot()

    def on_scene_mouse_move(self, pos):
        """处理场景鼠标移动事件 (悬停/光标状态)"""
        track = self.current_track
        if not track:
            return

        # Only handle hover logic here. Dragging is handled in on_viewbox_mouse_move
        if self.is_selecting or self.is_dragging_selection:
            return

        mouse_point = self.plot_widget.plotItem.vb.mapSceneToView(pos)

        # Hover Logic (Cursor Shape)
        if self.tool_mode == 'select':
            if track and track.track_type == 'vocal' and self.selection_mask is not None:
                sel_param = self.selection_param or getattr(self, 'edit_param', 'pitch')
                arr = self.get_param_array(track, sel_param)
                curve_y = self.get_param_curve_y(track, sel_param)
                if arr is None or curve_y is None:
                    self.plot_widget.setCursor(Qt.CursorShape.ArrowCursor)
                    return

                x = int(mouse_point.x()) - track.start_frame
                if 0 <= x < len(self.selection_mask) and self.selection_mask[x]:
                    y = mouse_point.y()
                    if abs(y - curve_y[x]) < 3.0:
                        self.plot_widget.setCursor(Qt.CursorShape.OpenHandCursor)
                    else:
                        self.plot_widget.setCursor(Qt.CursorShape.ArrowCursor)
                else:
                    self.plot_widget.setCursor(Qt.CursorShape.ArrowCursor)
            else:
                self.plot_widget.setCursor(Qt.CursorShape.ArrowCursor)

    def on_viewbox_mouse_press(self, ev):
        track = self.current_track
        if not track:
            return

        vb = self.plot_widget.plotItem.vb
        pos = ev.scenePos()
        if not vb.sceneBoundingRect().contains(pos):
            return

        if ev.button() == Qt.MouseButton.LeftButton or ev.button() == Qt.MouseButton.RightButton:
            ev.accept()
            mouse_point = vb.mapSceneToView(pos)

            is_left = ev.button() == Qt.MouseButton.LeftButton
            is_right = ev.button() == Qt.MouseButton.RightButton

            if self.tool_mode == 'move' and is_left:
                self.move_start_x = mouse_point.x()
                self.move_start_frame = track.start_frame
                self.plot_widget.setCursor(Qt.CursorShape.ClosedHandCursor)
            elif self.tool_mode == 'draw' and track.track_type == 'vocal' and (
                track.f0_edited is not None or getattr(track, 'tension_edited', None) is not None
            ):
                self.last_mouse_pos = None
                self.handle_draw(mouse_point, is_left, is_right)

            elif self.tool_mode == 'select' and is_left and track.track_type == 'vocal':
                sel_param = self.selection_param or getattr(self, 'edit_param', 'pitch')
                arr = self.get_param_array(track, sel_param)
                curve_y = self.get_param_curve_y(track, sel_param)
                if arr is None or curve_y is None:
                    return

                # Check if clicking inside existing selection
                x = int(mouse_point.x()) - track.start_frame
                is_inside_selection = False
                if self.selection_mask is not None and 0 <= x < len(self.selection_mask):
                    if self.selection_mask[x]:
                        y = mouse_point.y()
                        if abs(y - curve_y[x]) < 3.0:
                            is_inside_selection = True

                if is_inside_selection:
                    # Start Dragging Selection
                    self.is_dragging_selection = True
                    self.drag_start_pos = mouse_point
                    self.drag_param = sel_param

                    self.drag_start_values = arr.copy()
                    self.drag_start_f0 = track.f0_edited.copy() if getattr(track, 'f0_edited', None) is not None else None
                    self.push_undo()
                    self.plot_widget.setCursor(Qt.CursorShape.ClosedHandCursor)
                else:
                    # Start Box Selection
                    self.is_selecting = True
                    self.selection_start_pos = mouse_point
                    self.selection_box_item.setRect(QRectF(mouse_point, mouse_point))
                    self.selection_box_item.setVisible(True)
                    self.set_selection(None)

                    self.update_plot()
                    self.status_label.setText("开始框选...")

    def handle_draw(self, point, is_left, is_right):
        track = self.current_track
        if not track or track.track_type != 'vocal':
            return

        x = int(point.x()) - track.start_frame
        y = point.y()

        # Start of a new stroke?
        if self.last_mouse_pos is None:
            self.push_undo()

        edit_param = getattr(self, 'edit_param', 'pitch')

        # ---- Tension drawing ----
        if edit_param == 'tension':
            tension = getattr(track, 'tension_edited', None)
            if tension is None:
                return

            v = self.plot_y_to_tension(y)
            changed = False
            affected_range = (x, x)

            if 0 <= x < len(tension):
                if self.last_mouse_pos is not None:
                    last_x, last_v = self.last_mouse_pos

                    start_x, end_x = sorted((last_x, x))
                    start_x = max(0, start_x)
                    end_x = min(len(tension) - 1, end_x)
                    affected_range = (start_x, end_x)

                    if start_x < end_x:
                        for i in range(start_x, end_x + 1):
                            if is_left:
                                ratio = (i - last_x) / (x - last_x) if x != last_x else 0
                                interp_v = last_v + ratio * (v - last_v)
                                tension[i] = interp_v
                                changed = True
                            elif is_right:
                                tension[i] = 0.0
                                changed = True
                    else:
                        if is_left:
                            tension[x] = v
                            changed = True
                        elif is_right:
                            tension[x] = 0.0
                            changed = True
                else:
                    if is_left:
                        tension[x] = v
                        changed = True
                    elif is_right:
                        tension[x] = 0.0
                        changed = True

                self.last_mouse_pos = (x, v)
                self.update_plot()

                if changed:
                    track.tension_version += 1
                    track._tension_processed_audio = None
                    track._tension_processed_key = None
                    self._set_dirty(True)
                    self.status_label.setText(i18n.get("status.tension_modified_live"))

            return

        # ---- Pitch drawing ----
        if track.f0_edited is None:
            return

        changed = False
        affected_range = (x, x)

        f0 = track.f0_edited
        f0_orig = track.f0_original

        if 0 <= x < len(f0):
            if self.last_mouse_pos is not None:
                last_x, last_y = self.last_mouse_pos

                start_x, end_x = sorted((last_x, x))
                start_x = max(0, start_x)
                end_x = min(len(f0) - 1, end_x)
                affected_range = (start_x, end_x)

                if start_x < end_x:
                    for i in range(start_x, end_x + 1):
                        if is_left:
                            ratio = (i - last_x) / (x - last_x) if x != last_x else 0
                            interp_y = last_y + ratio * (y - last_y)
                            f0[i] = interp_y
                            changed = True
                        elif is_right:
                            if f0_orig is not None:
                                f0[i] = f0_orig[i]
                                changed = True
                else:
                    if is_left:
                        f0[x] = y
                        changed = True
                    elif is_right and f0_orig is not None:
                        f0[x] = f0_orig[x]
                        changed = True
            else:
                if is_left:
                    f0[x] = y
                    changed = True
                elif is_right and f0_orig is not None:
                    f0[x] = f0_orig[x]
                    changed = True

            if changed:
                # Mark affected segments as dirty
                min_x, max_x = affected_range
                for i, (seg_start, seg_end) in enumerate(track.segments):
                    if not (max_x < seg_start or min_x >= seg_end):
                        track.segment_states[i]['dirty'] = True

            self.last_mouse_pos = (x, y)
            self.update_plot()

            if changed:
                self._set_dirty(True)
                self.status_label.setText(i18n.get("status.pitch_modified_unsynth"))

    def mouseReleaseEvent(self, ev):
        if self.tool_mode == 'move':
            self.move_start_x = None
            self.plot_widget.setCursor(Qt.CursorShape.OpenHandCursor)

        self.last_mouse_pos = None
        QMainWindow.mouseReleaseEvent(self, ev)

    def apply_shift(self, semitones):
        track = self.current_track
        if not track or track.track_type != 'vocal' or track.f0_edited is None:
            return

        delta = semitones - float(getattr(self, 'last_shift_value', 0.0))
        track.f0_edited += delta
        track.shift_value = semitones
        self.last_shift_value = semitones

        # Mark all segments as dirty on global shift
        for state in track.segment_states:
            state['dirty'] = True
        self.update_plot()
