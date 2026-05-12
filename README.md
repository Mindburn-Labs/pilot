> **Launch boundary note**
>
> Pilot is an experimental downstream application. It is not part of HELM OSS
> and should not be used to evaluate HELM kernel readiness, HELM OSS
> conformance, or the HELM launch surface.
>
> For HELM OSS, use: https://github.com/Mindburn-Labs/helm-oss

# Pilot

Pilot is an open-source, self-hostable autonomous founder operating system. It
helps founders assess fit, discover opportunities, evaluate real co-founder
candidates, coordinate digital operators, build, launch, and apply - behind a
governed trust boundary.

## Status And Audience

- Package: `pilot`
- Version: `1.3.0`
- Package manager: `npm@11.6.2`
- Runtime: Node.js 22, PostgreSQL 17, pgvector, Hono, Drizzle, pg-boss, Turbo
- Target deployment: self-hostable single-founder stack
- License: MIT

Pilot is not yet production-ready as a fully autonomous startup OS. The
authoritative capability states live in [docs/capabilities.md](docs/capabilities.md),
`GET /api/capabilities`, and
`packages/shared/src/capabilities/index.ts`. A feature may not be claimed
production-ready unless that registry marks it `production_ready` with passing
eval evidence.

## What Pilot Is

- A self-hostable founder OS for structured founder workflows.
- A single-process Node.js server with PostgreSQL and pgvector.
- A Telegram bot, Telegram Mini App, and web dashboard.
- A trust-boundary consumer that routes autonomous work through HELM via
  `packages/helm-client`.
- A Scrapling-first ingestion and browser-automation stack.

## What Pilot Is Not

- Not a HELM replacement. Production Pilot runs behind a HELM sidecar.
- Not a HELM OSS conformance surface.
- Not a multi-tenant SaaS.
- Not a general scraping framework.
- Not a place for ad-hoc tool calls, raw SQL, or new ORMs.
- Not a rewrite of historical vendored imports; those remain outside the active
  repo.

## Quick Start

Prerequisites:

- Node.js 22+
- npm 11+
- Docker and Docker Compose
- Python 3.10+ for Scrapling-backed pipelines
- A Telegram bot token from [@BotFather](https://t.me/BotFather), when using
  the bot or Mini App
- A HELM sidecar with an upstream LLM key for production
- OpenRouter, Anthropic, OpenAI, or Ollama only for direct-provider local
  development

```bash
git clone https://github.com/Mindburn-Labs/pilot.git
cd pilot
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d postgres
npm ci
bash scripts/install-python-runtime.sh
npm run db:migrate
npm run dev
```

The gateway starts on `http://localhost:3100` and the web app on
`http://localhost:3000`. The Telegram bot uses long polling in development.

## Architecture

Pilot V1 is a single-process server with service routers and background jobs.
PostgreSQL is the primary store and pg-boss job queue. pgvector powers semantic
memory. Scrapling handles public ingestion and browser automation.

Every autonomous action must pass through `packages/helm-client` and the HELM
trust boundary. No out-of-band tool calls are allowed.

## Repository Map

| Path                       | Purpose                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `apps/telegram-bot/`       | Telegram bot using grammY in polling and webhook modes                                  |
| `apps/telegram-miniapp/`   | Telegram Mini App UI                                                                    |
| `apps/web/`                | Next.js 15 web dashboard                                                                |
| `services/gateway/`        | Hono HTTP API, auth, CORS, rate limiting, and SSE                                       |
| `services/orchestrator/`   | Trust boundary, agent loop, and pg-boss jobs                                            |
| `services/memory/`         | pgvector semantic and keyword search                                                    |
| `services/decision-court/` | Adversarial decision gate                                                               |
| `services/*-engine/`       | Founder, cofounder, YC, product, launch, content, finance, application, and SEO engines |
| `packages/db/`             | Drizzle schema, migrations, and database helpers                                        |
| `packages/shared/`         | Zod schemas, config, logger, LLM provider, and capabilities registry                    |
| `packages/connectors/`     | External service integrations                                                           |
| `packages/helm-client/`    | HELM trust-boundary client                                                              |
| `pipelines/`               | Scrapling-backed ingestion                                                              |
| `infra/docker/`            | Local and self-host compose stack                                                       |
| `infra/digitalocean/`      | DigitalOcean deployment runbook and compose stack                                       |

## Configuration And Secrets

Start from `.env.example`. Required local values include `DATABASE_URL`,
`SESSION_SECRET`, `ENCRYPTION_KEY`, and `APP_URL`. `APP_URL` must be the public
gateway URL used for OAuth callbacks.

Production uses the HELM sidecar:

- `HELM_GOVERNANCE_URL` points Pilot at the sidecar.
- `HELM_FAIL_CLOSED=1` keeps governed calls blocked when HELM is unreachable.
- Upstream provider keys belong to the sidecar environment, not direct Pilot
  app config.

Direct local provider keys are for development only. Do not commit `.env`,
OAuth client secrets, Telegram tokens, encryption keys, or provider keys.

See [docs/env-reference.md](docs/env-reference.md) and `.env.example` for the
full environment reference.

## Development

```bash
npm run dev
npm run build
npm run typecheck
npm test
npm run lint
npm run db:generate
npm run db:migrate
npm run db:studio
```

Validate the local runtime, including Scrapling and browser binaries:

```bash
PYTHON_BIN=./.venv-pipelines/bin/python ./scripts/launch-gate.sh
```

Run the full release gate:

```bash
npm run test:release
```

## Self-Hosting

The local compose stack starts PostgreSQL, the gateway on port `3100`, and the
web app on port `3000`:

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d
```

Production deployment uses DigitalOcean as one Docker Compose stack: PostgreSQL,
private HELM governance sidecar, Pilot gateway, web app, Caddy TLS, and
optional backup scheduling. See [infra/digitalocean/README.md](infra/digitalocean/README.md)
for the full runbook.

```bash
cp infra/digitalocean/env.production.shared.example .env.production.shared
cp infra/digitalocean/env.production.helm.example .env.production.helm
cp infra/digitalocean/env.production.pilot.example .env.production.pilot

export DO_SSH_KEYS=<digitalocean-ssh-key-id-or-fingerprint>
export DO_REGION=fra1
export DO_SIZE=s-2vcpu-4gb

bash infra/digitalocean/deploy.sh doctor
bash infra/digitalocean/deploy.sh create
export DO_DROPLET_IP=<new-droplet-ip>
bash infra/digitalocean/deploy.sh preload-helm
bash infra/digitalocean/deploy.sh deploy
```

Set the Telegram webhook after DNS resolves:

```bash
TELEGRAM_BOT_TOKEN=... APP_URL=https://pilot.example.com bash infra/scripts/set-telegram-webhook.sh
```

## API

Unauthenticated routes are limited to `/health`, `/metrics`, and public
login/logout endpoints under `/api/auth`. API-key creation at
`/api/auth/apikey` is authenticated.

Use one of:

- `Authorization: Bearer <session-token>` from Telegram login
- `X-API-Key: <api-key>` generated through `POST /api/auth/apikey`

Core route groups include auth, status, founder profile, co-founder candidates,
opportunities, tasks, operators, knowledge search, connectors, YC companies,
product plans, launch artifacts, and task-event SSE.

## Invariants

- All autonomous actions go through `packages/helm-client`.
- Orchestrator remains single-process.
- Ingestion is Scrapling-first.
- DB access goes through Drizzle; raw SQL is limited to migrations.
- Payloads are validated with Zod from `packages/shared`.
- Vendored legacy import trees must not be reintroduced.
- The product name is `Pilot`; the on-disk directory is `pilot/`.

## Documentation

- Capabilities: [docs/capabilities.md](docs/capabilities.md)
- Self-hosting: [docs/self-hosting.md](docs/self-hosting.md)
- HELM integration: [docs/helm-integration.md](docs/helm-integration.md)
- Environment reference: [docs/env-reference.md](docs/env-reference.md)
- Security: [docs/security.md](docs/security.md)
- Runbook: [docs/runbook.md](docs/runbook.md)
- Roadmap: [docs/roadmap.md](docs/roadmap.md)
- DigitalOcean deployment: [infra/digitalocean/README.md](infra/digitalocean/README.md)

## Security And Contributing

- Security reports: [SECURITY.md](SECURITY.md)
- Contribution process: [CONTRIBUTING.md](CONTRIBUTING.md)
- Community expectations: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
