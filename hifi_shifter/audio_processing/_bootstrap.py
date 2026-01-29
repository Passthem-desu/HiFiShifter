from __future__ import annotations

import sys
from pathlib import Path


def ensure_project_root_on_sys_path() -> Path:
    """Ensure repository root is on sys.path.

    This project keeps some modules (e.g. `training/`, `utils/`) at repo root.
    When launching via different entrypoints, the repo root may not be on sys.path.
    """
    root = Path(__file__).resolve().parents[2]
    root_str = str(root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    return root
