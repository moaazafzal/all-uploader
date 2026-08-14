import 'dotenv/config'
import os from 'node:os'
import { claim, complete, fail, reclaimStalled } from '@/lib/queue'
import { publishTarget } from '@/lib/publish'
import { PublishError } from '@/platforms'

const WORKER_ID = `${os.hostname()}-${process.pid}`
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000)
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4)

let running = true
let inFlight = 0

const stamp = () => new Date().toISOString().slice(11, 19)
const log = (msg: string) => console.log(`[${stamp()}] ${msg}`)

async function handle(job: Awaited<ReturnType<typeof claim>>[number]) {
  const label = `${job.kind}#${job.id.slice(0, 8)}`
  const jobLog = (m: string) => log(`  ${label} ${m}`)
  log(`${label} start (attempt ${job.attempts})`)

  try {
    switch (job.kind) {
      case 'publish_target':
        await publishTarget(String(job.payload.targetId), jobLog)
        break
      default:
        throw new PublishError(`Unknown job kind: ${job.kind}`)
    }
    await complete(job.id)
    log(`${label} done`)
  } catch (err) {
    const e = err as PublishError
    const retryable = e instanceof PublishError ? e.retryable : true
    await fail(job.id, e.message ?? String(err), retryable)
    log(`${label} ${retryable ? 'failed, will retry' : 'failed permanently'}: ${e.message}`)
  }
}

async function loop() {
  log(`worker ${WORKER_ID} up, concurrency ${CONCURRENCY}`)

  // Sweep once at boot so jobs orphaned by a previous crash come back.
  const reclaimed = await reclaimStalled().catch(() => 0)
  if (reclaimed) log(`reclaimed ${reclaimed} stalled job(s)`)

  let sinceSweep = 0
  while (running) {
    if (inFlight >= CONCURRENCY) {
      await sleep(POLL_MS)
      continue
    }
    let jobs: Awaited<ReturnType<typeof claim>> = []
    try {
      jobs = await claim(WORKER_ID, CONCURRENCY - inFlight)
    } catch (err) {
      log(`claim failed: ${(err as Error).message}`)
      await sleep(5000)
      continue
    }

    if (!jobs.length) {
      await sleep(POLL_MS)
      if ((sinceSweep += POLL_MS) > 5 * 60_000) {
        sinceSweep = 0
        const n = await reclaimStalled().catch(() => 0)
        if (n) log(`reclaimed ${n} stalled job(s)`)
      }
      continue
    }

    for (const job of jobs) {
      inFlight++
      handle(job).finally(() => {
        inFlight--
      })
    }
  }

  log('draining...')
  while (inFlight > 0) await sleep(200)
  log('worker stopped')
  process.exit(0)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (!running) process.exit(1)
    log(`${sig} received, finishing ${inFlight} in-flight job(s)`)
    running = false
  })
}

loop().catch((err) => {
  console.error('worker crashed:', err)
  process.exit(1)
})
