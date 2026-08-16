#!/usr/bin/env bash
set -euo pipefail

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy a dirty checkout." >&2
  git status --short >&2
  exit 1
fi

git pull --ff-only origin main
bash up.sh
