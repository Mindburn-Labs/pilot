# Graceful Degradation Matrix

Pilot is designed so that missing optional services cause specific, bounded feature loss rather than cascading failure. This document lists every optional env var and what happens when it is absent.

| Env Var                                                                           | Unset behavior                                                                                                                                            | Features affected                                                                                 |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `HELM_GOVERNANCE_URL` / `HELM_FAIL_CLOSED`                                        | Production requires HELM. If HELM is unreachable with fail-closed enabled, `/health` degrades and governed LLM calls are denied.                          | Agent runs and founder-intel paths that need governed inference.                                  |
| `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_BASE_URL` | Direct-provider fallback only when HELM is not configured. If none, agent loop returns `completed` immediately with `No LLM configured`.                  | Local/dev agent runs, founder-intel extraction, knowledge truth compilation, opportunity scoring. |
| `OPENAI_API_KEY` / `VOYAGE_API_KEY`                                               | Embedding provider falls back to deterministic hash pseudo-embedding (not semantically meaningful).                                                       | Vector search returns low-quality results. Keyword search still works.                            |
| `TELEGRAM_BOT_TOKEN`                                                              | Telegram bot is not started.                                                                                                                              | `/api/telegram/webhook` not mounted. Mini-app still served. Approval notifications disabled.      |
| `TELEGRAM_WEBHOOK_SECRET`                                                         | Webhook secret validation skipped (dev) / rejected (prod — set it).                                                                                       | Bot webhook security.                                                                             |
| `TELEGRAM_MANAGER_BOT_USERNAME`                                                   | Manager username is resolved from Telegram `getMe` when `TELEGRAM_BOT_TOKEN` is set.                                                                      | Web-created launch/support bot setup links fail if neither value is available.                    |
| `APP_URL`                                                                         | Child managed-bot webhook setup fails.                                                                                                                    | Founder-owned launch/support bots cannot receive customer updates.                                |
| `REDIS_URL`                                                                       | Optional legacy limiter backend. Main API rate limits use Postgres `ratelimit_buckets`.                                                                   | Legacy in-memory limiter paths only.                                                              |
| `SENTRY_DSN`                                                                      | Error reporting disabled, errors only hit local logs.                                                                                                     | No remote error alerting.                                                                         |
| `EMAIL_PROVIDER` (`noop`)                                                         | Magic-link emails are not sent; dev-only auth responses return codes while provider logs keep only redacted delivery metadata. **Unsafe for production.** | Users cannot log in unless they are using the local development auth response.                    |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`                                       | GitHub connector is registered but OAuth initiation throws. Manual-token mode still works if tokens are supplied directly.                                | OAuth self-serve for GitHub.                                                                      |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                                       | Same as above for Gmail + Drive.                                                                                                                          | OAuth self-serve for Google.                                                                      |
| `STORAGE_PROVIDER`                                                                | Defaults to `local` — files written to `STORAGE_PATH` (default `./data/storage`).                                                                         | S3-backed storage disabled.                                                                       |
| `COHERE_API_KEY`                                                                  | Search reranking disabled.                                                                                                                                | Slightly less relevant opportunity and knowledge ranking.                                         |
| `ENCRYPTION_KEY`                                                                  | **Required in production** (process exits 1). Dev fallback is insecure.                                                                                   | Connector token encryption at rest.                                                               |
| `SESSION_SECRET`                                                                  | Defaults to dev value. **Unsafe for production.**                                                                                                         | Session token + OAuth state HMAC.                                                                 |
| `ENABLED_CONNECTORS`                                                              | All connectors register with warnings if credentials missing.                                                                                             | Strict startup validation disabled.                                                               |
| `RUN_MIGRATIONS_ON_STARTUP`                                                       | Defaults to `true`. DigitalOcean production sets `false` and runs migrations explicitly during deploy.                                                    | Schema drift risk if set false and migrations forgotten.                                          |
| `DAILY_BUDGET_MAX` / `PER_TASK_BUDGET_MAX`                                        | Defaults to 500 / 100 (EUR).                                                                                                                              | Cost enforcement tightness.                                                                       |
| `DB_POOL_MAX` / `DB_IDLE_TIMEOUT` / etc.                                          | Sensible defaults applied.                                                                                                                                | Pool tuning only matters under high concurrency.                                                  |

## Startup refusal conditions (fatal)

The process exits non-zero if any of these fail:

1. `DATABASE_URL` is missing.
2. `SESSION_SECRET`, `ENCRYPTION_KEY`, or configured `EVIDENCE_SIGNING_KEY` is missing or still a default development value when `NODE_ENV=production`.
3. `TELEGRAM_BOT_TOKEN` is set in production without `TELEGRAM_WEBHOOK_SECRET`.
4. `drizzle-kit migrate` fails during startup (when `RUN_MIGRATIONS_ON_STARTUP=true`).
5. Any connector listed in `ENABLED_CONNECTORS` has missing credentials (prod only).
6. `EMAIL_PROVIDER=resend` without `RESEND_API_KEY`, or `EMAIL_PROVIDER=smtp` without `SMTP_HOST`.

## Degraded but running

The process starts successfully and runs, but specific features are degraded:

- **HELM down in production:** `/health` reports degraded and governed inference fails closed. Restore the sidecar before resuming autonomous work.
- **No direct LLM keys in dev:** All direct-provider agent operations return immediately. Surface a clear "AI provider required" error in the UI.
- **No Telegram:** Telegram surface disappears. Web UI + REST API still fully operational.
- **No Redis:** Main API rate limits still use Postgres token buckets. Legacy in-memory limiter paths remain per-process.
- **No Sentry:** You'll only see errors in logs. Set up `SENTRY_DSN` before you hit real traffic.
- **No email provider:** Dev mode only. Magic link codes appear in logs and HTTP responses.

## Verifying degradation

Start the gateway with no optional env vars set and hit `/health`:

```bash
curl http://localhost:3100/health
```

Response includes a `checks` object listing what's connected. Use that to confirm which optional services are active.
