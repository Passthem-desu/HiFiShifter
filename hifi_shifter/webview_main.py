from __future__ import annotations

from pathlib import Path
import os

import webview

from .web_api import HifiShifterWebAPI


def main():
    root = Path(__file__).resolve().parents[1]
    ui_index = root / 'frontend' / 'dist' / 'index.html'
    if not ui_index.exists():
        raise FileNotFoundError(
            f'Web UI dist not found: {ui_index}. '
            'Please run: cd frontend && npm install && npm run build'
        )

    debug = str(os.getenv('PYWEBVIEW_DEBUG', '')).strip().lower() in {'1', 'true', 'yes', 'on'}
    # Force modern engine: Vite build uses ES modules.
    gui = str(os.getenv('HS_WEBVIEW_GUI', 'edgechromium')).strip() or 'edgechromium'

    api = HifiShifterWebAPI()
    webview.create_window(
        title='HiFiShifter (WebView)',
        # NOTE: When using http_server=True, pass a local file path so pywebview
        # can correctly determine the server root and serve relative assets (./assets/*).
        url=str(ui_index),
        js_api=api,
        width=1320,
        height=860,
        min_size=(980, 680),
    )
    try:
        webview.start(debug=debug, http_server=True, gui=gui)
    except Exception as exc:
        # Most common reason for a "white screen" on Windows is falling back to MSHTML/IE,
        # which cannot run modern ES-module bundles. Force EdgeChromium, and if it fails,
        # provide a clear action item.
        raise RuntimeError(
            'Failed to start pywebview with a modern engine. '\
            'Please ensure Microsoft Edge WebView2 Runtime is installed, '\
            'or set env HS_WEBVIEW_GUI=edgechromium explicitly. '\
            f'Original error: {exc}'
        )


if __name__ == '__main__':
    main()
