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
