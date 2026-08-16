#!/usr/bin/env bash
set -euo pipefail

BEATZ_MEDIA_ROOT="${BEATZ_MEDIA_ROOT:-$HOME/beatz-selected}"
export BEATZ_MEDIA_ROOT

if [[ ! -d "$BEATZ_MEDIA_ROOT" ]]; then
  echo "Beat library not found: $BEATZ_MEDIA_ROOT" >&2
  exit 1
fi
if [[ ! -r "$BEATZ_MEDIA_ROOT/darklogo.png" ]]; then
  echo "Dark logo not readable: $BEATZ_MEDIA_ROOT/darklogo.png" >&2
  exit 1
fi

docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker compose -f docker-compose.prod.yml ps
