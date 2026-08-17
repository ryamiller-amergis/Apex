#!/usr/bin/env python3
"""
Check interactive-chat critical App Service settings for an environment.

Reports presence only — never prints secret values.
Exit 0 if REDIS_HOST + REDIS_KEY (or REDIS_PASSWORD) present; exit 1 otherwise.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import (  # noqa: E402
    assert_az_login,
    require_env,
    webapp_setting_present,
    websockets_enabled,
)

CRITICAL = (
    "REDIS_HOST",
    "REDIS_SSL_PORT",
    "REDIS_KEY",
    "REDIS_PASSWORD",
    "AI_RUNS_INTERACTIVE_DISPATCH_URL",
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
)


def main() -> None:
    cfg, _ = require_env(sys.argv[1:])
    assert_az_login(cfg.get("subscriptionHint"))

    app = cfg["appName"]
    rg = cfg["appResourceGroup"]
    slot = cfg.get("slot")

    present = {}
    for name in CRITICAL:
        present[name] = webapp_setting_present(app, rg, name, slot)

    redis_ok = present["REDIS_HOST"] and (present["REDIS_KEY"] or present["REDIS_PASSWORD"])
    ws = websockets_enabled(app, rg, slot)

    report = {
        "env": cfg["env"],
        "appName": app,
        "resourceGroup": rg,
        "slot": slot or "production",
        "settingsPresent": {
            "REDIS_HOST": present["REDIS_HOST"],
            "REDIS_SSL_PORT": present["REDIS_SSL_PORT"],
            "REDIS_KEY_OR_PASSWORD": present["REDIS_KEY"] or present["REDIS_PASSWORD"],
            "AI_RUNS_INTERACTIVE_DISPATCH_URL": present["AI_RUNS_INTERACTIVE_DISPATCH_URL"],
            "APPLICATIONINSIGHTS_CONNECTION_STRING": present[
                "APPLICATIONINSIGHTS_CONNECTION_STRING"
            ],
        },
        "webSocketsEnabled": ws,
        "verdict": "ok" if redis_ok else "A — config drift (REDIS missing)",
    }
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if redis_ok else 1)


if __name__ == "__main__":
    main()
