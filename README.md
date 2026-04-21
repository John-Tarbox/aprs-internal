# aprs-internal

Internal-only website for the APRS Foundation. Deployed on Cloudflare Workers at `https://internal.aprsfoundation.org`.

Source code is public; the deployed site is gated by dual-provider authentication:

- **Okta** (`aprsfoundation.okta.com`) — for APRS staff. First login auto-creates a user row with the `viewer` role; an admin can elevate to `staff` or `admin` after that.
- **Google** (any Google account) — for consultants and other external collaborators. Authorization is enforced by a per-user allow-list in D1. An admin adds the person's Google email via `/admin/users`; they then sign in with "Sign in with Google" and the system recognizes them.

Google sign-in from an email NOT on the allow-list is rejected with an "ask an admin to invite you" page. Any Google user on Earth can *authenticate*; only listed users are *authorized*.

## Stack

- Cloudflare Workers (runtime) + Hono (router)
- D1 (SQLite) for users, roles, sessions, audit log
- Server-rendered JSX pages
- No KV / R2 / Workers AI at this stage — added per feature as needed

## Prerequisites

1. **Cloudflare API token** scoped to the APRS Foundation Inc account (`d8e848325a1b3c22b7631ed3f51eecdb`). **Generate a fresh token for this project** — do not reuse another project's token. See `.env.example`.
2. **Okta OIDC app** registered in the APRS Okta admin console, with redirects:
   - `https://internal.aprsfoundation.org/auth/okta/callback`
   - `http://localhost:8788/auth/okta/callback`
3. **Google OAuth client** in any Google Cloud Console project, "Web application" type, same two redirect URIs. OAuth consent screen should be published (not "testing") so arbitrary Gmail users can sign in without the unverified-app warning.
4. Secrets set via `wrangler secret put`: `OKTA_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` (`openssl rand -hex 32`).

## First-time setup

```bash
# Install deps
npm install

# CRITICAL: verify the active Cloudflare account matches this project
npx wrangler whoami   # must show APRS Foundation Inc / d8e848325a1b3c22b7631ed3f51eecdb

# Create the D1 database, then paste the returned database_id into wrangler.toml
npx wrangler d1 create aprs-internal-db

# Edit migrations/0002_seed.sql if the bootstrap admin email needs to change
# Then run migrations against BOTH local (for dev) and remote (for prod)
npm run db:migrate:local
npm run db:migrate:remote

# Put secrets (one at a time; wrangler will prompt)
npx wrangler secret put OKTA_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET   # value: `openssl rand -hex 32`

# First deploy. The custom domain route in wrangler.toml auto-provisions
# internal.aprsfoundation.org since the zone is on this Cloudflare account.
npm run deploy
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the four secrets
npm run dev                       # http://localhost:8788

# Dev-mode mock auth (only active when ENVIRONMENT=development):
curl -H "X-Mock-User-Email: test@example.com" -H "X-Mock-User-Role: admin" \
  http://localhost:8788/admin/users
```

## Adding an external (Google) user

1. Sign in as an admin (via Okta or Google).
2. Go to `/admin/users`.
3. Enter the person's Google email, pick a role (`viewer` / `staff` / `admin`), submit.
4. Tell the person: "Go to `https://internal.aprsfoundation.org` and click 'Sign in with Google'."
5. On their first sign-in, the system matches their Google email to the `users` row and creates a session. If their email doesn't match, they see an "ask an admin to invite you" page.

Any Google email works as the identity — personal Gmail, Google Workspace under their own company, whatever. The allow-list (not the email domain) is what grants access.

## Deactivating a user

From `/admin/users`, click "Deactivate" next to their row. Their `active` flag is cleared and their next request redirects them to `/login`. Existing session rows are invalidated on the next request (not pre-emptively killed — the session lookup joins `users.active`).

## Role model

Three roles, hierarchical: `admin > staff > viewer`.

- `viewer` — read-only internal access (default for new Okta users and new external invites).
- `staff` — elevated read/write on content (specific sections as they're built).
- `admin` — can manage users, roles, and all content.

Role grants are local to this app's D1. Okta groups are intentionally NOT consulted — this keeps Okta and Google users symmetrical.

## Session model

Server-side sessions in D1. The cookie carries only an opaque session id (HMAC-signed with `SESSION_SECRET`). Every request does one indexed D1 lookup. Because sessions live in D1, deactivating a user invalidates their live cookie on their next request — there's no "wait for JWT expiry" window.

- Okta sessions: 7-day TTL
- Google sessions: 8-hour TTL (shorter because Okta has its own MFA/device policy; Google we treat as lower-trust)

## Project layout

```
migrations/       # D1 migrations (apply in numerical order)
src/
  index.ts        # Hono app composition
  env.ts          # Env bindings / vars / secrets interface
  middleware/     # authMiddleware + requireRole
  services/       # cookie, session, oidc, okta, google, jwks, users, audit
  routes/         # auth / pages / admin / health
  pages/          # server-rendered JSX
```

## Operations

Run the checklist in `/home/wa1kli/.claude/plans/not-so-fast-there-hidden-twilight.md` after the first deploy to confirm end-to-end correctness.

`wrangler tail` is the fastest way to see what's happening in prod in real time.

## Cloudflare account safety

This project lives on the same Cloudflare account as the FAQ project, but uses its own separate API token. **Before any `wrangler` command, run `npx wrangler whoami` and confirm the account matches.** The `account_id` pin in `wrangler.toml` will also refuse mismatched deploys.
