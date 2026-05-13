# Pilot Runbook

On-call response procedures, diagnostic commands, and rollback playbooks for operators running Pilot in production.

---

## 0. Start Here (Every Incident)

1. **Check `/health`** — `curl https://<your-domain>/health`. Anything non-200 is a hard incident.
2. **Check Sentry** — are there recent unhandled errors spiking?
3. **Check Grafana dashboards** — `api.json`, `orchestrator.json`, `infrastructure.json`.
4. **Check DigitalOcean Droplet and Compose status** — `bash infra/digitalocean/deploy.sh status`.
5. Declare severity and communicate on your internal channel.

---

## 1. Common Incidents

### 1A. Auth broken — users cannot log in

Symptoms: users report not receiving email magic link, or verify returns 401 despite correct code.

- Check `/health` → `checks.db` true?
- Check `EMAIL_PROVIDER` config — if it reverted to `noop`, emails are not sent; only local development auth responses expose the code.
  ```bash
  ssh root@$DO_DROPLET_IP 'cd /opt/pilot/current && docker compose -f infra/digitalocean/docker-compose.yml exec pilot env | grep EMAIL'
  ```
- Check Resend/SMTP dashboard for bounces or rate limiting.
- Check the `sessions` table — are rows being written?
  ```sql
  SELECT COUNT(*), MAX(created_at) FROM sessions WHERE channel = 'email_pending';
  ```
- If Resend API is down: temporarily switch to a backup SMTP provider in `.env.production.pilot`, redeploy with `bash infra/digitalocean/deploy.sh deploy`, and verify login.

### 1B. Database down

Symptoms: `/health` returns 503 with `checks.db: false`.

- DigitalOcean Compose Postgres: `docker compose --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml exec postgres psql -U helm -d pilot -c '\l'`.
- Check DB logs: `docker compose --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml logs --tail=200 postgres`.
- Connection pool exhausted? Query `SELECT count(*) FROM pg_stat_activity`. If >80 increase `DB_POOL_MAX` or investigate slow queries.
- If the DB is truly down, restore the latest verified backup on a replacement Droplet, then point DNS at the new Droplet IP.

### 1C. HELM sidecar or LLM provider outage

Symptoms: `/health` returns degraded with `checks.helm: "unreachable"`, or agent tasks fail with HELM unreachability / upstream provider errors.

- Check HELM first: `docker compose --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml logs --tail=200 helm` and `docker compose --env-file .env.production.shared -f infra/digitalocean/docker-compose.yml exec helm wget -qO- http://localhost:8081/healthz`.
- Check provider status pages for the upstream configured on HELM (`HELM_UPSTREAM_URL`). In production, provider keys belong on the HELM sidecar, not on the Pilot app.
- If HELM is healthy but the upstream is down, rotate the sidecar upstream/key in `.env.production.helm` and redeploy.
- Enable kill switch temporarily: set `policy.killSwitch=true` via a workspace-settings update. Tasks will be blocked rather than retry-storming.

### 1D. Rate-limiting users unexpectedly

Symptoms: users report 429 on normal usage.

- Check Postgres token buckets in `ratelimit_buckets` for the reported subject and route class.
- If a single bad IP is hammering, block it with Cloudflare, Caddy, or the DigitalOcean Cloud Firewall before changing app limits.
- Bump limits temporarily via code — update `services/gateway/src/index.ts` rate-limit configs and ship.

### 1E. Disk full / storage exhausted

- Check Droplet and Docker volume usage with `df -h` and `docker system df`.
- Rotate old Pino logs (if writing to disk): `find /app/logs -mtime +7 -delete`.
- Clean old S3 backups via `scripts/backup.sh` retention (default 30 days).
- If `STORAGE_PROVIDER=local`, migrate to S3.

### 1F. Task stuck in 'running' status

Symptoms: a task shows status='running' for hours.

- Expected: the reaper job should move it to 'failed' after 10 minutes (`tasks.reap_stuck` scheduled every 5 min).
- If not happening, check pg-boss health: `SELECT * FROM pgboss.schedule WHERE name = 'tasks.reap_stuck'`.
- Manual reap: `UPDATE tasks SET status='failed' WHERE id='<uuid>' AND status='running'`.

### 1G. YC private sync / Scrapling runtime broken

Symptoms: YC connector validates in UI but private sync jobs fail, or operator fetches return browser/runtime errors.

- Check the configured Python runtime:
  ```bash
  PYTHON_BIN=${PYTHON_BIN:-./.venv-pipelines/bin/python} $PYTHON_BIN scripts/verify-python-runtime.py
  ```
- If browser binaries are missing, re-run:
  ```bash
  bash scripts/install-python-runtime.sh
  ```
- Verify `ENCRYPTION_KEY` did not rotate without a connector/session migration plan.
- Confirm the `yc` connector still shows a validated session in the workspace settings UI.
- If validation fails after a YC auth change, capture and save a fresh session snapshot.

---

## 2. Diagnostic Commands

### Health

```bash
curl https://<host>/health | jq          # full health JSON
curl https://<host>/metrics | head -50   # Prometheus metrics sample
```

### Logs (DigitalOcean Compose)

```bash
ssh root@$DO_DROPLET_IP
cd /opt/pilot/current
docker compose -f infra/digitalocean/docker-compose.yml logs --tail=200 pilot
docker compose -f infra/digitalocean/docker-compose.yml logs pilot | grep ERROR
docker compose -f infra/digitalocean/docker-compose.yml logs pilot | grep requestId=XXX
```

### Database (DigitalOcean Compose Postgres)

```bash
docker compose -f infra/digitalocean/docker-compose.yml exec postgres psql -U helm -d pilot

# Most active tables
SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC LIMIT 10;

# Pool saturation
SELECT count(*), state FROM pg_stat_activity GROUP BY state;

# Long-running queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active' AND now() - pg_stat_activity.query_start > interval '30 seconds';
```

### pg-boss queue

```sql
SELECT name, state, COUNT(*) FROM pgboss.job GROUP BY name, state;
SELECT * FROM pgboss.archive ORDER BY completed_on DESC LIMIT 20;  -- recently completed
```

### Python / Scrapling

```bash
PYTHON_BIN=${PYTHON_BIN:-./.venv-pipelines/bin/python} $PYTHON_BIN scripts/verify-python-runtime.py
ls -la ${PLAYWRIGHT_BROWSERS_PATH:-./.cache/ms-playwright}
ls -la ${PATCHRIGHT_BROWSERS_PATH:-./.cache/ms-patchright}
```

---

## 3. Rollback Procedure

### 3A. Application rollback

1. Find the last known-good release:
   ```bash
   git log --oneline -20
   ```
2. Roll back to the previous release:
   ```bash
   DO_DROPLET_IP=<ip> bash infra/digitalocean/deploy.sh rollback
   ```
3. Watch health:
   ```bash
   while true; do curl -s https://<host>/health | jq -c; sleep 2; done
   ```

### 3B. Database rollback (destructive — last resort)

1. Stop the gateway: `docker compose -f infra/digitalocean/docker-compose.yml stop pilot`.
2. Take a snapshot of current DB state.
3. Restore from last known-good backup:
   ```bash
   bash scripts/backup.sh restore <backup-file.sql.gz.gpg>
   ```
4. Start gateway: `docker compose -f infra/digitalocean/docker-compose.yml up -d pilot`.
5. **Warning:** connector tokens encrypted with a since-rotated ENCRYPTION_KEY will be unreadable. Plan carefully.

### 3C. Migration rollback

Drizzle migrations are forward-only by default. To roll a migration back:

1. Write a reverse migration SQL file manually (e.g., `0005_revert_xyz.sql` that drops the column added in `0004`).
2. Apply it normally via `npm run db:push`.
3. Redeploy the app pinned to the pre-`0004` schema version.

---

## 4. Escalation

- **SEV-1 (data loss, security breach):** Wake the on-call immediately. Preserve state (snapshots, logs) before attempting fixes.
- **SEV-2 (service down for all users):** Respond within 15 min. Start incident channel.
- **SEV-3 (degraded, subset of users):** Respond within 1h. File ticket, fix during business hours.

---

## 5. Post-Incident Review Template

```
# Incident YYYY-MM-DD — <one-line summary>

## Timeline
- HH:MM UTC — Detected (how?)
- HH:MM UTC — First responder on call
- HH:MM UTC — Mitigated (what was done?)
- HH:MM UTC — Fully resolved

## Impact
- Users affected: <count> / <total>
- Features affected: <list>
- Data loss: <yes/no + scope>

## Root Cause
<what actually caused it>

## Contributing Factors
<what made it worse or prevented faster recovery>

## Action Items
- [ ] <fix root cause permanently>
- [ ] <detect earlier next time>
- [ ] <respond faster next time>
- [ ] <prevent this class of issue>

## Lessons Learned
<what we knew vs. didn't know; what we'd do differently>
```
