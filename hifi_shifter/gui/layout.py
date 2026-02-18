from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QBrush, QColor, QKeySequence, QShortcut
from PyQt6.QtWidgets import (
    QAbstractSpinBox,
    QButtonGroup,
    QComboBox,
    QDoubleSpinBox,
    QGraphicsRectItem,
    QHBoxLayout,
    QLabel,
    QProgressBar,
    QPushButton,
    QScrollBar,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

import pyqtgraph as pg

from .. import theme
from ..timeline import TimelinePanel
from ..widgets import BPMAxis, CustomViewBox, MusicGridItem, PianoRollAxis, PlaybackCursorItem
from utils.i18n import i18n


class LayoutMixin:
    def init_ui(self):
        self.create_menu_bar()

        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        layout = QVBoxLayout(central_widget)
        layout.setContentsMargins(0, 0, 0, 0)  # Remove outer margins

        # Controls Bar
        controls_layout = QHBoxLayout()
        controls_layout.setAlignment(Qt.AlignmentFlag.AlignLeft)
        controls_layout.setContentsMargins(10, 5, 10, 5)

        # Tool Mode Selector
        self.mode_combo = QComboBox()
        self.mode_combo.addItems([i18n.get("mode.edit"), i18n.get("mode.select")])
        self.mode_combo.setCurrentIndex(0)
        self.mode_combo.setFocusPolicy(Qt.FocusPolicy.NoFocus)  # Prevent Spacebar toggle
        self.mode_combo.currentIndexChanged.connect(self.on_mode_changed)

        # Edit Parameter Selector (Pitch / Tension)
        self.edit_param = 'pitch'  # 'pitch' | 'tension'
        self.param_combo = QComboBox()
        self.param_combo.addItems([i18n.get("param.pitch"), i18n.get("param.tension")])
        self.param_combo.setCurrentIndex(0)
        self.param_combo.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.param_combo.currentIndexChanged.connect(self.on_param_changed)

        # Tab Shortcut for Mode Toggle
        self.tab_shortcut = QShortcut(QKeySequence(Qt.Key.Key_Tab), self)
        self.tab_shortcut.activated.connect(self.toggle_mode)

        self.bpm_spin = QDoubleSpinBox()
        self.bpm_spin.setRange(10, 300)
        self.bpm_spin.setValue(120)
        self.bpm_spin.setPrefix(i18n.get("label.bpm") + ": ")
        self.bpm_spin.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
        self.bpm_spin.setFocusPolicy(Qt.FocusPolicy.ClickFocus)  # Allow typing but not tab focus
        self.bpm_spin.valueChanged.connect(self.on_bpm_changed)

        self.beats_spin = QSpinBox()
        self.beats_spin.setRange(1, 32)
        self.beats_spin.setValue(4)
        self.beats_spin.setPrefix(i18n.get("label.time_sig") + ": ")
        self.beats_spin.setSuffix(" / 4")
        self.beats_spin.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
        self.beats_spin.setFocusPolicy(Qt.FocusPolicy.ClickFocus)
        self.beats_spin.valueChanged.connect(self.on_beats_changed)

        # Grid Resolution
        self.grid_combo = QComboBox()
        self.grid_combo.addItems(["1/4", "1/8", "1/16", "1/32"])
        self.grid_combo.setCurrentIndex(0)  # Default 1/4
        self.grid_combo.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.grid_combo.currentIndexChanged.connect(self.on_grid_changed)

        controls_layout.addWidget(QLabel(i18n.get("label.mode") + ":"))
        controls_layout.addWidget(self.mode_combo)
        controls_layout.addWidget(QLabel(i18n.get("label.edit_param") + ":"))
        controls_layout.addWidget(self.param_combo)
        controls_layout.addWidget(QLabel(i18n.get("label.params") + ":"))
        controls_layout.addWidget(self.bpm_spin)

        controls_layout.addWidget(self.beats_spin)
        controls_layout.addWidget(QLabel(i18n.get("label.grid") + ":"))
        controls_layout.addWidget(self.grid_combo)

        controls_layout.addStretch()

        layout.addLayout(controls_layout)

        # Main Content Area (Splitter: Timeline / Piano Roll)
        splitter = QSplitter(Qt.Orientation.Vertical)

        # Timeline Panel
        hop_size = self.processor.config.get('hop_size', 512)  # Default to 512 if not set
        self.timeline_panel = TimelinePanel(parent_gui=self)
        self.timeline_panel.hop_size = hop_size
        self.timeline_panel.trackSelected.connect(self.on_track_selected)
        self.timeline_panel.filesDropped.connect(self.on_files_dropped)
        self.timeline_panel.cursorMoved.connect(self.on_timeline_cursor_moved)
        self.timeline_panel.trackTypeChanged.connect(self.convert_track_type)
        splitter.addWidget(self.timeline_panel)

        # Plot Area (Piano Roll) Container
        self.plot_container = QWidget()
        self.plot_layout = QHBoxLayout(self.plot_container)
        self.plot_layout.setContentsMargins(0, 0, 0, 0)
        self.plot_layout.setSpacing(0)

        # Container for Plot Widget to apply rounded corners
        self.plot_container_widget = QWidget()
        self.plot_container_widget.setStyleSheet("border-radius: 10px;")
        plot_container_layout = QVBoxLayout(self.plot_container_widget)
        plot_container_layout.setContentsMargins(0, 0, 0, 0)
        plot_container_layout.setSpacing(0)

        # Param switch inside the editor area (Pitch / Tension)
        self.param_bar = QWidget(self.plot_container_widget)
        param_bar_layout = QHBoxLayout(self.param_bar)
        param_bar_layout.setContentsMargins(8, 6, 8, 6)
        param_bar_layout.setSpacing(6)
        param_bar_layout.addStretch()

        self.param_button_group = QButtonGroup(self)
        self.btn_param_pitch = QPushButton(i18n.get("param.pitch"))
        self.btn_param_pitch.setCheckable(True)
        self.btn_param_tension = QPushButton(i18n.get("param.tension"))
        self.btn_param_tension.setCheckable(True)

        for b in (self.btn_param_pitch, self.btn_param_tension):
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            b.setMinimumWidth(48)

        self.param_button_group.setExclusive(True)
        self.param_button_group.addButton(self.btn_param_pitch)
        self.param_button_group.addButton(self.btn_param_tension)
        self.btn_param_pitch.setChecked(True)
        self.param_button_group.buttonClicked.connect(self.on_param_button_clicked)

        param_bar_layout.addWidget(self.btn_param_pitch)
        param_bar_layout.addWidget(self.btn_param_tension)
        plot_container_layout.addWidget(self.param_bar)

        self.plot_widget = pg.PlotWidget(
            viewBox=CustomViewBox(self),
            axisItems={
                'left': PianoRollAxis(self, orientation='left'),
                'top': BPMAxis(self, orientation='top'),
                'bottom': pg.AxisItem(orientation='bottom'),  # Standard axis, will be hidden
            },
        )

        plot_container_layout.addWidget(self.plot_widget)

        # Disable AutoRange to prevent crash on startup with infinite items
        self.plot_widget.plotItem.vb.disableAutoRange()
        self.plot_widget.plotItem.hideButtons()  # Hide the "A" button
        self.timeline_panel.ruler_plot.plotItem.vb.disableAutoRange()
        self.timeline_panel.ruler_plot.plotItem.hideButtons()  # Hide the "A" button

        current_theme = theme.get_current_theme()
        self.plot_widget.setBackground(current_theme['graph']['background'])
        self.update_left_axis_label()
        # Disable default X grid, keep Y grid
        self.plot_widget.showGrid(x=False, y=True, alpha=current_theme['graph'].get('grid_alpha', 0.5))
        self.plot_widget.setMouseEnabled(x=True, y=True)

        # Add Custom Music Grid
        self.music_grid = MusicGridItem(self)
        self.plot_widget.addItem(self.music_grid)

        # Configure Axes
        self.plot_widget.showAxis('top')
        self.plot_widget.hideAxis('bottom')

        # Limit Y range: C2..C8 (MIDI 36..108)
        self.pitch_y_min = 36
        self.pitch_y_max = 108
        self.plot_widget.setLimits(yMin=self.pitch_y_min, yMax=self.pitch_y_max)
        self.plot_widget.setYRange(60, 72, padding=0)  # Initial view: C4 to C5

        # Scrollbar for Piano Roll
        self.plot_scrollbar = QScrollBar(Qt.Orientation.Vertical)
        self.plot_scrollbar.setRange(0, 100)  # Will be updated dynamically
        self.plot_scrollbar.valueChanged.connect(self.on_plot_scroll)

        self.plot_layout.addWidget(self.plot_container_widget)
        self.plot_layout.addWidget(self.plot_scrollbar)

        splitter.addWidget(self.plot_container)
        splitter.setSizes([200, 600])

        layout.addWidget(splitter)

        # Set Limits
        self.plot_widget.setLimits(xMin=0)
        self.timeline_panel.ruler_plot.setLimits(xMin=0)

        # Connect ViewBox Y range change to scrollbar
        self.plot_widget.plotItem.vb.sigYRangeChanged.connect(self.update_plot_scrollbar)

        # Playback Cursor
        self.play_cursor = PlaybackCursorItem()
        self.plot_widget.addItem(self.play_cursor)

        # Waveform View
        self.waveform_view = pg.ViewBox()
        self.waveform_view.setMouseEnabled(x=False, y=False)
        self.waveform_view.setMenuEnabled(False)
        self.waveform_view.setAcceptedMouseButtons(Qt.MouseButton.NoButton)
        self.waveform_view.setXLink(self.plot_widget.plotItem.vb)
        self.waveform_view.setYRange(-1, 1)
        self.waveform_view.setZValue(-1)
        self.plot_widget.scene().addItem(self.waveform_view)

        self.plot_widget.plotItem.vb.sigResized.connect(self.update_views)

        # Custom Mouse Interaction
        self.plot_widget.scene().sigMouseMoved.connect(self.on_scene_mouse_move)

        # Curves
        self.waveform_curve = pg.PlotCurveItem(pen=pg.mkPen(color=(255, 255, 255, 30), width=1), name="Waveform")
        self.waveform_view.addItem(self.waveform_curve)

        self.f0_orig_curve_item = self.plot_widget.plot(
            pen=pg.mkPen(color=(255, 255, 255, 80), width=2, style=Qt.PenStyle.DashLine),
            name="Original F0",
        )
        self.f0_curve_item = self.plot_widget.plot(pen=pg.mkPen('#00ff00', width=3), name="F0")

        # Selected/highlighted portion for current parameter (pitch/tension/...)
        self.selected_param_curve_item = self.plot_widget.plot(pen=pg.mkPen('#0099ff', width=4), name="Selected Param")
        self.selected_param_curve_item.setZValue(900)

        # Tension overlay (mapped to the same Y axis as pitch)
        self.tension_curve_item = self.plot_widget.plot(pen=pg.mkPen('#cc66ff', width=2), name="Tension")

        # Selection Box
        self.selection_box_item = QGraphicsRectItem()
        pen = pg.mkPen(color=(255, 255, 255), width=1, style=Qt.PenStyle.DashLine)
        pen.setCosmetic(True)
        self.selection_box_item.setPen(pen)
        self.selection_box_item.setBrush(QBrush(QColor(255, 255, 255, 50)))
        self.selection_box_item.setZValue(1000)  # Ensure on top
        self.selection_box_item.setVisible(False)
        self.plot_widget.addItem(self.selection_box_item)

        # Selection State
        self.selection_mask = None
        self.selection_param = None  # which param the current selection applies to
        self.is_selecting = False
        self.is_dragging_selection = False
        self.selection_start_pos = None
        self.drag_start_pos = None
        # Generic drag state (for pitch/tension and future params)
        self.drag_param = None
        self.drag_start_values = None
        self.drag_start_f0 = None  # kept for backward compatibility

        # Update timeline bounds to ensure limits are applied to plot_widget
        self.timeline_panel.update_timeline_bounds()

        # Ensure initial view range is set correctly after linking
        self.timeline_panel.set_initial_view_range()

        # Status Bar Layout
        status_layout = QHBoxLayout()
        layout.addLayout(status_layout)

        # Status Label
        self.status_label = QLabel(i18n.get("status.ready"))
        self.status_label.setFixedHeight(20)  # Fix height to prevent jumping
        status_layout.addWidget(self.status_label)

        # Progress Bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_bar.setTextVisible(False)
        self.progress_bar.setFixedSize(200, 15)  # Fix size
        self.progress_bar.setVisible(False)
        status_layout.addWidget(self.progress_bar)

        # Playback timer
        self.playback_timer = QTimer()
        self.playback_timer.setInterval(30)  # 30ms update
        self.playback_timer.timeout.connect(self.update_cursor)

        # Set initial cursor and status text
        self.on_mode_changed(self.mode_combo.currentIndex())
        status_layout.addStretch()

    def on_grid_changed(self, index):
        resolutions = [4, 8, 16, 32]
        if index < len(resolutions):
            res = resolutions[index]
            self.music_grid.set_resolution(res)
            # Update all track grids
            if hasattr(self, 'timeline_panel'):
                for row in self.timeline_panel.rows:
                    row.lane.music_grid.set_resolution(res)

    def on_bpm_changed(self):
        self.plot_widget.getAxis('top').picture = None
        self.plot_widget.getAxis('top').update()
        self.music_grid.update()
        # Update all track grids
        if hasattr(self, 'timeline_panel'):
            for row in self.timeline_panel.rows:
                row.lane.music_grid.update()

    def on_beats_changed(self):
        self.plot_widget.getAxis('top').picture = None
        self.plot_widget.getAxis('top').update()
        self.music_grid.update()
        # Update all track grids
        if hasattr(self, 'timeline_panel'):
            for row in self.timeline_panel.rows:
                row.lane.music_grid.update()

    def update_plot_scrollbar(self, vb, range):
        # range is (minY, maxY)
        min_y, max_y = range
        view_height = max_y - min_y

        # Total range: C2..C8
        total_min = getattr(self, 'pitch_y_min', 36)
        total_max = getattr(self, 'pitch_y_max', 108)

        total_height = total_max - total_min

        # Let's map scrollbar value (0..1000) to view top (total_max .. total_min + view_height)
        self.plot_scrollbar.blockSignals(True)

        # Page step is proportional to view height
        sb_max = 1000
        self.plot_scrollbar.setRange(0, sb_max)
        self.plot_scrollbar.setPageStep(int(sb_max * (view_height / total_height)))

        scrollable_height = total_height - view_height
        if scrollable_height <= 0:
            self.plot_scrollbar.setValue(0)
        else:
            ratio = (total_max - max_y) / scrollable_height
            val = int(ratio * sb_max)
            self.plot_scrollbar.setValue(val)

        self.plot_scrollbar.blockSignals(False)

    def on_plot_scroll(self, value):
        # Calculate new top
        sb_max = self.plot_scrollbar.maximum()
        if sb_max == 0:
            return

        ratio = value / sb_max

        # Get current view height
        current_range = self.plot_widget.plotItem.vb.viewRange()[1]
        view_height = current_range[1] - current_range[0]

        total_min = getattr(self, 'pitch_y_min', 36)
        total_max = getattr(self, 'pitch_y_max', 108)

        total_height = total_max - total_min
        scrollable_height = total_height - view_height

        # New Top = Total Max - (Ratio * Scrollable Height)
        new_top = total_max - (ratio * scrollable_height)
        new_bottom = new_top - view_height

        self.plot_widget.plotItem.vb.setYRange(new_bottom, new_top, padding=0)

    def update_views(self):
        self.waveform_view.setGeometry(self.plot_widget.plotItem.vb.sceneBoundingRect())
        self.waveform_view.linkedViewChanged(self.plot_widget.plotItem.vb, self.waveform_view.XAxis)
        # Sync timeline view X range if needed (already linked via setXLink)
        pass
