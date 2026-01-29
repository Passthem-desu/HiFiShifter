import sys
import os
import time
import json
import pathlib
import numpy as np
import sounddevice as sd
import scipy.io.wavfile as wavfile
import traceback
import threading
from PyQt6.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout, 
                             QHBoxLayout, QPushButton, QLabel, QFileDialog, 
                             QMessageBox, QComboBox, QDoubleSpinBox, QSpinBox,
                             QButtonGroup, QSplitter, QScrollBar, QGraphicsRectItem,
                             QProgressBar, QAbstractSpinBox)
from PyQt6.QtGui import QAction, QKeySequence, QPen, QColor, QBrush, QShortcut, QActionGroup, QIcon
from PyQt6.QtCore import Qt, QTimer, QRectF, QObject, QThread, pyqtSignal
import pyqtgraph as pg


# Import widgets
from .widgets import CustomViewBox, PianoRollAxis, BPMAxis, MusicGridItem, PlaybackCursorItem
from .timeline import TimelinePanel, CONTROL_PANEL_WIDTH
from .track import Track
# Import AudioProcessor
from .audio_processor import AudioProcessor, apply_tension_tilt_pd

# Import Config Manager
from . import config_manager
# Import Theme
from . import theme
# Import I18n
from utils.i18n import i18n


class _BackgroundTask(QObject):
    """Run a callable in a QThread and report back via Qt signals.

    Important: the callable MUST NOT touch Qt widgets directly.
    """

    finished = pyqtSignal(object)
    failed = pyqtSignal(str)
    progress = pyqtSignal(int, int)  # current, total

    def __init__(self, fn, *, total: int | None = None):
        super().__init__()
        self._fn = fn
        self._total = total

    def run(self):
        try:
            def _progress(cur: int, total: int | None = None):
                t = int(total if total is not None else (self._total if self._total is not None else 0))
                self.progress.emit(int(cur), t)

            result = self._fn(_progress)
            self.finished.emit(result)
        except Exception:
            self.failed.emit(traceback.format_exc())


class HifiShifterGUI(QMainWindow):
    def __init__(self):
        super().__init__()
        
        # Initialize Language
        lang = config_manager.get_language()
        # Assuming assets folder is at project root/assets
        # We need to find the project root. 
        # Current file is in hifi_shifter/main_window.py
        # Root is one level up
        root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        i18n.load_language(lang, os.path.join(root_dir, 'assets'))
        
        self.setWindowTitle(i18n.get("app.title"))
        self.resize(1200, 800)
        
        # Set Window Icon
        assets_dir = os.path.join(root_dir, 'assets')
        icon_path = os.path.join(assets_dir, 'icon.png')
        if not os.path.exists(icon_path):
             icon_path = os.path.join(assets_dir, 'icon.ico')
        if os.path.exists(icon_path):
            self.setWindowIcon(QIcon(icon_path))
        
        # Apply Theme
        current_theme_name = config_manager.get_theme()
        theme.apply_theme(QApplication.instance(), current_theme_name)
        
        # Initialize Audio Processor
        self.processor = AudioProcessor()
        
        # Data for UI
        self.project_path = None
        self.model_path = None
        
        # Project dirty flag (unsaved changes)
        self.is_dirty = False

        # Track Management
        self.tracks = []

        self.current_track_idx = -1
        
        # Tools
        self.tool_mode = 'draw' # 'draw' only now
        
        # Playback State
        self.is_playing = False
        self.current_playback_time = 0.0 # seconds
        self.playback_start_time = 0.0 # seconds (for return to start)
        self.last_wall_time = 0.0
        self.playback_timer = QTimer()
        self.playback_timer.setInterval(30) # 30ms update
        self.playback_timer.timeout.connect(self.update_cursor)

        # Real-time playback stream state (so volume/mute/solo changes apply during playback)
        self._playback_stream = None
        self._playback_lock = threading.RLock()
        self._playback_items = []  # list[(Track, np.ndarray(float32), start_sample)]
        self._playback_sample_pos = 0
        self._playback_total_samples = 0
        self._playback_sr = 44100
        self._playback_hop_size = 512

        # Background task state (keep heavy work off the UI thread)
        self._bg_thread: QThread | None = None

        self._bg_task: _BackgroundTask | None = None
        self._bg_kind: str | None = None
        self._pending_track_paths: list[str] = []
        self._pending_synthesis: bool = False
        self._pending_playback: bool = False


        # Undo/Redo Stacks (Global or per track? Per track is better but harder. Let's keep global for now, but it needs to track which track was edited)

        # Actually, let's make undo/redo per track, or clear it when switching tracks.
        # For simplicity, let's clear undo stack when switching tracks for now.
        self.undo_stack = []
        self.redo_stack = []
        
        # Clipboard
        self.pitch_clipboard = None
        
        # Interaction State
        self.is_drawing = False
        self.last_mouse_pos = None
        
        self.init_ui()
        self.load_default_model()
        
    def _set_dirty(self, dirty: bool = True):
        self.is_dirty = dirty

    @property
    def current_track(self):
        if 0 <= self.current_track_idx < len(self.tracks):
            return self.tracks[self.current_track_idx]
        return None
        
    def create_menu_bar(self):
        menu_bar = self.menuBar()
        
        # File Menu
        file_menu = menu_bar.addMenu(i18n.get("menu.file"))
        
        open_action = QAction(i18n.get("menu.file.open"), self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self.open_project_dialog)
        file_menu.addAction(open_action)
        
        open_vocalshifter_action = QAction(i18n.get("menu.file.open_vocalshifter_project"), self)
        open_vocalshifter_action.triggered.connect(self.open_vocalshifter_project_dialog)
        file_menu.addAction(open_vocalshifter_action)
        
        save_action = QAction(i18n.get("menu.file.save"), self)
        save_action.setShortcut(QKeySequence.StandardKey.Save)
        save_action.triggered.connect(self.save_project)
        file_menu.addAction(save_action)
        
        save_as_action = QAction(i18n.get("menu.file.save_as"), self)
        save_as_action.setShortcut(QKeySequence.StandardKey.SaveAs)
        save_as_action.triggered.connect(self.save_project_as)
        file_menu.addAction(save_as_action)
        
        file_menu.addSeparator()

        load_model_action = QAction(i18n.get("menu.file.load_model"), self)
        load_model_action.triggered.connect(self.load_model_dialog)
        file_menu.addAction(load_model_action)

        load_audio_action = QAction(i18n.get("menu.file.load_audio"), self)
        load_audio_action.triggered.connect(self.load_audio_dialog)
        file_menu.addAction(load_audio_action)
        
        file_menu.addSeparator()
        
        export_action = QAction(i18n.get("menu.file.export_audio"), self)
        export_action.triggered.connect(self.export_audio_dialog)
        file_menu.addAction(export_action)

        # Edit Menu
        edit_menu = menu_bar.addMenu(i18n.get("menu.edit"))
        
        undo_action = QAction(i18n.get("menu.edit.undo"), self)
        undo_action.setShortcut(QKeySequence.StandardKey.Undo)
        undo_action.triggered.connect(self.undo)
        edit_menu.addAction(undo_action)

        redo_action = QAction(i18n.get("menu.edit.redo"), self)
        redo_action.setShortcut(QKeySequence.StandardKey.Redo)
        redo_action.triggered.connect(self.redo)
        edit_menu.addAction(redo_action)

        paste_vocalshifter_action = QAction(i18n.get("menu.edit.paste_vocalshifter"), self)
        paste_vocalshifter_action.triggered.connect(self.paste_vocalshifter_clipboard_data)
        edit_menu.addAction(paste_vocalshifter_action)

        # View Menu
        view_menu = menu_bar.addMenu(i18n.get("menu.view"))
        
        toggle_theme_action = QAction(i18n.get("menu.view.toggle_theme"), self)
        toggle_theme_action.triggered.connect(self.toggle_theme)
        view_menu.addAction(toggle_theme_action)

        # Playback Menu
        play_menu = menu_bar.addMenu(i18n.get("menu.playback"))
        
        play_orig_action = QAction(i18n.get("menu.playback.original"), self)
        play_orig_action.triggered.connect(self.play_original)
        play_menu.addAction(play_orig_action)
        
        synth_play_action = QAction(i18n.get("menu.playback.synthesize"), self)
        synth_play_action.triggered.connect(self.synthesize_and_play)
        play_menu.addAction(synth_play_action)
        
        stop_action = QAction(i18n.get("menu.playback.stop"), self)
        stop_action.setShortcut(Qt.Key.Key_Escape)
        stop_action.triggered.connect(self.stop_audio)
        play_menu.addAction(stop_action)

        # Settings Menu
        settings_menu = menu_bar.addMenu(i18n.get("menu.settings"))
        
        set_default_model_action = QAction(i18n.get("menu.settings.default_model"), self)
        set_default_model_action.triggered.connect(self.set_default_model_dialog)
        settings_menu.addAction(set_default_model_action)
        
        # Language Submenu
        lang_menu = settings_menu.addMenu(i18n.get("menu.settings.language"))
        
        zh_action = QAction("简体中文", self)
        zh_action.setCheckable(True)
        zh_action.setChecked(i18n.current_lang == 'zh_CN')
        zh_action.triggered.connect(lambda: self.change_language('zh_CN'))
        lang_menu.addAction(zh_action)
        
        en_action = QAction("English", self)
        en_action.setCheckable(True)
        en_action.setChecked(i18n.current_lang == 'en_US')
        en_action.triggered.connect(lambda: self.change_language('en_US'))
        lang_menu.addAction(en_action)
        
        # Group for exclusivity
        lang_group = QActionGroup(self)
        lang_group.addAction(zh_action)
        lang_group.addAction(en_action)
        lang_group.setExclusive(True)

    def toggle_theme(self):
        current = config_manager.get_theme()
        new_theme = 'light' if current == 'dark' else 'dark'
        config_manager.set_theme(new_theme)
        theme_data = theme.apply_theme(QApplication.instance(), new_theme)
        
        # Update Plot Widget
        self.plot_widget.setBackground(theme_data['graph']['background'])
        self.plot_widget.showGrid(x=False, y=True, alpha=theme_data['graph'].get('grid_alpha', 0.5))
        self.music_grid.update_theme()
        
        # Update Waveform Color
        self.update_plot()
        
        # Update Timeline Panel
        if hasattr(self, 'timeline_panel'):
            self.timeline_panel.update_theme()
            
        QMessageBox.information(self, i18n.get("msg.restart_required"), i18n.get("msg.restart_content"))

    def change_language(self, lang_code):
        if lang_code == i18n.current_lang:
            return
            
        config_manager.set_language(lang_code)
        QMessageBox.information(self, i18n.get("msg.restart_required"), i18n.get("msg.restart_content"))

    def init_ui(self):
        self.create_menu_bar()
        
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        layout = QVBoxLayout(central_widget)
        layout.setContentsMargins(0, 0, 0, 0) # Remove outer margins
        
        # Controls Bar
        controls_layout = QHBoxLayout()
        controls_layout.setAlignment(Qt.AlignmentFlag.AlignLeft)
        controls_layout.setContentsMargins(10, 5, 10, 5)

        # Tool Mode Selector
        self.mode_combo = QComboBox()
        self.mode_combo.addItems([i18n.get("mode.edit"), i18n.get("mode.select")])
        self.mode_combo.setCurrentIndex(0)
        self.mode_combo.setFocusPolicy(Qt.FocusPolicy.NoFocus) # Prevent Spacebar toggle
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
        self.bpm_spin.setFocusPolicy(Qt.FocusPolicy.ClickFocus) # Allow typing but not tab focus
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
        self.grid_combo.setCurrentIndex(0) # Default 1/4
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
        # Initialize timeline panel with default track_index and hop_size
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
                'bottom': pg.AxisItem(orientation='bottom') # Standard axis, will be hidden
            }
        )
        
        plot_container_layout.addWidget(self.plot_widget)
        
        # Set fixed width for left axis to align with track controls
        # self.plot_widget.getAxis('left').setWidth(CONTROL_PANEL_WIDTH)
        
        # Link Timeline X axis to Plot Widget X axis
        # self.timeline_panel.ruler_plot.setXLink(self.plot_widget) # Decoupled as requested
        
        # Disable AutoRange to prevent crash on startup with infinite items
        self.plot_widget.plotItem.vb.disableAutoRange()
        self.plot_widget.plotItem.hideButtons() # Hide the "A" button
        self.timeline_panel.ruler_plot.plotItem.vb.disableAutoRange()
        self.timeline_panel.ruler_plot.plotItem.hideButtons() # Hide the "A" button
        
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
        # self.plot_widget.getAxis('top').setLabel('小节-拍') # Removed label as requested
        
        # Limit Y range: C2..C8 (MIDI 36..108)
        self.pitch_y_min = 36
        self.pitch_y_max = 108
        self.plot_widget.setLimits(yMin=self.pitch_y_min, yMax=self.pitch_y_max)
        self.plot_widget.setYRange(60, 72, padding=0) # Initial view: C4 to C5


        # Scrollbar for Piano Roll
        self.plot_scrollbar = QScrollBar(Qt.Orientation.Vertical)
        self.plot_scrollbar.setRange(0, 100) # Will be updated dynamically
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
        # self.plot_widget.scene().sigMouseClicked.connect(self.on_scene_mouse_click) # Replaced by on_viewbox_mouse_press
        
        # Curves
        self.waveform_curve = pg.PlotCurveItem(pen=pg.mkPen(color=(255, 255, 255, 30), width=1), name="Waveform")
        self.waveform_view.addItem(self.waveform_curve)
        
        self.f0_orig_curve_item = self.plot_widget.plot(pen=pg.mkPen(color=(255, 255, 255, 80), width=2, style=Qt.PenStyle.DashLine), name="Original F0")
        self.f0_curve_item = self.plot_widget.plot(pen=pg.mkPen('#00ff00', width=3), name="F0")

        # Selected/highlighted portion for current parameter (pitch/tension/...) 
        self.selected_param_curve_item = self.plot_widget.plot(pen=pg.mkPen('#0099ff', width=4), name="Selected Param")
        self.selected_param_curve_item.setZValue(900)

        # Tension overlay (mapped to the same Y axis as pitch)
        self.tension_curve_item = self.plot_widget.plot(pen=pg.mkPen('#cc66ff', width=2), name="Tension")
        
        # Selection Box

        self.selection_box_item = QGraphicsRectItem()
        # Use cosmetic pen to ensure visibility at any zoom level
        # Initial colors, will be updated by update_plot or theme change
        pen = pg.mkPen(color=(255, 255, 255), width=1, style=Qt.PenStyle.DashLine)
        pen.setCosmetic(True)
        self.selection_box_item.setPen(pen)
        self.selection_box_item.setBrush(QBrush(QColor(255, 255, 255, 50)))
        self.selection_box_item.setZValue(1000) # Ensure on top
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
        self.status_label.setFixedHeight(20) # Fix height to prevent jumping
        status_layout.addWidget(self.status_label)
        
        # Progress Bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_bar.setTextVisible(False)
        self.progress_bar.setFixedSize(200, 15) # Fix size
        self.progress_bar.setVisible(False)
        status_layout.addWidget(self.progress_bar)

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
        
        # Scrollbar represents the "Top" of the view relative to total range
        # Inverted: 0 is Top (156), Max is Bottom (12 + view_height)
        
        # Calculate scrollbar max
        # The scrollbar "value" usually corresponds to the top of the slider
        # If slider is at top (value=0), view top should be total_max
        # If slider is at bottom (value=max), view bottom should be total_min
        # i.e. view top should be total_min + view_height
        
        # Let's map scrollbar value (0..1000) to view top (total_max .. total_min + view_height)
        
        self.plot_scrollbar.blockSignals(True)
        
        # Update page step
        # Page step is proportional to view height
        # Let's use a fixed large range for scrollbar for smoothness
        sb_max = 1000
        self.plot_scrollbar.setRange(0, sb_max)
        self.plot_scrollbar.setPageStep(int(sb_max * (view_height / total_height)))
        
        # Calculate value
        # Ratio of (total_max - current_top) / (total_max - (total_min + view_height))
        # Wait, simpler:
        # Available scrollable height = total_height - view_height
        # Current scroll position (from top) = total_max - max_y
        
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

    def set_tool_mode(self, mode):
        self.tool_mode = mode
        if mode == 'draw':
            self.plot_widget.setCursor(Qt.CursorShape.CrossCursor)
            self.status_label.setText(i18n.get("status.tool.edit").format(self._current_param_display_name()))
        elif mode == 'move':
            self.plot_widget.setCursor(Qt.CursorShape.OpenHandCursor)
            self.status_label.setText(i18n.get("status.tool.move"))


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
            super().keyPressEvent(ev)

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


    def toggle_playback(self):
        if self.is_playing:
            self.stop_playback()
        else:
            self.start_playback()

    def _is_bg_busy(self) -> bool:
        return self._bg_thread is not None and self._bg_thread.isRunning()

    def _set_bg_locked(self, locked: bool):
        """Disable interactive UI while a background task is running.

        This avoids race conditions where the UI reads/writes track data while
        synthesis/loading/export is mutating it.
        """
        for attr in (
            'mode_combo',
            'param_combo',
            'btn_param_pitch',
            'btn_param_tension',
            'timeline_panel',
        ):
            w = getattr(self, attr, None)
            try:
                if w is not None:
                    w.setEnabled(not locked)
            except Exception:
                pass

    def _on_bg_progress(self, cur: int, total: int):
        try:
            if total and total > 0:
                self.progress_bar.setRange(0, max(1, int(total)))
                self.progress_bar.setValue(int(cur))
            else:
                # Busy indicator
                self.progress_bar.setRange(0, 0)
            self.progress_bar.setVisible(True)
        except Exception:
            pass

    def _start_bg_task(self, *, kind: str, status_text: str, fn, total: int | None = None, on_success=None, on_failed=None) -> bool:
        if self._is_bg_busy():
            return False

        self._bg_kind = kind
        self.status_label.setText(status_text)
        self.progress_bar.setVisible(True)
        if total is None:
            self.progress_bar.setRange(0, 0)
        else:
            self.progress_bar.setRange(0, max(1, int(total)))
            self.progress_bar.setValue(0)

        self._set_bg_locked(True)

        thread = QThread(self)
        task = _BackgroundTask(fn, total=total)
        task.moveToThread(thread)

        task.progress.connect(self._on_bg_progress)

        def _finish_common():
            try:
                self.progress_bar.setVisible(False)
            except Exception:
                pass
            self._set_bg_locked(False)
            self._bg_kind = None
            self._bg_task = None
            self._bg_thread = None

            # If playback was requested during a background task, resume now.
            if getattr(self, '_pending_playback', False):
                self._pending_playback = False
                try:
                    self.start_playback()
                except Exception:
                    pass


        def _on_success(result):
            try:
                if on_success is not None:
                    on_success(result)
            finally:
                _finish_common()

        def _on_failed(err_text: str):
            try:
                print(err_text)
                if on_failed is not None:
                    on_failed(err_text)
            finally:
                _finish_common()

        task.finished.connect(_on_success)
        task.failed.connect(_on_failed)

        thread.started.connect(task.run)
        task.finished.connect(thread.quit)
        task.failed.connect(thread.quit)
        thread.finished.connect(task.deleteLater)
        thread.finished.connect(thread.deleteLater)

        self._bg_thread = thread
        self._bg_task = task
        thread.start()
        return True

    def _count_dirty_segments(self) -> int:
        total = 0
        for track in self.tracks:
            if getattr(track, 'track_type', None) != 'vocal':
                continue
            for state in getattr(track, 'segment_states', []) or []:
                if state.get('dirty'):
                    total += 1
        return total

    def _has_dirty_segments(self) -> bool:
        return self._count_dirty_segments() > 0

    def synthesize_audio_async(self, *, after=None):
        """Synthesize dirty segments in a background thread.

        `after` will be called on the UI thread after synthesis finishes.
        """
        total_segments = self._count_dirty_segments()
        if total_segments <= 0:
            if after is not None:
                after()
            return

        if self._is_bg_busy():
            # Coalesce repeated requests (e.g. multiple clicks)
            self._pending_synthesis = True
            return

        # Stop playback while mutating track audio buffers
        try:
            if self.is_playing:
                self.stop_playback(reset=False)
        except Exception:
            pass

        def _work(progress):
            hop_size = self.processor.config['hop_size'] if self.processor.config else 512
            processed = 0
            for track in self.tracks:
                if track.track_type != 'vocal':
                    continue
                for i, state in enumerate(track.segment_states):
                    if state.get('dirty'):
                        track.synthesize_segment(self.processor, i)
                        processed += 1
                        progress(processed, total_segments)
                track.update_full_audio(hop_size)
            return processed

        def _ok(_processed_count):
            self.status_label.setText(i18n.get("status.synthesis_complete"))

            if self._pending_synthesis:
                self._pending_synthesis = False
                # Re-run once more to pick up new dirty segments
                self.synthesize_audio_async(after=after)
                return

            if after is not None:
                after()

        def _fail(_err_text: str):
            self.status_label.setText(i18n.get("status.auto_synthesis_failed"))

        self._start_bg_task(
            kind='synthesize',
            status_text=i18n.get("status.synthesizing"),
            fn=_work,
            total=total_segments,
            on_success=_ok,
            on_failed=_fail,
        )

    def _close_playback_stream(self):
        stream = getattr(self, '_playback_stream', None)
        self._playback_stream = None

        if stream is None:
            return

        try:
            stream.stop()
        except Exception:
            pass

        try:
            stream.close()
        except Exception:
            pass

    def _on_stream_finished(self):
        """Called on the UI thread when the sounddevice stream finishes."""
        try:
            self._close_playback_stream()
        except Exception:
            pass

        if self.is_playing:
            self.is_playing = False
            self.playback_timer.stop()
            self.status_label.setText(i18n.get("status.stopped"))

    def _prepare_stream_playback_async(self):
        """Prepare per-track float32 buffers for callback mixing in a background thread."""
        if self._is_bg_busy():
            return

        def _work(_progress):
            sr = int(self.processor.config['audio_sample_rate']) if self.processor.config else 44100
            hop_size = int(self.processor.config['hop_size']) if self.processor.config else 512

            items = []
            max_len = 0

            for track in self.tracks:
                audio = self._get_track_audio_for_mix(track)
                if audio is None:
                    continue
                if len(audio) <= 0:
                    continue
                if audio.dtype != np.float32:
                    audio = audio.astype(np.float32)
                audio = np.ascontiguousarray(audio)

                start_sample = int(track.start_frame) * hop_size
                end_sample = start_sample + int(len(audio))
                if end_sample > max_len:
                    max_len = end_sample

                items.append((track, audio, start_sample))

            if max_len <= 0 or not items:
                return None

            return {
                'sr': sr,
                'hop_size': hop_size,
                'total_samples': int(max_len),
                'items': items,
            }

        def _ok(prep):
            self._start_stream_playback(prep)

        def _fail(_err_text: str):
            self.status_label.setText(i18n.get("status.load_failed"))

        self._start_bg_task(
            kind='prepare_playback',
            status_text=i18n.get("status.mixing"),
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )

    def _start_stream_playback(self, prep):
        if prep is None:
            return

        # Stop any existing playback first
        try:
            self._close_playback_stream()
        except Exception:
            pass
        try:
            sd.stop()
        except Exception:
            pass

        sr = int(prep.get('sr', 44100))
        hop_size = int(prep.get('hop_size', 512))
        total_samples = int(prep.get('total_samples', 0))
        items = prep.get('items', [])

        if total_samples <= 0 or not items:
            return

        # Mark where "stop(reset=False)" returns to
        self.playback_start_time = self.current_playback_time

        if self.current_playback_time < 0:
            self.current_playback_time = 0.0

        start_sample = int(self.current_playback_time * sr)
        if start_sample >= total_samples:
            start_sample = 0
            self.current_playback_time = 0.0
            self.play_cursor.setValue(0)

        self._playback_sr = sr
        self._playback_hop_size = hop_size
        self._playback_total_samples = total_samples
        self._playback_items = items
        with self._playback_lock:
            self._playback_sample_pos = int(start_sample)

        def _finished_callback():
            # sounddevice thread -> marshal to UI thread
            try:
                QTimer.singleShot(0, self._on_stream_finished)
            except Exception:
                pass

        def _callback(outdata, frames, _time_info, _status):
            outdata.fill(0)

            with self._playback_lock:
                pos = int(self._playback_sample_pos)
                total = int(self._playback_total_samples)

            if total <= 0 or pos >= total:
                raise sd.CallbackStop()

            n_avail = total - pos
            n = frames if frames <= n_avail else n_avail
            if n <= 0:
                raise sd.CallbackStop()

            items_local = self._playback_items

            # If any track is solo, only solo tracks are audible.
            solo_any = False
            for t, _buf, _start in items_local:
                if getattr(t, 'solo', False):
                    solo_any = True
                    break

            mix = np.zeros(n, dtype=np.float32)

            for t, buf, start in items_local:
                if getattr(t, 'muted', False):
                    continue
                if solo_any and (not getattr(t, 'solo', False)):
                    continue

                vol = float(getattr(t, 'volume', 1.0))
                if vol == 0.0:
                    continue

                src0 = pos - int(start)

                # No overlap with this output block
                if src0 >= len(buf) or src0 + n <= 0:
                    continue

                out0 = 0
                if src0 < 0:
                    out0 = -src0
                    src0 = 0

                take = min(n - out0, len(buf) - src0)
                if take <= 0:
                    continue

                mix[out0:out0 + take] += buf[src0:src0 + take] * vol

            np.clip(mix, -1.0, 1.0, out=mix)
            outdata[:n, 0] = mix

            with self._playback_lock:
                self._playback_sample_pos += int(n)

            if n < frames:
                raise sd.CallbackStop()

        try:
            self._playback_stream = sd.OutputStream(
                samplerate=sr,
                channels=1,
                dtype='float32',
                callback=_callback,
                finished_callback=_finished_callback,
            )
            self._playback_stream.start()
        except Exception as e:
            print(f"Playback error: {e}")
            self._close_playback_stream()
            return

        self.is_playing = True
        self.playback_timer.start()
        self.status_label.setText(i18n.get("status.playing"))

    def start_playback(self):
        # Ensure synthesis happens off the UI thread; playback itself is stream/callback mixed.
        if not self.tracks:
            return

        if self._is_bg_busy():
            self._pending_playback = True
            return

        if self._has_dirty_segments():
            self.synthesize_audio_async(after=self.start_playback)
            return

        self._prepare_stream_playback_async()

    def pause_playback(self):
        if not self.is_playing:
            return

        try:
            sr = int(self._playback_sr) if getattr(self, '_playback_sr', None) else 44100
            with self._playback_lock:
                self.current_playback_time = float(self._playback_sample_pos) / float(sr)
        except Exception:
            pass

        try:
            self._close_playback_stream()
        except Exception:
            pass

        try:
            sd.stop()
        except Exception:
            pass

        self.is_playing = False
        self.playback_timer.stop()
        self.status_label.setText(i18n.get("status.paused"))

    def stop_playback(self, reset=False):
        try:
            sr = int(self._playback_sr) if getattr(self, '_playback_sr', None) else 44100
            with self._playback_lock:
                self.current_playback_time = float(self._playback_sample_pos) / float(sr)
        except Exception:
            pass

        try:
            self._close_playback_stream()
        except Exception:
            pass

        try:
            sd.stop()
        except Exception:
            pass

        self.is_playing = False
        self.playback_timer.stop()

        if reset:
            self.current_playback_time = 0
            try:
                with self._playback_lock:
                    self._playback_sample_pos = 0
            except Exception:
                pass
            self.play_cursor.setValue(0)
            self.playback_start_time = 0
        else:
            # Return to start position
            self.current_playback_time = self.playback_start_time
            try:
                with self._playback_lock:
                    self._playback_sample_pos = int(self.current_playback_time * sr)
            except Exception:
                pass

            if self.processor.config:
                hop_size = self.processor.config['hop_size']
                sr_cfg = self.processor.config.get('audio_sample_rate', 44100)
                self.play_cursor.setValue(self.current_playback_time * sr_cfg / hop_size)
                self.timeline_panel.set_cursor_position(self.current_playback_time * sr_cfg / hop_size)

        self.status_label.setText(i18n.get("status.stopped"))


    def set_playback_position(self, x_frame):
        if x_frame < 0: x_frame = 0
        
        # Update cursor visual
        self.play_cursor.setValue(x_frame)
        self.timeline_panel.set_cursor_position(x_frame)
        
        # Update internal time
        if self.processor.config:
            hop_size = self.processor.config['hop_size']
            sr = self.processor.config.get('audio_sample_rate', 44100)
            self.current_playback_time = x_frame * hop_size / sr
            self.playback_start_time = self.current_playback_time # Update start time on seek
            
            if self.is_playing:
                # Pause playback on seek
                self.pause_playback()

    def update_cursor(self):
        if not self.is_playing:
            return

        # When using OutputStream callback playback, derive time from sample position.
        if getattr(self, '_playback_stream', None) is not None:
            try:
                sr = int(self._playback_sr) if getattr(self, '_playback_sr', None) else 44100
                with self._playback_lock:
                    self.current_playback_time = float(self._playback_sample_pos) / float(sr)
            except Exception:
                pass
        else:
            # Fallback (should rarely happen now)
            now = time.time()
            dt = now - self.last_wall_time
            self.last_wall_time = now
            self.current_playback_time += dt

        # Convert time to x (frames)
        if self.processor.config:
            hop_size = self.processor.config['hop_size']
            sr_cfg = self.processor.config.get('audio_sample_rate', 44100)
            x = self.current_playback_time * sr_cfg / hop_size
            self.play_cursor.setValue(x)
            self.timeline_panel.set_cursor_position(x)


    def update_views(self):
        self.waveform_view.setGeometry(self.plot_widget.plotItem.vb.sceneBoundingRect())
        self.waveform_view.linkedViewChanged(self.plot_widget.plotItem.vb, self.waveform_view.XAxis)
        # Sync timeline view X range if needed (already linked via setXLink)
        pass

    def load_model_dialog(self):
        folder = QFileDialog.getExistingDirectory(self, i18n.get("dialog.select_model_dir"))
        if folder:
            self.load_model(folder)

    def load_default_model(self):
        default_path = config_manager.get_default_model_path()
        if default_path and os.path.exists(default_path):
            try:
                self.processor.load_model(default_path)
                self.model_path = default_path
                if hasattr(self, 'status_label'):
                    self.status_label.setText(i18n.get("status.default_model_loaded") + f": {pathlib.Path(default_path).name}")
            except Exception as e:
                if hasattr(self, 'status_label'):
                    self.status_label.setText(i18n.get("status.default_model_failed") + f": {e}")

    def set_default_model_dialog(self):
        folder_path = QFileDialog.getExistingDirectory(self, i18n.get("dialog.select_default_model_dir"))
        if folder_path:
            config_manager.set_default_model_path(folder_path)
            QMessageBox.information(self, i18n.get("msg.success"), i18n.get("msg.default_model_set") + f": {folder_path}")
            # Optionally load it now if no model is loaded
            if self.model_path is None:
                self.load_model(folder_path)

    def load_model(self, folder):
        if self._is_bg_busy():
            return

        def _work(_progress):
            self.processor.load_model(folder)
            return folder

        def _ok(_folder):
            self.model_path = folder
            self.status_label.setText(i18n.get("status.model_loaded") + f": {pathlib.Path(folder).name}")

            # Update timeline hop_size if possible
            try:
                if self.processor.config and hasattr(self, 'timeline_panel'):
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
            except Exception:
                pass

        def _fail(err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.load_model_failed") + f":\n{err_text}")
            self.status_label.setText(i18n.get("status.model_load_failed"))

        self._start_bg_task(
            kind='load_model',
            status_text=i18n.get("status.loading_model") + f" {folder}...",
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )


    def load_audio_dialog(self):
        file_path, _ = QFileDialog.getOpenFileName(self, i18n.get("dialog.select_audio"), "", i18n.get("filter.audio_files"))
        if file_path:
            self.add_track_from_file(file_path)

    def on_files_dropped(self, files):
        for file_path in files:
            self.add_track_from_file(file_path)

    def add_track_from_file(self, file_path):
        if not os.path.exists(file_path):
            return

        # If a background task is running, queue the request.
        if self._is_bg_busy():
            self._pending_track_paths.append(file_path)
            try:
                self.status_label.setText(i18n.get("status.loading_track") + f" {os.path.basename(file_path)}... (queued)")
            except Exception:
                pass
            return

        name = os.path.basename(file_path)

        def _work(_progress):
            track = Track(name, file_path, track_type='vocal')
            track.load(self.processor)
            return track

        def _continue_queue():
            if self._pending_track_paths:
                next_path = self._pending_track_paths.pop(0)
                self.add_track_from_file(next_path)

        def _ok(track: Track):
            self.tracks.append(track)

            # Update Timeline
            try:
                if self.processor.config:
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
            except Exception:
                pass

            self.timeline_panel.refresh_tracks(self.tracks)
            self.timeline_panel.select_track(len(self.tracks) - 1)

            # Trigger selection logic manually since select_track doesn't emit signal
            self.on_track_selected(len(self.tracks) - 1)

            self.status_label.setText(i18n.get("status.track_loaded") + f": {name}")
            _continue_queue()

        def _fail(err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.load_track_failed") + f":\n{err_text}")
            self.status_label.setText(i18n.get("status.load_failed"))
            _continue_queue()

        self._start_bg_task(
            kind='add_track',
            status_text=i18n.get("status.loading_track") + f" {name}...",
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )


    def on_track_selected(self, index):
        self.current_track_idx = index
        track = self.current_track
        
        # Sync Timeline Selection (if triggered from elsewhere)
        # self.timeline_panel.select_track(index) # Avoid loop if triggered by timeline
        
        # Clear selection when switching tracks
        self.clear_selection(hide_box=True)

        self.update_plot()

    def on_track_mix_settings_changed(self, *_args):
        """Mark project as dirty when track-level mix/arrangement settings change.

        This covers volume/mute/solo/position changes which are saved into the project file.
        """
        self._set_dirty(True)



    def on_timeline_cursor_moved(self, x_frame):

        # Update playback position
        if self.processor.config:
            hop_size = self.processor.config['hop_size']
            sr = self.processor.config.get('audio_sample_rate', 44100)
            
            time_sec = x_frame * hop_size / sr
            self.current_playback_time = time_sec
            self.playback_start_time = time_sec
            
            self.play_cursor.setValue(x_frame)
            
            # If playing, restart from new position?
            if self.is_playing:
                self.stop_playback(reset=False)
                self.start_playback()

    def convert_track_type(self, track, new_type):
        # track is the Track object passed from signal
        if track.track_type == new_type:
            return

        if self._is_bg_busy():
            return

        track.track_type = new_type

        def _work(_progress):
            track.load(self.processor)
            return track

        def _ok(_track):
            self.status_label.setText(i18n.get("status.reloaded") + f": {track.name}")
            self.update_plot()

            # Update Timeline
            try:
                if self.processor.config:
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
            except Exception:
                pass

            self.timeline_panel.refresh_tracks(self.tracks)
            self.timeline_panel.select_track(self.current_track_idx)

        def _fail(err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.reload_track_failed") + f":\n{err_text}")
            self.status_label.setText(i18n.get("status.audio_load_failed"))

        self._start_bg_task(
            kind='reload_track',
            status_text=i18n.get("status.reloading_track") + f" {track.name}...",
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )


    def _get_track_audio_for_mix(self, track: Track):
        """Return audio buffer for mixing/export, applying tension post-FX for vocal tracks."""
        if track is None or track.synthesized_audio is None:
            return None

        audio = track.synthesized_audio

        if track.track_type != 'vocal':
            return audio

        tension = getattr(track, 'tension_edited', None)
        f0 = getattr(track, 'f0_edited', None)
        if tension is None or f0 is None:
            return audio

        # Skip if neutral
        try:
            if np.nanmax(np.abs(tension)) < 1e-6:
                return audio
        except Exception:
            return audio

        sr = self.processor.config['audio_sample_rate'] if self.processor.config else 44100
        hop_size = self.processor.config['hop_size'] if self.processor.config else 512

        key = (getattr(track, 'synth_version', 0), getattr(track, 'tension_version', 0), int(len(audio)))
        if getattr(track, '_tension_processed_key', None) == key and getattr(track, '_tension_processed_audio', None) is not None:
            return track._tension_processed_audio

        try:
            processed = apply_tension_tilt_pd(audio, sr, f0, tension, hop_size)
        except Exception as e:
            # Fail-safe: don't break playback/export
            print(f"Tension post-FX failed: {e}")
            processed = audio

        track._tension_processed_audio = processed
        track._tension_processed_key = key
        return processed

    def mix_tracks(self):
        max_len = 0
        active_tracks = [t for t in self.tracks if not t.muted]
        solo_tracks = [t for t in self.tracks if t.solo]
        if solo_tracks:
            active_tracks = solo_tracks

        if not active_tracks:
            return None

        hop_size = self.processor.config['hop_size'] if self.processor.config else 512

        for track in active_tracks:
            audio = self._get_track_audio_for_mix(track)
            if audio is not None:
                start_sample = track.start_frame * hop_size
                end_sample = start_sample + len(audio)
                max_len = max(max_len, end_sample)

        if max_len == 0:
            return None

        mixed_audio = np.zeros(max_len, dtype=np.float32)

        for track in active_tracks:
            audio = self._get_track_audio_for_mix(track)
            if audio is None:
                continue

            start_sample = track.start_frame * hop_size
            l = len(audio)
            mixed_audio[start_sample:start_sample + l] += audio * track.volume

        return mixed_audio


    def export_audio_dialog(self):
        # Ensure everything is synthesized (async) before exporting
        if self._has_dirty_segments():
            self.synthesize_audio_async(after=self.export_audio_dialog)
            return

        msg_box = QMessageBox(self)
        msg_box.setWindowTitle(i18n.get("dialog.export_audio"))
        msg_box.setText(i18n.get("msg.select_export_mode"))

        btn_mixed = msg_box.addButton(i18n.get("btn.export_mixed"), QMessageBox.ButtonRole.AcceptRole)
        btn_separated = msg_box.addButton(i18n.get("btn.export_separated"), QMessageBox.ButtonRole.AcceptRole)
        btn_cancel = msg_box.addButton(i18n.get("btn.cancel"), QMessageBox.ButtonRole.RejectRole)

        msg_box.exec()

        clicked_button = msg_box.clickedButton()
        if clicked_button == btn_cancel:
            return

        if clicked_button == btn_mixed:
            file_path, _ = QFileDialog.getSaveFileName(self, i18n.get("dialog.export_mixed"), "output.wav", "WAV Audio (*.wav)")
            if file_path:
                self.export_audio(file_path)

        elif clicked_button == btn_separated:
            dir_path = QFileDialog.getExistingDirectory(self, i18n.get("dialog.select_export_dir"))
            if dir_path:
                self.export_separated_tracks(dir_path)

    def export_separated_tracks(self, dir_path):
        """Export all active vocal tracks to separate WAV files (background thread)."""
        if self._is_bg_busy():
            return

        # Estimate total export count for progress
        total = 0
        for track in self.tracks:
            if track.track_type == 'vocal' and not track.muted and track.synthesized_audio is not None:
                total += 1

        def _work(progress):
            count = 0
            sr = self.processor.config['audio_sample_rate'] if self.processor.config else 44100
            hop_size = self.processor.config['hop_size'] if self.processor.config else 512

            for i, track in enumerate(self.tracks):
                if track.muted or track.track_type == 'bgm':
                    continue
                if track.synthesized_audio is None:
                    continue

                safe_name = "".join([c for c in track.name if c.isalnum() or c in (' ', '-', '_')]).strip()
                if not safe_name:
                    safe_name = f"track_{i+1}"

                file_path = os.path.join(dir_path, f"{safe_name}.wav")

                audio = self._get_track_audio_for_mix(track)
                if audio is None:
                    continue
                if audio.dtype != np.float32:
                    audio = audio.astype(np.float32)

                start_sample = track.start_frame * hop_size
                if start_sample > 0:
                    pad = np.zeros(start_sample, dtype=np.float32)
                    audio_to_save = np.concatenate((pad, audio))
                elif start_sample < 0:
                    start_idx = -start_sample
                    if start_idx < len(audio):
                        audio_to_save = audio[start_idx:]
                    else:
                        audio_to_save = np.array([], dtype=np.float32)
                else:
                    audio_to_save = audio

                wavfile.write(file_path, sr, audio_to_save)
                count += 1
                progress(count, total)

            return count

        def _ok(count: int):
            QMessageBox.information(self, i18n.get("msg.success"), i18n.get("msg.export_separated_success").format(count, dir_path))

        def _fail(_err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.export_failed"))

        self._start_bg_task(
            kind='export_separated',
            status_text=i18n.get("status.exporting") + f" {dir_path}...",
            fn=_work,
            total=total if total > 0 else None,
            on_success=_ok,
            on_failed=_fail,
        )

    def export_audio(self, file_path):
        """Export mixed audio to a single WAV file (background thread)."""
        if self._is_bg_busy():
            return

        def _work(_progress):
            mixed_audio = self.mix_tracks()
            if mixed_audio is None:
                return None

            if mixed_audio.dtype != np.float32:
                mixed_audio = mixed_audio.astype(np.float32)

            sr = self.processor.config['audio_sample_rate'] if self.processor.config else 44100
            wavfile.write(file_path, sr, mixed_audio)
            return file_path

        def _ok(result_path):
            if result_path is None:
                QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.no_audio_to_export"))
                return
            self.status_label.setText(i18n.get("status.export_success") + f": {result_path}")
            QMessageBox.information(self, i18n.get("msg.success"), i18n.get("msg.export_success") + f":\n{result_path}")

        def _fail(_err_text: str):
            self.status_label.setText(i18n.get("status.export_failed"))
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.export_failed"))

        self._start_bg_task(
            kind='export_mixed',
            status_text=i18n.get("status.exporting") + f" {file_path}...",
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )

    def open_project_dialog(self):

        file_path, _ = QFileDialog.getOpenFileName(self, i18n.get("menu.file.open"), "", "HifiShifter Project (*.hsp *.json)")
        if file_path:
            self.open_project(file_path)

    def open_project(self, file_path):
        if self._is_bg_busy():
            return

        # Clear current UI state quickly (UI thread)
        try:
            self.stop_playback(reset=True)
        except Exception:
            pass

        self.tracks = []
        self.current_track_idx = -1
        try:
            self.timeline_panel.refresh_tracks(self.tracks)
        except Exception:
            pass
        self.clear_selection(hide_box=True)
        self.update_plot()

        project_dir = os.path.dirname(os.path.abspath(file_path))

        def _work(progress):
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # Resolve & load model (heavy)
            loaded_model_path = None
            model_path = data.get('model_path')
            if model_path:
                if not os.path.exists(model_path):
                    rel_path = os.path.join(project_dir, model_path)
                    if os.path.exists(rel_path):
                        model_path = rel_path

                if os.path.exists(model_path):
                    # Direct call to avoid spawning nested background tasks
                    self.processor.load_model(model_path)
                    loaded_model_path = model_path

            params = data.get('params', {}) if isinstance(data, dict) else {}

            tracks: list[Track] = []
            missing_audio: list[str] = []

            if 'tracks' in data:
                t_list = data.get('tracks') or []
                total = len(t_list)
                for idx, t_data in enumerate(t_list):
                    file_p = t_data.get('file_path')
                    if not file_p:
                        continue

                    if not os.path.exists(file_p):
                        rel_p = os.path.join(project_dir, file_p)
                        if os.path.exists(rel_p):
                            file_p = rel_p

                    if not os.path.exists(file_p):
                        missing_audio.append(str(file_p))
                        progress(idx + 1, total)
                        continue

                    track = Track(t_data.get('name', os.path.basename(file_p)), file_p, t_data.get('type', 'vocal'))
                    track.load(self.processor)

                    track.shift_value = t_data.get('shift', 0.0)
                    track.muted = t_data.get('muted', False)
                    track.solo = t_data.get('solo', False)
                    track.volume = t_data.get('volume', 1.0)
                    track.start_frame = t_data.get('start_frame', 0)

                    if 'f0' in t_data and track.f0_edited is not None:
                        saved_f0 = np.array(t_data['f0'])
                        min_len = min(len(saved_f0), len(track.f0_edited))
                        track.f0_edited[:min_len] = saved_f0[:min_len]
                        for state in track.segment_states:
                            state['dirty'] = True

                    if 'tension' in t_data and getattr(track, 'tension_edited', None) is not None:
                        saved_tension = np.array(t_data['tension'], dtype=np.float32)
                        min_len = min(len(saved_tension), len(track.tension_edited))
                        track.tension_edited[:min_len] = saved_tension[:min_len]
                        track.tension_version += 1
                        track._tension_processed_audio = None
                        track._tension_processed_key = None

                    tracks.append(track)
                    progress(idx + 1, total)

            # Backward compatibility for v1.0
            elif 'audio_path' in data:
                audio_path = data['audio_path']
                if not os.path.exists(audio_path):
                    rel_p = os.path.join(project_dir, audio_path)
                    if os.path.exists(rel_p):
                        audio_path = rel_p

                if os.path.exists(audio_path):
                    track = Track(os.path.basename(audio_path), audio_path, 'vocal')
                    track.load(self.processor)

                    if 'f0' in data and track.f0_edited is not None:
                        saved_f0 = np.array(data['f0'])
                        min_len = min(len(saved_f0), len(track.f0_edited))
                        track.f0_edited[:min_len] = saved_f0[:min_len]
                        for state in track.segment_states:
                            state['dirty'] = True

                    if 'tension' in data and getattr(track, 'tension_edited', None) is not None:
                        saved_tension = np.array(data['tension'], dtype=np.float32)
                        min_len = min(len(saved_tension), len(track.tension_edited))
                        track.tension_edited[:min_len] = saved_tension[:min_len]
                        track.tension_version += 1
                        track._tension_processed_audio = None
                        track._tension_processed_key = None

                    if 'params' in data and 'shift' in data['params']:
                        track.shift_value = data['params']['shift']

                    tracks.append(track)

            return {
                'data': data,
                'loaded_model_path': loaded_model_path,
                'params': params,
                'tracks': tracks,
                'missing_audio': missing_audio,
            }

        def _ok(result: dict):
            loaded_model_path = result.get('loaded_model_path')
            if loaded_model_path:
                self.model_path = loaded_model_path
            else:
                # Keep previous model_path (if any), but warn user if project had a model path
                data = result.get('data', {})
                mp = (data.get('model_path') if isinstance(data, dict) else None)
                if mp:
                    QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.model_not_found") + f": {mp}")

            params = result.get('params', {}) or {}
            if 'bpm' in params:
                self.bpm_spin.setValue(params['bpm'])
            if 'beats' in params:
                self.beats_spin.setValue(params['beats'])

            self.tracks = result.get('tracks', []) or []

            # Update Timeline
            try:
                if self.processor.config:
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
            except Exception:
                pass
            self.timeline_panel.refresh_tracks(self.tracks)

            # Auto-select first track
            if self.tracks:
                self.timeline_panel.select_track(0)
                self.on_track_selected(0)

            self.project_path = file_path
            self._set_dirty(False)
            self.status_label.setText(i18n.get("status.project_loaded") + f": {file_path}")



            missing = result.get('missing_audio', []) or []
            if missing:
                # Show a short list to avoid extremely large dialogs
                preview = "\n".join(missing[:8])
                if len(missing) > 8:
                    preview += f"\n... (+{len(missing) - 8})"
                QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.audio_not_found") + ":\n" + preview)

        def _fail(err_text: str):
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.open_project_failed") + f":\n{err_text}")

        self._start_bg_task(
            kind='open_project',
            status_text=i18n.get("status.loading_project"),
            fn=_work,
            total=None,
            on_success=_ok,
            on_failed=_fail,
        )


    def save_project(self) -> bool:
        if self.project_path:
            return self._save_project_file(self.project_path)
        return self.save_project_as()

    def save_project_as(self) -> bool:
        file_path, _ = QFileDialog.getSaveFileName(self, i18n.get("menu.file.save_as"), "project.hsp", "HifiShifter Project (*.hsp *.json)")
        if not file_path:
            return False
        return self._save_project_file(file_path)

    def _save_project_file(self, file_path) -> bool:
        try:
            project_dir = os.path.dirname(os.path.abspath(file_path))

            
            tracks_data = []
            for track in self.tracks:
                # Try to make path relative
                try:
                    rel_path = os.path.relpath(track.file_path, project_dir)
                except ValueError:
                    rel_path = track.file_path # Different drive or cannot be relative

                t_data = {
                    'name': track.name,
                    'file_path': rel_path,
                    'type': track.track_type,
                    'shift': track.shift_value,
                    'muted': track.muted,
                    'solo': track.solo,
                    'volume': track.volume,
                    'start_frame': track.start_frame
                }
                if track.track_type == 'vocal' and track.f0_edited is not None:
                    t_data['f0'] = track.f0_edited.tolist()
                if track.track_type == 'vocal' and getattr(track, 'tension_edited', None) is not None:
                    t_data['tension'] = track.tension_edited.tolist()
                tracks_data.append(t_data)


            # Model path relative
            model_path_save = self.model_path
            if self.model_path:
                try:
                    model_path_save = os.path.relpath(self.model_path, project_dir)
                except ValueError:
                    model_path_save = self.model_path

            data = {
                'version': '2.1',
                'model_path': model_path_save,
                'params': {
                    'bpm': self.bpm_spin.value(),
                    'beats': self.beats_spin.value()
                },
                'tracks': tracks_data
            }
            
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4)
            
            self.project_path = file_path
            self._set_dirty(False)
            self.status_label.setText(i18n.get("status.project_saved") + f": {file_path}")
            return True


        except Exception as e:
            QMessageBox.critical(self, i18n.get("msg.error"), i18n.get("msg.save_project_failed") + f": {str(e)}")
            return False

    def closeEvent(self, event):
        """Prompt to save when closing a modified (dirty) project."""
        accept_close = True

        if getattr(self, 'is_dirty', False):
            proj_name = os.path.basename(self.project_path) if self.project_path else i18n.get("project.untitled")

            msg = QMessageBox(self)
            msg.setIcon(QMessageBox.Icon.Question)
            msg.setWindowTitle(i18n.get("dialog.unsaved_changes_title"))
            msg.setText(i18n.get("dialog.unsaved_changes_text").format(proj_name))

            btn_save = msg.addButton(i18n.get("btn.save"), QMessageBox.ButtonRole.AcceptRole)
            btn_discard = msg.addButton(i18n.get("btn.dont_save"), QMessageBox.ButtonRole.DestructiveRole)
            btn_cancel = msg.addButton(i18n.get("btn.cancel"), QMessageBox.ButtonRole.RejectRole)
            msg.setDefaultButton(btn_save)

            msg.exec()
            clicked = msg.clickedButton()

            if clicked == btn_cancel:
                accept_close = False
            elif clicked == btn_save:
                # Save-as may be cancelled or save failed.
                accept_close = bool(self.save_project())
            else:
                # btn_discard
                accept_close = True

        if not accept_close:
            event.ignore()
            return

        # Stop playback/streams on exit
        try:
            if getattr(self, 'is_playing', False):
                self.stop_playback(reset=False)
        except Exception:
            pass

        event.accept()



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

    def get_param_array(self, track: Track, param: str | None = None):
        param = param or getattr(self, 'edit_param', 'pitch')
        if param == 'tension':
            return getattr(track, 'tension_edited', None)
        return getattr(track, 'f0_edited', None)

    def get_param_curve_y(self, track: Track, param: str | None = None):
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
            # Scale to fit nicely in background
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

        if self.tool_mode == 'move' and is_left and self.move_start_x is not None:
            delta = mouse_point.x() - self.move_start_x
            new_start = int(self.move_start_frame + delta)
            if new_start < 0: new_start = 0
            
            if new_start != track.start_frame:
                track.start_frame = new_start
                self.update_plot()
                self.status_label.setText(f"移动音轨: {new_start} 帧")
                
        elif self.tool_mode == 'draw' and track.track_type == 'vocal' and (track.f0_edited is not None or getattr(track, 'tension_edited', None) is not None):
            if is_left or is_right:
                self.handle_draw(mouse_point, is_left, is_right)

                
        elif self.tool_mode == 'select':
            if self.is_selecting:
                # Update Selection Box
                rect = QRectF(self.selection_start_pos, mouse_point).normalized()
                self.selection_box_item.setRect(rect)
                # Force update to ensure visibility
                self.selection_box_item.update()
            elif self.is_dragging_selection:
                # Drag Selection
                dy = mouse_point.y() - self.drag_start_pos.y()

                if self.selection_mask is not None and self.drag_start_values is not None:
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
                     if abs(y - curve_y[x]) < 3.0: # Tolerance
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
        
        # Check if click is within the ViewBox geometry
        vb = self.plot_widget.plotItem.vb
        pos = ev.scenePos()
        if not vb.sceneBoundingRect().contains(pos):
            return
            
        if ev.button() == Qt.MouseButton.LeftButton or ev.button() == Qt.MouseButton.RightButton:
            ev.accept()
            mouse_point = vb.mapSceneToView(pos)
            
            is_left = (ev.button() == Qt.MouseButton.LeftButton)
            is_right = (ev.button() == Qt.MouseButton.RightButton)
            
            if self.tool_mode == 'move' and is_left:
                self.move_start_x = mouse_point.x()
                self.move_start_frame = track.start_frame
                self.plot_widget.setCursor(Qt.CursorShape.ClosedHandCursor)
            elif self.tool_mode == 'draw' and track.track_type == 'vocal' and (track.f0_edited is not None or getattr(track, 'tension_edited', None) is not None):
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
                    self.push_undo() # Push undo before drag starts
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

        # Adjust x by start_frame
        x = int(point.x()) - track.start_frame
        y = point.y()

        # Start of a new stroke?
        if self.last_mouse_pos is None:
            self.push_undo()

        edit_param = getattr(self, 'edit_param', 'pitch')

        # ---- Tension drawing (stored in [-100, 100], displayed on pitch axis via mapping) ----
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

        # ---- Pitch drawing (existing behavior) ----
        if track.f0_edited is None:
            return

        changed = False
        affected_range = (x, x) # Track min/max x affected

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

            self.last_mouse_pos = (x, y) # Store relative index
            self.update_plot()

            if changed:
                self._set_dirty(True)
                self.status_label.setText(i18n.get("status.pitch_modified_unsynth"))



    
    def mouseReleaseEvent(self, ev):
        if self.tool_mode == 'move':
            self.move_start_x = None
            self.plot_widget.setCursor(Qt.CursorShape.OpenHandCursor)
            
        self.last_mouse_pos = None
        super().mouseReleaseEvent(ev)

    def apply_shift(self, semitones):
        track = self.current_track
        if not track or track.track_type != 'vocal' or track.f0_edited is None:
            return
            
        delta = semitones - self.last_shift_value
        track.f0_edited += delta
        track.shift_value = semitones
        self.last_shift_value = semitones
        
        # Mark all segments as dirty on global shift
        for state in track.segment_states:
            state['dirty'] = True
        self.update_plot()

    def play_original(self):
        track = self.current_track
        if track and track.audio is not None:
            # Avoid fighting with the real-time stream
            try:
                if self.is_playing:
                    self.stop_playback(reset=False)
            except Exception:
                pass

            sd.stop()
            sd.play(track.audio, track.sr)


    def synthesize_and_play(self):
        # Start playback pipeline: synthesize (if needed) -> mix -> play
        self.stop_playback(reset=True)
        self.start_playback()


    def delete_track(self, index):
        if 0 <= index < len(self.tracks):
            # Deleting tracks while playing can lead to confusing audio state.
            try:
                if self.is_playing:
                    self.stop_playback(reset=True)
            except Exception:
                pass

            reply = QMessageBox.question(self, i18n.get("track.delete_confirm_title"), 
                                         i18n.get("track.delete_confirm_msg").format(self.tracks[index].name),
                                         QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, 
                                         QMessageBox.StandardButton.No)

            if reply == QMessageBox.StandardButton.Yes:
                del self.tracks[index]
                if self.current_track_idx == index:
                    self.current_track_idx = -1
                elif self.current_track_idx > index:
                    self.current_track_idx -= 1
                
                self.timeline_panel.refresh_tracks(self.tracks)
                self.update_plot()

    def copy_pitch(self, index):
        if 0 <= index < len(self.tracks):
            track = self.tracks[index]
            if track.f0_edited is not None:
                self.pitch_clipboard = track.f0_edited.copy()
                self.status_label.setText(f"Copied pitch from track '{track.name}'")
            else:
                self.status_label.setText("No pitch data to copy")

    def paste_pitch(self, index):
        if 0 <= index < len(self.tracks) and self.pitch_clipboard is not None:
            track = self.tracks[index]
            if track.f0_original is None:
                 QMessageBox.warning(self, "Paste Error", "Target track has no audio/pitch data.")
                 return

            target_len = len(track.f0_original)
            source_len = len(self.pitch_clipboard)
            
            if target_len != source_len:
                reply = QMessageBox.question(self, 'Paste Pitch', 
                                             f"Pitch length mismatch (Source: {source_len}, Target: {target_len}). Paste anyway? (Will be truncated/padded)",
                                             QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, 
                                             QMessageBox.StandardButton.No)
                if reply != QMessageBox.StandardButton.Yes:
                    return
            
            new_f0 = np.zeros(target_len)
            copy_len = min(target_len, source_len)
            new_f0[:copy_len] = self.pitch_clipboard[:copy_len]
            
            if copy_len < target_len:
                 new_f0[copy_len:] = track.f0_original[copy_len:]
            
            track.f0_edited = new_f0
            track.is_edited = True
            
            # Mark all segments as dirty
            for state in track.segment_states:
                state['dirty'] = True
                
            self.update_plot()
            self.status_label.setText(f"Pasted pitch to track '{track.name}'")
        else:
             self.status_label.setText("Clipboard empty or invalid index")

    def stop_audio(self):
        self.stop_playback()

    def paste_vocalshifter_clipboard_data(self):
        """
        读取并应用 VocalShifter 剪贴板数据
        """
        import os
        import struct
        import tempfile
        
        track = self.current_track
        if not track or track.track_type != 'vocal':
            QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.no_vocal_track_selected"))
            return
        
        if track.f0_edited is None:
            QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.no_pitch_data"))
            return
        
        # 构建文件路径
        temp_dir = os.path.join(tempfile.gettempdir(), 'vocalshifter_tmp')
        file_path_1 = os.path.join(temp_dir, 'vocalshifter_id.clb')
        file_path_2 = os.path.join(temp_dir, 'vocalshifter_le_id.clb')
        
        # 检查两个文件是否存在
        exists_1 = os.path.exists(file_path_1)
        exists_2 = os.path.exists(file_path_2)
        
        if not exists_1 and not exists_2:
            # 两个都不存在，报错
            QMessageBox.warning(self, i18n.get("msg.warning"), 
                            i18n.get("msg.vocalshifter_file_not_found") + f": {file_path_1} or {file_path_2}")
            return
        elif exists_1 and not exists_2:
            # 只有第一个存在
            file_path = file_path_1
        elif not exists_1 and exists_2:
            # 只有第二个存在
            file_path = file_path_2
        else:
            # 两个都存在，选择修改时间最晚的
            mtime_1 = os.path.getmtime(file_path_1)
            mtime_2 = os.path.getmtime(file_path_2)
            file_path = file_path_1 if mtime_1 >= mtime_2 else file_path_2
        
        try:
            self.status_label.setText(i18n.get("status.loading_vocalshifter_clipboard_data"))
            QApplication.processEvents()
            
            # 读取二进制文件
            with open(file_path, 'rb') as f:
                data = f.read()
            
            if len(data) == 0:
                QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.vocalshifter_file_empty"))
                return
            
            # 检查数据长度
            if len(data) % 0x80 != 0:
                QMessageBox.warning(self, i18n.get("msg.warning"), 
                                i18n.get("msg.vocalshifter_invalid_format"))
                return
            
            # 解析 VocalShifter 数据
            num_samples = len(data) // 0x80
            vocalshifter_clipboard_data = []
            
            for i in range(num_samples):
                sample_start = i * 0x80
                sample_data = data[sample_start:sample_start + 0x80]
                
                # 读取16个double值（每个8字节）
                doubles = []
                for j in range(16):
                    double_start = j * 8
                    double_bytes = sample_data[double_start:double_start + 8]
                    if len(double_bytes) == 8:
                        value = struct.unpack('<d', double_bytes)[0]  # 小端序
                        doubles.append(value)
                
                if len(doubles) >= 4:  # 至少需要4个值才能获取第1、第2和第3个
                    start_time = doubles[0]  # 第1个：起始时间（秒）
                    disable_edit = doubles[1]  # 第2个：是否禁用编辑 (1.0=是, 0.0=否)
                    pitch_cents = doubles[2]  # 第3个：音分
                    
                    # 只存储我们需要的数据
                    vocalshifter_clipboard_data.append((start_time, disable_edit, pitch_cents))
            
            if not vocalshifter_clipboard_data:
                QMessageBox.warning(self, i18n.get("msg.warning"), i18n.get("msg.no_valid_vocalshifter_clipboard_data"))
                return
            
            # 统计禁用了编辑的采样点数量
            disabled_count = sum(1 for _, disable_edit, _ in vocalshifter_clipboard_data if disable_edit == 1.0)
            
            # 将VocalShifter数据应用到当前音轨
            self.apply_vocalshifter_clipboard_to_track(track, vocalshifter_clipboard_data)
            
            self.status_label.setText(i18n.get("status.vocalshifter_clipboard_data_applied"))
            QMessageBox.information(self, i18n.get("msg.success"), 
                                i18n.get("msg.vocalshifter_clipboard_data_loaded") + 
                                f": {len(vocalshifter_clipboard_data)} {i18n.get('label.samples')}\n" +
                                i18n.get("msg.vocalshifter_disabled_samples") + f": {disabled_count}")
            
        except Exception as e:
            QMessageBox.critical(self, i18n.get("msg.error"), 
                                i18n.get("msg.load_vocalshifter_failed") + f": {str(e)}")
            self.status_label.setText(i18n.get("status.vocalshifter_clipboard_data_load_failed"))

    def apply_vocalshifter_clipboard_to_track(self, track, vocalshifter_clipboard_data):
        """
        将VocalShifter数据应用到音轨
        现在vocalshifter_clipboard_data是一个三元组列表：(start_time, disable_edit, pitch_cents)
        """
        # 推入撤销栈
        self.push_undo()
        
        # 获取音频参数
        sr = track.sr if track.sr else self.processor.config['audio_sample_rate']
        hop_size = self.processor.config['hop_size']
        
        # 按时间排序
        vocalshifter_clipboard_data.sort(key=lambda x: x[0])
        
        # 将VocalShifter数据映射到f0帧
        for i in range(len(track.f0_edited)):
            # 计算当前帧对应的时间（秒）
            frame_time = (i * hop_size) / sr
            
            # 找到最接近的VocalShifter采样点
            closest_sample = None
            min_time_diff = float('inf')
            
            for sample_time, disable_edit, sample_pitch in vocalshifter_clipboard_data:
                time_diff = abs(frame_time - sample_time)
                if time_diff < min_time_diff:
                    min_time_diff = time_diff
                    closest_sample = (sample_time, disable_edit, sample_pitch)
            
            # 如果找到足够接近的采样点，则应用音高
            if closest_sample and min_time_diff < (hop_size / sr):  # 在半个hop_size范围内
                _, disable_edit, target_pitch = closest_sample
                
                if disable_edit == 1.0:
                    # 禁用编辑：恢复初始音高
                    if track.f0_original is not None and i < len(track.f0_original):
                        track.f0_edited[i] = track.f0_original[i]
                else:
                    # 未禁用编辑：应用修正后的音高
                    # 将音分转换为MIDI音高
                    midi_pitch = target_pitch / 100.0
                    track.f0_edited[i] = midi_pitch
        
        # 标记所有段为脏，需要重新合成
        for state in track.segment_states:
            state['dirty'] = True
        
        # 更新绘图
        self.update_plot()

    def open_vocalshifter_project_dialog(self):
        """打开VocalShifter工程文件"""
        file_path, _ = QFileDialog.getOpenFileName(
            self, 
            i18n.get("dialog.open_vocalshifter_project"), 
            "", 
            "VocalShifter Project (*.vshp *.vsp)"
        )
        if file_path:
            self.load_vocalshifter_project(file_path)

    def load_vocalshifter_project(self, file_path):
        """加载并解析VocalShifter工程文件"""
        import locale
        import struct
        try:
            self.status_label.setText(i18n.get("status.loading_vocalshifter_project"))
            QApplication.processEvents()
            
            with open(file_path, 'rb') as f:
                # 1. 检查文件头
                header = f.read(16)
                if header[:4] != b'VSPD':
                    QMessageBox.critical(self, i18n.get("msg.error"), 
                                    i18n.get("msg.vocalshifter_invalid_header"))
                    return
                
                # 读取文件大小（小端序）
                file_size = struct.unpack('<I', header[12:16])[0]
                
                # 存储工程文件夹路径，用于解析相对路径
                project_dir = os.path.dirname(os.path.abspath(file_path))
                
                # 解析数据块
                project_info = {}
                tracks = []
                audio_blocks = []  # ITMP数据块
                itmp_audio_blocks = []  # Itmp数据块（包含Ctrp数据）
                
                current_offset = 16  # 跳过文件头
                
                # 第一轮：收集所有ITMP数据块
                f.seek(current_offset)
                while current_offset < file_size:
                    chunk_header = f.read(8)
                    
                    if len(chunk_header) < 8:
                        break
                        
                    chunk_type = chunk_header[:4]
                    chunk_version = struct.unpack('<I', chunk_header[4:8])[0]
                    
                    if chunk_type == b'PRJP':
                        # PRJP 数据块 - 工程信息
                        prjp_data = f.read(0x108 - 8)  # 总长度0x108，减去已读的8字节
                        
                        # 采样率 (偏移16字节，相对于PRJP数据开始)
                        sample_rate = struct.unpack('<I', prjp_data[16:20])[0]
                        
                        # 拍号分子 (偏移20字节)
                        beats_per_bar = struct.unpack('<I', prjp_data[20:24])[0]
                        
                        # 拍号分母 (偏移24字节)
                        beat_unit = struct.unpack('<I', prjp_data[24:28])[0]
                        
                        # BPM (偏移32字节)
                        bpm = struct.unpack('<d', prjp_data[32:40])[0]
                        
                        project_info = {
                            'sample_rate': sample_rate,
                            'beats_per_bar': beats_per_bar,
                            'beat_unit': beat_unit,
                            'bpm': bpm
                        }
                        
                        current_offset += 0x108
                        
                    elif chunk_type == b'TRKP':
                        # TRKP 数据块 - 轨道信息
                        trkp_data = f.read(0x108 - 8)
                        
                        # 轨道名称 (64字节，系统本地编码)
                        track_name_bytes = trkp_data[0:64]
                        # 找到第一个null终止符
                        null_pos = track_name_bytes.find(b'\x00')
                        if null_pos != -1:
                            track_name_bytes = track_name_bytes[:null_pos]
                        
                        # 解码为系统默认编码
                        track_name = track_name_bytes.decode(locale.getpreferredencoding())
                        
                        # 音量倍率 (偏移64字节)
                        volume = struct.unpack('<d', trkp_data[64:72])[0]
                        
                        # 声像 (偏移72字节) - HifiShifter不支持，忽略
                        # pan = struct.unpack('<d', trkp_data[72:80])[0]
                        
                        # 静音 (偏移80字节)
                        muted = struct.unpack('<I', trkp_data[80:84])[0] == 1
                        
                        # 独奏 (偏移84字节)
                        solo = struct.unpack('<I', trkp_data[84:88])[0] == 1
                        
                        # 反相 (偏移96字节) - HifiShifter不支持，忽略
                        # inverted = struct.unpack('<I', trkp_data[96:100])[0] == 1
                        
                        track_info = {
                            'name': track_name,
                            'volume': volume,
                            'muted': muted,
                            'solo': solo
                        }
                        
                        tracks.append(track_info)
                        current_offset += 0x108
                        
                    elif chunk_type == b'ITMP':
                        # ITMP 数据块 - 音频块信息
                        itmp_data = f.read(0x208 - 8)
                        
                        # 音频文件路径 (从偏移0开始，直到0x00)
                        path_bytes = bytearray()
                        for i in range(0, 0x108):
                            byte = itmp_data[i:i+1]
                            if byte == b'\x00':
                                break
                            path_bytes.extend(byte)
                        
                        # 解码为系统默认编码
                        file_path_str = path_bytes.decode(locale.getpreferredencoding())
                        
                        # 解析轨道索引 (偏移0x108)
                        track_index = struct.unpack('<I', itmp_data[0x108:0x10C])[0]
                        
                        # 起始位置 (偏移0x110，单位：采样点)
                        start_position_samples = struct.unpack('<d', itmp_data[0x110:0x118])[0]
                        
                        # 转换为秒
                        start_position_seconds = start_position_samples / project_info.get('sample_rate', 44100)
                        
                        # 转换为HifiShifter的帧单位（需要hop_size）
                        hop_size = self.processor.config.get('hop_size', 512) if self.processor.config else 512
                        start_frame = int(start_position_seconds * project_info.get('sample_rate', 44100) / hop_size)
                        
                        audio_block = {
                            'file_path': file_path_str,
                            'track_index': track_index,
                            'start_position_samples': start_position_samples,
                            'start_position_seconds': start_position_seconds,
                            'start_frame': start_frame,
                            'tuning_samples': []  # 将在后面填充Ctrp数据
                        }
                        
                        audio_blocks.append(audio_block)
                        current_offset += 0x208
                        
                    else:
                        # 未知数据块，跳过8字节
                        current_offset += 8
                        f.seek(current_offset)
                
                # 第二轮：收集所有Itmp数据块和对应的Ctrp数据
                current_offset = 16  # 重置偏移，重新扫描文件
                f.seek(current_offset)
                itmp_block_index = 0  # 用于跟踪Itmp数据块的顺序
                
                while current_offset < file_size:
                    chunk_header = f.read(8)
                    
                    if len(chunk_header) < 8:
                        break
                        
                    chunk_type = chunk_header[:4]
                    chunk_version = struct.unpack('<I', chunk_header[4:8])[0]
                    
                    if chunk_type == b'Itmp':
                        # Itmp 数据块 - 音频块调音数据头
                        itmp_data = f.read(0x108 - 8)  # 总长度0x108，减去已读的8字节
                        
                        # 创建Itmp音频块记录
                        itmp_block = {
                            'index': itmp_block_index,
                            'tuning_samples': []
                        }
                        
                        # 检查是否有对应的ITMP音频块
                        if itmp_block_index < len(audio_blocks):
                            # 将Itmp块与对应的ITMP块关联
                            audio_blocks[itmp_block_index]['itmp_block'] = itmp_block
                        
                        current_offset += 0x108
                        f.seek(current_offset)
                        
                        # 读取紧随其后的Ctrp数据块
                        while current_offset < file_size:
                            # 预读下一个数据块头
                            next_chunk_header = f.read(8)
                            if len(next_chunk_header) < 8:
                                break
                            
                            next_chunk_type = next_chunk_header[:4]
                            
                            if next_chunk_type == b'Ctrp':
                                # Ctrp 数据块 - 调音采样点
                                ctrp_data = f.read(0x68 - 8)  # 总长度0x68，减去已读的8字节
                                
                                # 是否禁用编辑 (偏移18字节)
                                disabled = struct.unpack('<h', ctrp_data[18:20])[0] == 1
                                
                                # 修正后的音高 (偏移22字节，单位：音分)
                                pitch_cents = struct.unpack('<h', ctrp_data[22:24])[0]
                                
                                # 转换为MIDI音高
                                # VocalShifter: 0 = C-1, 6000 = C4
                                # 转换为MIDI: C-1 = MIDI 0, C4 = MIDI 60
                                # 音分转半音: pitch_cents / 100
                                # C-1是MIDI 0，所以: midi_pitch = pitch_cents / 100
                                midi_pitch = pitch_cents / 100.0
                                
                                tuning_sample = {
                                    'disabled': disabled,
                                    'pitch_cents': pitch_cents,
                                    'midi_pitch': midi_pitch
                                }
                                
                                # 添加到Itmp块的调音采样点列表
                                itmp_block['tuning_samples'].append(tuning_sample)
                                
                                # 如果有关联的ITMP音频块，也添加到那里
                                if itmp_block_index < len(audio_blocks):
                                    audio_blocks[itmp_block_index]['tuning_samples'].append(tuning_sample)
                                
                                current_offset += 0x68
                                f.seek(current_offset)
                            else:
                                # 不是Ctrp数据块，回退8字节并跳出循环
                                f.seek(current_offset)  # 回到数据块开始位置
                                break
                        
                        itmp_block_index += 1
                    else:
                        # 其他数据块，跳过8字节
                        current_offset += 8
                        f.seek(current_offset)
                
                # 现在我们已经解析了所有数据，开始创建HifiShifter工程
                
                # 清空当前工程
                self.tracks = []
                self.current_track_idx = -1
                self.timeline_panel.refresh_tracks([])
                
                # 设置工程参数
                if project_info:
                    self.bpm_spin.setValue(project_info.get('bpm', 120))
                    # 设置网格单位（拍号）
                    # HifiShifter使用beats_spin表示拍号分子，分母固定为4
                    # 所以我们需要将VocalShifter的拍号转换为HifiShifter的格式
                    beats_per_bar = project_info.get('beats_per_bar', 4)
                    beat_unit = project_info.get('beat_unit', 4)
                    
                    # 如果分母是4，直接使用分子
                    if beat_unit == 4:
                        self.beats_spin.setValue(beats_per_bar)
                    else:
                        # 否则进行转换（简化处理）
                        self.beats_spin.setValue(beats_per_bar)
                        QMessageBox.information(self, i18n.get("msg.info"), 
                                            i18n.get("msg.time_signature_converted") + 
                                            f" {beats_per_bar}/{beat_unit} -> {beats_per_bar}/4")
                
                # 统计无法导入的文件
                unsupported_files = []
                
                # 为每个音频块创建轨道
                for i, audio_block in enumerate(audio_blocks):
                    # 解析文件路径
                    raw_path = audio_block['file_path']
                    
                    # 检查是否是相对路径
                    if not os.path.isabs(raw_path):
                        # 尝试相对于工程文件路径
                        abs_path = os.path.join(project_dir, raw_path)
                    else:
                        abs_path = raw_path
                    
                    # 检查文件是否存在
                    if not os.path.exists(abs_path):
                        # 尝试在工程文件夹内查找
                        file_name = os.path.basename(raw_path)
                        alt_path = os.path.join(project_dir, file_name)
                        if os.path.exists(alt_path):
                            abs_path = alt_path
                        else:
                            unsupported_files.append(f"{raw_path} ({i18n.get('msg.file_not_found')})")
                            continue
                    
                    # 检查文件格式是否支持
                    file_ext = os.path.splitext(abs_path)[1].lower()
                    supported_extensions = {'.wav', '.flac', '.mp3'}
                    
                    if file_ext not in supported_extensions:
                        unsupported_files.append(f"{raw_path} ({i18n.get('msg.unsupported_format')})")
                        continue
                    
                    # 获取对应的轨道信息
                    track_info = None
                    if audio_block['track_index'] < len(tracks):
                        track_info = tracks[audio_block['track_index']]
                    
                    # 创建轨道名称
                    if track_info:
                        # 如果轨道中有多个音频块，添加序号
                        track_count_in_track = sum(1 for ab in audio_blocks if ab['track_index'] == audio_block['track_index'])
                        if track_count_in_track > 1:
                            track_name = f"{track_info['name']}_{i+1}"
                        else:
                            track_name = track_info['name']
                    else:
                        track_name = f"Track_{i+1}"
                    
                    # 创建并加载轨道
                    try:
                        track = Track(track_name, abs_path, track_type='vocal')
                        track.load(self.processor)
                        
                        # 设置轨道参数
                        if track_info:
                            track.volume = track_info.get('volume', 1.0)
                            track.muted = track_info.get('muted', False)
                            track.solo = track_info.get('solo', False)
                        
                        # 设置起始位置
                        track.start_frame = audio_block['start_frame']
                        
                        # 应用调音采样点数据
                        if audio_block['tuning_samples'] and track.f0_edited is not None:
                            # 将调音采样点应用到音高曲线
                            self.apply_vocalshifter_tuning_samples(track, audio_block['tuning_samples'])
                        
                        self.tracks.append(track)
                        
                    except Exception as e:
                        unsupported_files.append(f"{raw_path} ({str(e)})")
                
                # 更新UI
                if self.processor.config:
                    self.timeline_panel.hop_size = self.processor.config['hop_size']
                self.timeline_panel.refresh_tracks(self.tracks)
                
                # 如果有无法导入的文件，显示警告
                if unsupported_files:
                    warning_msg = i18n.get("msg.unsupported_files_found") + ":\n\n"
                    warning_msg += "\n".join(unsupported_files[:10])  # 最多显示10个
                    if len(unsupported_files) > 10:
                        warning_msg += f"\n\n...{len(unsupported_files) - 10} more"
                    
                    QMessageBox.warning(self, i18n.get("msg.warning"), warning_msg)
                
                self.status_label.setText(i18n.get("status.vocalshifter_project_loaded"))
                
        except Exception as e:
            QMessageBox.critical(self, i18n.get("msg.error"), 
                            i18n.get("msg.load_vocalshifter_project_failed") + f": {str(e)}")
            import traceback
            traceback.print_exc()
            self.status_label.setText(i18n.get("status.vocalshifter_load_failed"))

    def apply_vocalshifter_tuning_samples(self, track, tuning_samples):
        """
        将VocalShifter调音采样点应用到音轨
        每个调音采样点时间长度为0.005秒，相邻点之间线性插值
        """
        if not tuning_samples or track.f0_edited is None:
            return
        
        # 推入撤销栈
        self.push_undo()
        
        # 获取音频参数
        sr = track.sr if track.sr else self.processor.config['audio_sample_rate']
        hop_size = self.processor.config['hop_size']
        
        # 创建调音采样点的时间-音高列表
        # 每个调音采样点对应0.005秒
        time_pitch_pairs = []
        
        for i, sample in enumerate(tuning_samples):
            # 计算采样点时间（秒）
            sample_time = i * 0.005
            
            # 如果禁用编辑，则使用原始音高
            if sample.get('disabled', False):
                # 需要找到对应时间的原始音高
                # 我们将这个点标记为特殊值，稍后处理
                time_pitch_pairs.append((sample_time, None, True))  # (时间, 音高, 是否禁用)
            else:
                # 使用修正后的音高
                midi_pitch = sample.get('midi_pitch', 0)
                time_pitch_pairs.append((sample_time, midi_pitch, False))
        
        if not time_pitch_pairs:
            return
        
        # 计算音频总时长（秒）
        audio_duration = len(track.audio) / sr if track.audio is not None else 0
        
        # 处理每个音高帧
        for i in range(len(track.f0_edited)):
            # 计算当前帧对应的时间（秒）
            frame_time = (i * hop_size) / sr
            
            # 如果超出音频时长，跳过
            if frame_time > audio_duration:
                continue
            
            # 找到当前时间所在的两个调音采样点
            sample_index = int(frame_time / 0.005)
            next_sample_index = sample_index + 1
            
            # 处理边界情况
            if sample_index >= len(time_pitch_pairs):
                # 超出最后一个采样点，使用最后一个采样点的值
                last_time, last_pitch, last_disabled = time_pitch_pairs[-1]
                if last_disabled:
                    # 使用原始音高
                    if track.f0_original is not None and i < len(track.f0_original):
                        track.f0_edited[i] = track.f0_original[i]
                elif last_pitch is not None:
                    track.f0_edited[i] = last_pitch
                continue
            
            if sample_index < 0:
                # 在第一个采样点之前，使用第一个采样点的值
                first_time, first_pitch, first_disabled = time_pitch_pairs[0]
                if first_disabled:
                    # 使用原始音高
                    if track.f0_original is not None and i < len(track.f0_original):
                        track.f0_edited[i] = track.f0_original[i]
                elif first_pitch is not None:
                    track.f0_edited[i] = first_pitch
                continue
            
            # 获取当前采样点和下一个采样点
            current_time, current_pitch, current_disabled = time_pitch_pairs[sample_index]
            
            if next_sample_index >= len(time_pitch_pairs):
                # 没有下一个采样点，使用当前采样点的值
                if current_disabled:
                    # 使用原始音高
                    if track.f0_original is not None and i < len(track.f0_original):
                        track.f0_edited[i] = track.f0_original[i]
                elif current_pitch is not None:
                    track.f0_edited[i] = current_pitch
                continue
            
            next_time, next_pitch, next_disabled = time_pitch_pairs[next_sample_index]
            
            # 计算时间比例（用于线性插值）
            time_ratio = (frame_time - current_time) / (next_time - current_time)
            
            # 处理两个采样点都禁用的情况
            if current_disabled and next_disabled:
                # 两个点都禁用，使用原始音高
                if track.f0_original is not None and i < len(track.f0_original):
                    track.f0_edited[i] = track.f0_original[i]
                continue
            
            # 处理只有一个点禁用的情况
            if current_disabled:
                # 当前点禁用，使用原始音高
                if track.f0_original is not None and i < len(track.f0_original):
                    track.f0_edited[i] = track.f0_original[i]
                continue
            
            if next_disabled:
                # 下一个点禁用，使用当前点的音高（不插值）
                if current_pitch is not None:
                    track.f0_edited[i] = current_pitch
                continue
            
            # 两个点都未禁用，进行线性插值
            if current_pitch is not None and next_pitch is not None:
                interpolated_pitch = current_pitch + (next_pitch - current_pitch) * time_ratio
                track.f0_edited[i] = interpolated_pitch
        
        # 标记所有段为脏，需要重新合成
        for state in track.segment_states:
            state['dirty'] = True
        
        # 更新绘图
        self.update_plot()