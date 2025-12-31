from __future__ import annotations

import os
import threading

from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication, QMainWindow

from ..audio_processor import AudioProcessor
from .. import config_manager, theme
from utils.i18n import i18n

from .background import BackgroundMixin
from .editor import EditorMixin
from .exporter import ExportMixin
from .layout import LayoutMixin
from .menu import MenuMixin
from .mixdown import MixdownMixin
from .params import ParamsMixin
from .playback import PlaybackMixin
from .plotting import PlottingMixin
from .project_io import ProjectIOMixin
from .synthesis import SynthesisMixin
from .tracks import TracksMixin
from .vocalshifter import VocalShifterMixin


class HifiShifterGUI(
    QMainWindow,
    MenuMixin,
    LayoutMixin,
    ParamsMixin,
    PlottingMixin,
    EditorMixin,
    BackgroundMixin,
    SynthesisMixin,
    MixdownMixin,
    PlaybackMixin,
    TracksMixin,
    ProjectIOMixin,
    ExportMixin,
    VocalShifterMixin,
):
    def __init__(self):
        super().__init__()

        # Initialize Language
        lang = config_manager.get_language()
        # NOTE: this file lives in `hifi_shifter/gui/`, so project root is 3 levels up.
        root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
        self.tool_mode = 'draw'  # 'draw' | 'select' | (legacy: 'move')

        # Playback State
        self.is_playing = False
        self.current_playback_time = 0.0  # seconds
        self.playback_start_time = 0.0  # seconds (for return to start)
        self.last_wall_time = 0.0

        # Real-time playback stream state (so volume/mute/solo changes apply during playback)
        self._playback_stream = None
        self._playback_lock = threading.RLock()
        self._playback_items = []  # list[(Track, np.ndarray(float32), start_sample)]
        self._playback_sample_pos = 0
        self._playback_total_samples = 0
        self._playback_sr = 44100
        self._playback_hop_size = 512

        # Background task state (keep heavy work off the UI thread)
        self._bg_thread = None
        self._bg_task = None
        self._bg_kind = None
        self._pending_track_paths = []
        self._pending_synthesis = False
        self._pending_playback = False

        # Clipboard
        self.pitch_clipboard = None

        # Interaction State
        self.is_drawing = False
        self.last_mouse_pos = None

        # Legacy move tool state (defensive init)
        self.move_start_x = None
        self.move_start_frame = 0

        # Shift tool state (defensive init)
        self.last_shift_value = 0.0

        self.init_ui()
        self.load_default_model()

    @property
    def current_track(self):
        if 0 <= self.current_track_idx < len(self.tracks):
            return self.tracks[self.current_track_idx]
        return None
