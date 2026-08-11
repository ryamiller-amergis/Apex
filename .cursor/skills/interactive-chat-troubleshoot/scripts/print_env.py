#!/usr/bin/env python3
"""Print the resolved resource map for an environment (no secrets)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import require_env  # noqa: E402


def main() -> None:
    cfg, _ = require_env(sys.argv[1:])
    print(json.dumps(cfg, indent=2))


if __name__ == "__main__":
    main()
