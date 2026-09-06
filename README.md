# StaticForge Engine

A schema-driven static site generation engine, organized as a pnpm monorepo.

> **Status:** 🟢 Phases 01–27 delivered. End-to-end pipeline working against a
> live Supabase PostgreSQL instance, with a standalone queue worker, a data-sync
> boundary, headless block editing, database-backed templates, a plugin runtime,
> a read-only AI gap analyst, incremental publishing that re-authors only the
> pages a change reached, an RBAC organization layer with a database audit
> trail, a distributed token bucket that keeps several workers inside one
> tenant's provider allowance, hashed per-organization API keys, and metered
> usage behind hard quotas, and a `User` table with a Supabase session guard.
> **Not yet deployed, and nothing yet calls that guard** — Phase 23 added
> authorization, Phase 25 machine credentials, Phase 27 the pieces of human
> identity, but `userId` is still asserted by callers rather than proved — see
> [STATICFORGE_CONTEXT.md](STATICFORGE_CONTEXT.md)
> for the full state and the outstanding technical debt.

---

## The map

Twenty-seven phases, grouped into three eras by what each one was solving. The
grouping is retrospective — the phases were not planned this way, and the
boundaries fall where the problem changed.

```txt
                          S T A T I C F O R G E
        programmatic SEO engine for multi-location service businesses

  ┌───────────────────────────────────────────────────────────────────────┐
  │  ERA I · CORE ENGINE                                     phases 01-13 │
  │  "produce a page that is worth publishing"                            │
  ├───────────────────────────────────────────────────────────────────────┤
  │                                                                       │
  │   01 content contract ──▶ 02 AI authoring ──▶ 03 fact grounding       │
  │            │                                        │                 │
  │            │                                        ▼                 │
  │            │                              04 versioning + cache       │
  │            ▼                                                          │
  │   05 internal link graph ──▶ 06 SEO publishing ──▶ 07 scale (500 pp)  │
  │                                                          │            │
  │   08 deploy pipeline ◀── 09 templates ÷ profiles ◀───────┘            │
  │            │                                                          │
  │            ▼                                                          │
  │   10 dashboard ──▶ 11 SaaS foundation ──▶ 12 autonomous refresh       │
  │                    (tenancy, async jobs)              │               │
  │                                                       ▼               │
  │                                    13 hardening · SF-01…SF-25 audit   │
  └───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │  ERA II · DISTRIBUTED INFRASTRUCTURE                     phases 14-22 │
  │  "survive a second worker, and stop paying for what did not change"   │
  ├───────────────────────────────────────────────────────────────────────┤
  │                                                                       │
  │   14 queue worker ────────────┐        the engine leaves the web tier │
  │      lease · claim · resume   │                                       │
  │                               ▼                                       │
  │   15 sync layer ──▶ change detection ──▶ 16/17 headless block editing │
  │      pull · webhooks              │                                   │
  │                                   ▼                                   │
  │   18 templates + profiles as rows ──▶ 19 plugin bus (observe-only)    │
  │                                              │                        │
  │                                              ▼                        │
  │   20 AI gap analyst ──▶ 21 impact analysis ──▶ 22 build triggers      │
  │      (read-only)          only affected pages      on queue drain     │
  └───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │  ERA III · ENTERPRISE CONTROL PLANE                      phases 23-27 │
  │  "decide who may do what, and what it costs"                          │
  ├───────────────────────────────────────────────────────────────────────┤
  │                                                                       │
  │   23 organizations · RBAC · audit trail                               │
  │        OWNER > EDITOR > VIEWER          ──┐                           │
  │                                           │                           │
  │   24 distributed token bucket             │  every write passes       │
  │        atomic, one SQL statement          ├─▶ requireCapability       │
  │                                           │   then requireQuota       │
  │   25 API keys (SHA-256, per org) ─────────┤                           │
  │        a key IS a member ──────────────────┘                          │
  │                                                                       │
  │   26 metering + quotas          27 human identity                     │
  │        checked before                User table · FK · session guard  │
  │        metered after                                                  │
  └───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │  ERA IV · THE CLOSED SYSTEM                              phases 28-31 │
  │  "prove who is calling, then survive somebody trying to break it"     │
  ├───────────────────────────────────────────────────────────────────────┤
  │                                                                       │
  │   28 one route authenticated ──▶ 29 every route, by one helper        │
  │      sf_org_ prefix ÷ JWT          LOCAL_OPERATOR_ID gone from web    │
  │                                              │                        │
  │                                              ▼                        │
  │   30 browser sessions ──────────▶ the same door, two credentials      │
  │      HttpOnly cookies · SSR        header wins over cookie, always    │
  │                                                                       │
  │   ─────────────────────── red team audit ───────────────────────      │
  │                                                                       │
  │   31 the checks moved INSIDE the data layer                           │
  │        ▸ RBAC in the functions, not only in front of them             │
  │        ▸ quotas HOLD what they admit   40/40 ▶ 10/40 under load       │
  │        ▸ billing outlives its tenant   no cascade from Organization   │
  │        ▸ the worker survives a promise nobody awaited                 │
  │        ▸ login is metered, on a key no header can forge               │
  └───────────────────────────────────────────────────────────────────────┘

  NOT BUILT — the honest half of this map
  ────────────────────────────────────────────────────────────────────────
  ✗ the /login page                    middleware redirects to a 404
  ✗ Supabase credentials               nobody has ever actually signed in
  ✗ row-level security                 isolation is application-level only
  ✗ deployment / CI                    verify is run by hand; worker unhosted
  ✗ invoicing                          usage is metered, never priced
  ✗ live AI verification               no ANTHROPIC_API_KEY; doubles only
  ✗ packages/templates                 still a .gitkeep
```

> The phases below the map are the record of what was actually built and
> merged. The eras are a reading of that record, added in Phase 28 — not a plan
> anything was built against.

---

## Overview

StaticForge Engine takes structured input data, validates it against shared schemas,
and generates static sites from templates. The pipeline is split into focused
packages so each concern (validation, core logic, generation, templating, AI) can
evolve independently.

---

## Workspace layout

```txt
staticforge-engine/
├─ apps/
│  └─ web/              # Next.js front-end / preview app
├─ packages/
│  ├─ schemas/          # Shared data schemas & validation
│  ├─ core/             # Core engine logic, sync adapters, plugin runtime
│  ├─ generator/        # Static site generation pipeline
│  ├─ database/         # Prisma data access, multi-tenant repository, job queue
│  ├─ cli/              # The `staticforge` binary: build | worker | sync | analyze
│  ├─ templates/        # Site templates (placeholder — still empty)
│  └─ ai/               # AI-assisted generation helpers
├─ data/
│  ├─ input/            # Source input data
│  └─ output/           # Generated site output (git-ignored)
├─ package.json         # Root workspace manifest
├─ pnpm-workspace.yaml  # pnpm workspace globs
└─ tsconfig.json        # Base TypeScript config (strict) to extend
```

---

## Tooling

- **Package manager:** pnpm (workspaces)
- **Language:** TypeScript (strict mode)
- **Node:** >= 20

---

## Getting started

```bash
# from the staticforge-engine/ directory
pnpm install
```

> pnpm is provided via Corepack on this machine. If the global `pnpm` shim is
> unavailable, prefix commands with `corepack`, e.g. `corepack pnpm install`.

---

## Conventions

- Each package extends the root [`tsconfig.json`](tsconfig.json) and enables strict mode.
- Generated output lives in `data/output/` and is never committed.

---

## MVP checkpoint

### Current status

- ✅ Generator pipeline works (load → validate → build → save).
- ✅ Output files are written to `data/output/`.
- ✅ The Next.js app reads `manifest.json` at build time.
- ✅ 9 generated static routes build into production-ready static HTML.

### Commands

```bash
corepack pnpm install     # install workspace dependencies
corepack pnpm import:csv  # CSV sheet → data/input/{services,locations}.json
corepack pnpm generate    # run the generator pipeline → data/output/
corepack pnpm dev:web     # start the Next.js dev server
corepack pnpm build:web   # build the static site
corepack pnpm typecheck   # typecheck every workspace package
corepack pnpm test        # run every package's test suite (1114 tests)
corepack pnpm verify      # generate + typecheck (all) + test (all) + web build
```

Database-backed commands, via the `staticforge` binary:

```bash
corepack pnpm staticforge build --project-id <id>    # generate one tenant's project
corepack pnpm staticforge worker                     # claim and run queued jobs
corepack pnpm staticforge sync --project-id <id> --url <csv> --dry-run
corepack pnpm staticforge analyze --project-id <id>  # AI gap analysis (read-only)
corepack pnpm staticforge api-keys create --org-id <id> --name "CI pipeline"
corepack pnpm staticforge help
```

### Generated output structure

```txt
data/output/
├─ manifest.json          # summary index of all generated pages
└─ pages/
   └─ {slug}.json         # one validated page per file
```

### Example verified static routes

- `/` — home (reads the manifest, lists sample slugs)
- `/bueroreinigung-duisburg`
- `/grundreinigung-essen`

---

## Delivered phases

Phases 01–13 established the content contract and the AI engine; phases 14–20
turned it into a service; phases 21–22 made publishing incremental; phase 23
added the enterprise layer; phase 24 made rate limiting survive a second
worker; phase 25 gave organizations a credential they can prove they hold.
Phase 26 put a ceiling in front of the paid paths. Every phase below is merged
into `main`.

### 01–13 — engine and hardening (summary)

| Phase | Delivered |
| --- | --- |
| 01 | Strict content contract and validation schemas |
| 02 | AI content engine under strict Zod enforcement |
| 03 | Fact grounding and hallucination rejection guards |
| 04 | Content versioning and the caching layer |
| 05 | Internal linking graph and contextual linking rules |
| 06 | SEO publishing layer — sitemaps, metadata, rendered links |
| 07 | Scale test: 500 pages, benchmark metrics, language-neutral cleanup |
| 08 | Unified deploy pipeline (generate → validate → build) |
| 09 | Visual templates decoupled from content profiles |
| 10 | Minimal dashboard for engine orchestration |
| 11 | SaaS foundation: `siteUrl`, tenant isolation, async generation jobs |
| 12 | Autonomous refresh loop with feedback prompts and targeted rewrites |
| 13 | Atomic writes, dynamic timeouts, DB retries, and the SF-01…SF-25 security audit sweep |

### 14 — Standalone queue worker, progress tracking, job resumability

The engine moved out of the web server. The `GenerationJob` table *is* the
queue — no broker, because Postgres already holds the row the dashboard polls.

- `claimNextJob` takes a job with a **conditional update** whose `where` repeats
  the condition that made it claimable, so the claim is decided by the database
  rather than by the gap between reading and writing. Safe without
  `FOR UPDATE SKIP LOCKED`.
- A `RUNNING` job whose lease lapsed is **reclaimed, not failed** — failing it
  would discard content the tenant already paid for.
- **Resumability:** a stored AI page is reused only when its `sourceHash`
  matches what this run computes. A 500-page run killed at 400 costs 100 pages.
- `progress` is derived from the counts, so a bar reading 80% beside "12/500" is
  unrepresentable.
- The jobs route now writes one row and answers `202`; process spawning and
  supervision left the Next.js process entirely.

Run it with `corepack pnpm staticforge worker`.

### 15 — Data sync layer, webhooks, and change detection

One boundary for external data, drawn once instead of once per source.

- A `DataSyncAdapter` does **shape only** — no I/O, no database, no policy. Both
  shipped adapters reduce to the entity schemas.
- **Pull:** `staticforge sync --project-id <id> --url <csv>`, with `--dry-run`.
  The URL is guarded: http(s) only, no loopback or private ranges, size cap,
  timeout.
- **Push:** `POST /api/webhooks/sync`. The token is hashed and compared with
  `timingSafeEqual`; an unset or placeholder `STATICFORGE_WEBHOOK_SECRET`
  refuses every call.
- **Change detection:** incoming data is fingerprinted over the fields that
  reach a page — not `updatedAt`, not row order. No difference, no write, no
  job. Without it, a nightly cron re-uploading the same sheet re-buys hundreds
  of pages of identical prose.
- **An absent collection is not an empty one.** A sheet with no recognisable
  rows is refused, because an unpublished Google Sheet returns an HTML sign-in
  page that parses as a header with zero rows.

### 16–17 — Headless block patching with strict re-validation

`PATCH /api/dashboard/projects/[id]/pages/[slug]/block`, built on the premise
that a partial edit is *more* dangerous than a whole rewrite.

- `parseBlockPath` / `getAtPath` / `setAtPath` refuse prototype-chain segments
  at any depth, never auto-vivify (so `content.hero.titel` fails instead of
  growing a field), treat an out-of-range index as a mistake rather than an
  append, and never mutate their input.
- The merged result passes the **same three gates a model's answer faces** —
  structural contract, quality profile, verified record. Any failure discards
  the patch whole; the published page is untouched.
- Only the authored slice is editable. Slugs, entity ids and the link graph are
  not. `schemaOrg` is realigned when the copy it describes changes.
- A successful patch stamps `source: MANUAL`, protecting the edit from the next
  generation run.

### 18 — Dynamic templates and content profiles

Profiles and templates became rows instead of compile-time constants.

- `ContentProfile` and `Template` carry `key`, `name`, JSON `definition`,
  `isGlobal`, and an owner. `key` is separate from `id` so two tenants can each
  have a "premium" profile.
- The owner column is **not nullable** — a `__global__` sentinel, because
  `UNIQUE(key, userId)` over a nullable owner would accept two rows both
  claiming to be the global default.
- Definitions are parsed out of the database against the engine's own schemas. A
  malformed row is an error naming that row and field — never skipped.
- **A definition configures a view that already exists in code; it cannot
  introduce one.** A template carrying markup or component code from a row into
  a React tree would be remote code execution with a marketplace's branding on
  it. `.strict()` throughout.

### 19 — Event-driven plugin architecture

Extensible without becoming editable.

- **Listeners observe; they do not transform.** Payloads are flat, frozen,
  already-serialisable summaries. A plugin able to alter content after the three
  gates could publish anything.
- **A failing plugin cannot fail a run:** throws and rejections are caught per
  listener, `emit` never rejects, and the thrown value reaches the failure
  report rather than being discarded.
- **A hang is a failure too** — listeners run under a deadline and are abandoned
  past it.
- A plugin whose `setup` throws is skipped and reported; the rest install.
  Listeners are auto-tagged with their plugin's name, so none can register
  anonymously and later be unattributable.

### 20 — Proactive AI gap analyst

The engine's first proactive model call: not "write this page" but "what should
the operator do next".

- The engine computes which service-in-city pairs are missing (a set difference,
  exact and free); the model advises which of them matter and why.
  `--gaps-only` answers the question without buying an opinion about it.
- **Two gates:** a strict schema with a floor on every rationale, then a
  grounding check that matches each recommendation back against the catalogue
  the model was shown. Unmatched, duplicate or already-covered rows are dropped
  **and reported** — the discard count is the signal.
- **Read-only by construction:** the agent module imports no database client, no
  queue, no file handle. It cannot enqueue what it recommends.
- Not cached, deliberately — a cached analysis is stale advice with a fresh
  timestamp.

Run it with `corepack pnpm staticforge analyze --project-id <id>`.

### 21–22 — Smart continuous publishing, impact analysis, and build triggers

A sync used to queue a run over the whole project. Editing one service in a
forty-city account re-authored two hundred pages, and paid for every one, to
change five.

**Impact analysis.** `findAffectedPages(projectId, userId, serviceIds, locationIds, prisma)`
asks which pages a change *reaches* — a different question from the gap
analyst's, which computes a cross-product in memory. This one asks which pages
*exist*, because a page that was never generated cannot be re-authored and a
page an operator has since edited must not be.

- Hand-edited pages are refused through an **allowlist** (`source IN (TEMPLATE, AI)`),
  not a `NOT MANUAL`. A `PageSource` added to the schema later would be
  *included* by a negative filter the moment it existed, and the first anyone
  would know is a customer's page being overwritten.
- The filter lives in the query, never in a `.filter()` afterwards.
- Two empty id lists return without querying at all — an `OR` over two empty
  `IN` filters is exactly the shape a later refactor drops entirely, at which
  point every page in the project is "affected".
- Scoped to `userId` as well as `projectId`: with no row-level security behind
  it, the scope in this query *is* the tenant boundary.

**Smart queuing.** `planSyncRun` produces one of three outcomes:

| Change | Decision | Why |
| --- | --- | --- |
| Only **updates** | One job scoped to the reached pages | The feature |
| **Added** or **removed** entities | Full run (empty scope) | A scope cannot create a page, and a removal breaks the link graph |
| Nothing regenerable was reached | **Queue nothing at all** | Every reached page is hand-edited, or the project was never generated |

Getting the second row backwards is not a performance bug: a scoped run after a
service was added would queue a job for pages that do not exist, do nothing,
report success, and leave the new service unpublished with no error anywhere.

**What a scope narrows.** The AI authoring pass, and nothing else. The run still
builds, links, and persists the whole project — the link graph is computed across
every page, the sitemap describes all of them, and the file output is cleared and
rewritten whole. Authoring is the only step with a marginal cost, so it is the
only step worth narrowing.

A page outside the scope keeps its stored content **without** the `sourceHash`
freshness check that governs resumption. That inversion is what makes a scope
safe to pass: applying the freshness test to a page the run was told not to touch
would overwrite a paid, authored page with template assembly. An empty scope
authors nothing; a scope that fails to arrive costs a full run, which is
expensive and correct rather than cheap and silently wrong.

The scope rides on `GenerationJob.targetSlugs` and reaches the engine through
`STATICFORGE_ONLY_SLUGS` — the environment rather than `argv`, because on Windows
a spawn goes through a shell and a list of hundreds of slugs is the worst case
for that.

**Static build triggers.** A new `afterQueueDrained` lifecycle event fires on the
*transition* to idle, never on an already-idle tick — a worker polling an empty
queue every three seconds would otherwise announce a drain twenty times a minute
and a deploy trigger would act on it just as often. One sync that queues ten jobs
is one build, not ten.

`createStaticBuildTriggerPlugin` posts to `DEPLOY_WEBHOOK_URL` when the queue
drains. It is host-agnostic — Vercel, Netlify, Cloudflare Pages and GitHub all
expose the same primitive.

- A drain following only failures publishes nothing: the content on disk is what
  the host already serves, and deploying would make a failing queue look like a
  working one.
- A cooperative shutdown after work is announced too, with a distinct `reason`,
  because silence would leave pages generated, never announced, and therefore
  never published.
- The hook URL is a **capability** — anyone holding one can trigger a production
  deploy — so only its origin is ever logged.
- It is checked at construction, so a typo is a line at boot rather than a silent
  non-deploy discovered by a customer. A broken hook is skipped and reported: a
  worker refusing to boot over a deploy URL turns a stale site into an idle queue.

Configure it by presence:

```bash
DEPLOY_WEBHOOK_URL=https://api.vercel.com/v1/integrations/deploy/prj_x/xxxx
```


### 23 — Enterprise layer: organizations, RBAC, and the audit trail

Every query used to scope on a `userId` column that defaulted to the string
`"local-operator"`. That was honest while there was one operator; it is not a
tenancy model, and nothing decided whether a caller was *allowed* to do what it
had just done.

**Organizations.** `Organization` is the tenant root that carries people and
roles; `OrganizationMember` is one person's role in one organization, unique per
pair. `Workspace` keeps grouping projects but is no longer the authorisation
root — the two are deliberately not merged, because renaming a populated model
is a destructive migration that deserves its own change.

`Project.organizationId` is denormalised so a scope never needs a join, but
**it cannot drift**: the foreign key is composite, pointing at
`Workspace(id, organizationId)`, so Postgres itself refuses a project whose
organization disagrees with its workspace's.

**Roles are a rank, not a matrix.** `OWNER > EDITOR > VIEWER`. A matrix invites
per-action exceptions and the first exception is the one nobody reviews.

| Capability | Minimum role | Why |
| --- | --- | --- |
| `project:read` | VIEWER | |
| `project:write` — edit, sync, generate | EDITOR | A viewer able to trigger a paid AI run makes "read only" meaningless in the one dimension with a bill |
| `project:delete` | OWNER | The damage outlives the person doing it |
| `member:manage` | OWNER | An EDITOR who can grant EDITOR has OWNER in every way that matters |

**The gate.** `requireRole(organizationId, userId, requiredRole, prisma)` and
`requireCapability(...)` throw rather than returning a boolean — `await
canWrite(...)` compiles, does the query, discards the answer and writes anyway,
whereas forgetting to handle a throw fails loudly.

Its two refusals are worded differently on purpose:

- **A non-member** is told only `No access to organization "X"` — identical to
  what a non-existent organization produces. A message that differed would turn
  the gate into a tenant enumeration API with a 403 in front of it.
- **A member whose role is too weak** is told their role and what the action
  needs. Not a leak — they know both already — and the difference between a
  self-service fix and a support thread.

`heldRole` is carried on `AccessDeniedError`, so a route answers `404` for the
first case and `403` for the second without parsing prose.

Everything unrecognised is a denial: `undefined` means "not a member" and is
handled inside the helper rather than pushed out to every caller, and a stored
role this build does not know resolves to no access rather than being compared
numerically.

**Enforcement, not just a helper.** `syncProject` and `enqueueJob` both gate
before doing anything. The placement in `syncProject` is load-bearing: the check
runs *before* the impact query, so a refused caller never learns which pages
exist. A dry run is refused too — writing nothing is not the same as revealing
nothing.

**The audit trail is a table, not a log.** A log is trimmed, rotated, and
readable by whoever has shell access; `AuditLog` is something a customer can be
shown, scoped to their own organization.

- **Nothing cascades into it.** `resourceId` is a plain string, so deleting a
  project does not delete the record of the project being deleted — which is the
  question an audit log is bought for.
- **There is no unscoped read in the module at all.** The first convenience
  function returning "all recent activity" is the one that ends up behind a
  dashboard route.
- Failures are recorded, not only successes. Syncs that changed nothing are
  recorded by default: a sync that found nothing to do is still someone's
  credential reaching this system.

`createDatabaseAuditLoggerPlugin` is handed its writer at construction — the
plugin contract gives a plugin no database client, so what it may reach is
decided in one visible place.

```bash
STATICFORGE_AUDIT_DB=true   # write the trail to the AuditLog table
STATICFORGE_AUDIT_LOG=true  # write it to stdout as well
```

> **The trail is best-effort, deliberately.** It is written after the action, by
> a listener the bus may abandon, so an unreachable database in the seconds
> after a job finishes loses that entry. Making it guaranteed would mean writing
> it inside the action's own transaction — which the plugin architecture cannot
> do and should not, since a plugin able to fail a run is a plugin able to abort
> a paid, hour-long build. What *is* guaranteed is that a failed write is loud.

> **This is authorization, not authentication.** There is still no user table, no
> session, and no login: `userId` is supplied by the caller rather than proved.
> The gate decides what a user may do; it does not establish who they are.


### 24 — Distributed rate limiting

Rate limiting in process memory works exactly until there is a second process,
and Phase 14 made the worker a thing you are meant to run more than one of. Two
workers each politely holding themselves to the provider's limit will together
exceed it, every time, and the failure arrives as 429s in the middle of a paid
run rather than as anything anyone designed.

The limit belongs to the **tenant and the provider**, not to a process, so the
state lives in Postgres — which already holds the queue those processes
coordinate through. A `RateLimitState` row is one shared token bucket.

**The grant is a single statement.** The obvious implementation reads the row,
decides, and writes the count back — and between that read and that write is the
entire bug: both workers read the same balance, both decide there is room, both
spend it.

```sql
INSERT INTO "RateLimitState" ... VALUES (...)
ON CONFLICT ("id") DO UPDATE SET ... WHERE <refilled> >= <requested>
RETURNING "availableTokens"
```

Postgres takes a row lock on the conflict and re-evaluates both the `SET`
expressions and the `WHERE` against the current tuple, so a second caller
arriving mid-flight sees the first one's deduction. The database decides, not
the gap between two queries.

**A denial writes nothing at all**, including `lastRefillAt`. The time a refused
caller spends waiting is time the bucket is still filling; advancing the clock
on a denial would charge a caller for its own wait.

**The fractional remainder is carried, not discarded.** Tokens are an integer, so
a refill of 0.4 has nowhere to go. Setting the clock to `NOW()` would lose that
fraction on *every* call, and a caller polling faster than one token's worth of
time would then earn nothing forever while every dashboard insisted it was being
topped up. So the clock advances by exactly the time the whole tokens represent.
The only case where time is deliberately discarded is a bucket already at
capacity — which is what a bucket means.

**A request larger than the whole capacity** is refused before the database is
touched and reported as *unsatisfiable* rather than as a long wait. Telling a
caller to wait for it would be telling it to wait for ever.

**The gate sits at `callProvider`** — the one choke point every provider call
passes through, fresh authoring and refresh alike. A limiter with two entry
points is a limiter with one entry point somebody forgot. It is asked *before*
the request is built: asking afterwards would debit the bucket for a call
already made and paid for, which is an accounting record rather than a limiter.
A page served from the cache costs the bucket nothing.

The limiter reaches `@staticforge/ai` as a **bound function taking a token count
and nothing else**. It cannot choose its bucket or raise its capacity — a
component able to widen its own limit is not limited — and it carries no
database client, which is what keeps the AI package free of Prisma.

Waiting is bounded three ways: a per-pause ceiling so a huge computed wait
cannot starve a lease renewal, a floor so a limiter reporting zero cannot spin
the loop into a denial of service against our own Postgres, and a total budget
so a misconfigured bucket cannot turn a run into a process that is alive,
holding a lease, and never finishing. Each pause is announced, because an
operator watching a silent process decides it has hung and kills it.

```bash
STATICFORGE_RATE_LIMIT_CAPACITY=160000        # burst ceiling, in tokens
STATICFORGE_RATE_LIMIT_REFILL_PER_SEC=2600    # sustained ceiling
```

A refill rate of `0` is a valid policy — a hard quota that never tops up. A
bucket in that state that lacks the tokens is reported as exhausted rather than
as a wait, because waiting would never help.


### 25 — Organizational API keys

The sync webhook used to trust a single `STATICFORGE_WEBHOOK_SECRET`. That value
authenticated the *caller* and said nothing about which tenant they were, so
anyone holding it could sync any project the operator owned — one trust domain,
and the reason the endpoint could never be handed to a customer. Keys replace
it, and the old path was **deleted** rather than left beside the new one: two
ways in means the weaker one defines the security.

```bash
corepack pnpm staticforge api-keys create --org-id <id> --name "CI pipeline"
corepack pnpm staticforge api-keys list   --org-id <id>
corepack pnpm staticforge api-keys revoke --org-id <id> --key-id <id>
```

The plaintext is printed **once**. Nothing stores it, and no function can
produce it again — a lost key is replaced, not recovered.

**Only a hash is stored, and it is SHA-256 rather than bcrypt.** Slow hashes
exist to make *low-entropy* secrets expensive to guess; a key here is 256 bits
of `randomBytes`, so there is nothing to guess at any work factor. What a salted
hash would actually cost is the ability to look one up: verification would
become a scan of every key row with a comparison each — O(n) per request, and
slower as a customer adds keys. A fast hash over a high-entropy secret is
indexable and gives up nothing that matters here.

**The key does not contain the organization it grants.** A credential carrying
its own identity leaks that identity to anyone who sees it in a log line or a
screenshot, and invites code that reads the tenant *out of the key* rather than
out of the row it resolves to — the first such reader turns a forged prefix into
a tenant crossing. `sf_org_` names the *kind* of principal, not a particular
one. The prefix is fixed because a fixed prefix is what lets secret scanners
recognise one of these in a public repository before someone else does.

**A key is a member of its organization.** That is the decision the rest follows
from: the alternative is a second permission path just for keys, and a second
path is how one of them ends up missing a check the other has. A key gets a
principal id (`apikey:<id>`) and a membership row written in the same
transaction, so every existing `requireCapability` call works on it unchanged.

It defaults to **EDITOR** — enough to sync, not enough to delete a project or
add members, and therefore **not enough to mint another key**. A credential that
can create its own successors survives its own revocation. `--role VIEWER` makes
a read-only integration key.

**The endpoint asks three questions, in an order that is load-bearing:**

1. **Who is this?** An unresolvable key stops before anything reads a project —
   an endpoint that touched one first would let an unauthenticated caller
   measure which ids exist.
2. **Is the project theirs?** A project in another organization answers exactly
   as a project that is not there. Two different answers would turn a valid key
   for one tenant into a probe for every other tenant's project ids.
3. **May they do this?** `requireCapability`, inside the operation — so a key
   issued as a VIEWER authenticates and is still refused the write.

Absent, malformed, unknown and revoked are four things internally and **one
answer** to a caller: `401 Unauthorized`. Three extra messages are three bits
handed to whoever is guessing.

**Revocation stamps a time rather than deleting the row** — the audit trail
still needs to say which key did something last month and when it was stopped —
and it deletes the membership, so the principal loses access by two independent
mechanisms.

The rule lives in `@staticforge/database` (`authorizeProjectAccess`) rather than
in the route. A decision written inside an HTTP handler can only be tested by
standing up an HTTP handler, and a rule that is hard to test gets one test
instead of twelve.

> **This is machine authentication, not human authentication.** An organization
> can now prove it holds a credential. There is still no user table, no session
> and no login, so on every path other than this webhook a human `userId` is
> asserted by the caller rather than proved.


### 26 — Metering and quotas

Usage is counted **after** the fact; quotas are checked **before**. Those are
opposite guarantees, and both directions are deliberate.

**Why metering is retrospective.** A run's real page count is not knowable when
it is queued: the grid is computed after the input loads, the AI pass skips
cached and out-of-scope pages, and a run can fail half way. Charging at enqueue
time would bill for work that was never done — the one billing error a customer
never forgives. So consumption is recorded from lifecycle events once a verdict
is durable, and the job row's own `completedCount` is read back rather than the
grid estimated.

**Why the quota is prospective.** A quota discovered when the work finishes is
an invoice, not a ceiling: the pages are already written and already paid for.
So `requireQuota` throws, in front of `enqueueJob` and `syncProject`, before
either writes anything.

| Metric | Counted | Gated at |
| --- | --- | --- |
| `AI_GENERATED_PAGES` | Pages an AI pass actually authored | `enqueueJob` |
| `SYNC_OPERATIONS` | Calls that reached the sync layer | `syncProject` |

**What the asymmetry costs, stated plainly.** The number the gate reads is a
lower bound — work already queued has not been metered yet, and a meter write
lost to an unreachable database is never metered at all. A tenant can exceed its
limit by roughly the volume of work in flight when it crossed the line.

The gate was also **not atomic**, and that was accepted here after being refused
in Phase 24 — the rate limiter guards someone else's hard ceiling, where
overshooting produces 429s mid-run, while a quota guards a commercial agreement,
where overshooting produces a conversation.

> **Superseded by Phase 31.** The audit measured it rather than reasoning about
> it: 40 concurrent callers against a limit of 10 all passed. "A conversation"
> was the right frame for two callers and the wrong one for forty. The gate now
> holds what it admits — see [Phase 31](#31--red-team-remediation).

**Ordering inside each gate is load-bearing.** Permission is checked before
quota, so a caller who may not touch a project learns that rather than learning
how much allowance the organization has left. The quota is checked before the
impact query, so a tenant out of allowance cannot keep reading which of its
pages would change.

**The sync gate covers exactly the path the meter covers.** A dry run emits no
lifecycle event and never becomes a usage row, so it is not gated — refusing one
would charge a tenant nothing and cost it the ability to plan.

Three fail-open shapes were closed and one was kept:

- An empty `SUM` is `NULL` in SQL, and `null > limit` allows everything —
  coerced to zero.
- A `resetDate` in the future counts no usage at all, which is a quota that
  silently permits everything — **refused**, with a message saying it will not
  clear on its own.
- A negative limit is refused the same way.
- **Kept:** no quota row means unlimited. Quotas are opt-in, and a default of
  zero would have stopped every existing tenant the moment the table shipped.

Usage is **append-only**. Nothing updates a row; a correction is another row,
possibly negative. A usage table somebody can edit is one a customer is right to
distrust, and a running total is the same race the token bucket needed raw SQL
to avoid.

```bash
STATICFORGE_METER_USAGE=true   # write usage rows from the worker
```

The meter charges only for work that happened: a failed job meters nothing, a
run that authored no pages meters nothing, and a run with no tenant meters
nothing rather than putting the charge on somebody else's invoice.

> **Changed in Phase 31.** The first two now report *zero against the hold taken
> at admission*, which is a refund rather than a silence. Once the gate reserves
> what it admits, staying quiet leaves the estimate charged — so the refusal has
> to be stated to be honoured.

> **Not automated: advancing `resetDate` when a period rolls.** A quota counts
> from whenever it was last set, so a monthly plan needs its reset date moved by
> hand or by a scheduled job that does not exist yet. Until then a quota is a
> lifetime allowance rather than a recurring one — see the gaps list.

---

### 27–29 — Identity, and closing every route

Phase 23 decided *what* a caller may do and left *who they are* asserted rather
than proved. These three closed that.

**27 — human identity.** A `User` table, a real foreign key from
`OrganizationMember`, and `verifyUserSession` validating a Supabase token. The
migration created user rows before adding the constraint, because a foreign key
added first would have rejected every existing membership.

**28 — one authenticated route.** `GET /api/dashboard/projects` routes an
`sf_org_` prefix to `verifyApiKey` and anything else to the JWT path, then
returns projects through `OrganizationMember`.

**29 — every route, by one helper.** Repeating an auth check by hand is how the
fifth route ends up missing one nobody notices, so it became `requireApiAuth`.
The guards **return a discriminated union rather than throwing**: a route that
forgets a thrown guard still compiles and answers `500` instead of `401` — safe
by luck. Reading `auth.principal` without narrowing on `auth.ok` is a compile
error.

`LOCAL_OPERATOR_ID` was removed from `apps/web` entirely, and a route-coverage
test fails the build if a new route skips the guard. The two dashboard pages
stopped reading tenant data rather than keep an unauthenticated read that was
merely convenient.

### 30 — Browser sessions and the hybrid door

`@supabase/ssr` keeps tokens in `HttpOnly` cookies, a login route exchanges
credentials for them, middleware refreshes them, and the existing guard accepts
either a header or a cookie. **No API route changed** — that was the requirement.

**The header always wins, and the ordering is the security property.** A browser
attaches its cookie to every request to this origin, including ones an
integration makes through it, so checking the cookie first would answer a machine
caller as whoever happened to be logged in on that machine. A bad header is not
rescued by a good cookie either: falling back would mean a revoked key silently
keeps working for anyone signed in.

`getUser()` everywhere, never `getSession()` — the latter decodes the cookie the
client sent and verifies nothing, so a page guard built on it is one an attacker
writes their own cookie for.

The middleware deliberately does not run on `/api`: those routes answer `401`,
and a page guard in front of them would turn an integration's clear refusal into
a `302` toward an HTML form. It imports `@staticforge/core/auth-paths`, a
subpath, because the root barrel reaches for `node:crypto` and the Edge runtime
cannot load it.

The `next=` parameter carries a path and never a URL. `//evil.com` and
`/\evil.com` both look like paths and are both refused.

> **Still missing: the `/login` page itself.** The middleware redirects to it and
> it does not exist. Supabase is unconfigured, so nobody has actually signed in.

### 31 — Red Team remediation

An adversarial audit of phases 01–29, with no code written during it. Five
findings; three of them the same shape — **the check existed, one layer too far
out.**

**RBAC moved into the data layer.** Phase 29 gated every route and left the
functions open, so the guarantee was "every caller remembered". The acting
identity is now a **required** parameter on every privileged `database`
function, which turned each call site into a compile error — how they were all
found. A key needs `member:manage` because a key *is* a member: an EDITOR who
could mint an OWNER key would be an OWNER by a route no check would notice.

**`setQuota` is guarded differently, and deliberately.** Gating it with
`member:manage` would have been *worse than leaving it open* — OWNER holds that
capability, and the OWNER is the person the quota bills. It would have let a
customer raise their own spending cap while reading as a security improvement.
`requirePlatformOperator` asks a question no tenant role can answer.

**Billing outlives its tenant.** `UsageRecord` cascaded from `Organization`, so
deleting an account erased the last month nobody had invoiced yet. The relation
is gone.

**Quotas hold what they admit.** Usage is metered retrospectively, so
`SELECT ... FOR UPDATE` alone does not close the race: ten serialised callers
still read a total nothing has written to, and all ten still pass. The gate now
writes its estimate at admission, in the same transaction as the job row, and
the meter settles `actual - held` — so a failed run reports zero, which *is* the
refund.

| Gate | Admitted, 40 concurrent, limit 10 |
| --- | --- |
| Phase 26 read-only check | **40 of 40** |
| Phase 31 reserving gate | **10 of 40** |

**The worker survives a promise nobody awaited.** Node exits on an unhandled
rejection and the bus deliberately abandons listeners that overrun, so one bad
webhook took down a worker mid-build — then the worker that reclaimed the job.
Twenty rejections in a minute still exits, loudly: the point is to turn a
process-ending accident into a process-ending decision.

**Login is rate limited on two keys**, the caller's address and a global one.
Not on the email, which would let anyone lock a named user out of their own
account. The global key is the half that holds, because `X-Forwarded-For` is
forgeable; the address is read from the **rightmost** entry rather than the
leftmost.

**The `NaN` spin is closed.** `Math.max(1000, NaN)` is `NaN` and
`setTimeout(fn, NaN)` fires immediately — and `waited += NaN` disabled the
budget check permanently, for the rest of the call. The loop is now bounded by
counting as well as by arithmetic, because a guard against bad numbers that is
itself made of numbers protects nothing the next bug of the same shape cannot
switch off again.

Seven mutations, all caught. One survived on the first attempt and the **test**
was at fault rather than the code — it passed an id that could not have matched
anyway, so the guard was never exercised.

---

## Cloud database mode

The generator reads from PostgreSQL when given a project id, and writes the
generated pages back to it. Without the flag it reads `data/input/` exactly as
before.

```bash
corepack pnpm --filter @staticforge/database db:push    # schema → database
corepack pnpm --filter @staticforge/database db:seed    # sample tenant (idempotent)
corepack pnpm --filter @staticforge/generator generate --project-id <id>
```

> Pass `--project-id` **without** a `--` separator. pnpm forwards the separator
> to the script as a literal argument, where it is rejected as an unexpected
> positional.

`DATABASE_URL` lives in a git-ignored `.env` inside `packages/database/`
(see `.env.example`). Percent-encode any reserved character in the password —
an unencoded `?` terminates the URI authority and leaves the URL with no host.

### What the two modes share

Only the *load* step differs. Validation, page assembly, slug collision
detection, AI authoring and static output are identical, and this is verified
rather than assumed: the seeded project uses the same entity ids as the JSON
fixtures, so generating from the database produces output byte-identical to a
local-file run.

Static files are written in **both** modes, because the Next.js build reads
them. Database mode additionally persists each page, after validation and the
optional AI pass have both succeeded.

---

## CSV data ingestion

Services and locations can be imported from one flat CSV sheet instead of being
hand-written as JSON — the path to generating hundreds of pages without editing
JSON by hand.

```bash
corepack pnpm import:csv                # reads data/input/sample.csv
corepack pnpm import:csv --dry-run      # parse and report, write nothing
corepack pnpm import:csv --in my.csv    # a different sheet
```

> Pass flags **without** a `--` separator. The root script delegates through a
> second pnpm invocation, which would otherwise forward the separator itself as
> an argument.

`import:csv` **overwrites** `data/input/services.json` and
`data/input/locations.json`. Anything the sheet does not carry is gone, so
`--dry-run` — which parses, validates and prints the row counts without writing
a byte — is the safe first move on an unfamiliar sheet.

### Columns

The `type` column decides which schema a row must satisfy.

| Column        | `service`            | `location`         |
| ------------- | -------------------- | ------------------ |
| `type`        | required             | required           |
| `name`        | required             | required (city)    |
| `description` | required, 100+ chars | ignored            |
| `benefits`    | required, 3+ items   | ignored            |
| `state`       | ignored              | required           |
| `id`          | optional             | optional           |
| `slug`        | optional             | ignored            |
| `country`     | ignored              | optional (`DE`)    |
| `postalCode`  | ignored              | optional           |
| `pricing`     | optional             | ignored            |
| `coordinates` | ignored              | optional           |

`benefits` is a `|`-separated list, `pricing` is `from|to|currency`, and
`coordinates` is `lat|lng`. Unknown columns are ignored.

`description`, `benefits` and `state` are not conveniences that can be skipped —
`ServiceSchema` and `LocationSchema` require them, so a three-column sheet
cannot produce a page that validates.

### Why `slug` is a column

Slugs are derived from `name` only when the column is empty, and derivation
**strips** diacritics rather than transliterating them: `Büroreinigung` becomes
`buroreinigung`, not the curated `bueroreinigung`. Since a page's URL is built
from the service slug, letting derivation win would silently rename published
routes. Curated slugs belong in the sheet.

### Safety

- Every row is validated against the real schemas; issues are collected across
  the whole sheet and reported together with row number and column, so a bad
  sheet is fixed in one pass rather than one row per run.
- Duplicate ids are rejected — the generator indexes by id, so a collision would
  silently drop an entity.
- Validation runs **before** any write, so a failed import cannot leave
  `data/input/` half-overwritten.

`data/input/sample.csv` reproduces the current sample data exactly: importing it
leaves `services.json` and `locations.json` byte-identical.

### Intentionally deferred

- Importing businesses or the content template from CSV
- Merging into existing JSON instead of overwriting it
- Slug transliteration (`ü` → `ue`) as a derivation option
- Reading sheets from a URL or a spreadsheet API

---

### Scope & architecture reminders

- **Language-agnostic:** the German sample data is strictly demo content. The
  engine itself hardcodes no language — all page text comes from the input data
  and content templates.
- **Out of scope at this step:** AI, dashboard, auth, database, Stripe, and
  deploy logic are intentionally not part of the current MVP.

---

## Generated page rendering coverage

The generated slug page (`apps/web/app/[slug]/page.tsx`) maps validated page
fields to the rendered output as follows:

| Source field | Rendered as |
|---|---|
| `page.title`, `page.metaDescription` | Next.js `generateMetadata` (`<title>` / `<meta name="description">`) |
| `page.h1` | visible `<h1>` |
| `page.content.hero.subheading` | visible intro paragraph (falls back to `page.metaDescription`) |
| `page.content.sections[]` | visible content sections |
| `page.content.faq[]` | visible FAQ block |
| `page.content.cta` | visible CTA block |
| `page.schemaOrg` | server-rendered JSON-LD `<script type="application/ld+json">` |
| `page.locale` | `lang` attribute on the slug page container element |

### Intentionally deferred

These are recognized and deferred to keep the current step minimal:

- Root `<html>` `lang` tag handling (in `app/layout.tsx`)
- Locale routing via dynamic path segments
- OpenGraph / canonical / alternates SEO tags
- `content.hero.image` rendering layer
- `content.hero.heading` rendering (H1 currently uses `page.h1`)
- `templates` package isolation
- `ai` package implementation
- Database / auth / dashboard / Stripe / deployment configuration

---

## Route / view separation

The generated slug page is split into two co-located files with distinct
responsibilities:

- **`apps/web/app/[slug]/page.tsx`** — owns route-level concerns only:
  - `dynamicParams = false`
  - `generateStaticParams`
  - `generateMetadata`
  - slug / page lookup
  - `notFound()` handling

  After loading and null-checking the page, it renders
  `<GeneratedPageView page={page} />`.

- **`apps/web/app/[slug]/GeneratedPageView.tsx`** — owns presentation only. It
  receives an already-validated `GeneratedPage` object as a prop and renders
  JSX. It does **not** fetch data, read files, access route params, call
  `notFound()`, import `next/navigation`, or use any client-side behavior (no
  `"use client"`).

This is a plain Server Component split, **not** a `templates` package yet. The
view renders purely from the injected data, so the separation keeps the project
language-agnostic — no language is hardcoded in either file.

---

## Template readiness: `templateId`

`templateId` is now officially part of the generated page payload data contract
(`GeneratedPageSchema`), defined as `z.string().min(1).default("default")`.

- **Contract:** every generated page carries a page-level `templateId`.
- **Current value:** strictly `"default"` for all generated pages.
- **Language-agnostic:** `templateId` is a generic identifier, fully decoupled
  from the German demo content.
- **Slug-blind:** `templateId` is never used in or derived from route slugs.
- **Not yet rendered:** the frontend does not read or match `templateId`;
  `GeneratedPageView` remains the exclusive presentation view layer.
- **Backward compatible:** the `.default("default")` chain means older payloads
  without the field still validate.

> **Step 7B was a pure, zero-visible-behavior-change architectural preparation
> checkpoint** — it only introduced the identifier in the data contract.

### Intentionally deferred

- A centralized template component registry
- A frontend template rendering switch / dispatch layer
- Multiple distinct visual template components (e.g. a Dark Luxury landing page)
- A standalone dynamic `templates` package workspace
- Input-level `templateId` overrides and `templateId` exposure in the manifest

---

## Template registry

A minimal, route-local registry resolves which view renders a page.

> This section originally introduced a **default-only** registry; it has since
> been superseded by an additional template and strict unknown-template handling
> (see “Strict unknown-template handling” below).

- **Location:** `apps/web/app/[slug]/templateRegistry.ts` — strictly route-local,
  server-only, pure (no JSX, no `"use client"`).
- **Mapping:** `default` → `GeneratedPageView`; `luxuryLanding` → `LuxuryLandingView`.
- **Dispatch:** `page.tsx` still owns all framework concerns
  (`dynamicParams`, `generateStaticParams`, `generateMetadata`, data lookup,
  `notFound()`), and resolves the view dynamically via
  `getTemplateView(page.templateId)`.
- **Default view:** `GeneratedPageView` renders all current pages
  (`templateId: "default"`); `LuxuryLandingView` is registered but inactive.
- **Strict resolution:** an unknown / unregistered `templateId` now **throws** a
  clear error rather than silently falling back.

### Registry guardrails

The registry is intentionally inert — it must never:

- fetch data or call any API
- perform file-system I/O
- inspect dynamic route params
- run framework methods like `notFound()`
- import routing modules like `next/navigation`
- include client component hooks or any hydration footprint

### Intentionally deferred

- Multiple distinct visual template UIs (e.g. a high-ticket Dark Luxury layout)
- Moving the registry into a standalone `templates` workspace package
- Template-specific variations inside the core validation schemas
- Input-source template descriptor overrides
- Tracking `templateId` directly in `manifest.json`
- A stricter error / `notFound()` policy for unknown template requests

> **Step 8B was a pure, zero-visible-behavior-change architectural decoupling
> step** — all pages use `templateId: "default"`, so rendering is unchanged.

---

## Optional input-level `templateId` override

The input content config (`data/input/content.json`) may **optionally** declare a
top-level `templateId` to select which template renders the generated pages.

- **Optional:** if `templateId` is absent, the generator resolves it to
  `"default"` (`content.templateId ?? "default"`).
- **Non-empty:** validation uses `z.string().min(1).optional()`, so a present
  but empty string is rejected.
- **Sample data unchanged:** the current input intentionally omits `templateId`,
  so generated output still uses `"templateId": "default"`.
- **Language-agnostic:** `templateId` selects a rendering shape only — it is not
  tied to the German demo content, locale, service, location, or city.
- **Slug-blind:** `templateId` is never used in route slugs.
- **Render path:** the web registry still maps `"default"` → `GeneratedPageView`.

### Intentionally deferred

- Adding a second visual template
- Adding template-specific input examples
- Exposing `templateId` in `manifest.json`
- Stricter unknown-template handling
- A standalone `templates` package
- AI-driven template selection

> **Step 9B was a zero-visible-behavior-change input-contract step** — it only
> made `templateId` an accepted optional input, defaulting to `"default"`.

---

## Inactive alternate template: `luxuryLanding`

A first alternate template now exists, registered but not yet used:

- **Component:** `apps/web/app/[slug]/LuxuryLandingView.tsx` — a route-local
  Server Component rendered purely from page data.
- **Registered:** the registry maps `"default"` → `GeneratedPageView` and
  `"luxuryLanding"` → `LuxuryLandingView`.
- **Inactive:** all generated pages still use `templateId: "default"`, so current
  routes continue to render through `GeneratedPageView`.
- **Capable:** the registry can now resolve a non-default template if future
  input data opts into it via the optional `templateId` override.
- **Language-agnostic:** `luxuryLanding` names a rendering shape only — it is not
  tied to the German demo content.

### Guardrails

- No `templates` package yet — the component stays route-local
- No client components (pure Server Component, no `"use client"`)
- No sample-data activation — input is unchanged
- No route, slug, or manifest changes
- No visible behavior change for current pages

### Intentionally deferred

- Activating `luxuryLanding` through input data
- Comparing visual output between templates
- Adding more templates
- Moving templates into a shared package
- Stricter unknown-template handling
- Template-specific content contracts

> **Step 10B was a zero-visible-behavior-change step** — it added an inactive
> alternate template and registered it, leaving current rendering untouched.

---

## Template activation smoke test (reversible)

A temporary smoke test verified the end-to-end template activation path:

- **What was tested:** `templateId: "luxuryLanding"` was added to
  `data/input/content.json`, then regenerated and rebuilt.
- **Path proven:** input `content.templateId` → generator output `templateId`
  → web registry → `LuxuryLandingView`.
- **Scope during activation:** all 9 pages switched, because `content.json` is a
  single shared content object (one `templateId` applies to every page).
- **Reverted:** the field was removed afterwards. The canonical sample state
  remains `templateId: "default"`, and current pages render through
  `GeneratedPageView`.

No permanent non-default activation is committed. `luxuryLanding` remains
available but inactive by default.

### Intentionally deferred

- A permanent non-default sample dataset
- Per-page / per-service template selection
- Visual comparison tooling
- A standalone `templates` package
- A stricter unknown-template policy

> **Step 11B was a reversible verification step** — it proved activation works
> end-to-end, then restored the default-template state (net-zero change).

---

## Service-level `templateId` override

Templates can now be selected per service, more granularly than the global
content-level default.

- **Optional per service:** each entry in `data/input/services.json` may define
  `templateId` (`z.string().min(1).optional()` — empty strings rejected).
- **Precedence:** the generator resolves
  `service.templateId ?? content.templateId ?? "default"`, so a service-level
  value wins over the content-level value.
- **Sample unchanged:** current services and `content.json` intentionally omit
  `templateId`, so generated pages still resolve to `"templateId": "default"`.
- **Inactive alternate:** `luxuryLanding` remains registered but inactive.
- **Language-agnostic & decoupled:** `templateId` is a generic rendering
  identifier — never tied to the German demo content, and never used in slugs,
  routes, locale, city, or the manifest.

### Intentionally deferred

- Activating `luxuryLanding` on a sample service
- Per-location template overrides
- Per-business template overrides
- Page-combination template overrides
- A separate template mapping file
- Exposing `templateId` in `manifest.json`
- A stricter unknown-template policy

> **Step 13B was a zero-visible-behavior-change capability step** — it added
> optional per-service template selection while keeping output identical.

---

## Service-level template activation smoke test (reversible)

A temporary verification confirmed service-level `templateId` resolution:

- **Test:** temporarily activated `luxuryLanding` on service `svc-bueroreinigung`.
- **Result:** exactly 3 pages (`bueroreinigung-duisburg`, `bueroreinigung-essen`,
  `bueroreinigung-dusseldorf`) switched to `luxuryLanding`, while the other 6
  pages stayed `"default"`.
- **Conclusion:** granular per-service selection works; the active precedence is
  `service.templateId → content.templateId → "default"`.
- **Reverted:** the change was fully undone. `luxuryLanding` remains available but
  inactive, and the canonical sample state stays `templateId: "default"`. Slugs,
  routes, manifest structure, sample data, renderer files, and registry behavior
  are unchanged.

> **Step 14A was a reversible verification step** — it proved per-service
> activation works, then restored the default-template state (net-zero change).

---

## Strict unknown-template handling

The web template registry now fails loudly on an unrecognized `templateId`:

- **Throws, not falls back:** `getTemplateView` throws when the `templateId` is
  not registered, e.g. `Unknown templateId "<id>". Registered templates:
  default, luxuryLanding.` — the message names the bad id and the registered ids.
- **Catches typos early:** a mistyped service-level `templateId` now fails the
  build during prerender instead of silently rendering the default view.
- **Layering preserved:** the generator stays template-name agnostic (it only
  emits a string); schemas still validate `templateId` as a non-empty string,
  while registry *membership* is enforced in the web renderer.
- **Registered templates:** `default` and `luxuryLanding` remain the only two.

### Negative smoke test (reversible)

- One service was temporarily set to `templateId: "notRegisteredTemplate"`.
- Generation succeeded (9 pages), but the web build **failed during prerender**
  with the expected `Unknown templateId "notRegisteredTemplate". Registered
  templates: default, luxuryLanding.` error.
- The temporary input change was reverted; final `corepack pnpm verify` passed
  and the canonical sample returned to `templateId: "default"`.
- Slugs, routes, manifest, layout, renderer views, generator logic, and sample
  data are unchanged after revert.

> **Step 15B added strict validation; Step 15C proved it via a reversible
> negative test** — invalid ids now fail loudly, valid pages build unchanged.

---

## Duplicate slug collision protection

Generated slugs are now guarded against duplicates **before** `savePages` writes
anything:

- **Fails loudly:** `buildPages` tracks seen slugs and collects a validation
  issue for any collision, throwing a single `ValidationError` at the end of the
  generation pass (consistent with existing validation behavior).
- **Why it matters:** a duplicate slug would otherwise silently overwrite one
  page's `pages/{slug}.json`, leave duplicate rows in `manifest.json`, and create
  ambiguous `/[slug]` routes — all without any error.
- **Slug source unchanged:** slugs are still `service slug + location city`
  (`combineSlug([generateSlug(service.slug), location.city])`). **Business is
  still not part of the slug** in this step.
- **No behavior change for valid input:** valid slug generation, routes, manifest
  structure, schemas, sample data, and web app behavior are all unchanged; the
  guard only adds detection.

### Negative smoke test (reversible)

- A temporary duplicate location `loc-duisburg-dup` (city `Duisburg`, same as the
  existing `loc-duisburg`) was added to `data/input/locations.json`.
- `corepack pnpm generate` **failed** with **3 duplicate-slug issues** — the
  Duisburg service-location pages (`bueroreinigung-duisburg`,
  `grundreinigung-duisburg`, `treppenhausreinigung-duisburg`), each naming the
  colliding business/service/location.
- The temporary location was reverted; final `corepack pnpm verify` passed and
  the canonical output returned to the normal 9 pages.

> **Step 15E added the collision guard; Step 15F proved it via a reversible
> negative test** — duplicate slugs now fail loudly before any files are written.

---

## Business-level page eligibility

A business may optionally declare which services and locations it covers, so the
generator no longer assumes the full cartesian product applies to every business.

- **Fields (optional):** `business.serviceIds?: string[]` and
  `business.locationIds?: string[]`.
- **Semantics:** `undefined` → unconstrained (all services / all locations);
  `[]` → explicitly none; ids must be non-empty and **must reference existing**
  services/locations. An unknown referenced id fails validation loudly (collected
  into a single `ValidationError`, consistent with the existing pattern).
- **Generator behavior:** a business's pages are generated from
  `eligibleServices × eligibleLocations`. The current sample data declares neither
  field, so it still generates **9 pages**.
- **Slugs unchanged:** slugs remain `service slug + location city`; **business is
  not added to the slug**, and the Step 15 duplicate-slug protection stays active.

### Eligibility smoke test (reversible)

- The sample business was temporarily restricted to service `svc-grundreinigung`
  and location `loc-essen`.
- Generation produced **exactly one page** — `grundreinigung-essen` (manifest
  count 1), with matching `businessId`/`serviceId`/`locationId`.
- After revert, generation returned to **9 pages**, final `corepack pnpm verify`
  passed, and no `serviceIds`/`locationIds` remain in the sample data.

> **Step 17B added optional business-level eligibility; Step 17C proved it via a
> reversible smoke test.** No route, manifest-structure, web-renderer, or template
> changes; no language-specific coupling — German content remains demo data only.

---

## Manifest validation

`manifest.json` is now runtime-validated when the web app reads it, closing the
last validation gap (generated pages were already validated per file).

- **Shared schema:** `ManifestSchema` lives in `packages/schemas`.
  `ManifestEntrySchema` is derived from `GeneratedPageSchema` (picking `slug`,
  `locale`, `title`, `metaDescription`, `templateId`) so entry shapes — including
  `locale` and `templateId` — stay aligned with generated pages.
- **Constraints:** `count` is a non-negative integer, `pages` is an array of
  entries, and `count` must equal `pages.length`.
- **Web validation:** `apps/web/lib/staticforge-output.ts` runs
  `ManifestSchema.safeParse` after reading `data/output/manifest.json`. A missing
  manifest still returns `null` (unchanged); a **present but malformed** manifest
  now fails loudly with a clear `Invalid manifest.json: …` error. Valid manifests
  behave exactly as before.

### Negative smoke test (reversible)

- The valid manifest had `count: 9` / `pages.length: 9`.
- `count` was temporarily changed to `999` (valid JSON, schema-invalid).
- `corepack pnpm build:web` **failed** with
  `Invalid manifest.json: count: count (999) does not match pages.length (9)`.
- Output was regenerated to restore the manifest, and full `corepack pnpm verify`
  passed again (9 pages).

> **Step 18B added shared manifest validation; Step 18C proved it via a reversible
> negative test.** No manifest-structure, generator-output, route, sample-data, or
> template/rendering changes; German content remains demo data only.

> **Step 50B** later added `templateId` to each manifest entry, so the manifest is
> a complete index of which template every page uses. The change is additive and
> backward compatible — older manifests without `templateId` parse to `"default"`.
> (This supersedes the earlier "expose `templateId` in `manifest.json`" deferred
> items.)

---

## Template preview route

A static preview route lets any generated page be viewed through any registered
template, without touching the canonical site.

- **Route:** `/preview/[template]/[slug]`
- **Examples:**
  - `/preview/default/bueroreinigung-duisburg`
  - `/preview/luxuryLanding/bueroreinigung-duisburg`
- **Registered templates:** `default`, `luxuryLanding`.

### Static behavior

- `generateStaticParams` combines the registered template ids (`getTemplateIds()`)
  with the generated slugs — current sample → **18 preview pages** (2 × 9).
- `dynamicParams = false`: only those enumerated combinations exist; any other
  template/slug 404s.
- Canonical `/` and `/[slug]` routes are unchanged.

### Safety

- Server-only (no `"use client"`), reusing the existing output helpers.
- Preview pages are `noindex` (`robots: { index: false, follow: false }`).
- Rendering **ignores the page's own `templateId`** and uses the template from
  the URL — that's the point of the preview.
- No sample-data, generated-output, schema, manifest, or template-component
  changes; the only registry change is an additive `getTemplateIds()` export.

### Out of scope

- Visual polish of `LuxuryLandingView`
- Navigation links to the preview route
- Changing canonical pages
- Adding more templates or extracting a `templates` package
- Multi-business routing changes

> **Step 21B added a static, additive template preview route** — it makes the
> registry's templates viewable in real builds while leaving canonical output and
> sample data untouched.

<!-- Trigger CodeRabbit Audit -->
