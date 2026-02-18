"""Compatibility module.

Historically the entire GUI lived in this file.
It has been refactored into `hifi_shifter.gui` for better readability and maintainability.

Keep importing `HifiShifterGUI` from here to avoid breaking external entrypoints.
"""

from .gui.window import HifiShifterGUI

__all__ = ["HifiShifterGUI"]
