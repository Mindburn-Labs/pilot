# DigitalOcean Deployment

Pilot now uses DigitalOcean Droplets plus Docker Compose as the production deployment path. The topology is one Droplet running:

- PostgreSQL 17 with pgvector
- HELM governance sidecar
- Pilot gateway
- Next.js web app
- Caddy TLS reverse proxy
- optional scheduled backup runner

This keeps the HELM sidecar private on the Docker network and keeps production fail-closed with `HELM_FAIL_CLOSED=1`.

## Prerequisites

- `doctl` authenticated with `doctl auth init`
- an SSH key registered in DigitalOcean
- a DNS `A` record for your production domain pointed at the Droplet IP
- a HELM sidecar image in `HELM_IMAGE`; the deploy script can preload a local build before the stack starts
- a DO Spaces bucket and access key for encrypted production backups

DigitalOcean's `doctl compute droplet create` supports `--user-data-file`, which this runbook uses for `cloud-init` bootstrapping. The provision script enables DigitalOcean monitoring and backups at Droplet creation time.

## Configure

```bash
cp infra/digitalocean/env.production.shared.example .env.production.shared
cp infra/digitalocean/env.production.helm.example .env.production.helm
cp infra/digitalocean/env.production.pilot.example .env.production.pilot
openssl rand -hex 32 # use for SESSION_SECRET
openssl rand -hex 32 # use for ENCRYPTION_KEY
openssl rand -hex 32 # use for POSTGRES_PASSWORD
openssl rand -hex 32 # use for TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 32 # use for EVIDENCE_SIGNING_KEY
openssl rand -hex 32 # use for BACKUP_ENCRYPTION_PASSPHRASE
```

Edit the three env files and set at minimum:

- `.env.production.shared`: `DOMAIN`, `APP_URL`, `ALLOWED_ORIGINS`, `POSTGRES_PASSWORD`, pinned `POSTGRES_IMAGE`, `CADDY_IMAGE`, `OFELIA_IMAGE`, `HELM_IMAGE`, `PILOT_IMAGE`, `WEB_IMAGE`, `S3_ENDPOINT`, `S3_BUCKET`
- `.env.production.helm`: `HELM_UPSTREAM_URL`, `EVIDENCE_SIGNING_KEY`, and one upstream LLM provider key
- `.env.production.pilot`: `SESSION_SECRET`, `ENCRYPTION_KEY`, `TELEGRAM_WEBHOOK_SECRET`, production email delivery, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `BACKUP_ENCRYPTION_PASSPHRASE`

Do not set direct Pilot LLM keys in `.env.production.pilot`. Provider keys live on the HELM sidecar and Pilot talks to `http://helm:8080` only. The Compose stack initializes both `pilot` and `helm_governance` databases before the services boot.

## Create And Deploy

Run the release gate before creating or updating a production Droplet. It builds the workspace, runs unit/static checks, validates the DigitalOcean Compose file, then starts a local pgvector Postgres plus gateway and runs the Playwright API E2E suite:

```bash
npm run test:release
```

```bash
export DO_SSH_KEYS=<digitalocean-ssh-key-id-or-fingerprint>
export DO_REGION=fra1
export DO_SIZE=s-2vcpu-4gb

bash infra/digitalocean/deploy.sh doctor
bash infra/digitalocean/deploy.sh create
```

`create` provisions the Droplet with `cloud-init`, waits for Docker to be ready, and reconciles the launch firewall. It does not deploy automatically because the patched HELM sidecar image may need to be preloaded first.

```bash
export DO_DROPLET_IP=<new-droplet-ip>
bash infra/digitalocean/deploy.sh preload-helm
bash infra/digitalocean/deploy.sh deploy
```

`preload-helm` defaults to `HELM_PRELOAD_MODE=binary`: it cross-compiles the local `../helm-ai-kernel` sidecar for Linux amd64, packages it as `HELM_IMAGE`, copies it to the Droplet, and runs `docker load`. Set `HELM_PRELOAD_MODE=docker` to build from the HELM Dockerfile instead, or set `HELM_IMAGE_ARCHIVE` to upload an existing `docker save` tar.

`deploy` copies this checkout to `/opt/pilot/releases/<git-sha>`, writes the split production env files, pulls the pinned production images, starts Postgres, waits for both Pilot and HELM databases to accept connections, runs the production migration CLI once, starts the stack, and points `/opt/pilot/current` at the successful release. It starts `COMPOSE_PROFILES=backup` by default so encrypted scheduled backups run in production:

```bash
COMPOSE_PROFILES=backup docker compose -p pilot --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml up -d
```

Set `COMPOSE_PROFILES=` only for a controlled non-production smoke that intentionally disables scheduled backups.

## Verify

```bash
curl -fsS https://$DOMAIN/health | jq
curl -fsS https://$DOMAIN/metrics | head
HELM_FAIL_CLOSED=1 API_URL=https://$DOMAIN bash scripts/smoke-production-governance.sh
```

`/health` must report `checks.helm: "ok"` before launch. If it does not, check the sidecar first:

```bash
ssh root@$DO_DROPLET_IP
cd /opt/pilot/current
docker compose --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml logs --tail=200 helm
docker compose --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml exec helm wget -qO- http://localhost:8081/healthz
```

## Operations

```bash
# Status
bash infra/digitalocean/deploy.sh status

# Logs
ssh root@$DO_DROPLET_IP 'cd /opt/pilot/current && docker compose --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml logs -f --tail=200 pilot'

# Restart
ssh root@$DO_DROPLET_IP 'cd /opt/pilot/current && docker compose --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml restart pilot'

# Backup
ssh root@$DO_DROPLET_IP 'cd /opt/pilot/current && docker compose -p pilot --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml exec pilot bash /app/scripts/backup.sh create-and-upload'
```

Daily encrypted backup uploads are enabled by default through the `backup` Compose profile in `deploy.sh`. To start the profile manually:

```bash
docker compose -p pilot --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml --profile backup up -d
```

## Rollback

The deployment script keeps persistent data in Docker volumes and keeps the last three application releases. To roll back to the previous release:

```bash
DO_DROPLET_IP=<ip> bash infra/digitalocean/deploy.sh rollback
```

To roll back to a specific release directory or id:

```bash
DO_DROPLET_IP=<ip> bash infra/digitalocean/deploy.sh rollback <release-id-or-path>
```

Run the production smoke test after any rollback.
