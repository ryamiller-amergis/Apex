#!/usr/bin/env python3
"""
Download App Service docker logs and filter for a thread id / interactive signals.

Writes a temp zip under the skill scripts dir, extracts, greps, then cleans up.
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lib import assert_az_login, require_env, run_az  # noqa: E402

INTERESTING = re.compile(
    r"InteractiveLiveBus|Interactive dispatch|local agent slot|sendMessage|"
    r"nativeReads|agent-run-lifecycle|\[chat\]",
    re.I,
)


def main() -> None:
    cfg, rest = require_env(sys.argv[1:])
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--thread", required=True, help="Chat thread UUID")
    parser.add_argument("--minutes", type=int, default=30, help="Hint only (logs are full download)")
    args = parser.parse_args(rest)

    thread = args.thread.strip()
    assert_az_login(cfg.get("subscriptionHint"))

    app = cfg["appName"]
    rg = cfg["appResourceGroup"]
    slot = cfg.get("slot")

    work = Path(tempfile.mkdtemp(prefix="apex-interactive-logs-"))
    zip_path = work / "applog.zip"
    extract = work / "out"

    try:
        az_args = [
            "webapp",
            "log",
            "download",
            "--name",
            app,
            "--resource-group",
            rg,
            "--log-file",
            str(zip_path),
        ]
        if slot:
            az_args.extend(["--slot", slot])
        print(f"Downloading logs for {app} slot={slot or 'production'} …")
        run_az(az_args)

        extract.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract)

        hits: list[str] = []
        for log in extract.rglob("*docker*.log"):
            try:
                text = log.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for line in text.splitlines():
                if thread in line or (INTERESTING.search(line) and thread[:8] in line):
                    hits.append(line[:240])
                elif thread in line:
                    hits.append(line[:240])

        # Prefer thread-specific lines; fall back to interesting lines mentioning short id
        thread_hits = [h for h in hits if thread in h]
        print(f"=== matches for thread {thread} ({len(thread_hits)}) ===")
        for line in thread_hits[-40:]:
            print(line)

        if not thread_hits:
            print("(no thread-id lines — showing last interesting chat/livebus lines)")
            interesting: list[str] = []
            for log in extract.rglob("*docker*.log"):
                try:
                    text = log.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                for line in text.splitlines():
                    if INTERESTING.search(line):
                        interesting.append(line[:240])
            for line in interesting[-30:]:
                print(line)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        print("temp log download cleaned")


if __name__ == "__main__":
    main()
