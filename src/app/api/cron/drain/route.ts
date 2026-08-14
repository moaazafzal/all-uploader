import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { drain } from '@/lib/drain'

// Node runtime: the adapters use fs, streams and the AWS SDK.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Hobby plans cap this lower; the drain budget stays under whatever applies.
export const maxDuration = 60

/**
 * The worker, for deployments with no worker. Called on a schedule (GitHub
 * Actions, cron-job.org, Vercel Cron) to publish anything due.
 *
 * Authenticated with a shared secret because this endpoint causes real posts
 * to go out. Without CRON_SECRET set it refuses to run rather than defaulting
 * open.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not set; refusing to expose the drain endpoint.' },
      { status: 503 },
    )
  }

  const url = new URL(req.url)
  const presented =
    req.headers.get('authorization')?.replace(/^Bearer /i, '') ??
    url.searchParams.get('key') ??
    ''

  if (!timingSafeEqual(presented, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const budgetMs = Math.min(Number(url.searchParams.get('budgetMs') ?? 45_000), 280_000)
  const result = await drain({ budgetMs })
  return NextResponse.json(result)
}

export const POST = GET

/** Constant-time compare that does not leak length through an early return. */
function timingSafeEqual(a: string, b: string) {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}
