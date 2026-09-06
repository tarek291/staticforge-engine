# StaticForge — Architecture & Capability Briefing

**Status:** Engine complete and running against a live Supabase PostgreSQL
instance. Generation, persistence, queueing, sync, headless editing and
incremental publishing are all verified end to end, and an RBAC organization
layer now gates every write and a shared token bucket keeps several workers
inside one tenant's provider allowance. Not yet deployed. Machine callers now
authenticate with hashed per-organization API keys (Phase 25), and **every**
`apps/web` API route now verifies either a key or a Supabase session (Phases
28–29) — the local-operator constant is gone from the web server entirely. Paid
paths sit behind metered quotas (Phase 26).
**Audience:** Product and platform planning for the SaaS layer.
**Last updated:** 2026-08-28 (reflects phases 01–29)

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
headless editing API, the incremental publishing path and the distributed rate
limiter are built, tested, and exercised against the real database. A change now re-authors only the pages it
actually reached, and a drained queue triggers the static host's build.
**What remains is the commercial surface: a sign-in page, deployment, and
billing.** Authorization and tenant scoping are built as of Phase 23; a machine
caller can prove which organization it is as of Phase 25; every web API route
enforces both as of Phase 29; and as of Phase 30 a person can hold a session in
an `HttpOnly` cookie that the same guard accepts, header first. Phase 31 was a
remediation of an adversarial audit rather than a feature — the role checks
moved out of the routes and *into* the data layer, the quota gate became atomic
by holding what it admits, the billing ledger stopped cascading away with its
tenant, and the worker stopped dying on a promise nobody awaited.

The code has since been audited twice — an internal adversarial pass and an
external review — producing thirteen findings, all fixed and merged. The second
pass is the one worth noting for anyone assessing risk: it found that the first
pass's own headline fix had been applied to one of the two paths that needed it.

What is missing is the `/login` page itself and the Supabase credentials behind
it: the route works, the form does not exist, and nobody has actually signed
in.

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

### 3.13 Organizations and role-based access *(Phase 23)*

Until this phase every query scoped on a `userId` column that defaulted to the
string `"local-operator"`. That was honest while there was one operator; it is
not a tenancy model, and **nothing decided whether a caller was allowed to do
what it had just done**.

**Why `Organization` sits beside `Workspace` rather than replacing it.**
`Workspace` was the tenant root and had no concept of a person. An organization
is where people and their roles live, so it becomes the root authorisation is
decided against, and `Workspace` stays the grouping level it always was. The two
are deliberately not merged: renaming a populated model is a destructive
migration and deserves its own change, reviewed on its own terms, rather than
arriving as a side effect of adding roles.

**Denormalisation that cannot drift.** `Project.organizationId` is denormalised
from the workspace, for the reason `GenerationJob.userId` already is: every read
of the table is scoped, and a scope that needs a join is a scope somebody
eventually writes without. Unlike most denormalisation, this one is enforced —
the foreign key is *composite*, pointing at `Workspace(id, organizationId)`, so
Postgres refuses a project whose organization disagrees with its workspace's.
The invariant is in the schema rather than in a comment asking people to
remember it.

**Roles are a rank, not a permission matrix.** `OWNER > EDITOR > VIEWER`. A
matrix invites per-action exceptions and the first exception is the one nobody
reviews. Where an action needs more than "may write" it *requires OWNER* rather
than growing a flag bolted onto EDITOR.

| Capability | Minimum role | Why that level |
| --- | --- | --- |
| `project:read` | VIEWER | |
| `project:write` (edit, sync, generate) | EDITOR | A viewer who could trigger a paid AI run makes "read only" meaningless in the one dimension with a bill attached |
| `project:delete` | OWNER | The damage outlives the person doing it |
| `member:manage` | OWNER | An EDITOR who can grant EDITOR has OWNER in every way that matters |

**Why the gate throws.** A boolean return makes the safe and unsafe paths look
identical at the call site: `await canWrite(...)` compiles, runs the query,
discards the answer and writes anyway. Throwing means forgetting to handle the
refusal fails loudly — the failure mode points the right way.

**Why the two refusals are worded differently.** A *non-member* is told only
`No access to organization "X"`, in language identical to what a non-existent
organization produces. Distinguishing the two would turn the gate into a way to
enumerate tenants: try an id, and a different message means it is real. A
*member with too weak a role* is told their role and what the action needs —
which is not a leak, since they already know both, and is the difference between
a self-service fix and a support thread. `AccessDeniedError` carries `heldRole`,
so a route answers `404` for the first case and `403` for the second without
parsing prose.

**Everything unrecognised is a denial.** `undefined` means "not a member" and is
handled inside the helper rather than pushed out to every caller — the caller
that forgets is the one that fails open. A stored role this build does not know
resolves to no access rather than being compared numerically. Writing that
recogniser surfaced a real hole: `"constructor" in ORG_ROLE_RANK` is `true`,
because `in` walks the prototype chain, so every inherited key was accepted as a
role name. Nothing downstream compared successfully, so it happened to fail
closed — but a recogniser that is only accidentally right is one the next
refactor breaks.

**Enforcement, not merely a helper.** `syncProject` and `enqueueJob` both gate
before doing anything, and the placement is load-bearing: the sync check runs
*before* the impact query, so a refused caller never learns which pages exist —
an authorisation check that happens after the read it protects has already
disclosed the thing it was protecting. A dry run is refused too, because writing
nothing is not the same as revealing nothing. All three callers map the refusal
to 403 or 404, and the webhook route now treats its shared secret as
authenticating a *caller* rather than as deciding what that caller may do, which
is how an integration token otherwise becomes an administrator.

### 3.14 The audit trail *(Phase 23)*

A log is trimmed, rotated, and readable by whoever has shell access on the box
that produced it. `AuditLog` is a table a customer can be shown, scoped to their
own organization, when they ask who changed a page or what a sync did.

- **Nothing cascades into it.** `resourceId` is a plain string rather than a
  relation, so deleting a project does not delete the record of the project
  being deleted. A trail that disappears with the thing it describes cannot
  answer the question it exists for.
- **There is no unscoped read in the module.** The first convenience function
  returning "all recent activity" is the one that ends up behind a dashboard
  route, and an audit trail that leaks across tenants is worse than none — it is
  a breach recorded in the product sold as the safeguard.
- **Failures are recorded, not only successes.** "Nothing ran" and "it ran and
  failed" are different answers, and only one means somebody should read a log.
- **Syncs that changed nothing are recorded by default.** A sync that found
  nothing to do is still someone's credential reaching this system; volume is a
  retention-policy problem rather than a reason to record less.
- `details` is the one column in this schema with no shape contract, on purpose:
  a trail whose fields are pinned stops recording the ones added after it, which
  are exactly the ones an investigation needs.

`createDatabaseAuditLoggerPlugin` is handed its writer at construction. The
plugin contract gives a plugin no database client, so what it may reach is
decided by the composition root in one place a reviewer can see.

**Stated plainly: the trail is best-effort.** It is written after the action, by
a listener the bus is free to abandon, so a database unreachable for the seconds
after a job finishes loses that entry. Making it guaranteed would mean writing
it inside the same transaction as the action, which the plugin architecture
cannot do and should not — a plugin able to fail a run is a plugin able to abort
a paid, hour-long build, and installing one would then be a risk nobody should
take. What *is* guaranteed is that a failed write is loud: it throws, and the
bus records it against the plugin by name in the log an operator is already
reading.

**This is authorization, not authentication.** There is no user table, no
session and no login, so `userId` is supplied by the caller rather than proved.
Anyone able to set it is any user. This phase decides what a user *may* do; it
does not establish who they are, and the two must not be confused when reading
the gaps below.

### 3.15 Distributed rate limiting *(Phase 24)*

Rate limiting held in process memory works exactly until there is a second
process, and Phase 14 made the worker a thing you are meant to run more than one
of. Two workers each politely holding themselves to the provider's limit will
together exceed it, every time, and the failure arrives as 429s in the middle of
a paid run rather than as anything anyone designed.

The limit belongs to the **tenant and the provider**, not to a process, so the
state has to live where every process can see it. Postgres rather than Redis: it
already holds the queue those processes coordinate through, and a second thing
to run and secure is a poor trade for a row updated a few times a minute.

**Why the decision is one statement.** The obvious implementation reads the row,
works out whether there is room, and writes the new count back — and between
that read and that write is the entire bug. Both workers read the same balance,
both decide there is room, both spend it, and nothing in the code looks wrong.

So the grant is a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE` with the
arithmetic inside it. Postgres takes a row lock on the conflict and re-evaluates
both the `SET` expressions and the `WHERE` against the current tuple, so a
second caller arriving mid-flight sees the first one's deduction. The database
decides, not the gap between two queries.

**A denial writes nothing**, including the clock. The time a refused caller
spends waiting is time the bucket is still filling; advancing `lastRefillAt` on
a denial would charge a caller for its own wait and, under a busy queue, could
hold a bucket permanently empty.

**The fractional remainder is carried in the timestamp.** Tokens are stored as
an integer, so a refill of 0.4 tokens has nowhere to go. Discarding it and
advancing the clock to `NOW()` loses that fraction on every call — a caller
polling ten times a second at one token per second would earn nothing, forever,
while every dashboard insists it is being topped up. So the clock advances by
exactly the time the *whole* tokens represent and the remainder stays owed. The
only case where time is deliberately discarded is a bucket already at capacity,
which is what a bucket means.

**A request larger than the whole capacity** is refused before the database is
touched and reported as *unsatisfiable* rather than as a long wait. Separating
the two is what lets the AI layer fail immediately on a misconfiguration instead
of burning a two-minute budget to reach the same conclusion. A refill rate of
zero — a legitimate hard-quota policy — is handled the same way once the bucket
is empty: exhausted, not busy.

**Where the gate sits.** At `callProvider`, the one choke point every provider
call passes through, fresh authoring and refresh alike. A limiter with two entry
points is a limiter with one entry point somebody forgot. It is asked *before*
the request is built, because asking afterwards would debit the bucket for a
call already made and paid for — an accounting record rather than a limiter. A
page served from the cache costs the bucket nothing, since the gate is at the
call and not at the entry point.

The limiter reaches `@staticforge/ai` as a bound function taking a token count
and nothing else. It cannot choose its bucket or raise its capacity — a
component able to widen its own limit is not limited — and it carries no
database client, which is what keeps the AI package free of Prisma. The
composition root in the generator CLI is the only place that knows both the
project id and the database.

**Waiting is bounded three ways:** a per-pause ceiling, so a huge computed wait
cannot starve a job-lease renewal; a floor, so a limiter reporting zero cannot
spin the loop into a denial of service against our own Postgres; and a total
budget, so a misconfigured bucket cannot turn a run into a process that is
alive, holding a lease, and never finishing — the worst of the three outcomes,
because it looks like progress. Every pause is announced, because an operator
watching a silent process decides it has hung and kills it, throwing away pages
already paid for.

**The duplication, stated plainly.** The refill formula exists twice: in the SQL,
which is authoritative and atomic, and in `planTokenConsumption`, which computes
how long a denied caller should sleep. Doing the grant in TypeScript would
reintroduce the race this exists to close; computing the wait in SQL would leave
the arithmetic with no test that runs without a database. The two are kept
literally parallel and both are exercised by the live verification.

**What the mocks could not have caught.** Two real bugs were found only by
running it against Postgres: a `Prisma.sql` built from an already-joined string
carries no placeholders, so every parameter silently failed to bind; and a
refill rate of zero divided by zero in both implementations. Neither is
observable through a mocked client, which is why the concurrency guarantee is
verified against the live database and reported with the change rather than
asserted in a suite that never opens a connection.

### 3.16 Organizational API keys *(Phase 25)*

The sync webhook trusted a single `STATICFORGE_WEBHOOK_SECRET`. That value
authenticated the *caller* and said nothing about which tenant they were, so
anyone holding it could sync any project the operator owned. The endpoint's own
comment named this as the reason it could never be handed to a customer.

Keys replace it, and the old path was **deleted** rather than left beside the
new one. Two ways in means the weaker one defines the security, and a
dead-but-exported shared-secret verifier is a working alternative sitting in the
public API of `@staticforge/core`, waiting for someone to wire it back in.

**Only a hash is stored.** `generateApiKey` returns the plaintext, nothing
persists it, and no other function can produce it. A database dump, a log
aggregator, a support engineer with `SELECT`, or a backup left in a bucket
yields a list of values that cannot be replayed. The cost — a lost key is
replaced, not recovered — is stated by the command at the moment it matters.

**Why SHA-256 and not bcrypt.** Slow hashes exist to make *low-entropy* secrets
expensive to guess. A key here is 256 bits of `randomBytes`, so there is nothing
to guess at any work factor: an attacker who cannot find the key cannot
brute-force it, and one who has it does not need to.

What a slow, salted hash would actually cost is the ability to *look one up*.
Verification would become a scan of every key row with a comparison each — O(n)
per request, growing as a customer adds keys — where a fast hash over a
high-entropy secret is a single indexed lookup. The unique constraint on
`keyHash` is what makes that lookup, and it also makes a collision impossible
rather than improbable.

**The key does not carry the organization it grants.** A credential containing
its own identity leaks that identity to anyone who sees it in a log line, a bug
report or a screenshot — and, worse, invites code that reads the tenant *out of
the key* rather than out of the row the key resolves to. The first such reader
turns a forged prefix into a tenant crossing. So `sf_org_` names the *kind* of
principal, not a particular one, and which organization a key belongs to is
discoverable only by presenting it. The prefix is fixed because a fixed prefix
is what lets secret scanners recognise one of these in a public repository
before somebody else does.

**A key is a member of its organization**, and that is the decision the rest
follows from. A verified key resolves to an organization, and then something has
to decide whether it may do what it is asking. The alternative to reusing the
role gate is a second permission path just for keys — and a second path is how
one of them ends up missing a check the other has.

So a key gets a principal id (`apikey:<id>`) and a membership row written in the
same transaction as the key itself: either both exist or neither does, because a
key with no membership would authenticate and then be refused everything, which
reads as a permissions bug rather than as the half-finished write it is. Every
existing `requireCapability` call works on it unchanged.

It defaults to **EDITOR** — enough to sync and to queue generation, not enough
to delete a project or manage members, and therefore not enough to mint another
key. A credential that can create its own successors survives its own
revocation.

**The endpoint asks three questions and the order is load-bearing:**

1. *Who is this?* An unresolvable key stops before anything reads a project. An
   endpoint that touched a project first would give an unauthenticated caller a
   way to measure which ids exist.
2. *Is the project theirs?* A project in another organization answers exactly as
   a project that is not there. Two different answers would turn a valid key for
   one tenant into a probe for every other tenant's project ids.
3. *May they do this?* `requireCapability`, inside the operation — so a key
   issued as a VIEWER authenticates and is still refused the write.

Absent, malformed, unknown and revoked are four things internally and one answer
to a caller. Three extra messages are three bits of information handed to
whoever is guessing.

**Revocation stamps a time rather than deleting the row.** The audit trail still
needs to say which key did something last month and when it was stopped; a
deleted row takes that answer with it. It also deletes the membership, so the
principal loses access by two independent mechanisms rather than one.

The authorisation rule lives in `@staticforge/database` as
`authorizeProjectAccess`, not in the route. A decision written inside an HTTP
handler can only be tested by standing up an HTTP handler, and a rule that is
hard to test gets one test instead of twelve. The route turns a verdict into a
status code and does nothing else.

**This is machine authentication, not human authentication.** An organization
can now prove it holds a credential. There is still no user table, no session
and no login, so on every path other than this webhook a human `userId` is
asserted by the caller rather than proved — and the two must not be confused
when reading the gaps below.

### 3.17 Metering and quotas *(Phase 26)*

Usage is counted **after** an operation finishes; quotas are checked **before**
one starts. Those are opposite guarantees on purpose.

**Metering has to be retrospective.** A run's real page count is not knowable
when it is queued — the grid is computed after the input loads, the AI pass
skips cached and out-of-scope pages, and a run can fail half way. Charging at
enqueue time would bill for work that was never done, which is the one billing
error a customer never forgives. So consumption is recorded from lifecycle
events once a verdict is durable, and the job row's own `completedCount` is read
back rather than the grid estimated: the two differ for every run worth metering.

**The quota has to be prospective.** A quota discovered when the work finishes
is an invoice, not a ceiling — the pages are already written and already paid
for. `requireQuota` therefore throws, in front of `enqueueJob` and
`syncProject`, before either writes anything.

**What the asymmetry costs.** The number the gate reads is a lower bound. Work
already queued has not been metered yet, and a meter write lost to an
unreachable database is never metered at all, so a tenant can exceed its limit
by roughly the volume of work in flight when it crossed the line.

The gate was also not atomic: two callers arriving together both read the same
total and both pass, exactly as a read-then-write token bucket would.
**Phase 31 closed this for `enqueueJob`, and the external audit found it still
open for `syncProject`** — see 3.21 and 3.22. The reasoning that follows is kept
because the *asymmetry* it describes is still true, and is what made the fix
non-obvious twice over: a lock alone does not help a total nothing has written
to, and a lock outside a transaction is not a lock at all. That was
refused in Phase 24 and is accepted here, and the difference is what is being
protected. The rate limiter guards someone else's hard ceiling, where
overshooting produces 429s in the middle of a paid run, so it is a single atomic
statement. A quota guards a commercial agreement, where overshooting produces a
conversation. Paying for atomicity twice would be paying for the wrong thing.

**Ordering inside each gate is load-bearing.** Permission is checked before
quota, so a caller who may not touch a project learns that rather than learning
how much allowance the organization has left. The quota is checked before the
impact query, so a tenant out of allowance cannot keep reading which of its
pages would change.

**The sync gate covers exactly the path the meter covers.** A dry run emits no
lifecycle event and never becomes a usage row, so it is not gated — refusing one
would charge a tenant nothing and cost it the ability to plan, which is what
somebody near their limit most needs to do. Keeping check and charge on the same
paths is what stops the two drifting into a system that bills for what it did
not gate, or the reverse.

**Three fail-open shapes closed, one kept.** An empty `SUM` is `NULL` in SQL and
`null > limit` allows everything — coerced to zero. A `resetDate` in the future
counts no usage at all, which is a quota that silently permits everything —
refused, with a message saying it will not clear on its own. A negative limit is
refused the same way. The one kept is deliberate: no quota row means unlimited,
because quotas are opt-in and a default of zero would have stopped every
existing tenant the moment the table shipped.

**Usage is append-only.** Nothing updates a row; a correction is another row,
possibly negative. A usage table somebody can edit is one a customer is right to
distrust, and a running total is the same race the token bucket needed raw SQL
to avoid — where a `SUM` over an append-only table needs no lock and can be
recomputed from the records when it is doubted.

The meter charges only for work that happened: a failed job meters nothing, a
run that authored no pages meters nothing, and a run with no tenant meters
nothing rather than putting the charge on somebody else's invoice.

**Changed in Phase 31:** the first two now report zero *against the hold taken at
admission*, which is a refund rather than a silence. Once the gate reserves what
it admits, staying quiet would leave the estimate charged. Like the
audit logger it cannot promise delivery, and it points the safe way for the same
reason — an unmetered operation under-bills, while a meter able to fail a run
could abort an hour-long build.

### 3.18 Unified authentication on the dashboard API *(Phase 28)*

Phase 27 built a session guard and nothing called it. This calls it, on one
route, alongside the machine keys from Phase 25 — through one door.

**One door, not two.** A second endpoint for machines would be a second place
every authorisation check has to be repeated, and the one that gets forgotten is
never the one anybody is looking at. Phase 25 already made an API key a member of
its organization so that a key and a person could be asked the same question;
`authenticateRequest` is where that pays off.

The credential's *shape* picks the verifier — a `sf_org_…` prefix goes to the
key path, anything else to the session path — and both fail identically. A
caller cannot learn from a 401 whether it presented a malformed key, a real but
revoked one, an expired JWT, or nothing at all. That is a routing decision, not
an authentication one, and keeping it from becoming an oracle is the reason the
two branches share a message.

**Scoping goes through membership, not through the creator column.**
`Project.userId` records who *created* a project; `OrganizationMember` records
who may reach it, and the two diverge the moment a second person joins an
organization. Listing by the creator would show an owner their own projects and
hide their colleagues' — which reads as data loss rather than as a permissions
model. There is no branch on the kind of principal in that query, and the
absence is deliberate: a branch is where a person and a key would eventually be
scoped differently.

**The route reads and never writes.** A caller who verifies but has never been
provisioned sees an empty list rather than having a row written for them.
Just-in-time provisioning is a reasonable feature and a terrible side effect of
a `GET`: a read that writes cannot be retried, cached, or reasoned about.

**Configuration is validated, and lazily.** A Zod schema rather than
`process.env.X ?? throw`, because a *wrong* value fails differently from a
missing one and only the first is obvious — a `SUPABASE_URL` holding the
database connection string satisfies "is defined" and works nowhere, and an
anon key still carrying its `.env.example` placeholder rejects every user while
looking configured. Writing the test for that found the schema too weak:
`z.string().url()` accepts `postgres://…`, so the one wrong value an operator is
genuinely likely to paste passed it. The scheme is checked now.

Lazily, because the session verifier is built only if a session token is what
actually arrives. A deployment with no Supabase project can still serve
integrations holding API keys, and building it eagerly would turn one
misconfiguration into two outages. A configuration failure propagates as itself
and becomes a `500`; an unverifiable token is a `401`. Collapsing the two would
send an operator looking at their token while the server sits misconfigured —
and the `500` body says nothing useful to a stranger, because which environment
variables a deployment is missing belongs in the log where the operator is, not
in the response where an unauthenticated caller is.

**A cross-phase regression, found only by running it.** Phase 27's foreign key
broke Phase 25's key minting: `generateApiKey` writes an `OrganizationMember`
for an `apikey:…` principal, and there was no `User` row for it to point at, so
every mint failed on the constraint. No mocked test could have caught it — a
mock enforces no constraints — and the first live call hit it. The machine
principal is now provisioned in the same transaction, with the ordering pinned
by a test.

**What this phase is not.** Auth everywhere. The jobs route, the block-patch
route, `projects/[id]`, the dashboard pages and the whole CLI still pass the
`LOCAL_OPERATOR_ID` constant. And the session branch has never run against a
real Supabase project — `SUPABASE_URL` and `SUPABASE_ANON_KEY` are not
configured here, so the live verification exercised the API-key branch only.

### 3.19 Full API lockdown *(Phase 29)*

Phase 28 authenticated one route by hand. Repeating that by hand on the others
is how the fifth one ends up missing a check nobody notices — so the logic
became a helper, and a route is three lines of using it.

**Why the guards return a result instead of throwing.** A thrown guard is
forgotten silently: a route with no `try` still compiles, still runs, and
answers `500` instead of `401` — safe by luck rather than by design. The helpers
return a discriminated union, so reading `auth.principal` without first
narrowing on `auth.ok` is a **compile error**. The type system enforces the
check that a `catch` block only documents.

The refusal arrives as a ready `Response` rather than a status code, so two
routes cannot disagree about what a `401` body looks like.

```ts
const auth = await requireApiAuth(request, "jobs");
if (!auth.ok) return auth.response;

const allowed = await requireApiProjectCapability(id, auth.principal, "project:write");
if (!allowed.ok) return allowed.response;
```

**Two gates, in an order that is load-bearing.** Authentication first, so an
unidentified caller never reaches a project lookup — a route that read first
would let an anonymous request measure which project ids exist. Then the
capability: `project:write` is EDITOR or above, so a VIEWER authenticates and is
still refused with a `403` naming their role rather than a `401` that would send
them to re-authenticate a credential which is working fine. A non-member gets
`404`, identical to a project that does not exist.

**`LOCAL_OPERATOR_ID` is gone from `apps/web`.** Every API route authenticates:
the projects list, both jobs routes, the block patch, and the sync webhook.
`robots.txt` and `sitemap.xml` stay open because a crawler cannot present a
credential and neither reads tenant data. The only surviving mentions of the
constant are prose explaining what was removed.

**A coverage test makes omission impossible.** Every individual gate is tested
where it lives; what no unit test can see is the route somebody adds next month
that forgets to call one — it compiles, it works, and it is unauthenticated. So
a test walks `apps/web/app/**/route.ts` and fails if any route lacks an
authentication call or uses the constant. Public routes are listed explicitly,
which makes opening one a visible edit in a file about authentication rather
than an absence nobody notices.

It is a coarse check by nature — it reads source rather than behaviour, and a
route could satisfy it while using the guard wrongly. It is not trying to prove
correctness. It is trying to make *omission* impossible, and omission is the
failure that actually happens.

**The two dashboard pages stopped reading tenant data.** A server component
receives no `Authorization` header and there is no session cookie yet, so they
cannot authenticate at all — and the honest response to that is to stop
pretending, not to keep an unauthenticated read because it was convenient. They
render a shell pointing at the authenticated API. `ControlPanel`,
`RefreshButton` and the `STATICFORGE_DASHBOARD` guard were deleted with them:
the flag existed because those routes shipped no authentication, and leaving an
unauthenticated control panel in the tree is the same hazard as the shared-secret
verifier removed in Phase 25 — a working alternative path waiting to be wired
back in.

That is a real loss of function, and the control buttons were the more dangerous
half: they queued paid AI runs from a page that could not say who was clicking.

**The lockdown exposed the deeper inconsistency.** With authentication working, a
verified EDITOR passed every gate and then got `404` — because the tenant read
helpers still scoped on `Project.userId`, the column that records who *created*
a project. Membership records who may reach it, and the two diverge the moment a
second principal is given access. `projectVisibleTo` in `scope.ts` expresses the
rule once and `repository.ts` and `tenant.ts` use it, with one deliberate
exception documented in its own test: a `GenerationJob` carries its own
denormalised `userId` and is scoped on that column directly.

### 3.20 Browser sessions and the hybrid door *(Phase 30)*

Phase 29 closed the API and left people with no way to hold a credential. This
is the other half: `@supabase/ssr` keeps the tokens in `HttpOnly` cookies, a
login route exchanges an email and password for them, middleware refreshes them
on every request, and the existing guard accepts either a header or a cookie.

**No API route changed.** That was the requirement, and it is what the shape
buys: `authenticateRequest` gained an optional cookie resolver, so the CLI keeps
sending a bearer key, a dashboard sends a cookie, and both arrive at the same
principal through the same door.

**The header always wins, and the ordering is the security property.** A browser
attaches its cookie to every request to this origin — including ones an
integration makes through it — so checking the cookie first would answer a
machine caller as whoever happened to be logged in on that machine. A bad header
is not rescued by a good cookie either: the caller chose a credential and it was
refused, and falling back would mean a revoked key silently keeps working for
anyone signed in.

That ordering lives in `@staticforge/database`, not in the route. Reading
cookies needs Next's request-scoped store, so the *mechanics* have to live in
the app — but the part that can be got wrong is the sequence, and that belongs
where it can be tested.

**`getUser()` everywhere, never `getSession()`.** The latter decodes the cookie
the client sent and verifies nothing, so on a server it answers with whatever
the client wrote. Only `getUser()` revalidates against the auth server. A page
guard built on a decode is a page guard an attacker writes their own cookie for.

**The middleware threads its response object through** rather than building a
fresh one at the end. `createServerClient` writes rotated cookies through
`setAll`, and those writes have to land on the response actually returned — the
obvious tidy-up drops them, and the symptom is users being logged out at random
intervals with nothing in any log.

It deliberately does not run on `/api`. Those routes authenticate themselves and
answer `401`; a page guard in front of them would turn an integration's clear
refusal into a `302` toward an HTML form, which is the least actionable thing a
machine client can receive.

The `next=` parameter carries a path and never a URL. A redirect target a caller
controls is an open redirect, and "sign in here, then we will send you on" is a
phishing flow indistinguishable from a working one. `//evil.com` and
`/\evil.com` both look like paths and are both refused.

**The middleware imports `@staticforge/core/auth-paths`, a subpath, not the
package root.** Middleware runs on the Edge runtime and the root barrel
re-exports modules reaching for `node:crypto` — the API-key hashing among them —
which the Edge runtime cannot load. The build failed on exactly that.

The login route returns no token. The SSR client's adapter writes `HttpOnly`
cookies, so a cross-site script cannot read the session; returning the access
token in JSON, the obvious shape for an API, would hand that protection back for
one client's convenience. A wrong password and an unknown address get the same
`401`, because two answers make this a way to enumerate a customer's users.

> **Still missing: the `/login` page itself.** The middleware redirects to it and
> it does not exist, so the redirect lands on a 404. And `SUPABASE_URL` /
> `SUPABASE_ANON_KEY` are unconfigured, so every session path has been exercised
> against injected doubles and against its failure path only.

---

### 3.21 Red Team remediation *(Phase 31)*

An adversarial audit of phases 01–29 — concurrency, authorization, worker
stability, data integrity — with no code written during it. Five findings.
Three of them turned out to be the same shape: **the check existed, one layer
too far out.**

#### RBAC moved into the data layer

Phase 29 gated every route and left the functions behind them open, so the
guarantee was "every caller remembered". That holds until somebody adds route
twelve, a CLI command, a background job or a script — and the evidence that they
forgot is a customer's VIEWER holding an OWNER credential.

`generateApiKey`, `revokeApiKey`, `listApiKeys`, `listAuditEvents` and
`saveRefreshedPage` now check on their first line. The acting identity is a
**required** parameter, not an optional one: an optional identity is one a
caller omits, and the caller that omits it is the route somebody adds in a
hurry. Making it required turned every call site into a compile error, which is
how all of them were found.

A key needs `member:manage` because a key **is** a member — Phase 25 made it one
deliberately. So minting one is adding a member, and an EDITOR who could mint an
OWNER key would be an OWNER by a two-step route no permission check anywhere
would notice.

**`setQuota` is guarded differently, and this is the important part.** Gating it
with `member:manage` — the strictest thing a tenant role can be asked for —
would have been *worse than leaving it open*. OWNER holds that capability, every
organization has an OWNER, and the OWNER is the person the quota bills. The gate
would have let a customer raise their own spending cap while reading as a
security improvement.

So there is a boundary above every tenant. `requirePlatformOperator` asks a
question no tenant role can answer, and API-key principals are excluded
explicitly: a key that satisfied it would be a tenant credential holding
platform authority, issued by the very function the boundary guards.

#### The billing ledger stopped cascading

`UsageRecord` had `onDelete: Cascade` on `Organization`, so deleting an account
erased every record of what it had consumed — and the last month of an account
that churns is exactly the month nobody has invoiced yet. A `DELETE` on one
table quietly emptied the ledger of another.

`organizationId` is now a plain `String`, the shape `AuditLog` already used and
for the same reason: **a financial record must outlive its subject.** Nothing
enforces the id still resolves, which is correct — an invoice for a closed
account has to remain explicable after the account is gone.

#### Quotas are held, not merely checked

The Phase 26 gate was a TOCTOU, and the fix is not the obvious one.

Usage is metered *retrospectively*, so between a check passing and the work
finishing there was nothing for any other caller to see. `SELECT ... FOR UPDATE`
**alone does not fix that**: ten serialised callers still read a total nothing
has written to, and all ten still pass. Serialising the checks changes the order
they happen in, not their answer.

So the gate now *holds* what it admits. `reserveQuota` locks the quota row,
sums usage in a **separate statement** — so READ COMMITTED gives it a fresh
snapshot including the hold the caller ahead just committed — and writes a
`UsageRecord` for its estimate. Folding the sum into the locking query as a CTE
would look tidier and fix nothing, which is why a test asserts the two
statements and their order.

`enqueueJob` does this inside the same transaction as the job row: a hold
without its job charges for a run that does not exist, a job without its hold is
the original race, so neither commits alone. The amount lands on
`GenerationJob.reservedUnits`, because the halves happen in different processes
— the API admits, a worker completes — and the row is the only place the number
can wait.

The meter therefore reports the truth and the writer stores **`actual - held`**.
`billing-meter` no longer returns early on a failed or empty run: it reports
zero, which *is* the refund. Returning early would leave the estimate charged —
the exact over-billing that plugin exists to avoid.

Verified against live Postgres, 40 concurrent transactions on separate
connections against a limit of 10:

| Gate | Admitted |
| --- | --- |
| Phase 26 read-only check | **40 of 40** |
| Phase 31 reserving gate | **10 of 40** |

#### The worker survives a promise nobody awaited

Node exits on an unhandled rejection, and the plugin bus deliberately abandons
listeners that overrun its deadline. So one misconfigured deploy webhook took
down a worker half way through a paid build — then took down the worker that
reclaimed the job, because they run the same plugin. A fleet-wide outage from a
bad URL, with nothing in any log explaining it.

Surviving is right *here* and not in general: nothing awaits a detached promise,
so nothing downstream depends on it, and every promise the job loop depends on
is awaited. But absorbing without limit turns a crash into an invisible
haemorrhage, so twenty in a minute exits — loudly, and saying the job is
resumable. The point is to convert a process-ending accident into a
process-ending **decision**. `uncaughtException` is deliberately not caught: the
state after one is genuinely unknown.

#### Login is rate limited, on two keys

Not on the email — that would let anyone lock a named user out of their own
account by failing on their behalf, a denial of service handed out to whoever
asked for it.

On the caller's address **and** a global key. The global one is the half that
holds: `X-Forwarded-For` is forgeable, so a per-address limiter alone is evaded
by rotating the header, and a limiter keyed on a value the caller chooses binds
the honest users and nobody else. The address is read from the **rightmost**
entry — the one appended by the hop nearest this server — rather than the
leftmost that every tutorial reaches for.

The global bucket is checked first, so a flood cannot spend through other
people's buckets on the way past. It fails **open** on a database error: a blip
would otherwise lock every customer out of their own dashboard, which is a worse
and much more likely outcome than an unmetered minute of guessing.

#### The NaN spin, and a bound that arithmetic cannot break

`Math.max(1000, NaN)` is `NaN`, and `setTimeout(fn, NaN)` fires immediately — so
`awaitTokens` stopped waiting and hammered the limiter's database as fast as the
event loop allowed.

The second half made it an outage. `waited += NaN` makes `waited` permanently
`NaN`, and `NaN > budgetMs` is `false` — so the budget check, the only guard
between this and a process alive, holding a lease, and never finishing, was
silently switched off for the rest of the call. Including for later grants that
came back perfectly valid.

Durations are validated at both entrances, differently on purpose. A bad
**option** falls back to the documented default, because a caller who passed
`millis(undefined)` gave no usable budget. A bad **grant** throws
`RateLimitContractError`, because there is no honest substitute for "how long
until there is capacity" — and because a `RateLimitTimeoutError` here would say
"the bucket stayed full for two minutes" and send an operator to look at
capacity settings for a fault nowhere near them.

**The loop is now also bounded by counting.** Validating the input fixes the bug
that exists; it does not fix the shape of it. The budget check is *arithmetic*,
and arithmetic is precisely what a non-finite number breaks — so a guard against
bad numbers that is itself made of numbers protects nothing the next bug of the
same shape cannot switch off again. `attempt` is compared against
`Math.ceil(budgetMs / MIN_PAUSE_MS) + 1`: an integer against an integer, which
no arithmetic can poison, and exactly the largest number of passes a healthy run
can make.

The mutation argued for it. Weakening the validator to accept `NaN` did not fail
the suite — it **hung** it, exactly as the bug hangs a worker. With the counting
bound in place the same mutation fails eight tests in seconds.

#### How the fixes were checked

Seven mutations, all caught, all reverted: removing the hold write fails eight
tests; dropping `FOR UPDATE` fails one; removing the key role check fails four;
letting an `apikey:` principal be the platform operator fails one; restoring the
meter's silent-on-failure branch fails two; removing the crash guard's budget
fails two; weakening the duration validator fails eight.

One survived on the first attempt — the `apikey:` exclusion — and the **test**
was the problem rather than the code: it passed an id that could not have
matched anyway, so the guard was never exercised. It was replaced with the case
that does exercise it: an operator configuring a machine credential as the
platform operator, refused even though the id matches exactly.

---

### 3.22 The external audit *(CodeRabbit, 2026-09-06)*

The same code was then reviewed externally. Seven more findings, all real. Two
are worth reading in full: one was **worse** than reported, and one arrived with
a fix that would have broken two invariants.

#### CSRF on cookie sessions

`SameSite=Lax` reads like it settles this, and it does kill the classic
cross-*site* form post. The gap is that "site" is not "origin". `SameSite`
compares **registrable domains**, so `blog.example.com`, `staging.example.com`
and `app.example.com` are one site — and a POST from any of them to any other is
same-site, which means the cookie is attached.

Anyone able to put content on a sibling subdomain could therefore forge
authenticated mutations: a marketing page on a shared domain, an old staging host
nobody decommissioned, a subdomain takeover of a dangling DNS record.

Cookie-authenticated mutations now carry an `Origin` proof. Bearer callers
deliberately do not — an attacker cannot make a browser attach a header it does
not know, so they are not exposed, and demanding an `Origin` from `curl` would
break every integration while preventing nothing.

That distinction required the principal to know *how* it authenticated, so the
session variant gained a required `viaCookie`. Required rather than optional,
because an optional flag defaults to `false` and `false` here means "skip the
check" — the wrong way for a default to fail.

The match is on the exact host including the port. `endsWith("example.com")`
accepts `evil-example.com`, and matching the registrable domain accepts the
sibling subdomain the guard exists to refuse. A missing `Origin` is refused
rather than allowed: if absent meant allow, the attack would be to arrange for
absent.

#### The sync quota lock was doing nothing

Reported as "the reservation uses the root client before the transaction". The
consequence is larger than that phrasing suggests.

`reserveQuota` is three statements — lock the quota row `FOR UPDATE`, sum usage,
insert the hold. Against the base client each of those is its own implicit
transaction, so **the lock was released on the statement that took it**, before
the sum had even been sent. Not a weaker guarantee: no guarantee, with a
`FOR UPDATE` sitting in the SQL looking like one.

`enqueueJob` never had this, because its reservation shares the transaction that
writes the job row. `syncProject` had no transaction to share.

Measured against live Postgres, 40 concurrent callers against a limit of 10:

| Gate | Admitted |
| --- | --- |
| Phase 26 read-only check | 40 of 40 |
| Phase 31 reserve, base client | **37 of 40** |
| Phase 31 reserve, in a transaction | 10 of 40 |

**The suggested fix was refused.** Folding the reservation into the write
transaction further down would break two things: the gate must run before the
impact query, or a tenant out of allowance keeps getting to ask which of its
pages would change; and the unchanged path returns before that transaction
exists while still owing its unit, because a sync is one operation whether or
not it finds anything. It takes a transaction of its own instead.

A sync whose write throws now refunds its hold. Every path that *returns*
announces itself, and announcing is what settles — so a throw was the one exit
that left a unit charged for a sync that did not happen.

#### Settlement is durable

The meter runs on the plugin bus, which absorbs listener failures **on purpose**
so that a billing plugin can never abort a paid, hour-long build. That trade is
right and it left a hole: a worker dying between finishing a job and writing the
adjustment loses the event, and with it the only record that anything was owed
back. Retrying does not help — a retry loop lives in the process that died.

No outbox was needed. The hold is already durable (it is a `UsageRecord`) and the
amount is already on the job row. What was missing was a way to tell a settled
job from an unsettled one, which is one nullable column.

`GenerationJob.settledAt` is stamped in the **same transaction** as the
adjustment, which makes it both the durable record and the idempotency key —
settling twice would double-count the correction it was meant to fix.
`reconcileStrandedHolds` sweeps finished jobs holding units with no stamp, on the
worker's idle tick and never while jobs are waiting.

Only finished jobs. Refunding a running one would let a tenant exceed the ceiling
by exactly the work in flight, which is the race the hold exists to prevent.

#### The crash guard could crash

`String(Object.create(null))` throws — no prototype, so no `toString` — and so
does anything whose `toString`, `Symbol.toPrimitive` or `message` getter throws.

Ordinarily a cosmetic bug in a log line. Here it is not: that formatting runs
*inside* the `unhandledRejection` handler, and a throw from inside that handler
is an uncaught exception, which terminates the process. The guard installed to
stop a worker dying on a rejected promise would have been the thing that killed
it — on exactly the malformed rejection it exists to absorb.

Formatting is now total, rendered field by field so one unreadable half does not
lose the other, with a fallback that derives nothing from the value.

#### An unconfigured provider no longer answers 500 to a stranger

`readCookieUser` needs Supabase configuration and is consulted on **every request
that arrives without a header** — including one carrying no credential at all. So
on a deployment with no Supabase project, an anonymous request to any route threw
`ServerEnvError` and was answered `500`.

Wrong three ways: the caller sent nothing, so the honest answer is `401`; a `500`
tells an unauthenticated stranger the server is misconfigured, which is a fact
about the deployment they have no business learning; and every drive-by scanner
then registers as a server fault in whatever watches the error rate.

It degrades to "no cookie session", which is the truth — with no provider
configured, nobody can be signed in. A session token that was *actually
presented* still answers `500`: a caller who offered a credential we cannot check
is owed a different answer from one who offered nothing.

#### Two smaller ones

**A pause ceiling below the floor was a hammer loop.** `Math.min(ceiling,
Math.max(floor, reported))` applies the ceiling last, so `maxPauseMs: 0` won
outright — `setTimeout(fn, 0)` returns immediately, `waited` stops growing, and
the loop hammers the limiter's database. The same spin the `NaN` guard closed,
arriving through a value that is a perfectly good duration. The iteration cap
bounded it, but bounding a hammer loop is not the same as not having one.

**The platform operator had a guessable production default.** An unset variable
meant `"local-operator"`, the identity the CLI runs as and the OWNER the seed
installs. Nothing reachable over HTTP can currently *be* that string, so this was
hardening rather than an open door — but it was a door held shut by facts about
other modules, and the list of ways a `userId` gets set is exactly the list of
things that change. Outside development an unset variable now means there is no
platform operator at all, and every platform operation refuses.

Anything that is not literally `"production"` is treated as development, which
reads backwards until you ask which way it fails: the opposite default would hand
the fallback to exactly the deployment careless enough to misspell its own
`NODE_ENV`.

#### How these were checked

Five mutations, all caught, all reverted: a suffix host match fails one test;
allowing a missing `Origin` fails two; dropping the settlement compare-and-set
fails one; removing the pause floor fails two; restoring unguarded
stringification fails seven.

And one measurement no mock could have made. The sync lock was verified against
the live database in both configurations, because the property is Postgres's
rather than TypeScript's — a mocked client has no notion of a row lock and would
have reported the broken version as working.

---

### 3.23 SEO publishing and internal linking *(Phases 05–06)*

Sitemaps, robots, canonical metadata and structured data are generated as part
of the build rather than bolted on. An internal link graph is computed across
the whole page set with contextual linking rules, so pages reference their
siblings meaningfully instead of carrying a footer link dump.

### 3.24 Zero-JavaScript presentation layer

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

### 3.25 Test coverage

**1334 tests across 67 files in six packages**, all under Vitest, all passing.

| Package | Tests | Coverage |
| --- | --- | --- |
| `ai` | 259 | Schema-constrained output, grounding and bypass attempts, cache integrity, retry, prompt versioning, money detection, gap analysis, the rate-limit wait loop and its refusal of any wait that is not a duration |
| `core` | 396 | CSV import, link graph, content hashing, block-path patching, plugin isolation, sync adapters, outbound-URL guard, build trigger, the role model, the database audit logger, the token-bucket arithmetic, the API-key format and hashing, the billing meter, the session guard, the server-env contract, the route-coverage sweep, tenant paths, job budget, the settlement of quota holds, the forgery-resistant client address, and the same-origin rule that a `SameSite` cookie does not give you |
| `database` | 404 | Repository read mapping, atomic write path, queue claim, impact analysis, the incremental queuing rule, the authorisation gate, the audit trail, the rate limiter's statement shape and the API-key lifecycle, the quota gate, the unified auth door, the two gates a locked-down write route runs, the atomic reservation gate under a simulated running total, the data-layer role checks, and the once-only settlement of a hold — entirely against a mocked Prisma client |
| `generator` | 168 | Page assembly, slug collision, eligibility, placeholder rejection, SEO output, AI merge, run scoping, output persistence |
| `schemas` | 41 | The shared data contracts themselves |
| `cli` | 66 | Pipeline stages, the standalone worker, queue-drain detection, and the crash guard that keeps a worker alive through a detached rejection, including one whose reason cannot be turned into text |

**Mocks cannot prove a concurrency property**, and the quota gate's guarantee is
Postgres's rather than TypeScript's. So it was also checked against the live
database, twice, each time with a control run: 40 concurrent callers on separate
connections against a limit of 10 admitted **40** under the original read-only
check, **37** under a reservation taken outside a transaction, and **10** inside
one.

The middle number is the point. The mocked suite passed against that version,
because a mocked client has no notion of a row lock — it would have gone on
reporting a `FOR UPDATE` that Postgres was releasing immediately as working
protection. Probe tenants were deleted afterwards and the database confirmed
clean.

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
has not been shown to work, and Phase 31 found one that had not: a mutation
survived, and the test rather than the code turned out to be at fault. Second, the generator assertions deliberately use
Node's strict assertion library rather than the framework's, because loose
equality would have weakened 60 existing comparisons during the runner
migration.

---

## 4. Data Model & Business Logic

### 4.1 Tenancy

```
Organization  →  OrganizationMember[]   (OWNER | EDITOR | VIEWER)
              →  ApiKey[]                (SHA-256 hashed; each is also a member)
              →  OrganizationQuota[]     (one ceiling per metric)
              →  UsageRecord[]           (append-only; summed per period)

User  →  OrganizationMember[]   (a principal: a person, or an `apikey:…` machine)
              →  Workspace  →  Project  →  Business
                       →  ContentTemplate
                       →  Service[]
                       →  Location[]
                       →  GeneratedPage[]
                       →  GenerationJob[]   (carries targetSlugs: the pages one run may re-author)

ContentProfile / Template  →  owned by a user, or global via a __global__ sentinel
```

**Organization** is the tenant root as of Phase 23: it carries the members and
the roles every authorisation decision is made against, and it is what is
billed. **Workspace** groups projects beneath it — it held the root position
before this phase and was deliberately not renamed, because renaming a populated
model is a destructive migration that deserves its own change. **Project**
is one generated site, and carries `organizationId` under a composite foreign
key that makes disagreement with its workspace impossible. Every other row reaches a Workspace through a Project, so
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

**1. The `/login` page, and the credentials behind it.** Authentication is
otherwise finished as a mechanism: Phase 23 decides *what* a caller may do,
Phase 25 gives a machine a credential it can prove, Phase 27 adds real user
rows, Phase 29 enforces both on every API route, Phase 30 puts a person's
session in an `HttpOnly` cookie the same guard accepts, and Phase 31 moved the
role checks *inside* the data layer so a route that forgets is no longer the
only thing standing in the way.

What is left is small and total: **there is no `/login` page.** The middleware
redirects to it and it does not exist, so the redirect lands on a 404. And
`SUPABASE_URL` / `SUPABASE_ANON_KEY` are unconfigured, so nobody has ever
actually signed in — every session path is exercised against injected doubles
and against its failure path only.

**Row-level security is the remaining half of the same item.** Every isolation
guarantee today is an application-level `where` clause, so a query written
without one is a query without a boundary. RLS would make the database refuse
what the application forgot to. Phase 31 narrowed the exposure — permission is
now checked inside the functions rather than only in front of them — but that
is defence in the application, not in the database.

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

- **No `/login` page.** Browser sessions work (Phase 30) and the route behind
  the form is built; the form is not. The middleware redirects to a 404. The
  CLI still acts as `local-operator`, which is intended — it runs on an
  operator's own machine.
- **The session branch is unproven against a real provider.** `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` are not configured here; the live verification exercised
  the API-key branch only, and the JWT branch is covered by injected doubles.
- **No row-level security.** Tenant isolation is application-level `where`
  clauses only; the database would not refuse a query that forgot one.
- ~~**The gate is only as complete as its call sites.**~~ **Closed in Phase 31.**
  The role check moved inside the `database` functions, with the acting identity
  as a required parameter, so a caller that forgets is a compile error rather
  than an open door. `saveGeneratedPages` and `saveRefreshedPage` are gated too:
  reaching a page was never permission to rewrite it.
- ~~**A cookie session could be spent by a sibling subdomain.**~~ **Closed.**
  `SameSite=Lax` compares registrable domains, so `evil.example.com` posting to
  `app.example.com` is same-site and carries the cookie. Cookie-authenticated
  mutations now require a matching `Origin`; bearer callers do not, because they
  are not exposed to it.
- **The audit trail is best-effort**, written after the action by a listener the
  bus may abandon. Failures are loud, but a lost row is possible.
- **The rate limiter has never held back a real provider call.** With no
  `ANTHROPIC_API_KEY` configured, the bucket and the wait loop are verified
  against Postgres and against injected doubles respectively, but the last inch
  — a held-back call reaching the provider late rather than not at all — is
  unproven. Its *wait loop* is no longer a hazard: Phase 31 closed the `NaN`
  spin and bounded the loop by counting as well as by arithmetic.
- **No `ANTHROPIC_API_KEY` configured**; the AI path is covered only by injected
  doubles and has no live integration test.
- **`packages/templates` is an empty placeholder**; templates remain route-local.
- **Per-business eligibility is not exposed through the database read path** —
  the DB path treats every service and location on a project as eligible.
- **No CI pipeline and no deployment**; `verify` is run by hand, and the worker
  has no host — which now also means the crash guard added in Phase 31 has never
  run anywhere but a test.
- **Nothing turns usage into an invoice.** Phase 26 meters consumption and
  enforces quotas; no code prices a `UsageRecord` or charges anyone.
- **`resetDate` is never advanced automatically.** A quota counts from whenever
  it was last set, so a monthly plan is a lifetime allowance until an operator
  or a scheduled job moves the date. There is no such job.
- **`setQuota` has no caller.** It is guarded by `requirePlatformOperator`
  (Phase 31) and reachable only from a script — there is no CLI command and no
  platform-admin surface, so setting a customer's ceiling means writing code.
- **The platform boundary is one identity, not a role.** `requirePlatformOperator`
  cannot express two administrators, an audit of who changed a limit, or a
  support engineer with read-only access to billing. It is honest for a system
  with one operator and it is the one place a real platform-admin role would
  replace.
- ~~**The quota gate is not atomic.**~~ **Closed in Phase 31 for `enqueueJob`
  and in the CodeRabbit remediation for `syncProject`** — the first fix covered
  only the path that already had a transaction to share, and the sync path went
  on admitting 37 of 40 concurrent callers against a limit of 10 until the
  external audit found it. Both now hold what they admit inside a transaction,
  and both admit exactly 10 of 40.
- ~~**An unsettled hold stays charged for ever.**~~ **Closed.**
  `GenerationJob.settledAt` is stamped in the same transaction as the
  adjustment, and `reconcileStrandedHolds` sweeps finished jobs on the worker's
  idle tick — so a settlement event lost by the best-effort plugin bus is late
  rather than permanent.
- Businesses and content templates cannot be imported from CSV, only services
  and locations.
- `refresh-page` does not yet pass the realigned `schemaOrg` through
  `saveRefreshedPage`, so that path still carries the drift Phases 16–17 fixed
  elsewhere.
