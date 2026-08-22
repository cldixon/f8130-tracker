# Deployment

Every service is built from this one repository. That makes one thing
important and non-obvious:

**Railway's Config as Code overrides service settings.** A `railway.json` at
the repository root applies to *every* service built from the repo, so a root
config naming `web/Dockerfile` silently makes the ingest service build and run
a second copy of the website — which is exactly what happened the first time.
There is no root `railway.json` for that reason. Each service points at its own
config file instead, set once per service in Railway under
**Settings → Config file path**:

| service | config file path | notes |
|---|---|---|
| `f8130-tracker` (web) | `web/railway.json` | public; healthcheck `/api/health` |
| `ingest` | `ingest/railway.json` | no public domain; restarts always |
| `pds` | — | Docker image, not built from this repo |
| `Postgres` | — | Railway template |

After that, pushes to the tracked branch deploy every service automatically.

## Variables

The web service comes up correct with none set. The others need:

| service | variable | value |
|---|---|---|
| ingest | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| ingest | `PDS_HOST` | `ws://pds.railway.internal:3000` |
| web | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| web | `F8130_MODE` | `demo` until the PDS has data, then `live` |

Railway's private network is IPv6-only and is **not** TLS-terminated, hence
`ws://` and `.railway.internal` rather than `wss://` and a public hostname.

## Manual steps

Two things cannot be done through the API:

1. **A volume on the `pds` service**, mounted at `/pds`. Without it the PDS
   crashes on boot with "Cannot open database because the directory does not
   exist" — SQLite has nowhere to live.
2. **DNS records** for the PDS hostname. See the project README.

## The seed is not a normal service

It writes records, and Railway redeploys services on every push. An unrelated
commit therefore wrote a second complete set of parts into the demonstration
before anyone noticed — the deployment was green throughout.

Two guards now: the seed refuses to write when an organization already holds
records (`SEED_RESET=1` clears and rewrites, `SEED_FORCE=1` adds another set),
and its watch patterns are limited to `seed/**` so unrelated commits do not
redeploy it at all.

Those guards mean **expanding the cast does not take effect on its own.** The
seed sees that the original five organizations already hold records and stops,
which is the correct behaviour for an unrelated push and the wrong one after a
roster change. Set `SEED_RESET=1`, redeploy the seed, then unset it — the run
clears every f8130 record from every organization in the roster and rewrites
the whole demonstration.

`SEED_RESET` deletes records, never accounts. Every `did:plc` already
provisioned is reused, which matters because those registrations are permanent
and public: a roster change that renamed an existing handle would strand its
identity and orphan every record it ever signed. The roster tests assert the
five original handles are still present for exactly that reason.

Re-seeding rewrites the log, so both AppView indexes should be rebuilt
afterwards rather than left holding records whose URIs no longer exist.
