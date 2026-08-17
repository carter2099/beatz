#!/usr/bin/env bash
set -euo pipefail

BEATZ_MEDIA_ROOT="${BEATZ_MEDIA_ROOT:-$HOME/beatz-selected}"
BEATZ_DATA_ROOT="${BEATZ_DATA_ROOT:-$HOME/beatz-data}"
export BEATZ_MEDIA_ROOT BEATZ_DATA_ROOT

if [[ ! -d "$BEATZ_MEDIA_ROOT" ]]; then
  echo "Beat library not found: $BEATZ_MEDIA_ROOT" >&2
  exit 1
fi
if [[ ! -r "$BEATZ_MEDIA_ROOT/darklogo.png" ]]; then
  echo "Dark logo not readable: $BEATZ_MEDIA_ROOT/darklogo.png" >&2
  exit 1
fi

if [[ -e "$BEATZ_DATA_ROOT" && ! -d "$BEATZ_DATA_ROOT" ]]; then
  echo "Beat data root is not a directory: $BEATZ_DATA_ROOT" >&2
  exit 1
fi
mkdir -p "$BEATZ_DATA_ROOT"

caller_uid="$(id -u)"
if [[ "$caller_uid" == "0" ]]; then
  chown -R 1000:1000 "$BEATZ_DATA_ROOT"
elif [[ "$caller_uid" != "1000" ]]; then
  echo "Run as UID 1000 or root so the container can use: $BEATZ_DATA_ROOT" >&2
  exit 1
fi
if [[ "$(stat -c '%u' "$BEATZ_DATA_ROOT")" != "1000" ]]; then
  echo "Beat data root must be owned by UID 1000: $BEATZ_DATA_ROOT" >&2
  exit 1
fi
chmod u+rwx "$BEATZ_DATA_ROOT"

history_file="$BEATZ_DATA_ROOT/plays.jsonl"
if [[ -e "$history_file" ]]; then
  if [[ ! -f "$history_file" || "$(stat -c '%u' "$history_file")" != "1000" ]]; then
    echo "Beat play history must be a UID-1000-owned regular file: $history_file" >&2
    exit 1
  fi
  chmod u+rw "$history_file"
fi
if [[ ! -r "$BEATZ_DATA_ROOT" || ! -w "$BEATZ_DATA_ROOT" || ! -x "$BEATZ_DATA_ROOT" ]]; then
  echo "Beat data root must be readable, writable, and searchable: $BEATZ_DATA_ROOT" >&2
  exit 1
fi
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -f docker-compose.prod.yml ps
