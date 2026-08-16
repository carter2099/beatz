#!/usr/bin/env bash
set -euo pipefail

BEATS_MEDIA_ROOT="${BEATS_MEDIA_ROOT:-$HOME/beats-selected}"
export BEATS_MEDIA_ROOT

if [[ ! -d "$BEATS_MEDIA_ROOT" ]]; then
  echo "Beat library not found: $BEATS_MEDIA_ROOT" >&2
  exit 1
fi
if [[ ! -r "$BEATS_MEDIA_ROOT/darklogo.png" ]]; then
  echo "Dark logo not readable: $BEATS_MEDIA_ROOT/darklogo.png" >&2
  exit 1
fi

docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -f docker-compose.prod.yml ps
