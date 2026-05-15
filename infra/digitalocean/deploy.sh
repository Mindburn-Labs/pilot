#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ACTION="${1:-deploy}"
ACTION_ARG="${2:-}"
DROPLET_NAME="${DO_DROPLET_NAME:-pilot-prod}"
DO_REGION="${DO_REGION:-fra1}"
DO_SIZE="${DO_SIZE:-s-2vcpu-4gb}"
DO_IMAGE="${DO_IMAGE:-ubuntu-24-04-x64}"
DO_SSH_KEYS="${DO_SSH_KEYS:-}"
DO_TAGS="${DO_TAGS:-pilot,production}"
DO_FIREWALL_NAME="${DO_FIREWALL_NAME:-pilot-prod-fw}"
DO_FIREWALL_TAGS="${DO_FIREWALL_TAGS:-pilot}"
DO_SSH_CIDR="${DO_SSH_CIDR:-95.43.154.83/32}"
REMOTE_USER="${DO_REMOTE_USER:-root}"
REMOTE_BASE_DIR="${DO_REMOTE_BASE_DIR:-/opt/pilot}"
REMOTE_DIR="${DO_REMOTE_DIR:-$REMOTE_BASE_DIR/current}"
REMOTE_RELEASES_DIR="${DO_REMOTE_RELEASES_DIR:-$REMOTE_BASE_DIR/releases}"
RELEASE_ID="${DEPLOY_RELEASE_ID:-$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
ENV_DIR="${ENV_DIR:-.}"
ENV_SHARED_FILE="${ENV_SHARED_FILE:-$ENV_DIR/.env.production.shared}"
ENV_HELM_FILE="${ENV_HELM_FILE:-$ENV_DIR/.env.production.helm}"
ENV_PILOT_FILE="${ENV_PILOT_FILE:-$ENV_DIR/.env.production.pilot}"
COMPOSE_PROFILES="${COMPOSE_PROFILES:-backup}"
COMPOSE=(docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml)
HELM_KERNEL_DIR="${HELM_OSS_DIR:-${HELM_KERNEL_DIR:-$ROOT_DIR/../helm-ai-kernel}}"
HELM_DOCKERFILE="${HELM_DOCKERFILE:-Dockerfile.slim}"
HELM_DOCKER_PLATFORM="${HELM_DOCKER_PLATFORM:-linux/amd64}"
HELM_IMAGE_ARCHIVE="${HELM_IMAGE_ARCHIVE:-}"
HELM_PRELOAD_MODE="${HELM_PRELOAD_MODE:-binary}"

usage() {
  cat <<'USAGE'
Usage:
  ENV_DIR=. DO_SSH_KEYS=<fingerprint-or-id> bash infra/digitalocean/deploy.sh create
  ENV_DIR=. DO_DROPLET_IP=<ip> bash infra/digitalocean/deploy.sh preload-helm
  ENV_DIR=. DO_DROPLET_IP=<ip> bash infra/digitalocean/deploy.sh deploy
  DO_DROPLET_IP=<ip> bash infra/digitalocean/deploy.sh rollback [release-id-or-path]
  ENV_DIR=. bash infra/digitalocean/deploy.sh doctor
  DO_DROPLET_IP=<ip> bash infra/digitalocean/deploy.sh status
  DO_DROPLET_IP=<ip> bash infra/digitalocean/deploy.sh smoke

Required env files:
  .env.production.shared  shared non-provider configuration
  .env.production.helm    HELM sidecar provider keys and evidence settings
  .env.production.pilot   Pilot secrets and email settings, no direct LLM keys

Legacy ENV_FILE is intentionally unsupported because one shared env leaks
sidecar provider keys into Pilot.

Create provisions the Droplet and reconciles DO_FIREWALL_NAME for DO_FIREWALL_TAGS.
It does not deploy automatically, so preload-helm can load a local HELM image first.
Firewall defaults allow 80/443 from the public internet and 22 only from DO_SSH_CIDR.
Deploy and rollback start COMPOSE_PROFILES=backup by default so encrypted backup
uploads run on the production schedule. Set COMPOSE_PROFILES= to disable profiles.

HELM preload:
  preload-helm builds HELM_IMAGE from .env.production.shared, copies it to the
  Droplet, and runs docker load. By default HELM_PRELOAD_MODE=binary cross-compiles
  the HELM binary locally and packages it into a runtime image. Set
  HELM_PRELOAD_MODE=docker to build HELM_KERNEL_DIR with HELM_DOCKERFILE, or set
  HELM_IMAGE_ARCHIVE to upload an existing docker save tar.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

env_value() {
  local file="$1"
  local key="$2"
  local line
  line="$(grep -E "^${key}=" "$file" | tail -n1 || true)"
  printf '%s' "${line#*=}"
}

require_file() {
  [[ -f "$1" ]] || die "required env file not found: $1"
}

abs_path() {
  local path="$1"
  local dir base
  dir="$(dirname "$path")"
  base="$(basename "$path")"
  printf '%s/%s' "$(cd "$dir" && pwd -P)" "$base"
}

copy_env_if_needed() {
  local src="$1"
  local dst="$2"
  if [[ -f "$dst" && "$(abs_path "$src")" == "$(abs_path "$dst")" ]]; then
    return 0
  fi
  cp "$src" "$dst"
}

require_value() {
  local file="$1"
  local key="$2"
  local value
  value="$(env_value "$file" "$key")"
  [[ -n "$value" ]] || die "$key must be set in $file"
  case "$value" in
    change-me*|changeme*|example|example.com|helm|password)
      die "$key in $file still looks like a placeholder"
      ;;
  esac
}

require_pinned_image() {
  local file="$1"
  local key="$2"
  local value
  require_value "$file" "$key"
  value="$(env_value "$file" "$key")"
  case "$value" in
    *:local|*:latest|*REPLACE*|*change-me*|'')
      die "$key in $file must be an immutable release tag or digest, not '$value'"
      ;;
  esac
}

forbid_value() {
  local file="$1"
  local key="$2"
  local value
  value="$(env_value "$file" "$key")"
  [[ -z "$value" ]] || die "$key must not be set in $file; provider keys belong in .env.production.helm"
}

validate_env_files() {
  [[ -z "${ENV_FILE:-}" ]] || die "ENV_FILE is no longer supported; use split .env.production.{shared,helm,pilot} files"

  require_file "$ENV_SHARED_FILE"
  require_file "$ENV_HELM_FILE"
  require_file "$ENV_PILOT_FILE"

  require_value "$ENV_SHARED_FILE" DOMAIN
  require_value "$ENV_SHARED_FILE" APP_URL
  require_value "$ENV_SHARED_FILE" ALLOWED_ORIGINS
  require_value "$ENV_SHARED_FILE" POSTGRES_PASSWORD
  require_value "$ENV_SHARED_FILE" POSTGRES_DB
  require_value "$ENV_SHARED_FILE" HELM_POSTGRES_DB
  require_pinned_image "$ENV_SHARED_FILE" POSTGRES_IMAGE
  require_pinned_image "$ENV_SHARED_FILE" CADDY_IMAGE
  require_pinned_image "$ENV_SHARED_FILE" OFELIA_IMAGE
  require_pinned_image "$ENV_SHARED_FILE" HELM_IMAGE
  require_pinned_image "$ENV_SHARED_FILE" PILOT_IMAGE
  require_pinned_image "$ENV_SHARED_FILE" WEB_IMAGE
  forbid_value "$ENV_SHARED_FILE" OPENROUTER_API_KEY
  forbid_value "$ENV_SHARED_FILE" ANTHROPIC_API_KEY
  forbid_value "$ENV_SHARED_FILE" OPENAI_API_KEY
  forbid_value "$ENV_SHARED_FILE" VOYAGE_API_KEY

  [[ "$(env_value "$ENV_SHARED_FILE" APP_URL)" == https://* ]] || die "APP_URL must be HTTPS"
  [[ "$(env_value "$ENV_SHARED_FILE" ALLOWED_ORIGINS)" != "*" ]] || die "ALLOWED_ORIGINS cannot be '*' in production"

  require_value "$ENV_HELM_FILE" HELM_UPSTREAM_URL
  require_value "$ENV_HELM_FILE" EVIDENCE_SIGNING_KEY
  if [[ -z "$(env_value "$ENV_HELM_FILE" OPENROUTER_API_KEY)$(env_value "$ENV_HELM_FILE" ANTHROPIC_API_KEY)$(env_value "$ENV_HELM_FILE" OPENAI_API_KEY)" ]]; then
    die "set at least one upstream provider key in $ENV_HELM_FILE"
  fi

  require_value "$ENV_PILOT_FILE" SESSION_SECRET
  require_value "$ENV_PILOT_FILE" ENCRYPTION_KEY
  require_value "$ENV_PILOT_FILE" TELEGRAM_WEBHOOK_SECRET
  [[ "$(env_value "$ENV_PILOT_FILE" HELM_FAIL_CLOSED)" == "1" ]] || die "HELM_FAIL_CLOSED=1 is required in $ENV_PILOT_FILE"
  forbid_value "$ENV_PILOT_FILE" OPENROUTER_API_KEY
  forbid_value "$ENV_PILOT_FILE" ANTHROPIC_API_KEY
  forbid_value "$ENV_PILOT_FILE" OPENAI_API_KEY
  forbid_value "$ENV_PILOT_FILE" VOYAGE_API_KEY
  require_value "$ENV_SHARED_FILE" S3_ENDPOINT
  require_value "$ENV_SHARED_FILE" S3_BUCKET
  require_value "$ENV_PILOT_FILE" S3_ACCESS_KEY
  require_value "$ENV_PILOT_FILE" S3_SECRET_KEY
  require_value "$ENV_PILOT_FILE" BACKUP_ENCRYPTION_PASSPHRASE

  local email_provider
  email_provider="$(env_value "$ENV_PILOT_FILE" EMAIL_PROVIDER)"
  case "$email_provider" in
    resend)
      require_value "$ENV_PILOT_FILE" RESEND_API_KEY
      ;;
    smtp)
      require_value "$ENV_PILOT_FILE" SMTP_HOST
      require_value "$ENV_PILOT_FILE" SMTP_USER
      require_value "$ENV_PILOT_FILE" SMTP_PASS
      ;;
    *)
      die "EMAIL_PROVIDER must be resend or smtp in production"
      ;;
  esac
  require_value "$ENV_PILOT_FILE" EMAIL_FROM
}

compose_doctor() {
  validate_env_files
  require_cmd docker
  copy_env_if_needed "$ENV_SHARED_FILE" .env.production.shared
  copy_env_if_needed "$ENV_HELM_FILE" .env.production.helm
  copy_env_if_needed "$ENV_PILOT_FILE" .env.production.pilot
  COMPOSE_PROFILES="$COMPOSE_PROFILES" "${COMPOSE[@]}" config >/dev/null
  echo "DigitalOcean production doctor passed."
}

preload_helm_image() {
  local ip image archive cleanup_archive=0 build_dir target_os target_arch
  validate_env_files
  require_cmd docker
  require_cmd scp
  require_cmd ssh

  ip="$(droplet_ip)"
  [[ -n "$ip" ]] || die "set DO_DROPLET_IP or create a droplet named $DROPLET_NAME"
  image="$(env_value "$ENV_SHARED_FILE" HELM_IMAGE)"
  [[ -n "$image" ]] || die "HELM_IMAGE must be set in $ENV_SHARED_FILE"

  if [[ -n "$HELM_IMAGE_ARCHIVE" ]]; then
    archive="$HELM_IMAGE_ARCHIVE"
    [[ -f "$archive" ]] || die "HELM_IMAGE_ARCHIVE not found: $archive"
  else
    [[ -d "$HELM_KERNEL_DIR" ]] || die "HELM_KERNEL_DIR not found: $HELM_KERNEL_DIR"
    [[ -f "$HELM_KERNEL_DIR/$HELM_DOCKERFILE" ]] || die "HELM_DOCKERFILE not found: $HELM_KERNEL_DIR/$HELM_DOCKERFILE"
    archive="$(mktemp "${TMPDIR:-/tmp}/helm-sidecar-image.XXXXXX.tar")"
    cleanup_archive=1
    case "$HELM_PRELOAD_MODE" in
      binary)
        require_cmd go
        build_dir="$(mktemp -d "${TMPDIR:-/tmp}/helm-sidecar-build.XXXXXX")"
        target_os="${HELM_DOCKER_PLATFORM%%/*}"
        target_arch="${HELM_DOCKER_PLATFORM##*/}"
        echo "Cross-compiling HELM sidecar binary for $target_os/$target_arch ..."
        (cd "$HELM_KERNEL_DIR/core" && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build -ldflags="-s -w" -trimpath -o "$build_dir/helm" ./cmd/helm/)
        cat >"$build_dir/Dockerfile" <<'DOCKERFILE'
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata && \
    adduser -D -h /home/helm helm
COPY helm /usr/local/bin/helm
RUN mkdir -p /home/helm/data && chown helm:helm /home/helm/data
USER helm
WORKDIR /home/helm
ENTRYPOINT ["helm"]
CMD ["server"]
DOCKERFILE
        echo "Packaging HELM sidecar image $image for $HELM_DOCKER_PLATFORM ..."
        docker build --platform "$HELM_DOCKER_PLATFORM" -t "$image" "$build_dir"
        rm -rf "$build_dir"
        ;;
      docker)
        echo "Building HELM sidecar image $image from $HELM_KERNEL_DIR/$HELM_DOCKERFILE ..."
        docker build --platform "$HELM_DOCKER_PLATFORM" -f "$HELM_KERNEL_DIR/$HELM_DOCKERFILE" -t "$image" "$HELM_KERNEL_DIR"
        ;;
      *)
        die "HELM_PRELOAD_MODE must be binary or docker"
        ;;
    esac
    docker save "$image" -o "$archive"
  fi

  echo "Uploading HELM sidecar image $image to $REMOTE_USER@$ip ..."
  scp "${SSH_OPTS[@]}" "$archive" "$REMOTE_USER@$ip:/tmp/helm-sidecar-image.tar"
  ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$ip" "
    set -euo pipefail
    docker load -i /tmp/helm-sidecar-image.tar
    rm -f /tmp/helm-sidecar-image.tar
    docker image inspect '$image' >/dev/null
  "
  [[ "$cleanup_archive" -eq 0 ]] || rm -f "$archive"
  echo "HELM sidecar image preloaded: $image"
}

droplet_ip() {
  if [[ -n "${DO_DROPLET_IP:-}" ]]; then
    printf '%s\n' "$DO_DROPLET_IP"
    return
  fi
  require_cmd doctl
  doctl compute droplet get "$DROPLET_NAME" --format PublicIPv4 --no-header 2>/dev/null | tr -d '[:space:]'
}

firewall_id() {
  require_cmd doctl
  doctl compute firewall list --format ID,Name --no-header |
    awk -v name="$DO_FIREWALL_NAME" '$2 == name { print $1; exit }'
}

ensure_firewall() {
  local id inbound_rules outbound_rules
  require_cmd doctl
  [[ -n "$DO_SSH_CIDR" ]] || die "DO_SSH_CIDR is required for firewall SSH access"
  [[ -n "$DO_FIREWALL_TAGS" ]] || die "DO_FIREWALL_TAGS is required for firewall attachment"

  inbound_rules="protocol:tcp,ports:22,address:$DO_SSH_CIDR protocol:tcp,ports:80,address:0.0.0.0/0 protocol:tcp,ports:443,address:0.0.0.0/0"
  outbound_rules="protocol:tcp,ports:1-65535,address:0.0.0.0/0 protocol:udp,ports:1-65535,address:0.0.0.0/0 protocol:icmp,address:0.0.0.0/0"

  id="$(firewall_id)"
  if [[ -n "$id" ]]; then
    echo "Reconciling DigitalOcean firewall $DO_FIREWALL_NAME ($id) ..."
    doctl compute firewall update "$id" \
      --name "$DO_FIREWALL_NAME" \
      --tag-names "$DO_FIREWALL_TAGS" \
      --inbound-rules "$inbound_rules" \
      --outbound-rules "$outbound_rules" \
      >/dev/null
  else
    echo "Creating DigitalOcean firewall $DO_FIREWALL_NAME ..."
    doctl compute firewall create \
      --name "$DO_FIREWALL_NAME" \
      --tag-names "$DO_FIREWALL_TAGS" \
      --inbound-rules "$inbound_rules" \
      --outbound-rules "$outbound_rules" \
      >/dev/null
  fi
}

wait_for_cloud_init() {
  local ip="$1"
  echo "Waiting for cloud-init on $ip ..."
  for _ in {1..60}; do
    if ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$ip" 'test -f /opt/pilot/cloud-init-ready' >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  die "cloud-init did not finish in time; inspect /var/log/cloud-init-output.log on $ip"
}

create_droplet() {
  validate_env_files
  require_cmd doctl
  [[ -n "$DO_SSH_KEYS" ]] || die "DO_SSH_KEYS is required for droplet creation"

  if ip="$(droplet_ip)" && [[ -n "$ip" ]]; then
    echo "Droplet $DROPLET_NAME already exists at $ip"
    ensure_firewall
    wait_for_cloud_init "$ip"
    echo "Droplet is ready. Next: DO_DROPLET_IP=$ip ENV_DIR=$ENV_DIR bash infra/digitalocean/deploy.sh preload-helm"
    return
  fi

  echo "Creating DigitalOcean Droplet $DROPLET_NAME in $DO_REGION ..."
  ip="$(
    doctl compute droplet create "$DROPLET_NAME" \
      --region "$DO_REGION" \
      --size "$DO_SIZE" \
      --image "$DO_IMAGE" \
      --ssh-keys "$DO_SSH_KEYS" \
      --enable-monitoring \
      --enable-backups \
      --tag-names "$DO_TAGS" \
      --user-data-file "$ROOT_DIR/infra/digitalocean/cloud-init.yml" \
      --wait \
      --format PublicIPv4 \
      --no-header
  )"
  ip="$(printf '%s' "$ip" | tr -d '[:space:]')"
  [[ -n "$ip" ]] || die "DigitalOcean did not return a public IPv4"
  echo "Droplet created: $ip"
  ensure_firewall
  wait_for_cloud_init "$ip"
  echo "Droplet is ready. Next: DO_DROPLET_IP=$ip ENV_DIR=$ENV_DIR bash infra/digitalocean/deploy.sh preload-helm"
}

deploy_to() {
  local ip="$1"
  local release_dir="$REMOTE_RELEASES_DIR/$RELEASE_ID"
  validate_env_files
  require_cmd rsync
  require_cmd ssh

  echo "Deploying checkout to $REMOTE_USER@$ip:$release_dir ..."
  ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$ip" "mkdir -p '$REMOTE_RELEASES_DIR' '$release_dir'"
  rsync -az --delete \
    --exclude '.git' \
    --exclude '.turbo' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude '.next' \
    --exclude 'coverage' \
    --exclude 'backups' \
    --exclude 'data' \
    --exclude '.venv-pipelines' \
    --exclude '.env*' \
    ./ "$REMOTE_USER@$ip:$release_dir/"

  scp "${SSH_OPTS[@]}" "$ENV_SHARED_FILE" "$REMOTE_USER@$ip:$release_dir/.env.production.shared"
  scp "${SSH_OPTS[@]}" "$ENV_HELM_FILE" "$REMOTE_USER@$ip:$release_dir/.env.production.helm"
  scp "${SSH_OPTS[@]}" "$ENV_PILOT_FILE" "$REMOTE_USER@$ip:$release_dir/.env.production.pilot"

  echo "Starting Pilot on DigitalOcean ..."
  ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$ip" "
    set -euo pipefail
    cd '$release_dir'
    find packages services apps -type d \( -name dist -o -name .next \) -prune -exec rm -rf {} +
    COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml config >/dev/null
    COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml pull postgres caddy backup-cron pilot web
    COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml pull helm || {
      echo 'HELM image pull failed; continuing only if HELM_IMAGE was preloaded on the Droplet.'
      COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml config >/dev/null
    }
    COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml up -d postgres
    for attempt in \$(seq 1 60); do
      if COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml exec -T postgres sh -c 'pg_isready -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" && pg_isready -U \"\$POSTGRES_USER\" -d \"\$HELM_POSTGRES_DB\"' >/dev/null 2>&1; then
        break
      fi
      if [ \"\$attempt\" -eq 60 ]; then
        COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml logs --tail=100 postgres
        echo 'Postgres did not become ready before migrations.' >&2
        exit 1
      fi
      sleep 2
    done
    COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml run --rm --no-deps pilot node packages/db/dist/migrate-production.js
    COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml up -d
    COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml up -d --no-deps --force-recreate caddy
    COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile ||
      COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml restart caddy
    if [ -e '$REMOTE_DIR' ] && [ ! -L '$REMOTE_DIR' ]; then
      mv '$REMOTE_DIR' '$REMOTE_DIR.bootstrap.\$(date -u +%Y%m%d%H%M%S)'
    fi
    ln -sfnT '$release_dir' '$REMOTE_DIR'
    ls -1dt '$REMOTE_RELEASES_DIR'/* 2>/dev/null | tail -n +4 | xargs -r rm -rf
    COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml ps
  "

  echo "Deployed. Verify with:"
  echo "  HELM_FAIL_CLOSED=1 API_URL=https://$(env_value "$ENV_SHARED_FILE" DOMAIN) bash scripts/smoke-production-governance.sh"
}

status_remote() {
  local ip
  ip="$(droplet_ip)"
  [[ -n "$ip" ]] || die "set DO_DROPLET_IP or create a droplet named $DROPLET_NAME"
  ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$ip" "cd '$REMOTE_DIR' && COMPOSE_PROFILES='$COMPOSE_PROFILES' docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml ps"
}

rollback_remote() {
  local ip target
  ip="$(droplet_ip)"
  [[ -n "$ip" ]] || die "set DO_DROPLET_IP or create a droplet named $DROPLET_NAME"
  target="$ACTION_ARG"

  ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$ip" \
    "REMOTE_DIR='$REMOTE_DIR' REMOTE_RELEASES_DIR='$REMOTE_RELEASES_DIR' TARGET_RELEASE='$target' COMPOSE_PROFILES='$COMPOSE_PROFILES' bash -s" <<'REMOTE'
set -euo pipefail
target="$TARGET_RELEASE"
if [[ -z "$target" ]]; then
  current="$(readlink -f "$REMOTE_DIR" 2>/dev/null || true)"
  while IFS= read -r candidate; do
    if [[ "$candidate" != "$current" ]]; then
      target="$candidate"
      break
    fi
  done < <(ls -1dt "$REMOTE_RELEASES_DIR"/* 2>/dev/null || true)
else
  case "$target" in
    /*) ;;
    *) target="$REMOTE_RELEASES_DIR/$target" ;;
  esac
fi
[[ -n "$target" && -d "$target" ]] || {
  echo "No rollback release found under $REMOTE_RELEASES_DIR" >&2
  exit 1
}
cd "$target"
COMPOSE_PROFILES="$COMPOSE_PROFILES" docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml config >/dev/null
COMPOSE_PROFILES="$COMPOSE_PROFILES" docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml up -d
ln -sfnT "$target" "$REMOTE_DIR"
COMPOSE_PROFILES="$COMPOSE_PROFILES" docker compose -p pilot --env-file .env.production.shared --env-file .env.production.helm --env-file .env.production.pilot -f infra/digitalocean/docker-compose.yml ps
echo "Rolled back to $target"
REMOTE
}

smoke_remote() {
  local ip domain
  validate_env_files
  ip="$(droplet_ip)"
  [[ -n "$ip" ]] || die "set DO_DROPLET_IP or create a droplet named $DROPLET_NAME"
  domain="$(env_value "$ENV_SHARED_FILE" DOMAIN)"
  HELM_FAIL_CLOSED=1 API_URL="https://$domain" bash scripts/smoke-production-governance.sh
}

case "$ACTION" in
  doctor) compose_doctor ;;
  preload-helm) preload_helm_image ;;
  create) create_droplet ;;
  deploy)
    ip="$(droplet_ip)"
    [[ -n "$ip" ]] || die "set DO_DROPLET_IP or create a droplet named $DROPLET_NAME"
    wait_for_cloud_init "$ip"
    deploy_to "$ip"
    ;;
  status) status_remote ;;
  rollback) rollback_remote ;;
  smoke) smoke_remote ;;
  -h|--help|help) usage ;;
  *) usage; die "unknown action: $ACTION" ;;
esac
