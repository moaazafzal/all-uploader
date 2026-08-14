import { claim, complete, fail, reclaimStalled } from './queue'
import { publishTarget } from './publish'
import { PublishError } from '@/platforms'

/**
 * Runs queued jobs inline instead of in a long-lived worker process.
 *
 * This exists because a serverless deploy has nowhere to keep a worker running.
 * The tradeoff is the platform's function timeout: `budgetMs` stops claiming new
 * work with enough margin to return cleanly, and anything still queued is picked
 * up by the next invocation. Jobs are claimed with FOR UPDATE SKIP LOCKED, so
 * two overlapping invocations never run the same job.
 */
export interface DrainResult {
  claimed: number
  done: number
  failed: number
  reclaimed: number
  timedOut: boolean
  log: string[]
}

export async function drain(opts: { budgetMs?: number; batch?: number } = {}): Promise<DrainResult> {
  const budgetMs = opts.budgetMs ?? 45_000
  const batch = opts.batch ?? 3
  const started = Date.now()
  const workerId = `drain-${Math.random().toString(36).slice(2, 8)}`

  const result: DrainResult = { claimed: 0, done: 0, failed: 0, reclaimed: 0, timedOut: false, log: [] }
  result.reclaimed = await reclaimStalled().catch(() => 0)

  while (Date.now() - started < budgetMs) {
    const jobs = await claim(workerId, batch)
    if (!jobs.length) break
    result.claimed += jobs.length

    // Concurrent within a batch: one slow video upload should not stop the
    // other destinations from going out in the same invocation.
    await Promise.all(
      jobs.map(async (job) => {
        const label = `${job.kind}#${job.id.slice(0, 8)}`
        try {
          switch (job.kind) {
            case 'publish_target':
              await publishTarget(String(job.payload.targetId), (m) => result.log.push(`${label} ${m}`))
              break
            default:
              throw new PublishError(`Unknown job kind: ${job.kind}`)
          }
          await complete(job.id)
          result.done++
          result.log.push(`${label} done`)
        } catch (err) {
          const e = err as PublishError
          const retryable = e instanceof PublishError ? e.retryable : true
          await fail(job.id, e.message ?? String(err), retryable)
          result.failed++
          result.log.push(`${label} ${retryable ? 'retry queued' : 'failed'}: ${e.message}`)
        }
      }),
    )
  }

  result.timedOut = Date.now() - started >= budgetMs
  return result
}
