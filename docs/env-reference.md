# Environment Variables Reference

Complete reference for all Pilot configuration variables.

## Required Variables

| Variable         | Description                                                                         | Example                                       |
| ---------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `DATABASE_URL`   | PostgreSQL connection string with pgvector                                          | `postgresql://helm:helm@localhost:5432/pilot` |
| `SESSION_SECRET` | 64-char hex secret for session token signing. Generate: `openssl rand -hex 32`      | `a1b2c3...`                                   |
| `ENCRYPTION_KEY` | 64-char hex secret for connector token encryption. Generate: `openssl rand -hex 32` | `a1b2c3...`                                   |
| `APP_URL`        | Public gateway base URL used for OAuth, email login links, and callbacks            | `https://pilot.example.com`                   |

## Telegram

| Variable                        | Required | Default | Description                                                                            |
| ------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | No       | —       | Bot token from [@BotFather](https://t.me/BotFather). Enables the Telegram bot.         |
| `TELEGRAM_WEBHOOK_SECRET`       | Prod     | —       | HMAC secret for webhook validation. Generate: `openssl rand -hex 32`                   |
| `TELEGRAM_OWNER_CHAT_ID`        | No       | —       | Telegram chat ID of the bot owner. Enables admin commands and proactive notifications. |
| `TELEGRAM_MANAGER_BOT_USERNAME` | No       | `getMe` | Optional manager bot username override for Telegram Managed Bots setup links.          |

> **Finding your chat ID:** Send `/start` to [@userinfobot](https://t.me/userinfobot) on Telegram.

Managed launch/support bots require enabling **Bot Management Mode** for the main bot in BotFather's Mini App. `APP_URL` must be publicly reachable because child bot webhooks are configured as `{APP_URL}/api/telegram/managed/:managedBotId/webhook`.

## LLM Providers

Production deployments should route Pilot through the HELM sidecar. In that shape, direct provider keys live on the HELM app, not on the Pilot app. Direct providers are for local development, fallback labs, or non-HELM deployments.

| Variable              | Required   | Description                                                                               |
| --------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `HELM_GOVERNANCE_URL` | Prod       | HELM sidecar governed API URL, e.g. `http://helm:8080` on the Docker network.             |
| `HELM_HEALTH_URL`     | Prod       | HELM sidecar health URL, e.g. `http://helm:8081`.                                         |
| `HELM_FAIL_CLOSED`    | Prod       | Must be `1` in production. Unreachable HELM blocks governed LLM calls.                    |
| `HELM_UPSTREAM_URL`   | Prod       | OpenAI-compatible upstream endpoint used by the HELM sidecar after policy approval.       |
| `HELM_PORT`           | Local      | Host port exposed by the local HELM governance API. Defaults to `8420`.                   |
| `HELM_HEALTH_PORT`    | Local      | Host port exposed by the local HELM health API. Defaults to `8421`.                       |
| `HELM_REGION`         | No         | Region label included in local/deployed HELM sidecar metadata and evidence context.       |
| `PILOT_LLM_MODEL`     | No         | Model name passed through the HELM proxy.                                                 |
| `OPENROUTER_API_KEY`  | Direct dev | OpenRouter key when Pilot runs without HELM.                                              |
| `ANTHROPIC_API_KEY`   | Direct dev | Direct Anthropic key when Pilot runs without HELM.                                        |
| `OPENAI_API_KEY`      | Direct dev | Direct OpenAI key when Pilot runs without HELM. Also used for embeddings when configured. |
| `OLLAMA_BASE_URL`     | Direct dev | Local/self-hosted Ollama endpoint used only when no cloud key is set.                     |
| `OLLAMA_MODEL`        | If Ollama  | Ollama model id, e.g. `llama3.1:8b`.                                                      |

For DigitalOcean production, set upstream provider keys on the `helm` sidecar service; do not set direct provider keys on `pilot`.

## Connectors (OAuth)

These enable real OAuth flows for external services. Without them, connectors operate in manual-token mode.

| Variable               | Required | Description                                                                                                                                                                              |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`     | No       | GitHub OAuth App client ID                                                                                                                                                               |
| `GITHUB_CLIENT_SECRET` | No       | GitHub OAuth App client secret                                                                                                                                                           |
| `GOOGLE_CLIENT_ID`     | No       | Google OAuth client ID (for Gmail + Drive)                                                                                                                                               |
| `GOOGLE_CLIENT_SECRET` | No       | Google OAuth client secret                                                                                                                                                               |
| `GOOGLE_REDIRECT_URI`  | No       | Google OAuth redirect URI. Default: `{APP_URL}/api/connectors/gmail/oauth/callback`                                                                                                      |
| `ENABLED_CONNECTORS`   | No       | Comma-separated list of connectors to strictly validate at startup (e.g., `github,gmail,gdrive`). Missing credentials for enabled connectors cause `fatal error → exit 1` in production. |

### Setting up GitHub OAuth

1. Go to [GitHub Developer Settings → OAuth Apps](https://github.com/settings/developers)
2. Create a new OAuth App
3. Set Authorization callback URL to `https://your-domain.com/api/connectors/github/oauth/callback`
4. Copy Client ID and Client Secret to `.env`

### Setting up Google OAuth (Gmail + Drive)

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (Web application)
3. Add authorized redirect URIs:
   - `https://your-domain.com/api/connectors/gmail/oauth/callback`
   - `https://your-domain.com/api/connectors/gdrive/oauth/callback`
4. Enable the Gmail API and Google Drive API in the API Library
5. Copy Client ID and Client Secret to `.env`

## Connectors (Session Auth)

The YC connector uses founder-authorized browser session capture instead of OAuth.

| Variable         | Required | Description                                                              |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `APP_URL`        | Yes      | Base URL used to return from the guided YC session-capture flow.         |
| `ENCRYPTION_KEY` | Yes      | Encrypts stored browser storage-state snapshots in `connector_sessions`. |

YC session state is stored separately from OAuth tokens. It powers authenticated reads and syncs for YC cofounder matching and other private YC workflows.

## Security

| Variable               | Required | Default                   | Description                                                                               |
| ---------------------- | -------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `SESSION_SECRET`       | Yes      | `change-me-in-production` | Session token HMAC signing secret. **Must change in production.**                         |
| `ENCRYPTION_KEY`       | Prod     | dev fallback              | AES-256-GCM key for encrypting connector tokens at rest. Generate: `openssl rand -hex 32` |
| `EVIDENCE_SIGNING_KEY` | Prod     | dev fallback              | Ed25519 evidence-pack signing key used by governed receipt and audit flows.               |
| `DAILY_BUDGET_MAX`     | No       | `500`                     | Maximum daily spend (EUR) across all tasks before kill switch                             |
| `PER_TASK_BUDGET_MAX`  | No       | `100`                     | Maximum spend per individual task                                                         |

> ⚠️ **Production requirement:** Both `SESSION_SECRET` and `ENCRYPTION_KEY` must be set to unique, random values.

## Server

| Variable                    | Required | Default                                        | Description                                                                                                                                                |
| --------------------------- | -------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                      | No       | `3100`                                         | HTTP server port                                                                                                                                           |
| `NODE_ENV`                  | No       | `development`                                  | Environment. Set to `production` for production.                                                                                                           |
| `LOG_LEVEL`                 | No       | `info`                                         | Pino log level (`debug`, `info`, `warn`, `error`, `fatal`)                                                                                                 |
| `ALLOWED_ORIGINS`           | No       | `*` (dev)                                      | Comma-separated CORS allowed origins. Set to your domain in production.                                                                                    |
| `APP_URL`                   | No       | `http://localhost:3100`                        | Public-facing URL of the app (used for OAuth redirect URIs)                                                                                                |
| `RUN_MIGRATIONS_ON_STARTUP` | No       | `true`                                         | When `true` (default), gateway runs pending Drizzle migrations on boot. DigitalOcean production sets `false` and runs migrations explicitly during deploy. |
| `PYTHON_BIN`                | No       | `python3`                                      | Python executable used by the orchestrator for Scrapling-backed pipelines. For local installs, prefer `./.venv-pipelines/bin/python`.                      |
| `PLAYWRIGHT_BROWSERS_PATH`  | No       | repo-local cache or `/ms-playwright` in Docker | Browser binary cache used by dynamic Scrapling fetchers.                                                                                                   |
| `PATCHRIGHT_BROWSERS_PATH`  | No       | repo-local cache or `/ms-patchright` in Docker | Browser binary cache used by stealth Scrapling sessions.                                                                                                   |

## Email (Transactional)

Required in production to send magic-link login codes. In development, the `noop` provider does not send email; the local auth route returns the code in the HTTP response and provider logs include only redacted delivery metadata.

| Variable         | Required    | Default                        | Description                                                   |
| ---------------- | ----------- | ------------------------------ | ------------------------------------------------------------- |
| `EMAIL_PROVIDER` | No          | `noop`                         | `resend` \| `smtp` \| `noop`. Use `noop` only in development. |
| `EMAIL_FROM`     | No          | `Pilot <onboarding@pilot.dev>` | Sender address                                                |
| `RESEND_API_KEY` | If `resend` | —                              | API key from [resend.com](https://resend.com)                 |
| `SMTP_HOST`      | If `smtp`   | —                              | SMTP server hostname                                          |
| `SMTP_PORT`      | If `smtp`   | `587`                          | SMTP port (587 STARTTLS, 465 TLS)                             |
| `SMTP_USER`      | No          | —                              | SMTP auth username                                            |
| `SMTP_PASS`      | No          | —                              | SMTP auth password                                            |
| `SMTP_SECURE`    | No          | auto                           | `true` for port 465, else STARTTLS                            |

> ⚠️ **Production requirement:** `EMAIL_PROVIDER` must be `resend` or `smtp`. The `noop` provider is dev-only; users cannot log in.

## Object Storage

For storing artifacts, launch assets, and raw ingestion captures. Falls back to local filesystem if not configured.

| Variable           | Required | Default          | Description                                           |
| ------------------ | -------- | ---------------- | ----------------------------------------------------- |
| `STORAGE_PROVIDER` | No       | `local`          | `local` or `s3`                                       |
| `STORAGE_PATH`     | No       | `./data/storage` | Local storage directory (when using `local` provider) |
| `S3_ENDPOINT`      | Prod     | —                | S3-compatible endpoint URL, e.g. DO Spaces            |
| `S3_BUCKET`        | Prod     | —                | S3 bucket name                                        |
| `S3_ACCESS_KEY`    | Prod     | —                | S3 access key                                         |
| `S3_SECRET_KEY`    | Prod     | —                | S3 secret key                                         |
| `S3_REGION`        | Prod     | `fra1`           | S3 signing region                                     |

When using local storage, Pilot also persists:

- Scrapling adaptive selector databases under `STORAGE_PATH/adaptive`
- raw crawl captures under `STORAGE_PATH/raw`
- crawl checkpoints under `STORAGE_PATH/crawls`

## Error Reporting (Optional)

| Variable          | Required | Default | Description                                                                |
| ----------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `SENTRY_DSN`      | No       | —       | Sentry DSN for error reporting. When unset, errors only hit local logs.    |
| `RELEASE_VERSION` | No       | —       | Release tag for Sentry (e.g., git SHA). Helps correlate errors to deploys. |

## Search & Ranking

| Variable         | Required | Default | Description                                                                              |
| ---------------- | -------- | ------- | ---------------------------------------------------------------------------------------- |
| `COHERE_API_KEY` | No       | —       | Cohere API key for reranking search results. Improves opportunity and knowledge ranking. |

## DigitalOcean (Production)

| Variable            | Required | Default                                 | Description                                           |
| ------------------- | -------- | --------------------------------------- | ----------------------------------------------------- |
| `DOMAIN`            | Prod     | `localhost`                             | Public hostname served by Caddy on the Droplet        |
| `TLS_EMAIL`         | Prod     | `admin@pilot.dev`                       | ACME registration email for Caddy certificates        |
| `POSTGRES_PASSWORD` | Prod     | `helm`                                  | PostgreSQL password used by the Droplet compose stack |
| `POSTGRES_IMAGE`    | Prod     | `pgvector/pgvector:0.8.0-pg17`          | Pinned pgvector PostgreSQL image                      |
| `CADDY_IMAGE`       | Prod     | `caddy:2.10.2-alpine`                   | Pinned Caddy TLS proxy image                          |
| `OFELIA_IMAGE`      | Prod     | `mcuadros/ofelia:0.3.22`                | Pinned backup scheduler image                         |
| `HELM_IMAGE`        | Prod     | `ghcr.io/mindburn-labs/helm-oss:0.4.0`  | Published HELM sidecar image pulled by the Droplet    |
| `PILOT_IMAGE`       | Prod     | `ghcr.io/mindburn-labs/pilot:<tag>`     | Published Pilot gateway image pulled by the Droplet   |
| `WEB_IMAGE`         | Prod     | `ghcr.io/mindburn-labs/pilot-web:<tag>` | Published Next.js web image pulled by the Droplet     |

Deployment-time `doctl` variables such as `DO_REGION`, `DO_SIZE`, `DO_SSH_KEYS`, and `DO_DROPLET_IP` are consumed by `infra/digitalocean/deploy.sh`; they are not runtime app variables.

## Backup

| Variable                       | Required | Default     | Description                                            |
| ------------------------------ | -------- | ----------- | ------------------------------------------------------ |
| `BACKUP_DIR`                   | No       | `./backups` | Local backup directory for `scripts/backup.sh`         |
| `BACKUP_ENCRYPTION_PASSPHRASE` | Prod     | —           | GPG symmetric passphrase for encrypted remote backups  |
| `BACKUP_CRON_SCHEDULE`         | No       | `0 3 * * *` | Ofelia cron expression for the DigitalOcean backup job |

Production backups are uploaded as encrypted `.sql.gz.gpg` files using the `S3_*` variables above. Plaintext upload is blocked unless `BACKUP_ALLOW_PLAINTEXT_UPLOAD=1` is set for a non-production drill.
