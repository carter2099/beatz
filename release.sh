#!/usr/bin/env bash
# Build and promote the canonical Beats source into the owned production checkout.
# This is the supported release entrypoint; the copy in ~/beatz is not used.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
SOURCE_ROOT="$SCRIPT_DIR"
readonly SOURCE_ROOT
PRODUCTION_ROOT="${BEATZ_PRODUCTION_ROOT:-${HOME}/beatz}"
readonly PRODUCTION_ROOT
COMPOSE_FILE="$PRODUCTION_ROOT/docker-compose.prod.yml"
readonly COMPOSE_FILE
CONTAINER_NAME='carter-beatz'
readonly CONTAINER_NAME
IMAGE_REPOSITORY='carter-beatz'
readonly IMAGE_REPOSITORY
BRANCH='main'
readonly BRANCH
HEALTH_URL="${BEATZ_HEALTH_URL:-http://127.0.0.1:30142/healthz}"
readonly HEALTH_URL
HEALTH_TIMEOUT="${BEATZ_HEALTH_TIMEOUT:-60}"
readonly HEALTH_TIMEOUT

BEATZ_MEDIA_ROOT="${BEATZ_MEDIA_ROOT:-${HOME}/beatz-selected}"
BEATZ_DATA_ROOT="${BEATZ_DATA_ROOT:-${HOME}/beatz-data}"
export BEATZ_MEDIA_ROOT BEATZ_DATA_ROOT

rollback_dir=''
transaction_started=0
committed=0
rollback_done=0
rollback_failed=0
old_commit=''
old_image_id=''
old_image_ref=''
old_latest_image_id=''
old_container_id=''
old_container_running=''
old_mounts=''
rollback_tag=''
candidate_image=''
candidate_image_id=''
candidate_preexisting=0
candidate_built=0
image_override=''

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

compose() {
  (cd -- "$PRODUCTION_ROOT" && docker compose -f "$COMPOSE_FILE" "$@")
}

write_image_override() {
  local image="$1"
  printf 'services:\n  beatz:\n    image: "%s"\n' "$image" >"$image_override"
}

compose_image() {
  local image="$1"
  shift
  if ! write_image_override "$image"; then
    return 1
  fi
  (cd -- "$PRODUCTION_ROOT" && docker compose -f "$COMPOSE_FILE" -f "$image_override" "$@")
}

runtime_mounts() {
  local mounts
  mounts="$(docker inspect "$1" --format '{{range .Mounts}}{{println .Source "|" .Destination "|" .Mode "|" .RW}}{{end}}')" || return 1
  printf '%s\n' "$mounts" | LC_ALL=C sort
}

expected_mounts() {
  printf '%s\n' \
    "$BEATZ_DATA_ROOT | /data | rw | true" \
    "$BEATZ_MEDIA_ROOT | /music | ro | false" | LC_ALL=C sort
}

backup_path() {
  local path="$1"
  local name="$2"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ ! -L "$path" ]] || die "refusing symlinked production config: $path"
    cp -a -- "$path" "$rollback_dir/$name"
    : >"$rollback_dir/$name.present"
  fi
}

restore_path() {
  local destination="$1"
  local name="$2"
  local temporary
  if [[ -e "$rollback_dir/$name.present" ]]; then
    temporary="$(mktemp "${destination}.rollback.XXXXXX")"
    if ! cp -a -- "$rollback_dir/$name" "$temporary"; then
      rm -f -- "$temporary"
      return 1
    fi
    mv -f -- "$temporary" "$destination"
  else
    rm -f -- "$destination"
  fi
}


restore_latest_image() {
  if [[ -n "$old_latest_image_id" ]]; then
    docker image tag "$old_latest_image_id" "${IMAGE_REPOSITORY}:latest"
  else
    docker image rm --force "${IMAGE_REPOSITORY}:latest" >/dev/null 2>&1 || true
  fi
}

verify_runtime() {
  local container="$1"
  local expected_image="$2"
  local actual_image
  local user
  local readonly_root
  local cap_drop
  local security_opts
  local ports
  local memory
  local nano_cpus
  local pids_limit
  local container_env
  local mounts

  actual_image="$(docker inspect "$container" --format '{{.Image}}')"
  [[ "$actual_image" == "$expected_image" ]] || {
    printf 'container is not running expected image: %s (got %s)\n' "$expected_image" "$actual_image" >&2
    return 1
  }
  [[ "$(docker inspect "$container" --format '{{.Name}}')" == "/${CONTAINER_NAME}" ]] || {
    printf 'container name changed unexpectedly\n' >&2
    return 1
  }
  user="$(docker inspect "$container" --format '{{.Config.User}}')"
  [[ "$user" == '1000:1000' ]] || {
    printf 'container user guardrail changed: %s\n' "$user" >&2
    return 1
  }
  readonly_root="$(docker inspect "$container" --format '{{.HostConfig.ReadonlyRootfs}}')"
  [[ "$readonly_root" == 'true' ]] || {
    printf 'container root filesystem is not read-only\n' >&2
    return 1
  }
  cap_drop="$(docker inspect "$container" --format '{{range .HostConfig.CapDrop}}{{println .}}{{end}}')"
  [[ "$cap_drop" == 'ALL' ]] || {
    printf 'container capabilities were not dropped\n' >&2
    return 1
  }
  security_opts="$(docker inspect "$container" --format '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}')"
  [[ "$security_opts" == 'no-new-privileges:true' ]] || {
    printf 'container no-new-privileges guardrail is missing\n' >&2
    return 1
  }
  ports="$(docker inspect "$container" --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{println $port "|" .HostIp "|" .HostPort}}{{end}}{{end}}')"
  [[ "$ports" == '30142/tcp | 127.0.0.1 | 30142' ]] || {
    printf 'container is not bound only to the configured loopback port\n' >&2
    return 1
  }
  memory="$(docker inspect "$container" --format '{{.HostConfig.Memory}}')"
  [[ "$memory" == '134217728' ]] || {
    printf 'container memory limit changed: %s\n' "$memory" >&2
    return 1
  }
  nano_cpus="$(docker inspect "$container" --format '{{.HostConfig.NanoCpus}}')"
  [[ "$nano_cpus" == '500000000' ]] || {
    printf 'container CPU limit changed: %s\n' "$nano_cpus" >&2
    return 1
  }
  pids_limit="$(docker inspect "$container" --format '{{.HostConfig.PidsLimit}}')"
  [[ "$pids_limit" == '100' ]] || {
    printf 'container PID limit changed: %s\n' "$pids_limit" >&2
    return 1
  }
  [[ "$(docker inspect "$container" --format '{{.HostConfig.Privileged}}')" == 'false' ]] || {
    printf 'privileged container mode is not allowed\n' >&2
    return 1
  }
  container_env="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}')"
  [[ "$container_env" == *'BEATZ_MEDIA_ROOT=/music'* && "$container_env" == *'BEATZ_DATA_ROOT=/data'* ]] || {
    printf 'container media or data roots changed\n' >&2
    return 1
  }
  mounts="$(runtime_mounts "$container")"
  [[ "$mounts" == "$old_mounts" ]] || {
    printf 'media or play-data mounts changed during deployment\n' >&2
    return 1
  }
  return 0
}

wait_for_health() {
  local attempt
  for ((attempt = 0; attempt < HEALTH_TIMEOUT; attempt++)); do
    if curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  local failed=0
  local rollback_container_id
  local rollback_image_id

  if ((rollback_done)); then
    return "$rollback_failed"
  fi
  rollback_done=1

  if ! git -C "$PRODUCTION_ROOT" reset --hard "$old_commit" >/dev/null 2>&1; then
    failed=1
  fi
  if ! restore_path "$COMPOSE_FILE" compose.prod.yml; then
    failed=1
  fi
  if ! restore_path "$PRODUCTION_ROOT/.env" env; then
    failed=1
  fi

  if [[ -n "$rollback_tag" ]]; then
    if ! docker image tag "$rollback_tag" "${IMAGE_REPOSITORY}:latest" >/dev/null 2>&1; then
      failed=1
    fi
    if [[ "$old_image_ref" != *'@'* && -n "$old_image_ref" ]]; then
      if ! docker image tag "$rollback_tag" "$old_image_ref" >/dev/null 2>&1; then
        failed=1
      fi
    fi
    if ! compose_image "$rollback_tag" up -d --no-build --force-recreate beatz >/dev/null 2>&1; then
      failed=1
    fi
    rollback_container_id="$(compose ps -q beatz 2>/dev/null || true)"
    rollback_container_id="${rollback_container_id%%$'\n'*}"
    if [[ -z "$rollback_container_id" ]]; then
      failed=1
    else
      rollback_image_id="$(docker inspect "$rollback_container_id" --format '{{.Image}}' 2>/dev/null || true)"
      [[ "$rollback_image_id" == "$old_image_id" ]] || failed=1
    fi
    if ! wait_for_health; then
      failed=1
    fi
  else
    failed=1
  fi

  restore_latest_image || failed=1
  rollback_failed="$failed"
  if ((failed)); then
    printf 'Beats rollback failed; preserved %s and %s\n' \
      "$rollback_dir" "$rollback_tag" >&2
    return 1
  fi
  printf '%s\n' 'Beats deployment rolled back and restored health.' >&2
  return 0
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if ((transaction_started && !committed)); then
    if ! rollback; then
      status=1
    fi
  fi
  if [[ -n "$rollback_dir" && -d "$rollback_dir" ]] &&
    ((committed || !rollback_failed)); then
    rm -rf -- "$rollback_dir"
  fi
  if [[ -n "$rollback_tag" ]] && ((committed || !rollback_failed)); then
    docker image rm --force "$rollback_tag" >/dev/null 2>&1 || true
  fi
  if ((candidate_built && !candidate_preexisting && !committed && !rollback_failed)); then
    docker image rm --force "$candidate_image" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if (($# > 0)); then
  printf 'usage: %s\n' "$0" >&2
  exit 2
fi
[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die 'BEATZ_HEALTH_TIMEOUT must be a positive integer'
[[ "$PRODUCTION_ROOT" != / && "$PRODUCTION_ROOT" != "$SOURCE_ROOT" ]] ||
  die "unsafe production root: $PRODUCTION_ROOT"
[[ -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] || die "canonical source root must be a real directory: $SOURCE_ROOT"
[[ -d "$SOURCE_ROOT/.git" && ! -L "$SOURCE_ROOT/.git" ]] || die "canonical git repository is missing: $SOURCE_ROOT"
[[ -f "$SOURCE_ROOT/release.sh" && ! -L "$SOURCE_ROOT/release.sh" ]] || die 'canonical release.sh must be a regular file'
[[ -f "$SOURCE_ROOT/up.sh" && ! -L "$SOURCE_ROOT/up.sh" ]] || die 'canonical up.sh must be a regular file'
[[ -d "$PRODUCTION_ROOT" && ! -L "$PRODUCTION_ROOT" ]] ||
  die "production root must be a real directory: $PRODUCTION_ROOT"
production_owner="$(stat -c '%U' -- "$PRODUCTION_ROOT")"
owner_name="$(id -un)"
[[ "$production_owner" == "$owner_name" ]] ||
  die "production root must be owned by $owner_name: $PRODUCTION_ROOT"
[[ -d "$PRODUCTION_ROOT/.git" && ! -L "$PRODUCTION_ROOT/.git" ]] ||
  die "production git checkout is missing: $PRODUCTION_ROOT"
for path in "$COMPOSE_FILE" "$PRODUCTION_ROOT/release.sh" "$PRODUCTION_ROOT/up.sh"; do
  [[ -f "$path" && ! -L "$path" ]] ||
    die "production path must be a regular file: $path"
  [[ "$(stat -c '%U' -- "$path")" == "$owner_name" &&
     "$(stat -c '%h' -- "$path")" == '1' ]] ||
    die "production path must be singly linked and owned by $owner_name: $path"
done
if [[ -e "$PRODUCTION_ROOT/.env" || -L "$PRODUCTION_ROOT/.env" ]]; then
  [[ -f "$PRODUCTION_ROOT/.env" && ! -L "$PRODUCTION_ROOT/.env" ]] ||
    die "production environment must be a regular file: $PRODUCTION_ROOT/.env"
  [[ "$(stat -c '%U' -- "$PRODUCTION_ROOT/.env")" == "$owner_name" &&
     "$(stat -c '%h' -- "$PRODUCTION_ROOT/.env")" == '1' ]] ||
    die "production environment must be singly linked and owned by $owner_name"
fi
[[ "$BEATZ_MEDIA_ROOT" == /* && "$BEATZ_DATA_ROOT" == /* ]] ||
  die 'BEATZ_MEDIA_ROOT and BEATZ_DATA_ROOT must be absolute paths'
[[ -d "$BEATZ_MEDIA_ROOT" && ! -L "$BEATZ_MEDIA_ROOT" ]] ||
  die "beat library must be a real directory: $BEATZ_MEDIA_ROOT"
[[ -f "$BEATZ_MEDIA_ROOT/darklogo.png" && ! -L "$BEATZ_MEDIA_ROOT/darklogo.png" && -r "$BEATZ_MEDIA_ROOT/darklogo.png" ]] ||
  die "dark logo is not a readable regular file: $BEATZ_MEDIA_ROOT/darklogo.png"
if [[ -e "$BEATZ_DATA_ROOT" || -L "$BEATZ_DATA_ROOT" ]]; then
  [[ -d "$BEATZ_DATA_ROOT" && ! -L "$BEATZ_DATA_ROOT" ]] ||
    die "beat data root must be a real directory: $BEATZ_DATA_ROOT"
fi
for command in git docker curl stat id mktemp cp mv rm sort sleep; do
  command -v "$command" >/dev/null || die "$command is required"
done

git -C "$SOURCE_ROOT" diff --quiet || die 'canonical checkout has unstaged changes'
git -C "$SOURCE_ROOT" diff --cached --quiet || die 'canonical checkout has staged changes'
[[ -z "$(git -C "$SOURCE_ROOT" status --porcelain --untracked-files=all)" ]] ||
  die 'canonical checkout has uncommitted or untracked changes'
git -C "$PRODUCTION_ROOT" diff --quiet || die 'production checkout has unstaged changes'
git -C "$PRODUCTION_ROOT" diff --cached --quiet || die 'production checkout has staged changes'
[[ -z "$(git -C "$PRODUCTION_ROOT" status --porcelain --untracked-files=all)" ]] ||
  die 'production checkout has uncommitted or untracked changes'

source_top="$(git -C "$SOURCE_ROOT" rev-parse --show-toplevel 2>/dev/null)" || die 'canonical source is not a git worktree'
production_top="$(git -C "$PRODUCTION_ROOT" rev-parse --show-toplevel 2>/dev/null)" || die 'production root is not a git worktree'
[[ "$source_top" == "$SOURCE_ROOT" ]] || die "canonical source root mismatch: $source_top"
[[ "$production_top" == "$PRODUCTION_ROOT" ]] || die "production root mismatch: $production_top"
if ! source_branch="$(git -C "$SOURCE_ROOT" symbolic-ref --quiet --short HEAD)"; then
  die 'canonical checkout is detached'
fi
[[ "$source_branch" == "$BRANCH" ]] || die "canonical checkout must be on $BRANCH"
if ! production_branch="$(git -C "$PRODUCTION_ROOT" symbolic-ref --quiet --short HEAD)"; then
  die 'production checkout is detached'
fi
[[ "$production_branch" == "$BRANCH" ]] || die "production checkout must be on $BRANCH"

git -C "$SOURCE_ROOT" fetch --prune origin "$BRANCH"
canonical_commit="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
canonical_remote_commit="$(git -C "$SOURCE_ROOT" rev-parse "origin/$BRANCH")"
[[ "$canonical_commit" == "$canonical_remote_commit" ]] || die 'canonical main must be pushed before deployment'

old_commit="$(git -C "$PRODUCTION_ROOT" rev-parse HEAD)"
git -C "$PRODUCTION_ROOT" fetch --prune origin "$BRANCH"
production_remote_commit="$(git -C "$PRODUCTION_ROOT" rev-parse "origin/$BRANCH")"
[[ "$canonical_commit" == "$production_remote_commit" ]] || die 'production origin/main does not match canonical main'
if ! git -C "$PRODUCTION_ROOT" merge-base --is-ancestor "$old_commit" "$production_remote_commit"; then
  die 'production checkout is not behind origin/main; refusing a non-fast-forward update'
fi

caller_uid="$(id -u)"
if [[ ! -e "$BEATZ_DATA_ROOT" ]]; then
  mkdir -p -- "$BEATZ_DATA_ROOT"
fi
if [[ "$caller_uid" == '0' ]]; then
  chown -R 1000:1000 "$BEATZ_DATA_ROOT"
elif [[ "$caller_uid" != '1000' ]]; then
  die 'run as UID 1000 or root so the container can use the Beats data root'
fi
if [[ ! -d "$BEATZ_DATA_ROOT" || -L "$BEATZ_DATA_ROOT" ]]; then
  die "beat data root must be a real directory: $BEATZ_DATA_ROOT"
fi
if [[ "$(stat -c '%u' -- "$BEATZ_DATA_ROOT")" != '1000' ]]; then
  die "beat data root must be owned by UID 1000: $BEATZ_DATA_ROOT"
fi
chmod u+rwx "$BEATZ_DATA_ROOT"
history_file="$BEATZ_DATA_ROOT/plays.jsonl"
if [[ -e "$history_file" || -L "$history_file" ]]; then
  [[ -f "$history_file" && ! -L "$history_file" ]] ||
    die "beat play history must be a UID-1000-owned regular file: $history_file"
  [[ "$(stat -c '%u' -- "$history_file")" == '1000' ]] ||
    die "beat play history must be owned by UID 1000: $history_file"
  chmod u+rw "$history_file"
fi

rollback_dir="$(mktemp -d "${TMPDIR:-/tmp}/beatz-deploy-rollback.XXXXXX")"
image_override="$rollback_dir/image.override.yml"
backup_path "$COMPOSE_FILE" compose.prod.yml
backup_path "$PRODUCTION_ROOT/.env" env
if ! compose config >"$rollback_dir/compose.config"; then
  die 'could not capture the deployed Compose configuration'
fi

old_container_id="$(compose ps -q beatz 2>/dev/null || true)"
old_container_id="${old_container_id%%$'\n'*}"
if [[ -z "$old_container_id" ]]; then
  old_container_id="$(docker inspect "$CONTAINER_NAME" --format '{{.Id}}' 2>/dev/null || true)"
fi
[[ -n "$old_container_id" ]] || die 'a healthy existing Beats container is required for rollback'
docker inspect "$old_container_id" >"$rollback_dir/container.inspect"
old_image_id="$(docker inspect "$old_container_id" --format '{{.Image}}')"
old_image_ref="$(docker inspect "$old_container_id" --format '{{.Config.Image}}')"
old_container_running="$(docker inspect "$old_container_id" --format '{{.State.Running}}')"
old_mounts="$(runtime_mounts "$old_container_id")"
[[ "$old_container_running" == true ]] || die 'start the previous Beats deployment before releasing'
[[ "$old_mounts" == "$(expected_mounts)" ]] ||
  die 'configured media/data paths differ from the existing deployment; refusing a mount change'
verify_runtime "$old_container_id" "$old_image_id" ||
  die 'existing Beats runtime does not match the owned deployment contract'
wait_for_health || die 'existing Beats origin is unhealthy; no deployment changes made'
docker image inspect "$old_image_id" >"$rollback_dir/image.inspect"
old_latest_image_id="$(docker image inspect "${IMAGE_REPOSITORY}:latest" --format '{{.Id}}' 2>/dev/null || true)"

candidate_image="${IMAGE_REPOSITORY}:commit-${canonical_commit}"
if docker image inspect "$candidate_image" --format '{{.Id}}' >/dev/null 2>&1; then
  candidate_preexisting=1
  [[ "$(docker image inspect "$candidate_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$canonical_commit" ]] ||
    die 'existing revision image lacks matching provenance; refusing to overwrite it'
  printf 'Reusing immutable Beats image %s\n' "$candidate_image"
else
  printf 'Building immutable Beats image %s\n' "$candidate_image"
  docker build --label "org.opencontainers.image.revision=$canonical_commit" \
    --tag "$candidate_image" "$SOURCE_ROOT"
  candidate_built=1
fi
candidate_image_id="$(docker image inspect "$candidate_image" --format '{{.Id}}')"
[[ -n "$candidate_image_id" ]] || die 'candidate image has no inspectable image ID'
rollback_tag="${IMAGE_REPOSITORY}:rollback-${old_commit:0:12}-${BASHPID}"
docker image tag "$old_image_id" "$rollback_tag"

# The rollback tag is created only after the candidate image is built. The
# transaction begins immediately before the first production checkout change.
transaction_started=1
if ! git -C "$PRODUCTION_ROOT" merge --ff-only "origin/$BRANCH"; then
  rollback
  exit 1
fi
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || {
  printf 'candidate compose file is not a regular file\n' >&2
  rollback
  exit 1
}
for path in "$PRODUCTION_ROOT/release.sh" "$PRODUCTION_ROOT/up.sh"; do
  [[ -f "$path" && ! -L "$path" ]] || {
    printf 'candidate production entrypoint is not a regular file: %s\n' "$path" >&2
    rollback
    exit 1
  }
done
[[ ! -L "$PRODUCTION_ROOT/.env" ]] || {
  printf 'candidate introduced symlinked production environment\n' >&2
  rollback
  exit 1
}
if ! compose_image "$candidate_image" up -d --no-build --force-recreate beatz; then
  rollback
  exit 1
fi
candidate_container_id="$(compose ps -q beatz 2>/dev/null || true)"
candidate_container_id="${candidate_container_id%%$'\n'*}"
if [[ -z "$candidate_container_id" ]] || ! verify_runtime "$candidate_container_id" "$candidate_image_id"; then
  printf 'candidate Beats runtime failed its configuration gate\n' >&2
  rollback
  exit 1
fi
if ! wait_for_health; then
  printf 'Beats health check failed: %s\n' "$HEALTH_URL" >&2
  rollback
  exit 1
fi
if ! docker image tag "$candidate_image_id" "${IMAGE_REPOSITORY}:latest"; then
  printf 'could not promote candidate image to latest\n' >&2
  rollback
  exit 1
fi
compose ps beatz
committed=1
printf 'Beats deployed at %s using %s\n' \
  "$(git -C "$PRODUCTION_ROOT" rev-parse --short HEAD)" "$candidate_image"
