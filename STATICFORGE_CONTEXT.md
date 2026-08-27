# StaticForge — Architecture & Capability Briefing

**Status:** Engine complete, data loop closed. Not yet connected to a live database or deployed.
**Audience:** Product and platform planning for the SaaS layer.
**Last updated:** 2026-08-27

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
landing pages for every eligible service-and-city combination. Content can be
assembled deterministically from templates or authored by Claude under a strict
schema contract. Every page is validated against a shared data contract before
it is written, so invalid output cannot reach a build.

The engine currently runs as a local tool and as a database-backed multi-tenant
service. The multi-tenant data model, the tenant isolation boundary, and the
persistence layer are built and tested. **What remains is the commercial surface
around it: authentication, a dashboard, hosting, and billing.**

---

## 2. Architecture & Tech Stack

A pnpm monorepo of six workspace packages plus a Next.js application, in
TypeScript under strict mode across every package.

| Package | Responsibility |
| --- | --- |
| `@staticforge/schemas` | Shared Zod data contracts. The single source of truth for every entity shape. |
| `@staticforge/core` | Pure utilities: slug generation, SEO helpers, phone normalization, CSV ingestion. |
| `@staticforge/generator` | The pipeline: load → validate → build → author → persist. |
| `@staticforge/ai` | Claude integration with schema-constrained structured output. |
| `@staticforge/database` | Prisma data access, multi-tenant repository, seed. |
| `@staticforge/templates` | Reserved for extracting the presentation layer. Not yet populated. |
| `apps/web` | Next.js 15 static site generator and preview surface. |

**Language and validation.** TypeScript strict mode is enabled repo-wide, with
`noUncheckedIndexedAccess`, `noUnusedLocals`, and `verbatimModuleSyntax` on.
Zod carries the runtime contract. The two are deliberately not redundant: the
compiler governs code, Zod governs data crossing a boundary — file input, model
output, database rows, and the manifest the web app reads at build time.

**Persistence.** Prisma ORM against PostgreSQL, targeting Supabase. The schema
is written and validated; no database is connected yet.

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

### 3.3 AI content generation

Content authoring is strictly opt-in behind an environment flag. Without it the
pipeline is deterministic and free.

The Zod page contract is converted to JSON Schema and attached to a forced tool
call, so the model returns structured data rather than prose to be parsed. The
tool arguments are then parsed back through Zod before anything downstream sees
them — the model can fail, but it cannot silently produce a differently shaped
page.

The system prompt targets *information gain*: content that says something the
ten competing pages do not, with an explicit prohibition on invented prices,
credentials, and review counts. It instructs the model to write in the language
of the input data rather than naming any language, which keeps the engine
locale-agnostic.

**Critically, the model is only asked for what it can legitimately author** —
title, meta description, H1, and body content. Slugs, locale, template
selection, and entity identifiers are resolved deterministically by the engine
and merged in afterwards. The model is never in a position to invent an
identifier or rename a published URL. Every merged page is re-validated before
it is persisted.

Calls are paced with a delay between pages to stay inside provider rate limits,
and the pass fails fast rather than continuing past an error, since every
iteration is a paid call.

### 3.4 Dual-write persistence

In database mode, pages are written to both PostgreSQL and the static JSON
output. The files are not a legacy path: the Next.js build reads them, so they
are required in both modes. The database is the queryable record a dashboard
will read.

The database write is a single atomic transaction. Within it, pages whose slugs
this run no longer produces are deleted *before* the remaining pages are
upserted. The ordering is load-bearing rather than cosmetic — the table carries
a second uniqueness constraint on the service-and-location pair, so a renamed
service would otherwise leave an orphaned row that the slug-keyed write cannot
see and whose presence makes the insert fail. A partial failure leaves the
tenant's pages exactly as they were.

Each stored page records its provenance — template-assembled, AI-authored, or
manually edited — which the dashboard will need to show operators what has been
touched and by what.

### 3.5 Zero-JavaScript presentation layer

Two templates are registered: a clean default and a dark, high-ticket
"luxury landing" design. Any page can be previewed through any template on a
dedicated static preview route, without touching the canonical site.

The luxury template ships **zero client-side JavaScript**. Entrance animations
that would conventionally require an animation library are implemented as CSS
keyframes with staggered delays, which kept the template a pure Server
Component. The route's first-load JavaScript is unchanged by its addition.
Reduced-motion preferences are honoured.

The template contains no hardcoded human-language text — section and question
markers are numerals, which read identically in any locale. Every visible string
comes from tenant data. This is not a stylistic choice: it is what allows one
template to serve a German cleaning company and an English security firm without
a fork.

An unregistered template identifier fails the build loudly rather than silently
falling back, so a typo surfaces in CI rather than as a wrong-looking page.

### 3.6 Test coverage

**102 tests across three packages**, all under Vitest.

| Package | Tests | Coverage |
| --- | --- | --- |
| `database` | 43 | Repository read mapping and atomic write path, entirely against a mocked Prisma client |
| `generator` | 40 | Page assembly, slug collision, eligibility, placeholder rejection, SEO output, AI merge, output persistence |
| `core` | 19 | CSV import: slug handling, optional columns, and fail-loud validation |

The database suite never opens a connection — one test asserts that explicitly,
so the guarantee cannot rot silently. The AI merge suite runs against an
injected stub, so it costs nothing and needs no API key.

Two properties of this suite are worth noting for anyone assessing risk. First,
tests were repeatedly validated by *mutation* — deliberately breaking the code
under test to confirm the relevant tests fail, then reverting. A test that has
never failed has not been shown to work. Second, the assertions in the generator
package deliberately use Node's strict assertion library rather than the test
framework's, because the framework's loose equality would have weakened 60
existing comparisons during the runner migration.

---

## 4. Data Model & Business Logic

### 4.1 Tenancy

```
Workspace  →  Project  →  Business
                       →  ContentTemplate
                       →  Service[]
                       →  Location[]
                       →  GeneratedPage[]
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

*Planning note:* the file pipeline supports this today. The database read path
currently returns every service and location on a project as eligible. Exposing
per-business eligibility through the data model is a known, scoped gap, and the
dashboard will need a UI for it.

### 4.4 Template resolution

Template selection resolves through a defined precedence — service-level, then
project-level, then a default — so an operator can style one high-value service
differently without touching the rest of the site. The resolved identifier is
recorded on every generated page and indexed in the manifest.

### 4.5 Validation as an architectural boundary

Data is validated at every point it crosses into the system: CSV rows at import,
input at load, each assembled page before it is written, model output before it
is merged, merged pages before they are persisted, and the manifest when the web
app reads it.

Notably, the database adapter deliberately does **not** validate. It reshapes
rows into the input contract and hands them to the same validator the file path
uses, so validation stays in one place with one set of error messages rather
than forking into two implementations that drift.

---

## 5. Immediate Technical Next Steps

Ordered by dependency. The first item gates everything below it.

**1. Connect Supabase.** Provision the PostgreSQL instance, push the schema, and
run the seed. The seed is idempotent and reproduces the sample tenant with
identifiers matching the file fixtures, so the two modes can be compared
directly on first run. *This is the largest open risk in the project: the entire
database layer is verified against mocks and has never executed against a real
PostgreSQL server. Connection pooling for a serverless runtime is also unproven.*

**2. Authentication and tenant scoping.** Users, workspace membership, and roles.
Every query must be scoped to the caller's workspace. The subtree data model
makes this enforceable, but nothing enforces it yet — there is no authentication
layer at all today.

**3. Dashboard.** The operator surface: CRUD for services and locations, CSV
upload, triggering generation, previewing pages across templates, and reviewing
AI-authored content before publication. The preview route and provenance
tracking already exist to support the review workflow.

**4. Deployment and CI/CD.** Vercel for the Next.js application, with the
existing `verify` gate wired into CI. Generation currently runs as a local CLI;
hosted generation needs to become a background job, since an AI run is paced and
long-running by design and will exceed a request timeout.

**5. Billing.** Not started. The natural metering dimensions the data model
already supports are projects per workspace, pages per project, and AI-authored
pages — the last being the only line with a real marginal cost.

### Known gaps, stated plainly

- No database has ever been connected; the persistence layer is mock-verified only.
- No authentication, no authorization, no tenant scoping enforcement.
- The AI path has been executed end-to-end but is not covered by a live integration test.
- Per-business eligibility is not yet exposed through the database read path.
- The `templates` package is an empty placeholder; templates remain route-local.
- Businesses and content templates cannot be imported from CSV, only services and locations.
