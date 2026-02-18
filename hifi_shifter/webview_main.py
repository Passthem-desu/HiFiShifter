from __future__ import annotations

from pathlib import Path

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

    api = HifiShifterWebAPI()
    webview.create_window(
        title='HiFiShifter (WebView)',
        url=ui_index.as_uri(),
        js_api=api,
        width=1320,
        height=860,
        min_size=(980, 680),
    )
    webview.start(debug=False, http_server=True)


if __name__ == '__main__':
    main()
