from __future__ import annotations

import numpy as np

from utils.i18n import i18n


class ParamsMixin:
    def get_pitch_y_bounds(self):
        """Pitch axis range used by the editor and by overlay params."""
        return float(getattr(self, 'pitch_y_min', 36)), float(getattr(self, 'pitch_y_max', 108))

    def tension_to_plot_y(self, tension_values: np.ndarray) -> np.ndarray:
        """Map tension [-100,100] onto the pitch Y axis for overlay display."""
        y_min, y_max = self.get_pitch_y_bounds()
        t = np.asarray(tension_values, dtype=np.float32)
        t = np.clip(t, -100.0, 100.0)
        return y_min + ((t + 100.0) / 200.0) * (y_max - y_min)

    def plot_y_to_tension(self, y: float) -> float:
        y_min, y_max = self.get_pitch_y_bounds()
        t = ((float(y) - y_min) / (y_max - y_min)) * 200.0 - 100.0
        return float(np.clip(t, -100.0, 100.0))

    def tension_value_to_plot_y(self, t: float) -> float:
        """Map a single tension value [-100,100] to plot Y."""
        y_min, y_max = self.get_pitch_y_bounds()
        t = float(np.clip(float(t), -100.0, 100.0))
        return float(y_min + ((t + 100.0) / 200.0) * (y_max - y_min))

    # ---- Axis label abstraction (so left axis follows current param) ----
    def get_axis_param(self) -> str:
        """Which param the left axis should represent (defaults to current edit param)."""
        return getattr(self, 'edit_param', 'pitch')

    def get_param_axis_label(self, param: str | None = None) -> str:
        """Left-axis label text for a given param."""
        param = param or self.get_axis_param()
        if param == 'pitch':
            return i18n.get("label.pitch")
        if param == 'tension':
            # Added in lang files; keep a safe fallback.
            try:
                return i18n.get("label.tension")
            except Exception:
                return "张力 (Tension)"
        return str(param)

    def update_left_axis_label(self):
        """Update vertical left-axis label to follow current parameter panel."""
        try:
            if hasattr(self, 'plot_widget') and self.plot_widget is not None:
                self.plot_widget.setLabel('left', self.get_param_axis_label())
        except Exception:
            pass

    def get_param_axis_kind(self, param: str | None = None) -> str:
        """Return axis kind for a param.

        - 'note': render note names (pitch)
        - 'linear': render numeric values mapped from plot Y
        """
        param = param or self.get_axis_param()
        if param == 'pitch':
            return 'note'
        # tension / future params default to numeric axis
        return 'linear'

    def plot_y_to_param_value(self, y: float, param: str | None = None) -> float:
        """Convert plot Y coordinate -> param value for axis labeling."""
        param = param or self.get_axis_param()
        if param == 'tension':
            return self.plot_y_to_tension(y)
        # pitch (and default): identity in MIDI space
        return float(y)

    def param_value_to_plot_y(self, value: float, param: str | None = None) -> float:
        """Convert param value -> plot Y coordinate (inverse of plot_y_to_param_value)."""
        param = param or self.get_axis_param()
        if param == 'tension':
            return self.tension_value_to_plot_y(value)
        return float(value)

    def format_param_axis_value(self, value: float, param: str | None = None) -> str:
        """Format numeric axis labels for a param."""
        param = param or self.get_axis_param()
        # tension is integer-like [-100..100]
        if param == 'tension':
            return f"{float(value):.0f}"
        # default numeric
        return f"{float(value):.0f}"

    # ---- Param abstraction (for future: volume/formant/etc.) ----
    def get_param_array(self, track, param: str | None = None):
        param = param or getattr(self, 'edit_param', 'pitch')
        if param == 'tension':
            return getattr(track, 'tension_edited', None)
        return getattr(track, 'f0_edited', None)

    def get_param_curve_y(self, track, param: str | None = None):
        param = param or getattr(self, 'edit_param', 'pitch')
        arr = self.get_param_array(track, param)
        if arr is None:
            return None
        if param == 'tension':
            return self.tension_to_plot_y(arr)
        return arr

    def apply_param_drag_delta(self, base_values: np.ndarray, dy: float, param: str):
        """Apply drag delta in plot Y units onto parameter values."""
        if param == 'tension':
            y_min, y_max = self.get_pitch_y_bounds()
            units_per_y = 200.0 / max(1e-6, (y_max - y_min))
            delta = float(dy) * units_per_y
            out = base_values + delta
            return np.clip(out, -100.0, 100.0)
        # pitch: 1 plot unit == 1 MIDI
        return base_values + float(dy)

    def _current_param_display_name(self):
        return i18n.get("param.pitch") if getattr(self, 'edit_param', 'pitch') == 'pitch' else i18n.get("param.tension")

    def set_edit_param(self, param: str):
        """Set current editable parameter ('pitch' | 'tension') and sync UI."""
        param = 'tension' if param == 'tension' else 'pitch'
        if getattr(self, 'edit_param', 'pitch') == param:
            return

        self.edit_param = param
        self.update_left_axis_label()

        # Switching parameter invalidates current selection
        self.clear_selection(hide_box=True)

        # Avoid mixing stroke interpolation across parameters
        self.last_mouse_pos = None

        # Sync top combo
        if hasattr(self, 'param_combo') and self.param_combo is not None:
            idx = 0 if param == 'pitch' else 1
            if self.param_combo.currentIndex() != idx:
                self.param_combo.blockSignals(True)
                self.param_combo.setCurrentIndex(idx)
                self.param_combo.blockSignals(False)

        # Sync editor buttons
        if hasattr(self, 'btn_param_pitch') and hasattr(self, 'btn_param_tension'):
            if param == 'pitch':
                self.btn_param_pitch.setChecked(True)
            else:
                self.btn_param_tension.setChecked(True)

        self.update_plot()

        # Force left axis refresh (tickStrings depends on edit_param)
        try:
            axis_left = self.plot_widget.getAxis('left')
            axis_left.picture = None
            axis_left.update()
        except Exception:
            pass

        if self.tool_mode == 'draw':
            self.status_label.setText(i18n.get("status.tool.edit").format(self._current_param_display_name()))

    def on_param_changed(self, index):
        self.set_edit_param('pitch' if index == 0 else 'tension')

    def on_param_button_clicked(self, button):
        if button == getattr(self, 'btn_param_tension', None):
            self.set_edit_param('tension')
        else:
            self.set_edit_param('pitch')
