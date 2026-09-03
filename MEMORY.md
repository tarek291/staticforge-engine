# Project Memory — outstanding technical debt

**Last updated:** 2026-08-31, after phases 01–30 were merged into `main`.

This file is the short, blunt record of what is *not* built. It exists because
the architecture briefing describes the engine at its best and this does not.
Read both. For the full state, see [STATICFORGE_CONTEXT.md](STATICFORGE_CONTEXT.md).

Where the project stands: phases 01–30 merged and pushed, 1214 tests across 64
files passing, running against a live Supabase PostgreSQL instance, with a
standalone queue worker, a data-sync boundary, headless block editing,
database-backed templates and profiles, a plugin runtime, a read-only AI gap
analyst, incremental publishing, a distributed rate limiter, RBAC organizations
with an audit trail, hashed API keys, metered quotas, and every `apps/web` API
route behind an authentication guard that accepts a bearer credential or a
browser cookie.

---

## 1. No sign-in *page*, and no Supabase project configured

**Browser sessions are built as of Phase 30.** `@supabase/ssr` keeps the tokens
in `HttpOnly` cookies, `POST /api/auth/login` exchanges an email and password
for them, middleware refreshes the session on every request and redirects
`/dashboard/*` to `/login`, and `requireApiAuth` accepts a bearer credential or
a cookie — header first, so an integration running inside a logged-in browser
still acts as the key it presented.

Two things remain before a person can actually sign in:

- **There is no `/login` page.** The middleware redirects to it and it does not
  exist, so the redirect lands on a 404. The API route behind it works; the form
  does not exist.
- **`SUPABASE_URL` and `SUPABASE_ANON_KEY` are not configured.** `.env` holds
  only `DATABASE_URL`, so every session path — login, cookie verification,
  middleware — has been exercised against injected doubles and against the
  *failure* path only. See `apps/web/.env.example`.

Also missing: **`/api/auth/login` has no rate limiting.** Phase 24's token
bucket is keyed on an organization, which this endpoint does not know because
knowing it is what signing in establishes; keying on the email would let anyone
lock a named user out. Supabase's own limits on the endpoint behind it are the
whole protection today.

The CLI still acts as `local-operator`. That is intended — it runs on an
operator's own machine — and it is why the constant still exists at all.

## 1b. No Postgres row-level security

Kept separate from the item above because it did not close with it. Every
isolation guarantee is an application-level `where` clause, so a query written
without one has no boundary. The gates and the membership scoping are correct
today; RLS is what would make them impossible to get wrong tomorrow.

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

## 4. No CI, no deployment, no invoicing

- No CI pipeline. The `verify` gate — generate + typecheck + test + web build —
  is run by hand. Nothing catches a regression automatically.
- Nothing is deployed. Since Phase 14 the queue worker is a separate
  long-running process, so deployment needs **two** targets: Vercel for
  `apps/web`, plus a host for `staticforge worker`. It is not a build step.
- Metering and quotas exist (Phase 26): `UsageRecord`, `OrganizationQuota`, a
  `requireQuota` gate before `enqueueJob` and `syncProject`, and a billing meter
  plugin. **Invoicing does not.** Nothing prices a `UsageRecord` or charges
  anyone, and nothing advances a quota's `resetDate` when a period rolls — so a
  monthly plan is a lifetime allowance until an operator moves the date by hand.

Ordering: a browser session, then deployment, then invoicing.

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
