/**
 * Preflight check. Confirms the database is reachable, the encryption key is
 * usable, and reports which platforms are ready to connect.
 */
import postgres from 'postgres'
import { adapters, SETUP_TIER } from '../src/platforms'
import { isConfigured } from '../src/lib/oauth/providers'
import { hasFfprobe } from '../src/lib/storage'
import type { PlatformId } from '../src/platforms'

const ok = (s: string) => console.log(`  ok    ${s}`)
const warn = (s: string) => console.log(`  warn  ${s}`)
const bad = (s: string) => console.log(`  FAIL  ${s}`)

async function main() {
  let failures = 0
  console.log('\nall-uploader setup check\n')

  console.log('Database')
  if (!process.env.DATABASE_URL) {
    bad('DATABASE_URL is not set')
    failures++
  } else {
    try {
      const sql = postgres(process.env.DATABASE_URL, { max: 1 })
      const [{ version }] = await sql`select version()`
      const tables = await sql`select tablename from pg_tables where schemaname = 'public'`
      ok(version.split(' ').slice(0, 2).join(' '))
      if (tables.length === 0) warn('no tables yet -- run: npm run db:push')
      else ok(`${tables.length} tables present`)
      await sql.end()
    } catch (err) {
      bad(`cannot connect: ${(err as Error).message}`)
      failures++
    }
  }

  console.log('\nEncryption')
  try {
    const { encrypt, decrypt } = await import('../src/lib/crypto')
    if (decrypt(encrypt('roundtrip')) !== 'roundtrip') throw new Error('roundtrip mismatch')
    ok('ENCRYPTION_KEY works')
  } catch (err) {
    bad((err as Error).message)
    failures++
  }

  console.log('\nPublic URL')
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000'
  if (appUrl.includes('localhost') || appUrl.includes('127.0.0.1')) {
    warn(`APP_URL is ${appUrl} -- Instagram, Threads, TikTok photo posts and Pinterest cannot fetch media from it.`)
    warn('Run a tunnel (cloudflared tunnel --url http://localhost:3000) and set APP_URL to the public address.')
  } else {
    ok(appUrl)
  }

  console.log('\nStorage')
  if (process.env.S3_BUCKET) {
    ok(`S3 bucket ${process.env.S3_BUCKET} via ${process.env.S3_ENDPOINT ?? 'AWS'}`)
    if (!process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
      bad('S3_BUCKET is set but the access keys are missing')
      failures++
    }
    if (process.env.S3_PUBLIC_URL) ok(`public base ${process.env.S3_PUBLIC_URL}`)
    else warn('S3_PUBLIC_URL is unset -- media is proxied through this app instead of served from the bucket')
  } else {
    warn('local disk storage -- only works when the web app and worker share a filesystem')
  }

  console.log('\nQueue')
  if (process.env.CRON_SECRET) {
    ok('CRON_SECRET set -- /api/cron/drain is available for scheduled draining')
  } else {
    warn('CRON_SECRET unset -- /api/cron/drain refuses to run. Fine if you run "npm run worker".')
  }

  console.log('\nMedia probing')
  if (await hasFfprobe()) ok('ffprobe found -- video duration and dimensions will be validated')
  else warn('ffprobe not found -- video duration checks are skipped (brew install ffmpeg)')

  console.log('\nPlatforms')
  const ready: string[] = []
  const missing: string[] = []
  for (const a of Object.values(adapters)) {
    const tier = SETUP_TIER[a.id as PlatformId]
    if (a.connect.kind !== 'oauth2') { ready.push(`${a.label} (no app registration needed)`); continue }
    if (isConfigured(a.id as PlatformId)) ready.push(`${a.label} (${tier.tier})`)
    else missing.push(a.label)
  }
  for (const r of ready) ok(r)
  if (missing.length) warn(`no credentials yet: ${missing.join(', ')}`)

  console.log(`\n${failures ? `${failures} blocking problem(s).` : 'Ready. Start with: npm run dev:all'}\n`)
  process.exit(failures ? 1 : 0)
}

main()
