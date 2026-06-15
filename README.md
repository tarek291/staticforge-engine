# StaticForge Engine

A schema-driven static site generation engine, organized as a pnpm monorepo.

> **Status:** 🟢 MVP — end-to-end pipeline working: structured data → validated pages → static HTML routes.

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
│  ├─ core/             # Core engine logic
│  ├─ generator/        # Static site generation pipeline
│  ├─ templates/        # Site templates
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
corepack pnpm generate    # run the generator pipeline → data/output/
corepack pnpm dev:web     # start the Next.js dev server
corepack pnpm build:web   # build the static site
corepack pnpm verify      # generate + typecheck (generator & web) + build
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

## Template registry (default-only)

A minimal, route-local registry now resolves which view renders a page:

- **Location:** `apps/web/app/[slug]/templateRegistry.ts` — strictly route-local,
  server-only, pure (no JSX, no `"use client"`).
- **Mapping:** currently `templateId: "default"` → `GeneratedPageView`.
- **Dispatch:** `page.tsx` still owns all framework concerns
  (`dynamicParams`, `generateStaticParams`, `generateMetadata`, data lookup,
  `notFound()`), and now resolves the view dynamically via
  `getTemplateView(page.templateId)`.
- **Exclusive view:** `GeneratedPageView` remains the only presentation layout.
- **Safe fallback:** any unknown / unmapped `templateId` falls back to
  `GeneratedPageView`.

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
