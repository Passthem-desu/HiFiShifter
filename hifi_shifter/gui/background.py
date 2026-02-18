from __future__ import annotations

import traceback
from typing import Any, Callable

from PyQt6.QtCore import QObject, QThread, pyqtSignal


class _BackgroundTask(QObject):
    """Run a callable in a QThread and report back via Qt signals.

    Important: the callable MUST NOT touch Qt widgets directly.
    """

    finished = pyqtSignal(object)
    failed = pyqtSignal(str)
    progress = pyqtSignal(int, int)  # current, total

    def __init__(self, fn: Callable[[Callable[[int, int | None], None]], Any], *, total: int | None = None):
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


class BackgroundMixin:
    """Background task utilities.

    Expects the window to define:
    - `progress_bar`, `status_label`
    - `_bg_thread`, `_bg_task`, `_bg_kind`, `_pending_playback`
    """

    def _is_bg_busy(self) -> bool:
        return self._bg_thread is not None and self._bg_thread.isRunning()

    def _set_bg_locked(self, locked: bool):
        """Disable interactive UI while a background task is running."""
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

    def _start_bg_task(
        self,
        *,
        kind: str,
        status_text: str,
        fn,
        total: int | None = None,
        on_success=None,
        on_failed=None,
    ) -> bool:
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
