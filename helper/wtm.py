#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""wtm — resolve the primary checkout / workspace, mirroring the current subdirectory.

See helper/README.md for the shell contract and wrapper configuration.
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

_here = Path(__file__).resolve().parent
_wt = _here / "wt.py"

if not _wt.is_file():
    print(f"wtm: companion helper not found at {_wt}", file=sys.stderr)
    raise SystemExit(1)

# Hand over to wt.py with `main` inserted
sys.argv = [str(_wt), "main", *sys.argv[1:]]
runpy.run_path(str(_wt), run_name="__main__")
