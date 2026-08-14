import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets } from '@/db/schema'
import { pathFor } from '@/lib/storage'

/**
 * Deliberately unauthenticated: Instagram, Threads, TikTok and Pinterest fetch
 * media from this URL with no credentials of ours. The id is a random UUID, so
 * the URL is unguessable, but treat anything uploaded here as public once it
 * has been attached to a post for one of those platforms.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1)
  if (!row) return new Response('Not found', { status: 404 })

  const file = pathFor(row.storageKey)
  if (!fs.existsSync(file)) return new Response('Not found', { status: 404 })

  const total = row.bytes
  const range = req.headers.get('range')
  const headers: Record<string, string> = {
    'Content-Type': row.mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  }

  // Range support matters: Meta and TikTok probe video files with partial
  // requests before downloading them.
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m?.[1] ? Number(m[1]) : 0
    const end = m?.[2] ? Number(m[2]) : total - 1
    if (start >= total) return new Response('Range not satisfiable', { status: 416 })
    const stream = fs.createReadStream(file, { start, end })
    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) },
    })
  }

  return new Response(fs.createReadStream(file) as unknown as ReadableStream, {
    headers: { ...headers, 'Content-Length': String(total) },
  })
}
