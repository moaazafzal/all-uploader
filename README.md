# All Uploader

Compose a post once — text, images, video, or a mix — pick the accounts, and it
publishes to every one of them. Self-hosted, multi-user, no third-party service
in the middle.

Supports **13 platforms**: X, Bluesky, Mastodon, Telegram, Discord, Facebook
Pages, Instagram, Threads, TikTok, LinkedIn, YouTube, Reddit, Pinterest.

---

## The honest part first

The code is the easy half. Getting each platform to *let* you post is the other
half, and it is not up to this app:

| Tier | Platforms | What it takes |
|---|---|---|
| **Works immediately** | Bluesky, Mastodon, Telegram, Discord | Paste a credential you generate yourself. Minutes. |
| **Needs a developer app** | X, Reddit | Self-serve registration. X free tier is 500 posts/month. |
| **Needs platform review** | Facebook, Instagram, Threads, TikTok, LinkedIn, YouTube, Pinterest | Someone at that company approves your app. Days to weeks. |

Specifics worth knowing before you start:

- **TikTok** forces every post to *private* until it audits your app. This is
  the slowest approval of the set.
- **Instagram** requires a Business/Creator account linked to a Facebook Page.
  Personal accounts cannot be posted to by any API, ever.
- **YouTube** gives you ~6 uploads/day on the default quota; more needs a
  separate Google review.
- **LinkedIn** posts as a person out of the box. Company Pages need a partner
  program.
- **Instagram, Threads, TikTok photo posts and Pinterest fetch your media from a
  URL** rather than accepting an upload — so `APP_URL` must be reachable from
  the public internet or those four cannot work at all.

The Accounts screen shows all of this per platform, so nothing is a surprise at
publish time.

---

## Setup

Requires Node 20+ and Postgres 14+.

```bash
npm install

# Postgres: use the bundled compose file...
docker compose up -d db
# ...or point DATABASE_URL at any Postgres you already have.

cp .env.example .env
openssl rand -base64 32          # paste into ENCRYPTION_KEY

npm run db:push                  # create the schema
npm run setup                     # verify everything, list what is ready
npm run dev:all                   # web + worker together
```

Open http://localhost:3000, create an account, and connect a destination.
Bluesky is the fastest way to see it work end to end.

Optional: `brew install ffmpeg` so video duration and dimensions are validated
in the composer rather than rejected by the platform later.

### Making media reachable (needed for Instagram, Threads, TikTok, Pinterest)

```bash
cloudflared tunnel --url http://localhost:3000
# put the https URL it prints into APP_URL, restart
```

---

## How it works

```
composer ──> post ──> post_targets (one row per destination)
                            │
                            ├─> job ─> worker ─> adapter.publish() ─> X
                            ├─> job ─> worker ─> adapter.publish() ─> Instagram
                            └─> job ─> worker ─> adapter.publish() ─> TikTok
```

**One job per destination, not one per post.** This is the central design
decision. A TikTok transcode that takes four minutes does not hold up the X
post; a LinkedIn failure retries only LinkedIn; and a post that lands on five
platforms and fails on one is `partial`, showing you exactly which one and why.

**Validation happens before anything is sent.** Each adapter declares its real
limits (character count, file size, duration, aspect ratio, required fields) and
the composer checks against them as you type. A 400-character body is caught
while it is still editable rather than after it has already gone live on three
other platforms.

**Tokens are encrypted at rest** with AES-256-GCM under `ENCRYPTION_KEY`, and
refreshed automatically when they are within ten minutes of expiry. An account
whose refresh fails is flagged `needs_reauth` instead of failing silently.

**The queue is Postgres**, claimed with `FOR UPDATE SKIP LOCKED`. No Redis. Run
as many workers as you like; they will not collide, and jobs orphaned by a crash
are reclaimed after 30 minutes.

### Layout

```
src/
  platforms/        one file per platform + the adapter contract
    types.ts        PlatformAdapter, Capabilities, PublishError
    validate.ts     capability engine shared by composer and worker
  lib/
    publish.ts      fan-out, per-target publish, status roll-up
    queue.ts        Postgres job queue
    accounts.ts     token storage, refresh, reauth flagging
    oauth/          per-provider OAuth + destination discovery
    crypto.ts       AES-256-GCM token encryption, scrypt passwords
  worker/           the publish worker
  app/              Next.js dashboard + API routes
```

### Adding a platform

Write one file in `src/platforms/`, implement `PlatformAdapter`, register it in
`src/platforms/index.ts`. The composer, validation, queue, retry and status
roll-up all pick it up with no further changes.

---

## Operating notes

- `npm run worker` runs the publisher. **Nothing publishes without it.**
- Scheduled posts fire from the same worker — there is no separate cron.
- Media at `/api/media/:id/raw` is intentionally unauthenticated, because the
  four pull-based platforms fetch it with no credentials of ours. IDs are random
  UUIDs, but treat anything attached to those platforms as public.
- Roles: `owner` and `admin` can connect and remove accounts; `member` can
  compose and publish.

## License

MIT
