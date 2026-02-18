import sys
import os
import argparse

# Ensure the current directory is in sys.path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))


def _run_pywebview():
    from hifi_shifter.webview_main import main
    main()


def _run_legacy_pyqt():
    from hifi_shifter.main import main
    main()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Run HiFiShifter GUI')
    parser.add_argument('--legacy-pyqt', action='store_true', help='Run legacy PyQt GUI')
    args = parser.parse_args()

    if args.legacy_pyqt:
        _run_legacy_pyqt()
    else:
        _run_pywebview()
