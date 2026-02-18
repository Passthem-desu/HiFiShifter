from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QAction, QActionGroup, QKeySequence
from PyQt6.QtWidgets import QApplication, QMessageBox

from .. import config_manager, theme
from utils.i18n import i18n


class MenuMixin:
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
