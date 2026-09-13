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

So the build generates its own content. `scripts/generate-site.mjs` generates,
**refuses to continue if the manifest is empty**, and then runs the web build
with `STATICFORGE_OUTPUT_DIR` pointed at whatever it just wrote. Vercel runs it
as the build command; locally it is `pnpm build:site`.

That last part matters: database mode writes to a per-project subdirectory, and
the app's fallback points at the root. Left to a printed instruction, a build
would read the wrong place and find nothing.

---

## Web app — Vercel

### The settings, in full

| Setting | Value |
| --- | --- |
| **Root Directory** | `apps/web` |
| **Framework Preset** | Next.js |
| **Include source files outside of the Root Directory** | **on** |
| Build Command | leave empty — `apps/web/vercel.json` supplies it |
| Install Command | leave empty — same |
| Output Directory | leave empty — same |

`apps/web/vercel.json` is read because Vercel reads `vercel.json` **from the
Root Directory**, not from the repository root. That is the whole reason this
file lives where it does, and it is worth knowing before something goes wrong:
point Root Directory somewhere else and this configuration is silently not
applied.

### Why Root Directory is `apps/web` and not the repository root

Vercel detects the framework by reading `next` from the **Root Directory's**
`package.json`. The repository root's manifest has one dependency — `cross-env`
— so pointing Root Directory there produces:

```
Warning: Could not identify Next.js version, ensure it is defined as a project dependency.
Error: No Next.js version detected.
```

The build command still works from `apps/web`: `generate-site.mjs` resolves the
repository root from its own file location rather than from the working
directory, so the generator and the workspace packages are all reachable. What
does *not* work from the repository root is Vercel's framework detection, and
that is not something a build command can fix.

**"Include source files outside of the Root Directory" must be on.** Without it
the sibling workspace packages are not in the build context, and the generator
cannot run.

### Do not set Framework Preset to "Other"

It resolves the detection error and breaks the application, which is the worse
of the two outcomes because nothing reports it.

"Other" tells Vercel to publish a directory of static files. This app is not
that. It has six API routes — sign-in, three dashboard endpoints, the sync
webhook — and a `middleware.ts` that guards `/dashboard`. Under "Other" none of
them are built as serverless functions. The marketing pages would render, every
authenticated path would 404, and the deploy would be green.

A correct build shows both kinds in its output: `●` for prerendered pages and
`ƒ` for the dynamic routes and middleware. If the `ƒ` entries are missing, the
preset is wrong.

### Clear the UI overrides, all three of them

`vercel.json` takes precedence over the dashboard for these fields, so the
values below are pinned in the file. But a value left in the dashboard from an
earlier attempt is invisible in the repository and outlives every fix committed
to it, so clear Build Command, Install Command **and Output Directory**.

Output Directory is the one that bites, because it is interpreted **relative to
the Root Directory**. `apps/web/.next` typed into the field, with a root of
`apps/web`, means `apps/web/apps/web/.next` — and the deploy fails after a
successful build with:

```
Error: No Output Directory named "apps/web/.next" found after the Build completed.
```

which reads like the build produced nothing. It produced the right thing in the
right place; the path was doubled.

The correct value is `.next`, and it is in `apps/web/vercel.json` so nobody has
to know that. The build script also asserts that `apps/web/.next/BUILD_ID`
exists before it exits, so a future version of this mistake fails in the build
log rather than after it.

### Environment variables

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres. Needed at **build** time as well as runtime, because the build generates content from it. **Must be the pooler URL, not `db.<ref>.supabase.co`** — see below. |
| `SUPABASE_URL` | yes | The project sessions are verified against. |
| `SUPABASE_ANON_KEY` | yes | The **anon** key. Never the service-role key — see `apps/web/.env.example`. |
| `STATICFORGE_PROJECT_ID` | yes | Which tenant's site this deployment serves. Without it the build falls back to `data/input`, which is sample data. |
| `STATICFORGE_LOCALE` | no | Defaults to `de`. |
| `STATICFORGE_ALLOWED_ORIGINS` | no | Extra hosts a cookie session may post from. Only if the dashboard is served from a different host than the API. |
| `STATICFORGE_PLATFORM_OPERATOR` | no | Who may set quotas. **Unset in production means nobody can** — that is deliberate, see `packages/database/src/platform.ts`. |

### `DATABASE_URL` must be the pooler, not the direct host

This is the one that will look like a broken deploy and is a connection string.

Supabase's direct host — `db.<ref>.supabase.co` — publishes **no A record**.
It is IPv6 only:

```
$ getaddrinfo db.<ref>.supabase.co
  IPv4 (A)    none
  IPv6 (AAAA) 2a05:d018:...
```

Vercel's serverless functions have no IPv6 outbound, so that host is not slow
from there — it is **unresolvable**. Everything that does not touch the database
works perfectly, which is what makes it confusing: static pages render, the
login route answers, the session cookie is set, the middleware lets you through,
and then the dashboard shows a `500` from the projects endpoint.

Use the **transaction pooler** connection string, which resolves to IPv4:

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
```

Copy it from Supabase → Project Settings → Database → Connection string →
**Transaction pooler**. Note the username is `postgres.<ref>`, not `postgres`.

`?pgbouncer=true` tells Prisma not to use prepared statements, which a
transaction-mode pooler cannot support. `connection_limit=1` keeps each function
instance to one connection, because a serverless platform will happily start
more instances than the pooler has slots.

**Keep the direct URL locally.** A laptop has IPv6, `prisma db push` and
`prisma db seed` want a direct session, and the pooler is the wrong shape for
schema changes. The two environments legitimately use different URLs.

The dashboard reports this specifically rather than generically: signed in, with
an unreachable database, it names the host and says whether the problem is an
unset variable, a malformed URL, or exactly this.

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

### On Railway

`railway.json` points the builder at `Dockerfile.worker`, so there is nothing to
configure in the UI beyond the variables below. Create a service from this
repository and Railway reads it.

Restart policy is `ON_FAILURE` with ten retries rather than `ALWAYS`. A worker
that exits deliberately — the crash guard giving up after twenty absorbed
rejections in a minute — should stay down long enough to be noticed. `ALWAYS`
would restart it into the same pathology forever and turn a loud failure into a
quiet one.

**Set the stop timeout to at least a few minutes** in the service settings.
Railway's default grace period is far shorter than a generation run, and the
CLI's shutdown is cooperative: the first `SIGTERM` finishes the job in flight.

### The worker uses a *different* connection string from the web app

Both go through the pooler, on different ports, and the difference is not
cosmetic:

| | Port | Why |
| --- | --- | --- |
| Web (Vercel) | **6543** transaction | Serverless. Many short-lived instances, each holding a connection for one request. Needs `?pgbouncer=true` because transaction mode cannot hold prepared statements. |
| Worker (Railway) | **5432** session | One long-lived process. Keeps its own session, so prepared statements work and no flag is needed. |

Pointing the worker at 6543 would work and then behave oddly under load, because
a transaction-mode pooler hands the same process different backends between
statements. Pointing the web app at 5432 would exhaust the pool as serverless
instances multiply.

Verified against this project: the session URL on 5432 connects and reads the
queue table.

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
