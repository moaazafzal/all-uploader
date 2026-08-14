import { NextResponse } from 'next/server'
import { HttpError } from './auth'
import { PublishError } from '@/platforms'

/** One place that turns thrown errors into responses, so routes stay flat. */
export function handle(fn: () => Promise<unknown>) {
  return fn().then(
    (data) => NextResponse.json(data ?? { ok: true }),
    (err) => {
      if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status })
      if (err instanceof PublishError) return NextResponse.json({ error: err.message }, { status: 400 })
      console.error(err)
      return NextResponse.json({ error: (err as Error).message ?? 'Something went wrong' }, { status: 500 })
    },
  )
}

export const bad = (message: string, status = 400) => new HttpError(status, message)
