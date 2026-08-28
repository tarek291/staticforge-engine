# StaticForge — Architecture & Capability Briefing

**Status:** Engine complete and running against a live Supabase PostgreSQL
instance. Generation, persistence, queueing, sync, headless editing and
incremental publishing are all verified end to end. Not yet deployed, and there
is still no authentication.
**Audience:** Product and platform planning for the SaaS layer.
**Last updated:** 2026-08-28 (reflects phases 01–22)

---

## 1. Executive Summary

StaticForge is an **enterprise programmatic SEO engine for multi-location service
businesses** — cleaning companies, moving firms, handyman networks, security
providers, and similar operators who sell the same handful of services across
many towns.

These businesses face a structural content problem. A firm offering 5 services
in 40 cities needs 200 distinct landing pages to compete in local search. Each
page must be genuinely specific to its service-and-city pair, or it is thin
duplicate content that search engines discount and prospects bounce from. Hiring
that out is slow and expensive; templating it produces the spreadsheet-shaped
pages that rank for nothing.

StaticForge takes structured business data — services, locations, contact
identity, a content template — and produces validated, statically rendered
landing pages for every eligible service-and-city pair. Content can be assembled
deterministically from templates or authored by Claude under a strict schema
contract, grounded in verified facts. Every page is validated against a shared
data contract before it is written, so invalid output cannot reach a build.

The engine runs as a local CLI, as a database-backed multi-tenant service, and
as a standalone queue worker. The multi-tenant data model, the tenant isolation
boundary, the persistence layer, the job queue, the data-sync boundary, the
headless editing API and the incremental publishing path are built, tested, and
exercised against the real database. A change now re-authors only the pages it
actually reached, and a drained queue triggers the static host's build.
**What remains is the commercial surface: authentication and tenant scoping,
deployment, and billing.**

---

## 2. Architecture & Tech Stack

A pnpm monorepo of seven workspace packages plus a Next.js application, in
TypeScript under strict mode across every package.

| Package | Responsibility |
| --- | --- |
| `@staticforge/schemas` | Shared Zod data contracts. The single source of truth for every entity shape. |
| `@staticforge/core` | Pure utilities: slugs, SEO, phone normalization, CSV ingestion, link graph, content hashing, block-path patching, plugin runtime, sync adapters. |
| `@staticforge/generator` | The pipeline: load → validate → build → author → persist. |
| `@staticforge/ai` | Claude integration: schema-constrained output, grounding, caching, retry, refresh loop, gap-analysis agent. |
| `@staticforge/database` | Prisma data access, multi-tenant repository, job queue, seed. |
| `@staticforge/cli` | The `staticforge` binary: `build`, `worker`, `sync`, `analyze`. |
| `@staticforge/templates` | Reserved for extracting the presentation layer. **Still an empty placeholder.** |
| `apps/web` | Next.js 15 static site generator, preview surface, dashboard, and headless API. |

**Language and validation.** TypeScript strict mode is enabled repo-wide, with
`noUncheckedIndexedAccess`, `noUnusedLocals`, and `verbatimModuleSyntax` on.
Zod carries the runtime contract. The two are deliberately not redundant: the
compiler governs code, Zod governs data crossing a boundary — file input, model
output, database rows, webhook payloads, editor patches, and the manifest the
web app reads at build time.

**Persistence.** Prisma ORM against PostgreSQL on Supabase. **The database is
connected and in use.** The schema has been pushed with `db push`, the seed runs
against it, and generation, queueing and page persistence have each been
verified against the live instance rather than against mocks alone. The
connection string lives in a git-ignored `.env`.

**AI.** The Anthropic SDK, using Claude Opus 5 with adaptive thinking. Output is
constrained by converting the Zod contract to JSON Schema for a forced tool
call, then parsed back through Zod — the model cannot widen the payload shape.

**Presentation.** Next.js 15 App Router with static generation, Tailwind CSS,
and React Server Components throughout. No client-side JavaScript ships for the
generated pages.

**Quality gate.** A single `verify` command runs generation, typechecks every
package, runs every test suite, and builds the site. It is recursive rather than
an enumerated list, so a newly added package joins the gate automatically —
a deliberate choice after two packages were once silently outside it.

---

## 3. Engine Capabilities

### 3.1 CSV data ingestion

Services and locations import from a single flat sheet, so onboarding a client
with dozens of locations is a spreadsheet paste rather than hand-written JSON.

Each row is validated against the real entity schemas at import time, and issues
are collected across the whole sheet and reported together with row and column —
a bad sheet is corrected in one pass, not one row per run. Duplicate identifiers
are rejected, because the pipeline indexes by id and a collision would silently
drop an entity. Validation completes before anything is written, so a failed
import cannot leave the input directory half-overwritten.

One detail worth surfacing to anyone planning the dashboard's import UX: slugs
are an explicit column, not derived from names. Automatic derivation strips
diacritics rather than transliterating them, so a German service name would
yield a URL the operator did not intend. Because a page's URL depends on that
value, derivation is a fallback and never overrides a curated slug.

### 3.2 Dual-mode generator

The same pipeline runs against two data sources, selected by a single flag.

- **Local file mode** reads from a JSON input directory. This is the offline,
  no-infrastructure path, and it is unchanged from before the database existed.
- **Cloud database mode** loads one tenant's project from PostgreSQL.

Only the *load* step differs. Validation, page assembly, slug collision
detection, AI authoring, and static output are byte-identical across both modes.
The database client is imported dynamically, so a local run never loads Prisma
at all — no client construction, no engine binary, no infrastructure cost on a
machine that has no database.

This matters commercially: the same engine serves a local power user, a hosted
tenant, and a CI build, without a fork.

### 3.3 AI content generation, grounding and caching

Content authoring is strictly opt-in behind an environment flag. Without it the
pipeline is deterministic and free.

The Zod page contract is converted to JSON Schema and attached to a forced tool
call, so the model returns structured data rather than prose to be parsed. The
tool arguments are then parsed back through Zod before anything downstream sees
them — the model can fail, but it cannot silently produce a differently shaped
page.

**Critically, the model is only asked for what it can legitimately author** —
title, meta description, H1, and body content. Slugs, locale, template
selection, and entity identifiers are resolved deterministically by the engine
and merged in afterwards. The model is never in a position to invent an
identifier or rename a published URL. Every merged page is re-validated before
it is persisted.

**Fact grounding.** Generated copy is checked against the verified record the
engine actually holds. Invented prices, credentials, certifications and review
counts are rejected rather than published — a page claiming a licence the
operator does not hold is a liability, not a lead. Grounding is a gate on the
way in, not a lint applied afterwards.

**Caching and versioning.** Authored content is fingerprinted over the inputs
that actually reach a page — business, service, city, template, prompt version —
so an unchanged page is not re-authored and not re-billed. A prompt change
invalidates the cache by design, because the same inputs under a new prompt are
not the same request.

**The refresh loop.** Pages can be re-authored selectively against feedback
rather than regenerated wholesale, so improving one section does not cost a full
rebuild of content that was already correct.

Calls are paced with a delay between pages to stay inside provider rate limits,
and the pass fails fast rather than continuing past an error, since every
iteration is a paid call.

### 3.4 Dual-write persistence

In database mode, pages are written to both PostgreSQL and the static JSON
output. The files are not a legacy path: the Next.js build reads them, so they
are required in both modes. The database is the queryable record the dashboard
reads.

The database write is a single atomic transaction. Within it, pages whose slugs
this run no longer produces are deleted *before* the remaining pages are
upserted. The ordering is load-bearing rather than cosmetic — the table carries
a second uniqueness constraint on the service-and-location pair, so a renamed
service would otherwise leave an orphaned row that the slug-keyed write cannot
see and whose presence makes the insert fail. A partial failure leaves the
tenant's pages exactly as they were.

Each stored page records its provenance — template-assembled, AI-authored, or
manually edited — and a manually edited page is protected from being overwritten
by a later generation run.

### 3.5 Queue worker and job resumability *(Phase 14)*

The engine runs **outside the web server**. The `GenerationJob` table is the
queue; there is no broker, because a second thing to run, secure and reason
about is not worth it for a workload measured in jobs per hour, and Postgres
already holds the row the dashboard polls.

- **The claim is decided by the database.** `claimNextJob` picks a candidate and
  then takes it with a *conditional* update whose `where` repeats the condition
  that made it claimable. Two workers racing for the same row both issue that
  update; Postgres serialises them, the first wins, the second matches nothing
  and moves on. Safe without `FOR UPDATE SKIP LOCKED` and the raw SQL it needs.
- **Lapsed leases are reclaimed, not failed.** A `RUNNING` job whose lease
  expired becomes claimable again. Failing it would throw away content the
  tenant has already paid for.
- **Runs resume.** Stored AI pages are reused only when their `sourceHash`
  matches what this run computes — same business, service, city and template.
  Anything else is authored again rather than trusted. A five-hundred-page run
  killed at four hundred costs a hundred pages, not five hundred.
- **Progress is derived, not reported.** `progress` comes from the counts, so a
  bar reading 80% beside "12/500" is unrepresentable.

The jobs API route writes one row and answers `202`. Spawning and supervising
the engine inside the Next.js process is gone: the web tier can now be
restarted, replicated and deployed without destroying work in flight.

Verified against Supabase: a job enqueued through the real path was claimed by
`staticforge worker`, run to completion at 100% (9/9, exit 0), with the lease
released and output written to the project's isolated directory.

### 3.6 Data sync layer and webhooks *(Phase 15)*

A tenant's services and locations live somewhere before they live here. This is
the boundary they cross, drawn once instead of once per source.

- **Adapters do shape, nothing else.** A `DataSyncAdapter` takes one source's
  native form and produces the engine's entities, or says precisely why it
  cannot. No I/O, no database, no policy. Both shipped adapters reduce to the
  entity schemas, because an adapter validating its own way would become a
  second definition of a service and the two would drift.
- **Pull:** `staticforge sync --project-id <id> --url <csv>` fetches a published
  sheet and applies it; `--dry-run` reports what would change and writes
  nothing. The URL is checked — http(s) only, no loopback or private ranges, a
  size cap and a timeout — because the day a "sync from a URL" field reaches the
  dashboard is the day SSRF matters.
- **Push:** `POST /api/webhooks/sync` takes the same payload as JSON. The token
  is compared by hashing both sides and using `timingSafeEqual`. An unset or
  placeholder `STATICFORGE_WEBHOOK_SECRET` refuses every call: a forgotten
  environment variable must fail closed on a route that writes tenant data and
  queues paid work.
- **Change detection is the point.** These sources re-send by nature. Incoming
  data is fingerprinted over the fields that actually reach a page — not
  `updatedAt`, not row order — and compared before anything is written. No
  difference, no write, no job. Without this, a nightly cron re-uploading the
  same sheet is a standing order to re-buy a few hundred pages of identical
  prose.
- **An absent collection is not an empty one.** A sheet listing only locations
  must not read as an instruction to delete every service. Relatedly, a sheet
  with no recognisable rows is refused: an unpublished Google Sheet returns an
  HTML sign-in page that parses as a header with zero rows, and handed on as
  data it would clear the project.

### 3.7 Headless block editing *(Phases 16–17)*

The infrastructure a visual editor needs, built on the premise that a partial
edit is *more* dangerous than a whole rewrite. A rewrite arrives as a complete
page and is judged as one; a patch arrives as a fragment and looks too small to
check. An editor that clears a required heading sends a perfectly well-formed
request, and a person typing a phone number into a text box is exactly as
unverified as a model inventing one.

`PATCH /api/dashboard/projects/[id]/pages/[slug]/block` applies a scoped edit.

- **Path safety.** A block path is a string the client chose, driving a mutation
  of a structure the client does not own. Segments naming the prototype chain
  are refused at any depth. Nothing is auto-vivified, so `content.hero.titel`
  fails instead of growing a field. An index past the end of a list is a
  mistake, not an append. Nothing mutates its input.
- **The same three gates a model faces.** The merged result goes through the
  structural contract, the quality profile the page names, and the verified
  record. A failure at any gate discards the patch whole — there is no partial
  application, and the published page is untouched.
- **What cannot move.** Only the authored slice is editable. Slugs are published
  URLs and every inbound link pointing at them; the link graph is computed over
  the whole build; entity ids are what the page *is*. `schemaOrg` is not
  editable but is realigned when the copy it describes changes.
- **Provenance.** A successful patch stamps `source: MANUAL`, which protects the
  edit from the next generation run.

### 3.8 Dynamic templates and content profiles *(Phase 18)*

Profiles and templates were compile-time constants, which made every new policy
a code change and a deploy — the wrong shape for something a tenant is meant to
pick and eventually buy. They are rows now: `ContentProfile` and `Template`,
each with a `key`, a `name`, a JSON `definition`, `isGlobal`, and an owner.

- `key` is separate from `id` because two tenants must both be able to have a
  "premium" profile, which a shared primary key would forbid.
- The owner column is **not nullable**. Postgres treats NULL as distinct from
  every other NULL, so `UNIQUE(key, userId)` over a nullable owner would accept
  two rows both claiming to be the global "default" — the exact duplicate the
  constraint exists to prevent. A `__global__` sentinel makes the constraint
  mean what it reads as.
- Every definition is parsed on the way out of the database against the same
  schemas the engine's types come from. A malformed row is an error naming that
  row and the field that failed — not skipped, because a skipped tenant override
  would silently restore the global policy the tenant had edited away from.
- **A template definition names a view that already exists in code and
  configures it. It cannot introduce one.** That boundary is the whole security
  story: a template carrying markup or component code from a row into a React
  tree would be remote code execution with a marketplace's branding on it. So
  selling a template means selling a configuration; a genuinely new look stays a
  code change. `.strict()` throughout.

### 3.9 Plugin architecture *(Phase 19)*

The engine needs to be extensible without becoming editable — different things,
and the difference decided the design.

- **Listeners observe; they do not transform.** A hook that took a value and
  returned a changed one would be a hole through everything the engine is:
  content passes three gates before publication, and a plugin able to alter
  content after those gates could publish anything. Payloads are flat,
  already-serialisable summaries — ids, counts, slugs — and they are frozen.
- **A failing plugin cannot fail a run.** Each listener is isolated: throws and
  rejections are caught, the next listener still runs, and `emit` never rejects.
  The thrown value is carried into the failure report rather than discarded.
- **A hang is a failure too, and the quieter one.** Listeners run under a
  deadline and are abandoned past it. Nothing can cancel arbitrary code; it can
  decline to wait.
- **Setup failures are survived.** A plugin whose `setup` throws is skipped and
  reported; the rest install. Listeners are tagged with their plugin's name
  automatically, so a plugin cannot register anonymously and then be
  unattributable when it misbehaves.

Emission points include the worker after a job's verdict is durable, and the
sync layer on both outcomes.

### 3.10 Gap analyst *(Phase 20)*

The engine's first *proactive* use of a model. Every previous call answered a
question the engine had already framed — write this page, revise that paragraph.
This one asks what the operator should do next.

- **The model is not asked to do arithmetic.** Which service-in-city pairs lack
  a page is a set difference over two lists: the engine computes it exactly, in
  memory, for free. The model advises which of it matters and why. `--gaps-only`
  answers the question without buying an opinion about it.
- **Two gates, because one is not enough.** A schema pins the shape, with a
  floor on every rationale — "good opportunity" should not pass. But a schema
  cannot tell an invented identifier from a real one: `svc-gartenpflege` is
  well-formed whether or not the project has such a service. So every
  recommendation is matched back against the catalogue that was put in front of
  the model, and anything unmatched is dropped **and reported** — an analyst
  quietly discarding a third of its own answer is one nobody should trust.
- **Read-only, structurally.** The agent module imports nothing that writes: no
  database client, no queue, no file handle. `staticforge analyze` loads a
  project, asks, and prints. An analyst that enqueued what it recommended would
  turn a suggestion into a purchase order.
- **Not cached, deliberately.** A cached analysis is stale advice wearing a
  fresh timestamp.

Verified read-only against the live database: 3 × 3 = 9 possible pages, 9
existing, 0 missing, with job and page counts unchanged afterwards.

### 3.11 Impact analysis and incremental publishing *(Phases 21–22)*

A run regenerated a project. That was fine while a project was a demo and wrong
the moment one was a customer: editing the description of one service in a
forty-city account re-authored two hundred pages, and paid for every one of
them, to change five.

**The question the engine could not answer.** The generator cannot know which
pages a change reached — it never saw the change. The sync layer saw it and does
not know which pages exist. `findAffectedPages` is where the two meet: given the
services and locations that moved, it returns the *existing* pages they reach.

- **A hand-edited page is never returned, under any argument.** The exclusion is
  an allowlist — `source IN (TEMPLATE, AI)` — rather than a `NOT MANUAL`. A
  `PageSource` added to the schema later would be *included* by a negative filter
  the moment it existed, and the first anyone would know is a customer's page
  being overwritten. An allowlist fails the other way: a new source is skipped
  until someone decides it is safe, which is a conversation rather than an
  incident.
- The filter is expressed in the query rather than applied to the result, so a
  MANUAL page is never in a list at all.
- Two empty id lists return without querying. Not an optimisation: an `OR` over
  two empty `IN` filters is exactly the shape a later refactor collapses into a
  filter that is dropped, at which point every page in the project is "affected"
  and an empty sync re-authors the account.
- The read is scoped to the owner as well as the project. With no row-level
  security behind it, the scope in this query *is* the tenant boundary.

**The queuing rule.** `planSyncRun` produces one of three outcomes, and the
middle one is the feature:

| Change | Decision | Why |
| --- | --- | --- |
| Only **updates** | One job scoped to the reached pages | Existing pages are stale and can be listed |
| **Added** or **removed** entities | Full run, empty scope | A scope cannot create a page; a removal leaves dangling links |
| Nothing regenerable reached | **Nothing is queued** | Every reached page is hand-edited, or the project was never generated |

The second row is not a performance nicety. A scoped run after a service was
added would queue a job for pages that do not exist, do nothing, report success,
and leave the new service unpublished with no error anywhere.

The third is the one worth being careful about, because "queued nothing" and
"queued everything" look identical from outside until the bill arrives. The
reason is returned and reported, so an operator can tell them apart.

**What a scope is allowed to narrow.** The AI authoring pass, and nothing else.
The run still builds, links and persists the whole project — the link graph is
computed across every page, the sitemap describes all of them, the file output is
cleared and rewritten whole, and `saveGeneratedPages` keeps its delete-stale
logic because the run still produces every slug. A run that wrote only its scope
would publish a site missing everything else. Authoring is the only step with a
marginal cost, so it is the only step worth narrowing.

**Why an out-of-scope page keeps stale content.** A page outside the scope is
restored from storage *without* the `sourceHash` check that governs resumption,
and that inversion is what makes a scope safe to pass. Resumption asks "is this
prose still current?", and for a stale page the honest answer is no. A scope
asserts something different — "this page is not this run's business" — and
applying the freshness test would answer that by overwriting a paid, authored
page with template assembly.

An empty scope authors nothing rather than being read as "the caller meant
everything"; a scope that fails to arrive costs a full run, which is expensive
and correct rather than cheap and silently wrong. The scope travels on
`GenerationJob.targetSlugs` and reaches the engine through the environment, not
`argv`, because a Windows spawn goes through a shell and a list of hundreds of
slugs is the worst case for that.

### 3.12 Static build triggers *(Phase 22)*

The engine writes pages to a database and to disk; a static host builds a site
from them at a moment of its own choosing. Between those two facts is a gap in
which a customer's site shows yesterday's content and nothing anywhere is wrong.

`afterQueueDrained` closes it. The event fires on the **transition** to idle,
never on an already-idle tick: a worker polling an empty queue every three
seconds would otherwise announce a drain twenty times a minute, and any listener
acting on it would act just as often. One sync that queues ten jobs is one
build, not ten.

`createStaticBuildTriggerPlugin` posts to `DEPLOY_WEBHOOK_URL`. It is
deliberately not named for a host — Vercel, Netlify, Cloudflare Pages and GitHub
all expose the same primitive, a URL that starts a build when something POSTs to
it.

- **A drain following only failures publishes nothing.** The content on disk is
  already what the host serves, so a build would spend money to change nothing
  and would make a failing queue look like a working one. A *partial* success
  still deploys: one page that built is one page worth publishing, and waiting
  for a clean sweep would let a single poisoned job freeze the site.
- **A cooperative shutdown after work is announced too**, with a distinct
  `reason`, because staying silent would leave pages generated, never announced,
  and therefore never published.
- **The hook URL is a credential.** Anyone holding one can trigger a production
  deploy, so only its origin is ever logged — never the path that carries the
  secret.
- **It is checked at construction**, so a typo is a line at boot rather than a
  silent non-deploy discovered by a customer. A hook that is present and
  unusable is reported and skipped: a worker refusing to boot over a deploy URL
  would turn a stale site into an idle queue. Absence is silent, because a local
  worker legitimately has none.

The SSRF guard these share now lives in `@staticforge/core`. Two copies of a
guard are two guards until the first time someone relaxes one, and the one that
gets relaxed is always the one whose caller looked safe.

### 3.13 SEO publishing and internal linking *(Phases 05–06)*

Sitemaps, robots, canonical metadata and structured data are generated as part
of the build rather than bolted on. An internal link graph is computed across
the whole page set with contextual linking rules, so pages reference their
siblings meaningfully instead of carrying a footer link dump.

### 3.14 Zero-JavaScript presentation layer

Two views are registered: a clean default and a dark, high-ticket "luxury
landing" design. Any page can be previewed through any template on a dedicated
static preview route, without touching the canonical site.

The luxury template ships **zero client-side JavaScript**. Entrance animations
that would conventionally require an animation library are CSS keyframes with
staggered delays, which kept the template a pure Server Component. Reduced
motion is honoured.

The template contains no hardcoded human-language text — section and question
markers are numerals, which read identically in any locale. Every visible string
comes from tenant data. This is not stylistic: it is what allows one template to
serve a German cleaning company and an English security firm without a fork.

An unregistered template identifier fails the build loudly rather than silently
falling back, so a typo surfaces in CI rather than as a wrong-looking page.

### 3.15 Test coverage

**886 tests across 45 files in six packages**, all under Vitest, all passing.

| Package | Tests | Coverage |
| --- | --- | --- |
| `ai` | 225 | Schema-constrained output, grounding and bypass attempts, cache integrity, retry, prompt versioning, money detection, gap analysis |
| `core` | 221 | CSV import, link graph, content hashing, block-path patching, plugin isolation, sync adapters, outbound-URL guard, build trigger, tenant paths, job budget |
| `database` | 181 | Repository read mapping, atomic write path, queue claim, impact analysis and the incremental queuing rule — entirely against a mocked Prisma client |
| `generator` | 168 | Page assembly, slug collision, eligibility, placeholder rejection, SEO output, AI merge, run scoping, output persistence |
| `schemas` | 41 | The shared data contracts themselves |
| `cli` | 50 | Pipeline stages, the standalone worker, and queue-drain detection |

The database suite never opens a connection — one test asserts that explicitly,
so the guarantee cannot rot silently. AI suites run against injected stubs, so
they cost nothing and need no API key.

Some suites go further than mocking. The incremental-queuing tests run against a
fake page table that *honours the query it is given* — an absent filter restricts
nothing, exactly as Postgres behaves — so deleting the `MANUAL` exclusion makes
the tests fail rather than pass quietly, which a fixed-list stub would not.

Two properties are worth noting for anyone assessing risk. First, tests were
repeatedly validated by *mutation* — deliberately breaking the code under test
to confirm the relevant tests fail, then reverting. A test that has never failed
has not been shown to work. Second, the generator assertions deliberately use
Node's strict assertion library rather than the framework's, because loose
equality would have weakened 60 existing comparisons during the runner
migration.

---

## 4. Data Model & Business Logic

### 4.1 Tenancy

```
Workspace  →  Project  →  Business
                       →  ContentTemplate
                       →  Service[]
                       →  Location[]
                       →  GeneratedPage[]
                       →  GenerationJob[]   (carries targetSlugs: the pages one run may re-author)

ContentProfile / Template  →  owned by a user, or global via a __global__ sentinel
```

**Workspace** is the tenant root — an agency or a customer account. **Project**
is one generated site. Every other row reaches a Workspace through a Project, so
a tenant's data is a single subtree that can be scoped, exported, or deleted as
one unit, and every relation cascades on delete.

The Workspace/Business split is deliberate and commercially relevant: an agency
is one Workspace but may operate many client sites, each with its own trading
identity, contact details, and address. A Business is who a single site speaks
for; a Workspace is who is billed.

### 4.2 Slug collision protection

Page URLs are built from a service slug and a city. Two combinations producing
the same URL would silently overwrite one page, duplicate a manifest row, and
create an ambiguous route — all without an error.

The engine refuses this at three layers:

1. **In memory**, before anything is written: duplicate slugs are detected
   during page assembly and reported together as a single validation failure
   naming each colliding business, service, and location.
2. **At import**, where duplicate entity identifiers are rejected.
3. **In the database**, where page slug is unique per project and each
   service-and-location pair may produce only one page.

The same guarantee is expressed independently in the code and in the schema, so
neither can drift into permitting what the other forbids.

### 4.3 Eligibility matrix

A business does not necessarily serve every city with every service. A business
may optionally declare which services and locations it covers; pages are then
generated from the eligible cross-product rather than the full one. An absent
declaration means unconstrained, an empty one means none, and any identifier
referencing an entity that does not exist fails validation loudly.

This is what prevents the classic programmatic-SEO failure of publishing a page
promising a service in a city the operator does not actually cover — a page that
converts into a complaint rather than a lead.

*Planning note:* the file pipeline supports this today. **The database read path
still returns every service and location on a project as eligible.** Exposing
per-business eligibility through the data model remains a known, scoped gap, and
the dashboard will need a UI for it.

### 4.4 Template resolution

Template selection resolves through a defined precedence — service-level, then
project-level, then a default — so an operator can style one high-value service
differently without touching the rest of the site. The resolved identifier is
recorded on every generated page and indexed in the manifest. Since Phase 18 the
registry can be injected from database rows rather than compiled in.

### 4.5 Validation as an architectural boundary

Data is validated at every point it crosses into the system: CSV rows at import,
input at load, sync payloads at the adapter boundary, each assembled page before
it is written, model output before it is merged, editor patches before they are
applied, profile and template rows on the way out of the database, merged pages
before they are persisted, and the manifest when the web app reads it.

Notably, the database adapter deliberately does **not** validate. It reshapes
rows into the input contract and hands them to the same validator the file path
uses, so validation stays in one place with one set of error messages rather
than forking into two implementations that drift.

---

## 5. Immediate Technical Next Steps

Ordered by dependency.

**1. Authentication and tenant scoping.** Users, workspace membership, and roles.
Every query must be scoped to the caller's workspace, and Postgres row-level
security should back that up rather than relying on application code alone. The
subtree data model makes this enforceable, but **nothing enforces it yet — there
is no authentication layer at all today.** This is now the largest open risk in
the project: the dashboard and the headless API write tenant data with no caller
identity behind them.

**2. Prove the AI path against a live model.** `ANTHROPIC_API_KEY` is not
configured in this environment. Every AI suite runs against injected doubles, so
the prompts and tool schemas — including Phase 20's gap-analysis contract — have
never been exercised against a real provider round-trip. This is cheap to close
and blocks confidence in everything paid.

**3. Deployment and CI/CD.** Vercel for the Next.js application, with the
existing `verify` gate wired into CI, plus a host for the standalone worker —
which now has to be deployed as its own long-running process rather than living
inside the web tier.

**4. Billing.** Not started. The natural metering dimensions the data model
already supports are projects per workspace, pages per project, and AI-authored
pages — the last being the only line with a real marginal cost. Job rows already
carry the counts a meter would read.

**5. Extract the presentation layer.** `packages/templates` is still a
`.gitkeep`; templates remain route-local in `apps/web`. Phase 18 made template
*configuration* sellable; extracting the views is what would make the package
mean something.

### Known gaps, stated plainly

- **No authentication, no authorization, no tenant scoping enforcement, no RLS.**
- **No `ANTHROPIC_API_KEY` configured**; the AI path is covered only by injected
  doubles and has no live integration test.
- **`packages/templates` is an empty placeholder**; templates remain route-local.
- **Per-business eligibility is not exposed through the database read path** —
  the DB path treats every service and location on a project as eligible.
- **No CI pipeline and no deployment**; `verify` is run by hand, and the worker
  has no host.
- **Billing is not started.**
- Businesses and content templates cannot be imported from CSV, only services
  and locations.
- `refresh-page` does not yet pass the realigned `schemaOrg` through
  `saveRefreshedPage`, so that path still carries the drift Phases 16–17 fixed
  elsewhere.
