from __future__ import annotations

import numpy as np
import pyqtgraph as pg
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QBrush, QColor

from .. import theme


class PlottingMixin:
    def update_plot(self):
        track = self.current_track

        # Update Selection Box Theme
        current_theme = theme.get_current_theme()
        sel_pen_color = current_theme['piano_roll'].get('selection_pen', (255, 255, 255, 200))
        sel_brush_color = current_theme['piano_roll'].get('selection_brush', (255, 255, 255, 50))

        pen = pg.mkPen(color=sel_pen_color, width=1, style=Qt.PenStyle.DashLine)
        pen.setCosmetic(True)
        self.selection_box_item.setPen(pen)
        self.selection_box_item.setBrush(QBrush(QColor(*sel_brush_color)))

        if not track:
            self.waveform_curve.clear()
            self.f0_orig_curve_item.clear()
            self.f0_curve_item.clear()
            self.selected_param_curve_item.clear()
            self.tension_curve_item.clear()
            return

        # Waveform
        if track.audio is not None:
            hop_size = self.processor.config['hop_size'] if self.processor.config else 512
            ds_factor = max(1, int(hop_size / 4))
            audio_ds = track.audio[::ds_factor]
            # Add start_frame offset to x
            x_ds = (np.arange(len(audio_ds)) * ds_factor / hop_size) + track.start_frame

            # Use waveform_view (Y range -1 to 1)
            self.waveform_curve.setData(x_ds, audio_ds * 0.8)

            current_theme = theme.get_current_theme()
            pen_color = current_theme['graph'].get('waveform_pen', (255, 255, 255, 100))
            brush_color = current_theme['graph'].get('waveform_brush', (255, 255, 255, 30))

            self.waveform_curve.setPen(pg.mkPen(color=pen_color, width=1))
            self.waveform_curve.setBrush(pg.mkBrush(color=brush_color))
            self.waveform_curve.setFillLevel(0)
        else:
            self.waveform_curve.clear()

        if track.track_type == 'vocal':
            # Create x axis for F0
            x_f0 = np.arange(len(track.f0_original)) + track.start_frame if track.f0_original is not None else None

            current_theme = theme.get_current_theme()
            f0_orig_pen = current_theme['graph'].get('f0_orig_pen', (255, 255, 255, 80))
            f0_pen = current_theme['graph'].get('f0_pen', '#00ff00')

            pitch_alpha = 90 if getattr(self, 'edit_param', 'pitch') == 'tension' else 255

            if track.f0_original is not None:
                self.f0_orig_curve_item.setData(x_f0, track.f0_original, connect="finite")
                c_orig = pg.mkColor(f0_orig_pen)
                c_orig.setAlpha(pitch_alpha)
                self.f0_orig_curve_item.setPen(pg.mkPen(color=c_orig, width=2, style=Qt.PenStyle.DashLine))
            else:
                self.f0_orig_curve_item.clear()

            if track.f0_edited is not None:
                self.f0_curve_item.setData(x_f0, track.f0_edited, connect="finite")
                c = pg.mkColor(f0_pen)
                c.setAlpha(pitch_alpha)
                self.f0_curve_item.setPen(pg.mkPen(color=c, width=3))

                # Selection highlight (works for pitch/tension/...)
                self.update_selection_highlight()
            else:
                self.f0_curve_item.clear()
                self.selected_param_curve_item.clear()

            # Tension overlay: only visible while editing tension
            if getattr(self, 'edit_param', 'pitch') == 'tension' and getattr(track, 'tension_edited', None) is not None:
                x_t = np.arange(len(track.tension_edited)) + track.start_frame
                y_t = self.tension_to_plot_y(track.tension_edited)
                self.tension_curve_item.setData(x_t, y_t, connect="finite")
            else:
                self.tension_curve_item.clear()

        else:
            self.f0_orig_curve_item.clear()
            self.f0_curve_item.clear()
            self.selected_param_curve_item.clear()
            self.tension_curve_item.clear()
