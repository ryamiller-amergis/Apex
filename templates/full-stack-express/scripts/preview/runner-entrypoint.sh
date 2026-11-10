#!/bin/sh
set -eu

bundle=/input/runtime.tar
expected=${APEX_PREVIEW_BUNDLE_DIGEST:-}
mode=${1:-start}

if [ "$mode" = "proxy" ]; then
  exec node /usr/local/lib/apex-preview-runner/tcp-proxy.mjs
fi

if [ ! -f "$bundle" ]; then
  echo "Preview runtime bundle is missing." >&2
  exit 64
fi

digest_value=${expected#sha256:}
if [ "$expected" = "$digest_value" ] ||
  [ "${#digest_value}" -ne 64 ] ||
  [ -n "$(printf '%s' "$digest_value" | tr -d '0-9a-f')" ]; then
  echo "APEX_PREVIEW_BUNDLE_DIGEST must be a SHA-256 digest." >&2
  exit 64
fi

actual="sha256:$(sha256sum "$bundle" | cut -d ' ' -f 1)"
if [ "$actual" != "$expected" ]; then
  echo "Preview runtime bundle digest mismatch." >&2
  exit 65
fi

tar -tf "$bundle" | while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*\\*)
      echo "Preview runtime bundle contains an unsafe path." >&2
      exit 65
      ;;
  esac
done

rm -rf /session/api /session/packages /session/web
cp -a /runner/api /session/api
tar -xf "$bundle" -C /session

case "$mode" in
  migrate)
    exec node api/dist/cli/migrate.js
    ;;
  seed)
    exec node api/dist/cli/seed.js
    ;;
  start)
    exec node --import ./api/dist/instrument.js api/dist/index.js
    ;;
  *)
    echo "Unknown preview runner mode: $mode" >&2
    exit 64
    ;;
esac
