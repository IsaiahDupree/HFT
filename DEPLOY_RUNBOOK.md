# Deploy runbook

Two supported deploy modes:

| Mode | When to use | DB |
|------|-------------|-----|
| **A. Docker on a single VM** (recommended for solo operator) | You want one host, no platform lock-in, SQLite preserved | Local SQLite file on a Docker volume |
| **B. Vercel + managed Postgres** (multi-instance, no host to babysit) | You want Vercel deploys / preview URLs / cron / Edge | Neon Postgres via Vercel Marketplace |

The codebase ships ready for mode A out of the box. Mode B needs a one-time
DB migration (see §3).

---

## A. Docker on a single VM

### A.1 Build & run locally

```bash
docker compose up -d --build
docker compose logs -f app                  # tail the Next.js server
docker compose logs -f reconcile            # tail the reconciler sidecar
docker compose logs -f research             # tail the research-loop sidecar
docker compose down                         # stop everything
```

Services:
- **app** — Next.js production server on :3000. Mounts `polymarket-data` volume at `/app/data` so SQLite survives `docker compose down`.
- **reconcile** — sidecar that runs `npm run worker:reconcile` every 60s.
- **research** — sidecar that runs `npm run worker:research` every 5 min.

All three containers share the same SQLite volume. WAL mode is on
(`pragma journal_mode = WAL` in `src/lib/db/client.ts`) so concurrent
readers + the writer can coexist on the same file.

### A.2 First-run setup inside the container

```bash
docker compose exec app npm run db:init     # idempotent — safe to re-run
docker compose exec app npm run db:seed     # seed the 4 starter agents
docker compose exec app npm run seed:coinbase  # optional — Aurora Cross + pairings
```

### A.3 Deploying to a VM (e.g. DigitalOcean, Hetzner, EC2)

1. **Provision a host** — 2 vCPU / 2 GB RAM is enough for the current workload.
2. **Install Docker** (`apt install docker.io docker-compose-plugin` on Debian/Ubuntu).
3. **Copy the repo** (`git clone` or `rsync`).
4. **Create `.env.local`** at the project root.
5. **Drop `coinbase_cloud_api_key.json`** at the project root (matches the in-container path the app reads).
6. **`docker compose up -d --build`**.
7. **Run the first-run setup** (§A.2).
8. **Reverse-proxy** the container's :3000 behind nginx/caddy with TLS. The app has no built-in auth — front it with HTTP basic auth or your IdP, or restrict to a VPN.

### A.4 Backups

```bash
# nightly cron on the host
docker run --rm -v polymarketautomation_polymarket-data:/data \
  -v $(pwd)/backups:/backup \
  alpine sh -c "sqlite3 /data/polymarket.db '.backup /backup/polymarket-$(date +%F).db'"
```

`sqlite3 .backup` is online — safe to run while the app is writing.

### A.5 Rotating secrets

- Coinbase CDP key: rotate inside Coinbase, swap `coinbase_cloud_api_key.json`, restart with `docker compose restart`.
- Polymarket CLOB L2 creds: `docker compose exec app npm run derive:creds` with a new `nonce` and replace the values in `.env.local`. Restart.
- `ALLOW_TRADE` / `COINBASE_ALLOW_TRADE`: toggling these only takes effect on the next container restart (env vars are read into memory).

---

## B. Vercel + Neon Postgres

The current code paths use `better-sqlite3` against a local file. Vercel
Functions are stateless and have no persistent local disk — running there
**requires migrating off SQLite**.

### B.1 Provision Neon

Install the Neon Postgres marketplace integration:

```bash
# In your Vercel project
vercel integration install neon
```

This provisions `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, etc. and writes them
to the project's env vars across all environments.

### B.2 Migrate the SQL

1. The schema in `src/lib/db/schema.sql` is SQLite-flavored. Most of it ports
   cleanly to Postgres, but a few changes are needed:
   - `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY` (or `IDENTITY`).
   - `datetime('now')` → `now()`.
   - `INTEGER NOT NULL DEFAULT 0` for boolean flags → `BOOLEAN NOT NULL DEFAULT FALSE`.
   - `json_extract(payload, '$.foo')` (used in `dailyExecutedUsd()`) → `(payload->>'foo')::numeric`.
2. Replace `src/lib/db/client.ts` to use a Postgres client (recommend `@neondatabase/serverless`).
3. Replace `db().prepare(...).all/get/run` call sites — they have a slightly different async shape.

This is enough work that it's worth a dedicated PR + branch.

### B.3 Long-running workers

The reconciler and research-loop don't fit Vercel Functions naturally.
Options, in increasing order of effort:

- **`vercel.json` crons** (already wired for `/api/venue/health` every 15 min). Wrap each worker in an `/api/cron/*` route that runs one pass.
- **Vercel Queues + Workflow DevKit** for durable multi-step loops with retries.
- **External cron-as-a-service** (GitHub Actions cron, Render, Railway) hitting the same `/api/cron/*` endpoints.

### B.4 Deploy

```bash
vercel link
vercel env pull .env.local
vercel deploy --prod
```

---

## Smoke tests after deploy

Hit these in order — each should return 200 and reasonable JSON:

```bash
HOST=https://your-deploy.example.com
curl -s "$HOST/api/venue/health" | jq            # adapter health + chain status
curl -s "$HOST/api/risk/halt" | jq               # current kill-switch state
curl -s "$HOST/api/capsules" | jq                # capsule list
curl -s "$HOST/api/polymarket/sweep" | jq        # last sweep result
curl -s "$HOST/api/coinbase/sweep" | jq          # last Coinbase sweep
```

If any of these 5xx, check container logs and the env var the failure points to.

## Rollback

- **Docker**: `git checkout <last-good-commit> && docker compose up -d --build`.
- **Vercel**: `vercel rollback` (uses the previous successful production deployment).

---

## Operational guardrails

- **Engage the kill switch before any risky change.** `curl -X POST "$HOST/api/risk/halt" -d '{"reason":"<who/what>","mode":"liquidate"}'`. This sets `RiskEngine.halted=true` AND cancels every open order on every registered adapter. Resume with `curl -X DELETE "$HOST/api/risk/halt"`.
- **Verify the order-event chain weekly.** `curl -s "$HOST/api/venue/health" | jq .order_event_chain.ok` should always be `true`. A `false` means the audit chain was tampered with (or someone deleted rows from `order_events`).
- **Audit `evolution_log` after every deploy.** Look for `cb-error`, `arb-error`, `cb-rejected`, `arb-rejected`, `kill-switch-halt` events in the last 24h.
