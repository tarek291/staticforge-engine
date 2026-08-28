# StaticForge Engine

A schema-driven static site generation engine, organized as a pnpm monorepo.

> **Status:** 🟢 Phases 01–23 delivered. End-to-end pipeline working against a
> live Supabase PostgreSQL instance, with a standalone queue worker, a data-sync
> boundary, headless block editing, database-backed templates, a plugin runtime,
> a read-only AI gap analyst, incremental publishing that re-authors only the
> pages a change reached, and an RBAC organization layer with a database audit
> trail. **Not yet deployed, and there is no
> authentication layer** (Phase 23 added authorization, not identity) — see
> [STATICFORGE_CONTEXT.md](STATICFORGE_CONTEXT.md)
> for the full state and the outstanding technical debt.

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
corepack pnpm test        # run every package's test suite (830 tests)
corepack pnpm verify      # generate + typecheck (all) + test (all) + web build
```

Database-backed commands, via the `staticforge` binary:

```bash
corepack pnpm staticforge build --project-id <id>    # generate one tenant's project
corepack pnpm staticforge worker                     # claim and run queued jobs
corepack pnpm staticforge sync --project-id <id> --url <csv> --dry-run
corepack pnpm staticforge analyze --project-id <id>  # AI gap analysis (read-only)
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
added the enterprise layer. Every phase below is merged into `main`.

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
