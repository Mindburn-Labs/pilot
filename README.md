> **Launch boundary note**
>
> Pilot is an experimental downstream application. It is not part of HELM OSS and should not be used to evaluate HELM kernel readiness, HELM OSS conformance, or the HELM launch surface.
>
> For HELM OSS, use: https://github.com/Mindburn-Labs/helm-oss

# Pilot

Open-source, self-hostable autonomous founder operating system. Pilot helps founders assess fit, discover opportunities, evaluate real co-founder candidates, coordinate digital operators, build, launch, and apply, all behind a governed trust boundary.

Production-readiness truth: Pilot is not yet production-ready as a fully autonomous startup OS. The authoritative capability states live in [`docs/capabilities.md`](docs/capabilities.md), `GET /api/capabilities`, and `packages/shared/src/capabilities/index.ts`. A feature may not be claimed production-ready unless that registry marks it `production_ready` with passing eval evidence.

The ingestion and browser-automation layer is now Scrapling-first: public YC ingestion, session-backed YC matching sync, and operator-triggered fetch/extract work all run through the shared Scrapling runtime.

## Architecture

Single-process Node.js server (V1) with PostgreSQL 17 + pgvector.

```
apps/
  telegram-bot/       Telegram bot (grammY, polling + webhook modes)
  telegram-miniapp/   Telegram Mini App (web UI)
  web/                Next.js 15 web dashboard

services/
  gateway/            Hono HTTP API (auth, CORS, rate limiting, SSE)
  orchestrator/       Trust boundary + agent loop + pg-boss jobs
  memory/             Knowledge layer (pgvector semantic + keyword search)
  founder-intel/      LLM-powered founder profile extraction
  cofounder-engine/   Operator role matching + team composition
  yc-intel/           YC company/batch/advice search
  product-factory/    Product spec generation from plans
  launch-engine/      Deploy artifacts + launch tracking

packages/
  db/                 Drizzle ORM schema (47 tables, 13 domains)
  shared/             Zod schemas, config, logger, LLM provider
  connectors/         External service integrations
  ui/                 Shared UI components
```

## Prerequisites

- Node.js >= 22
- Docker & Docker Compose (for PostgreSQL)
- Python 3.10+ (for Scrapling-backed pipelines)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- For production: a HELM sidecar with an upstream LLM key configured on the sidecar
- For local direct-provider development: OpenRouter, Anthropic, OpenAI, or Ollama
- `APP_URL` set to the public gateway URL you will use for OAuth callbacks

## Quickstart

```bash
# Clone
git clone https://github.com/Mindburn-Labs/pilot.git
cd pilot

# Configure
cp .env.example .env
# Edit .env — set `DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `APP_URL`,
# `TELEGRAM_BOT_TOKEN`, and either HELM sidecar settings or a local LLM provider.

# Start PostgreSQL
docker compose -f infra/docker/docker-compose.yml up -d postgres

# Install dependencies
npm ci

# Install the pinned Python runtime for Scrapling pipelines
bash scripts/install-python-runtime.sh

# Run database migrations
npm run db:migrate

# Start dev server (all services)
npm run dev
```

The gateway starts on `http://localhost:3100` and the web app on `http://localhost:3000`. The Telegram bot connects via long polling in dev mode.

## Development Docker Compose

```bash
cp .env.example .env
# Edit .env with local development values

docker compose -f infra/docker/docker-compose.yml up -d
```

This dev-only stack starts PostgreSQL, the gateway on port `3100`, and the web app on port `3000`. PostgreSQL and pgAdmin bind to localhost. Use the DigitalOcean stack below for production.

## Deploy to DigitalOcean

Pilot deploys to DigitalOcean as one Docker Compose stack on a Droplet: PostgreSQL, the private HELM governance sidecar, the Pilot gateway, the web app, Caddy TLS, and optional backup scheduling. See [`infra/digitalocean/README.md`](infra/digitalocean/README.md) for the full runbook.

```bash
cp infra/digitalocean/env.production.shared.example .env.production.shared
cp infra/digitalocean/env.production.helm.example .env.production.helm
cp infra/digitalocean/env.production.pilot.example .env.production.pilot
# Fill DOMAIN, APP_URL, secrets, pinned images, Resend email,
# DO Spaces backup settings, and the sidecar's upstream provider key.

export DO_SSH_KEYS=<digitalocean-ssh-key-id-or-fingerprint>
export DO_REGION=fra1
export DO_SIZE=s-2vcpu-4gb

bash infra/digitalocean/deploy.sh doctor
bash infra/digitalocean/deploy.sh create
export DO_DROPLET_IP=<new-droplet-ip>
bash infra/digitalocean/deploy.sh preload-helm
bash infra/digitalocean/deploy.sh deploy

# Set Telegram webhook once DNS resolves.
TELEGRAM_BOT_TOKEN=... APP_URL=https://pilot.example.com bash infra/scripts/set-telegram-webhook.sh
```

## Development

```bash
npm run dev          # Start all services (Turbo)
npm run build        # Build all workspaces
npm run typecheck    # TypeScript check all workspaces
npm test             # Run all tests (Vitest)
npm run test:release # Full release gate: static checks, compose config, local API E2E
npm run db:generate  # Regenerate Drizzle migrations
npm run db:migrate   # Apply migrations
npm run db:studio    # Open Drizzle Studio (DB browser)
npm run format       # Prettier format
```

Validate the local runtime, including Scrapling and browser binaries:

```bash
PYTHON_BIN=./.venv-pipelines/bin/python ./scripts/launch-gate.sh
```

## API

All API routes require authentication except `/health`, `/metrics`, and the public login/logout endpoints under `/api/auth`. API-key creation at `/api/auth/apikey` is authenticated.

- `Authorization: Bearer <session-token>` (from Telegram login), or
- `X-API-Key: <api-key>` (generated via `POST /api/auth/apikey`)

| Method | Path                                   | Description                                              |
| ------ | -------------------------------------- | -------------------------------------------------------- |
| GET    | `/health`                              | Health check (DB + pg-boss status)                       |
| POST   | `/api/auth/telegram`                   | Authenticate via Telegram Web App                        |
| POST   | `/api/auth/apikey`                     | Generate API key (requires auth)                         |
| DELETE | `/api/auth/session`                    | Logout                                                   |
| GET    | `/api/status`                          | Workspace status summary for web + Mini App              |
| GET    | `/api/founder/profile`                 | Get founder profile                                      |
| POST   | `/api/founder/profile`                 | Upsert founder profile                                   |
| POST   | `/api/founder/analyze`                 | Analyze founder from text                                |
| GET    | `/api/founder/candidates`              | List real co-founder candidates                          |
| POST   | `/api/founder/candidates/:id/score`    | Score a co-founder candidate                             |
| GET    | `/api/opportunities`                   | List opportunities                                       |
| POST   | `/api/opportunities/:id/score`         | Queue opportunity scoring                                |
| POST   | `/api/tasks`                           | Create task                                              |
| GET    | `/api/tasks`                           | List tasks                                               |
| POST   | `/api/tasks/:id/run`                   | Run a task through the orchestrator                      |
| GET    | `/api/operators`                       | List operators                                           |
| GET    | `/api/knowledge/search`                | Search knowledge base                                    |
| GET    | `/api/connectors`                      | List connector definitions or workspace connector status |
| GET    | `/api/connectors/:name/oauth/initiate` | Start OAuth flow for a connector                         |
| GET    | `/api/yc/companies`                    | Search YC companies                                      |
| GET    | `/api/product/plans`                   | List product plans                                       |
| GET    | `/api/launch/artifacts`                | List launch artifacts                                    |
| GET    | `/api/events/tasks`                    | SSE stream for task updates                              |

## Environment Variables

| Variable                        | Required   | Default                 | Description                                                                                                              |
| ------------------------------- | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                  | Yes        | -                       | PostgreSQL connection string                                                                                             |
| `APP_URL`                       | Yes        | `http://localhost:3100` | Public gateway base URL used for OAuth callbacks                                                                         |
| `TELEGRAM_BOT_TOKEN`            | No         | -                       | Telegram bot token (enables bot)                                                                                         |
| `TELEGRAM_WEBHOOK_SECRET`       | No         | -                       | Webhook HMAC secret (production)                                                                                         |
| `TELEGRAM_MANAGER_BOT_USERNAME` | No         | `getMe`                 | Optional main-bot username override for Telegram Managed Bots setup links                                                |
| `HELM_GOVERNANCE_URL`           | Prod       | -                       | HELM sidecar URL. Production Pilot routes LLM and tool governance through this.                                          |
| `HELM_FAIL_CLOSED`              | Prod       | `1`                     | Keep `1` in production so HELM unreachability blocks governed calls.                                                     |
| `OPENROUTER_API_KEY`            | Direct dev | -                       | Direct Pilot LLM key only when HELM sidecar is not configured. In production this key belongs in `.env.production.helm`. |
| `SESSION_SECRET`                | Yes        | -                       | Session token signing secret                                                                                             |
| `ENCRYPTION_KEY`                | Yes        | -                       | Connector token encryption key                                                                                           |
| `PYTHON_BIN`                    | No         | `python3`               | Python executable used by background ingestion jobs                                                                      |
| `PLAYWRIGHT_BROWSERS_PATH`      | No         | repo-local cache        | Browser cache for Scrapling dynamic fetchers                                                                             |
| `PATCHRIGHT_BROWSERS_PATH`      | No         | repo-local cache        | Browser cache for Scrapling stealth sessions                                                                             |
| `PORT`                          | No         | 3100                    | HTTP server port                                                                                                         |
| `NODE_ENV`                      | No         | development             | Environment (development/production)                                                                                     |
| `LOG_LEVEL`                     | No         | info                    | Pino log level                                                                                                           |
| `ALLOWED_ORIGINS`               | No         | -                       | CORS allowed origins (comma-separated)                                                                                   |

See `.env.example` for the full list including optional providers and connectors.

## License

MIT
