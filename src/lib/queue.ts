import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { Job } from '@/db/schema'

/**
 * Postgres-backed queue. FOR UPDATE SKIP LOCKED lets several workers claim
 * disjoint rows in one statement, which is the whole reason this project needs
 * no Redis. The dedupe index makes double-enqueue harmless.
 */

// runAt is passed as an ISO string with an explicit cast: the raw sql template
// binds parameters through postgres.js, which does not serialize a Date here.
export async function enqueue(input: {
  kind: string
  payload: Record<string, unknown>
  runAt?: Date
  dedupeKey?: string
  maxAttempts?: number
}) {
  const rows = await db.execute<Job>(sql`
    insert into jobs (kind, payload, run_at, dedupe_key, max_attempts)
    values (
      ${input.kind},
      ${JSON.stringify(input.payload)}::jsonb,
      ${(input.runAt ?? new Date()).toISOString()}::timestamptz,
      ${input.dedupeKey ?? null},
      ${input.maxAttempts ?? 5}
    )
    on conflict do nothing
    returning *
  `)
  return rows[0] ?? null
}

/** Claim up to `limit` due jobs atomically. */
export async function claim(workerId: string, limit = 1): Promise<Job[]> {
  return db.execute<Job>(sql`
    update jobs
    set status = 'running',
        locked_at = now(),
        locked_by = ${workerId},
        attempts = attempts + 1
    where id in (
      select id from jobs
      where status = 'queued' and run_at <= now()
      order by run_at
      for update skip locked
      limit ${limit}
    )
    returning *
  `)
}

export async function complete(jobId: string) {
  await db.execute(sql`update jobs set status = 'done', locked_at = null, locked_by = null where id = ${jobId}`)
}

/** Exponential backoff with a ceiling; gives up once attempts hits max_attempts. */
export async function fail(jobId: string, error: string, retryable: boolean) {
  await db.execute(sql`
    update jobs
    set status = case
          when ${retryable} and attempts < max_attempts then 'queued'
          else 'failed'
        end,
        run_at = case
          when ${retryable} and attempts < max_attempts
          then now() + (least(power(3, attempts) * interval '10 seconds', interval '1 hour'))
          else run_at
        end,
        last_error = ${error.slice(0, 2000)},
        locked_at = null,
        locked_by = null
    where id = ${jobId}
  `)
}

/**
 * A worker that dies mid-job leaves the row 'running' forever. Anything locked
 * longer than the timeout is assumed dead and returned to the queue.
 */
export async function reclaimStalled(timeoutMinutes = 30) {
  const rows = await db.execute<{ id: string }>(sql`
    update jobs
    set status = 'queued', locked_at = null, locked_by = null
    where status = 'running'
      and locked_at < now() - (${timeoutMinutes} * interval '1 minute')
    returning id
  `)
  return rows.length
}
