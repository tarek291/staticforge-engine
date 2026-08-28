# Project Memory — outstanding technical debt

**Last updated:** 2026-08-28, after phases 01–20 were merged into `main`.

This file is the short, blunt record of what is *not* built. It exists because
the architecture briefing describes the engine at its best and this does not.
Read both. For the full state, see [STATICFORGE_CONTEXT.md](STATICFORGE_CONTEXT.md).

Where the project stands: phases 01–20 merged and pushed, 830 tests across 42
files passing, running against a live Supabase PostgreSQL instance, with a
standalone queue worker, a data-sync boundary, headless block editing,
database-backed templates and profiles, a plugin runtime, and a read-only AI gap
analyst.

---

## 1. No authentication, no authorization, no RLS — *blocking*

There is **no authentication layer at all**: no next-auth, no Clerk, no Supabase
auth, no sessions. There is no enforcement that a query is scoped to the
caller's workspace, and no Postgres row-level security.

The dashboard and the headless API — `apps/web/app/dashboard`,
`apps/web/app/api/dashboard/**`, `apps/web/app/api/webhooks/sync` — write tenant
data and enqueue paid AI work with no caller identity behind them.

The multi-tenant data model makes scoping enforceable (every row reaches a
Workspace through a Project), but nothing enforces it. **This gates deployment.**
Application-level scoping alone is not sufficient; back it with RLS.

## 2. No `ANTHROPIC_API_KEY` — the AI path is unproven against a real model

`.env` holds only `DATABASE_URL`. Every AI suite runs against injected doubles,
so **no prompt or tool schema has been exercised against a real provider
round-trip** — including Phase 20's gap-analysis contract.

The engine's handling is verified. The model's actual behaviour is not. Do not
describe the AI path as "verified end to end"; say it is verified against
injected doubles. Cheap to close, and it blocks confidence in everything billed.

## 3. `packages/templates` is empty

The package contains only a `.gitkeep`. Both registered views — the clean
default and the dark "luxury landing" — are still route-local in `apps/web`.

Phase 18 made template *configuration* sellable by moving definitions into rows,
but a definition can only configure a view that already exists in code
(deliberately: markup or component code arriving from a database row into a
React tree would be remote code execution). Extracting the views is what would
make the package mean anything.

## 4. No CI, no deployment, billing not started

- No CI pipeline. The `verify` gate — generate + typecheck + test + web build —
  is run by hand. Nothing catches a regression automatically.
- Nothing is deployed. Since Phase 14 the queue worker is a separate
  long-running process, so deployment needs **two** targets: Vercel for
  `apps/web`, plus a host for `staticforge worker`. It is not a build step.
- Billing is not started. The data model already supports the natural metering
  dimensions — projects per workspace, pages per project, and AI-authored pages
  (the only line with a real marginal cost). `GenerationJob` rows already carry
  the counts a meter would read.

Ordering: authentication, then deployment, then billing.

## 5. Per-business eligibility is missing from the database read path

Eligibility is supported by the **file** pipeline but not exposed through the
**database** read path — the adapter returns every service and every location on
a project as eligible, so the eligible cross-product silently becomes the full
one.

This is what prevents publishing a page promising a service in a city the
operator does not cover — a page that converts into a complaint rather than a
lead. A cloud-mode tenant currently cannot express the constraint, and the
dashboard will need a UI for it.

When comparing file mode and database mode, expect page counts to differ for any
business that declares eligibility. That is this gap, not a regression.

---

## Smaller known gaps

- Businesses and content templates cannot be imported from CSV — only services
  and locations.
- `refresh-page` does not pass the realigned `schemaOrg` through
  `saveRefreshedPage`, so that path still carries the drift phases 16–17 fixed
  elsewhere.
