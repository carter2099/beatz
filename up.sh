#!/usr/bin/env bash
# Start the deployed Beats image without building from a production checkout.
set -euo pipefail

if (($# > 0)); then
  printf 'usage: %s\n' "$0" >&2
  exit 2
fi

PRODUCTION_ROOT="${BEATZ_PRODUCTION_ROOT:-${HOME}/beatz}"
readonly PRODUCTION_ROOT
COMPOSE_FILE="$PRODUCTION_ROOT/docker-compose.prod.yml"
readonly COMPOSE_FILE
BEATZ_MEDIA_ROOT="${BEATZ_MEDIA_ROOT:-${HOME}/beatz-selected}"
BEATZ_DATA_ROOT="${BEATZ_DATA_ROOT:-${HOME}/beatz-data}"
export BEATZ_MEDIA_ROOT BEATZ_DATA_ROOT

[[ "$PRODUCTION_ROOT" != / && -d "$PRODUCTION_ROOT" && ! -L "$PRODUCTION_ROOT" ]] || {
  printf 'production Beats checkout is missing, unsafe, or symlinked: %s\n' "$PRODUCTION_ROOT" >&2
  exit 1
}
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || {
  printf 'production compose file is missing or symlinked: %s\n' "$COMPOSE_FILE" >&2
  exit 1
}
[[ "$BEATZ_MEDIA_ROOT" == /* && "$BEATZ_DATA_ROOT" == /* ]] || {
  printf 'BEATZ_MEDIA_ROOT and BEATZ_DATA_ROOT must be absolute paths\n' >&2
  exit 1
}
[[ -d "$BEATZ_MEDIA_ROOT" && ! -L "$BEATZ_MEDIA_ROOT" ]] || {
  printf 'Beat library not found or symlinked: %s\n' "$BEATZ_MEDIA_ROOT" >&2
  exit 1
}
[[ -f "$BEATZ_MEDIA_ROOT/darklogo.png" && ! -L "$BEATZ_MEDIA_ROOT/darklogo.png" && -r "$BEATZ_MEDIA_ROOT/darklogo.png" ]] || {
  printf 'Dark logo is not a readable regular file: %s\n' "$BEATZ_MEDIA_ROOT/darklogo.png" >&2
  exit 1
}

if [[ -e "$BEATZ_DATA_ROOT" || -L "$BEATZ_DATA_ROOT" ]]; then
  [[ -d "$BEATZ_DATA_ROOT" && ! -L "$BEATZ_DATA_ROOT" ]] || {
    printf 'Beat data root is not a real directory: %s\n' "$BEATZ_DATA_ROOT" >&2
    exit 1
  }
else
  mkdir -p -- "$BEATZ_DATA_ROOT"
fi

caller_uid="$(id -u)"
if [[ "$caller_uid" == '0' ]]; then
  chown -R 1000:1000 "$BEATZ_DATA_ROOT"
elif [[ "$caller_uid" != '1000' ]]; then
  printf 'Run as UID 1000 or root so the container can use: %s\n' "$BEATZ_DATA_ROOT" >&2
  exit 1
fi
if [[ "$(stat -c '%u' -- "$BEATZ_DATA_ROOT")" != '1000' ]]; then
  printf 'Beat data root must be owned by UID 1000: %s\n' "$BEATZ_DATA_ROOT" >&2
  exit 1
fi
chmod u+rwx "$BEATZ_DATA_ROOT"

history_file="$BEATZ_DATA_ROOT/plays.jsonl"
if [[ -e "$history_file" || -L "$history_file" ]]; then
  [[ -f "$history_file" && ! -L "$history_file" ]] || {
    printf 'Beat play history must be a UID-1000-owned regular file: %s\n' "$history_file" >&2
    exit 1
  }
  [[ "$(stat -c '%u' -- "$history_file")" == '1000' ]] || {
    printf 'Beat play history must be owned by UID 1000: %s\n' "$history_file" >&2
    exit 1
  }
  chmod u+rw "$history_file"
fi
if [[ ! -r "$BEATZ_DATA_ROOT" || ! -w "$BEATZ_DATA_ROOT" || ! -x "$BEATZ_DATA_ROOT" ]]; then
  printf 'Beat data root must be readable, writable, and searchable: %s\n' "$BEATZ_DATA_ROOT" >&2
  exit 1
fi
command -v docker >/dev/null || {
  printf 'docker is required\n' >&2
  exit 1
}

cd -- "$PRODUCTION_ROOT"
docker compose -f "$COMPOSE_FILE" up -d --no-build beatz
docker compose -f "$COMPOSE_FILE" ps beatz
