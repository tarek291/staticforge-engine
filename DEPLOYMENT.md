# Deploying StaticForge

Two deployables, and they are not the same shape.

The **web app** answers requests and serves a static site. It belongs on Vercel.
The **worker** claims jobs, holds leases, and runs generations that take
minutes. It cannot go on Vercel at all — see below.

---

## The thing that will bite you first

`data/output` is gitignored, and the web build reads
`data/output/manifest.json` to decide which static pages to render.

A fresh clone — which is what every CI runner and every Vercel build is — has no
manifest. **The build then succeeds and emits zero content pages.** Verified by
doing it: nine pages with the manifest present, zero without, and the same green
exit code either way.

A deploy that fails is an incident. A deploy that succeeds and serves an empty
site is an incident nobody opens, because every signal says it worked.

So the build generates its own content. `pnpm vercel-build` runs
`scripts/generate-site.mjs`, which generates, **refuses to continue if the
manifest is empty**, and then runs the web build with `STATICFORGE_OUTPUT_DIR`
pointed at whatever it just wrote.

That last part matters: database mode writes to a per-project subdirectory, and
the app's fallback points at the root. Left to a printed instruction, a build
would read the wrong place and find nothing.

---

## Web app — Vercel

### Root Directory decides everything else. Read this part.

Vercel reads `vercel.json` **from the Root Directory**, not from the repository
root. Point Root Directory at `apps/web` and the `vercel.json` in this
repository is never opened — no build command, no install command, no output
directory. None of the configuration below applies, and the failure surfaces as
something unrelated:

```
Running "pnpm vercel-build"
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "vercel-build" not found
```

That error is about the script; the cause is the setting.

**Set Root Directory to the repository root — leave the field empty, or `.`**

That is the configuration this repository is built for, and it is not a
preference. The build runs the generator, which lives in a sibling workspace
package, and writes to `data/output` at the repository root. `apps/web` on its
own cannot build this site.

With Root Directory empty, `vercel.json` supplies the rest and there is nothing
to type into the UI:

| Setting | Value |
| --- | --- |
| Build command | `pnpm vercel-build` |
| Install command | `pnpm install --frozen-lockfile` |
| Output directory | `apps/web/.next` |

**Clear any Build Command you typed into the Vercel UI.** A value there
overrides `vercel.json`, which is how the setting above goes wrong quietly.

### If you keep Root Directory at `apps/web`

`apps/web/package.json` also has a `vercel-build`, so the command resolves and
Vercel's Next.js detection runs it without a custom Build Command. It delegates
to the same script, which finds the repository root from its own location rather
than from the working directory.

Two things to check in that configuration, because `vercel.json` is still being
ignored:

- **Enable "Include source files outside of the Root Directory in the Build
  Step."** Without it the sibling packages are not there and the generator
  cannot run.
- Set the environment variables on the project as normal; they are read the same
  way either way.

The repository-root configuration is the one that is exercised locally and in
CI. This one is a convenience, and if it misbehaves the first thing to try is
moving Root Directory back.

### Environment variables

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres. Needed at **build** time as well as runtime, because the build generates content from it. |
| `SUPABASE_URL` | yes | The project sessions are verified against. |
| `SUPABASE_ANON_KEY` | yes | The **anon** key. Never the service-role key — see `apps/web/.env.example`. |
| `STATICFORGE_PROJECT_ID` | yes | Which tenant's site this deployment serves. Without it the build falls back to `data/input`, which is sample data. |
| `STATICFORGE_LOCALE` | no | Defaults to `de`. |
| `STATICFORGE_ALLOWED_ORIGINS` | no | Extra hosts a cookie session may post from. Only if the dashboard is served from a different host than the API. |
| `STATICFORGE_PLATFORM_OPERATOR` | no | Who may set quotas. **Unset in production means nobody can** — that is deliberate, see `packages/database/src/platform.ts`. |

### Things to check on the first deploy

**`Secure` cookies.** Every session in phases 30–32 has only ever been exercised
over `http://localhost`. Over HTTPS the SSR client sets `Secure`, and cookie
scoping across subdomains differs. This is the first place that runs for real.

**The `Origin` check.** Cookie-authenticated writes compare `Origin` against the
`Host` header. Behind Vercel's proxy that is the public hostname, which is what
the browser sends — but it has never been exercised against a real proxy. If
writes from the dashboard start returning `403`, this is the first place to
look, and `STATICFORGE_ALLOWED_ORIGINS` is the escape hatch.

**Nothing serves `/dashboard` content without a session.** That is correct
behaviour, not a broken deploy.

---

## Worker — anywhere that runs processes

Railway, Render, Fly, or a box with Docker. **Not Vercel:** Vercel runs
functions, which are invoked, answer, and stop. This worker claims a job, renews
a lease while it works, and may run for an hour. There is no request to hang it
off.

```bash
docker build -f Dockerfile.worker -t staticforge-worker .
docker run --env DATABASE_URL=... staticforge-worker
```

### Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | The queue lives here. |
| `STATICFORGE_INSTANCE_ID` | strongly advised | Identity for the lease. Must be **stable across a restart of the same instance** and distinct between instances — that is what makes "reclaim this instance's own leftovers on boot" safe. A container id changes every deploy; use the platform's instance name. Falls back to the hostname. |
| `ANTHROPIC_API_KEY` | for AI runs | Without it, authoring runs against injected doubles. |
| `STATICFORGE_METER_USAGE` | no | `true` to write billing rows. |
| `STATICFORGE_AUDIT_DB` | no | `true` to write the audit trail. |
| `DEPLOY_WEBHOOK_URL` | no | Pinged when the queue drains. See the loop below. |

### Set the stop timeout properly

`SIGTERM` is handled cooperatively: the first signal finishes the job in flight
and then exits; a second exits immediately. **Most platforms default to a 30
second grace period, which is far too short for a run measured in minutes.**

A worker killed mid-run loses nothing durable — the lease lapses and another
worker resumes it, which is what the lease is for — but it wastes whatever that
run had already paid for. Set the grace period to the longest run you expect, or
accept the re-run.

### Why the CMD looks the way it does

`pnpm staticforge worker` is three processes deep, and `SIGTERM` to PID 1 does
not reliably reach the bottom of that chain — so the cooperative shutdown above
would never run and every deploy would kill a job mid-flight. The image invokes
node directly instead, from the package that owns `tsx`, so the worker *is*
PID 1.

---

## Closing the content loop

Phase 22 built a deploy trigger that fires when the queue drains, and it has
never been connected to anything. This is what it is for:

```
 content changes  ──▶  worker generates  ──▶  queue drains
                                                   │
                              DEPLOY_WEBHOOK_URL ◀──┘
                                      │
                                      ▼
                        Vercel deploy hook rebuilds the site
                                      │
                                      ▼
                    build regenerates from the database — fresh content
```

Create a Deploy Hook in Vercel (Project Settings → Git → Deploy Hooks) and give
its URL to the worker as `DEPLOY_WEBHOOK_URL`. A sync that queues ten jobs
causes **one** deploy, not ten, because the trigger fires on the transition to
idle rather than per job.

---

## CI

`.github/workflows/verify.yml` runs `pnpm verify` — generate, typecheck, test,
web build — on every push to `main` and every pull request.

**It needs no secrets, and that is a property worth keeping.** `data/input` is
committed so the generator runs from files; every database test asserts against
a mocked client, and one of them asserts that no connection is opened, so the
guarantee cannot rot quietly. A fork's pull request therefore gets the same
verification a trusted branch does.

The moment CI needs a `DATABASE_URL`, that stops being true — and the first sign
will be a green tick on a fork that ran nothing.

The workflow also fails if the build produced an empty manifest, for the reason
at the top of this file.
