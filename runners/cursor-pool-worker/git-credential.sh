#!/usr/bin/env bash
# Git credential helper: ADO_PAT for dev.azure.com. Do not log the secret.
set -eu

protocol=""
host=""

while IFS= read -r line; do
  [[ -z "${line}" ]] && break
  case "${line}" in
    protocol=*) protocol="${line#protocol=}" ;;
    host=*) host="${line#host=}" ;;
  esac
done

if [[ "${protocol}" != "https" ]]; then
  exit 0
fi

case "${host}" in
  dev.azure.com|*.dev.azure.com|*.visualstudio.com)
    printf 'username=pat\n'
    printf 'password=%s\n' "${ADO_PAT}"
    ;;
esac
