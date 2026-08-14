# Deploying a live version, free

Free hosts will not run a persistent background process, so this setup replaces
the worker with a scheduled HTTP call. Everything else is unchanged.

| Piece | Service | Free tier |
|---|---|---|
| Web + API | Vercel | Hobby, no sleep |
| Postgres | Neon | 0.5 GB, no sleep |
| Media | Cloudflare R2 | 10 GB, zero egress |
| Queue draining | GitHub Actions cron | 2000 min/month |

**Know this before you start:** Vercel Hobby kills a function at 60 seconds.
Text, images and short video are fine. A large TikTok or YouTube upload can
exceed it — the job retries and the next run resumes, but very large video
eventually wants a real worker (see the bottom of this file).

---

## 1. Postgres — Neon

1. neon.tech, new project.
2. Copy the **pooled** connection string (the host contains `-pooler`). The app
   opens one connection per serverless instance, so the pooler matters.
3. Locally, put it in `.env` and run `npm run db:push` to create the schema.

## 2. Media — Cloudflare R2

1. Cloudflare dashboard → R2 → create a bucket.
2. Settings → **Public access** → enable `r2.dev`. Copy that public URL.
3. R2 → **Manage API tokens** → create one with *Object Read & Write*. Copy the
   access key ID, secret, and your account ID.
4. Bucket → Settings → **CORS policy**. Without this the browser cannot upload:

```json
[
  {
    "AllowedOrigins": ["https://your-app.vercel.app"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

## 3. Web — Vercel

1. vercel.com → Add New → Project → import `all-uploader`.
2. Framework preset: Next.js. Nothing to override.
3. Add environment variables:

```
DATABASE_URL          postgres://...-pooler.../neondb?sslmode=require
ENCRYPTION_KEY        openssl rand -base64 32
CRON_SECRET           openssl rand -hex 32
APP_URL               https://your-app.vercel.app

S3_BUCKET             all-uploader
S3_ENDPOINT           https://<account-id>.r2.cloudflarestorage.com
S3_REGION             auto
S3_ACCESS_KEY_ID      ...
S3_SECRET_ACCESS_KEY  ...
S3_PUBLIC_URL         https://pub-<hash>.r2.dev
```

4. Deploy. Then set `APP_URL` to the real URL it gives you and redeploy, because
   OAuth callbacks and media URLs are built from it.

**Keep `ENCRYPTION_KEY` safe.** Losing it means reconnecting every social
account; leaking it means someone can post as you everywhere.

## 4. The worker — GitHub Actions

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `APP_URL` | `https://your-app.vercel.app` |
| `CRON_SECRET` | the same value you set on Vercel |

`.github/workflows/drain.yml` then calls `/api/cron/drain` every five minutes.
Run it once by hand from the Actions tab to confirm it works — it prints the
number of jobs claimed and published.

GitHub's scheduler is best-effort and runs late under load, so treat five
minutes as a floor. **"Publish now" does not depend on it**: the app kicks its
own queue on publish and on retry. The schedule exists for posts you scheduled
ahead and for retrying failures.

## 5. Connect the platforms

`https://your-app.vercel.app` is public HTTPS, which is exactly what Instagram,
Threads, TikTok photo posts and Pinterest need — they fetch media rather than
accepting an upload. With `S3_PUBLIC_URL` set they read straight from R2.

Every OAuth callback URL is `{APP_URL}/api/oauth/{platform}/callback`. Register
them in each platform's developer console; `.env.example` lists them per
platform.

Fastest proof it works: connect Bluesky (an app password from your own
settings, no review) and publish.

---

## Verify the deploy

```bash
curl https://your-app.vercel.app/api/platforms          # 13 platforms
curl https://your-app.vercel.app/api/cron/drain         # 401 without the secret
curl -H "Authorization: Bearer $CRON_SECRET" \
     https://your-app.vercel.app/api/cron/drain         # {"claimed":0,...}
```

A 503 from the drain endpoint means `CRON_SECRET` is not set on the host. It
refuses to run rather than defaulting open.

## Other hosts

The code has no Vercel dependency. It needs a Node runtime, Postgres, and
either S3 or a shared disk.

- **Railway / Render / Fly** — run `npm run worker` as a second service and skip
  the cron workflow entirely. No function timeout, so large video uploads work.
  Not free.
- **Any VPS** — `docker compose up -d db`, `npm run build`, then run
  `npm start` and `npm run worker` under systemd or pm2. Local disk storage is
  fine here because both processes share it.

If you outgrow the 60-second limit, the cheapest fix is a single small box
running only `npm run worker` against the same database. Nothing else changes —
the queue is in Postgres, so a worker anywhere can drain it.
