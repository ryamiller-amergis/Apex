"""Shared helpers for interactive-chat-troubleshoot scripts."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

SKILL_DIR = Path(__file__).resolve().parent.parent
ENVIRONMENTS_PATH = SKILL_DIR / "environments.json"
VALID_ENVS = ("dev", "stg", "prd")


def load_environments() -> dict[str, Any]:
    with ENVIRONMENTS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def resolve_env(env: str) -> dict[str, Any]:
    key = env.strip().lower()
    if key in ("staging", "stage"):
        key = "stg"
    if key in ("prod", "production"):
        key = "prd"
    if key in ("cloud-dev", "cloud_dev", "development"):
        key = "dev"
    if key not in VALID_ENVS:
        raise SystemExit(f"Unknown env {env!r}. Use: {', '.join(VALID_ENVS)}")
    data = load_environments()
    cfg = data["envs"][key]
    cfg = dict(cfg)
    cfg["env"] = key
    return cfg


def parse_env_arg(argv: list[str]) -> tuple[str | None, list[str]]:
    env = None
    rest: list[str] = []
    i = 0
    while i < len(argv):
        if argv[i] in ("--env", "-e") and i + 1 < len(argv):
            env = argv[i + 1]
            i += 2
            continue
        if argv[i].startswith("--env="):
            env = argv[i].split("=", 1)[1]
            i += 1
            continue
        rest.append(argv[i])
        i += 1
    return env, rest


def require_env(argv: list[str]) -> tuple[dict[str, Any], list[str]]:
    env, rest = parse_env_arg(argv)
    if not env:
        raise SystemExit(
            "Missing --env. Ask the user: dev (cloud DEV), stg (staging slot), or prd (production)."
        )
    return resolve_env(env), rest


def resolve_az() -> str:
    """Return an az executable path (Windows often only exposes az.cmd)."""
    for candidate in (
        "az",
        "az.cmd",
        r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd",
        r"C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin\az.cmd",
    ):
        if candidate in ("az", "az.cmd"):
            from shutil import which

            found = which(candidate)
            if found:
                return found
            continue
        if Path(candidate).is_file():
            return candidate
    raise SystemExit("Azure CLI (az / az.cmd) not found on PATH")


def run_az(args: list[str], *, check: bool = True) -> str:
    cmd = [resolve_az(), *args]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            shell=False,
        )
    except FileNotFoundError as exc:
        raise SystemExit("Azure CLI (az) not found on PATH") from exc
    if check and proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise SystemExit(f"az failed ({proc.returncode}): {err[:500]}")
    return (proc.stdout or "").strip()


def assert_az_login(subscription_hint: str | None = None) -> dict[str, Any]:
    raw = run_az(["account", "show", "-o", "json"])
    account = json.loads(raw)
    name = account.get("name") or ""
    print(f"AZ_ACCOUNT={name}")
    if subscription_hint and subscription_hint.lower() not in name.lower():
        print(
            f"WARN: current subscription {name!r} may not match expected {subscription_hint!r}. "
            f"Run: az account set --subscription \"{subscription_hint}\"",
            file=sys.stderr,
        )
    return account


def webapp_setting_present(
    app_name: str,
    resource_group: str,
    setting_name: str,
    slot: str | None,
) -> bool:
    args = [
        "webapp",
        "config",
        "appsettings",
        "list",
        "--name",
        app_name,
        "--resource-group",
        resource_group,
        "--query",
        f"[?name=='{setting_name}'].value | [0]",
        "-o",
        "tsv",
    ]
    if slot:
        args.extend(["--slot", slot])
    value = run_az(args, check=False)
    return bool(value and value.lower() not in ("none", "null", ""))


def get_webapp_setting(
    app_name: str,
    resource_group: str,
    setting_name: str,
    slot: str | None,
) -> str | None:
    args = [
        "webapp",
        "config",
        "appsettings",
        "list",
        "--name",
        app_name,
        "--resource-group",
        resource_group,
        "--query",
        f"[?name=='{setting_name}'].value | [0]",
        "-o",
        "tsv",
    ]
    if slot:
        args.extend(["--slot", slot])
    value = run_az(args, check=False)
    if not value or value.lower() in ("none", "null"):
        return None
    return value


def websockets_enabled(app_name: str, resource_group: str, slot: str | None) -> bool | None:
    args = [
        "webapp",
        "config",
        "show",
        "--name",
        app_name,
        "--resource-group",
        resource_group,
        "--query",
        "webSocketsEnabled",
        "-o",
        "tsv",
    ]
    if slot:
        args.extend(["--slot", slot])
    raw = run_az(args, check=False)
    if not raw:
        return None
    return raw.strip().lower() in ("true", "1")


def set_env_secret(name: str, value: str) -> None:
    """Set process env for child scripts; never print the value."""
    os.environ[name] = value
    print(f"{name}_SET=true length={len(value)}")
