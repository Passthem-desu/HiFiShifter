from __future__ import annotations

from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hifi_shifter.web_api import HifiShifterWebAPI


def main():
    api = HifiShifterWebAPI()

    print('ping:', api.ping())
    print('runtime(before):', api.get_runtime_info())

    model_dir = REPO_ROOT / 'pc_nsf_hifigan_44.1k_hop512_128bin_2025.02'
    res = api.load_model(str(model_dir))
    print('load_model:', res)
    if not res.get('ok'):
        raise SystemExit(1)

    print('runtime(after):', api.get_runtime_info())


if __name__ == '__main__':
    main()
