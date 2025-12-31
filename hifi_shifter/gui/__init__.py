"""GUI package.

This subpackage contains UI mixins and helpers used by `HifiShifterGUI`.
The goal is to keep the window class small and split responsibilities by feature.
"""

from .window import HifiShifterGUI

__all__ = ["HifiShifterGUI"]
