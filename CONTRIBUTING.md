# Contributing

This project is a single-operator trading control plane, but it's structured
so external contributions are easy to review. If you're sending a PR, please
follow these notes.

## Ground rules

1. **Never commit a secret.** `.env.local`, `coinbase_cloud_api_key.json`, and `data/` are all gitignored. Run the pre-push diff in `SECURITY.md` before pushing.
2. **Treat the safety gates as load-bearing.** `ALLOW_TRADE`, `COINBASE_ALLOW_TRADE`, `RISK_*` caps, the kill switch, and capsule envelopes are why this app is safe to run unattended. PRs that loosen or bypass them need an explicit rationale.
3. **Tests are not optional.** Every PR should keep `npm run test:run` green. New modules in `src/lib/` deserve a `tests/unit/*` companion.

## Local setup

```bash
npm install
cp .env.local.example .env.local       # fill in POLYMARKET_PRIVATE_KEY, etc.
npm run derive:creds                   # one-shot L1 → L2 CLOB cred derivation
npm run db:init && npm run db:seed     # build SQLite + seed agents
npm run test:run                       # ~4s, 974+ tests
npm run dev                            # http://localhost:3000
```

If you need a Coinbase JSON key, drop it at `coinbase_cloud_api_key.json` (root); see `SECURITY.md`.

## Project layout

```
src/
├── app/                 Next.js App Router (pages + /api routes)
├── lib/
│   ├── polymarket/      typed clients + signing + executor (Polymarket-only)
│   ├── coinbase/        typed clients + JWT auth + executor (Coinbase-only)
│   ├── venue/           unified VenueAdapter + ExecutionRouter (NEW)
│   ├── risk/            RiskEngine + KillSwitch + limits (NEW)
│   ├── capsules/        per-agent risk envelope types + store + gate (NEW)
│   ├── stages/          release stage ladder for strategy_versions (NEW)
│   ├── reconcile/       diff local DB ↔ venue truth (NEW)
│   ├── backtest/        replay market_snapshots, score with arena formula (NEW)
│   └── db/              SQLite client + schema + typed queries
└── ...

scripts/                 tsx-runnable CLIs (db init, sweeps, workers)
tests/
├── unit/                pure functions, parametric (it.each) where useful
├── integration/         spin up in-memory SQLite, exercise the queries layer
├── contract/            mocked HTTP — assert URLs/headers/parsed shapes
└── e2e/                 opt-in (RUN_E2E=1) — live network
```

## Adding a new venue

1. Implement `VenueAdapter` (see `src/lib/venue/types.ts`) in `src/lib/venue/adapters/<venue>.ts`.
2. Register it in `getDefaultRouter()` (`src/lib/venue/router.ts`).
3. Add per-venue safety envs (`<VENUE>_ALLOW_TRADE`, etc.) inside the adapter's `submit()`.
4. Add the adapter's name to `RouterCapsule.allowed_venues` defaults if appropriate.
5. Write tests: a `client-urls.test.ts` (asserts you hit the right URLs) and an `execute-safety.test.ts` (asserts caps actually bind).

## Adding a new strategy

1. Add a row to `agents` (or reuse one) via a seed script.
2. Insert the first `strategy_versions` row with `is_current=1` and `stage='sim'`.
3. If the spec is parameterizable, add an evaluator branch in `scripts/research-loop.ts:evaluators`.
4. Once you have meaningful `market_snapshots`, run `npm run backtest -- --version <id> --token <token_id>`.
5. When you're ready to advance, `POST /api/strategies/:id/stage` (or use the future stage UI button).

## Style

- TypeScript strict mode is on (`tsconfig.json`). No `any` without a comment explaining why.
- Imports use the `@/*` alias for `src/*`.
- Indentation is two spaces.
- Don't add comments that just describe what code does; reserve them for *why* (constraints, edge cases, surprising decisions).

## Submitting a PR

- Title in imperative ("add capsule cooldown gate"), under 70 chars.
- Body covers: what changed, why, and the test plan. Reference any TradingBot/repo patterns you ported.
- Run `npm run test:run` and `npm run lint` locally before pushing.

Thanks!
