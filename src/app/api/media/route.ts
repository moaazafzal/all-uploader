import { db } from '@/db'
import { mediaAssets } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { store } from '@/lib/storage'
import { bad, handle } from '@/lib/api'

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 2_000_000_000)

export async function POST(req: Request) {
  return handle(async () => {
    const form = await req.formData()
    const workspaceId = String(form.get('workspaceId') ?? '')
    if (!workspaceId) throw bad('workspaceId is required')
    const { user } = await requireMembership(workspaceId)

    const files = form.getAll('files').filter((f): f is File => f instanceof File)
    if (!files.length) throw bad('No files were uploaded.')

    const saved = []
    for (const file of files) {
      if (file.size > MAX_BYTES) throw bad(`${file.name} is larger than the ${(MAX_BYTES / 1e9).toFixed(1)}GB upload limit.`)
      const buf = Buffer.from(await file.arrayBuffer())
      const stored = await store(workspaceId, file.name, file.type, buf)
      const [row] = await db
        .insert(mediaAssets)
        .values({
          workspaceId,
          kind: stored.kind,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          bytes: stored.bytes,
          width: stored.width,
          height: stored.height,
          durationMs: stored.durationMs,
          storageKey: stored.storageKey,
          checksum: stored.checksum,
          uploadedByUserId: user.id,
        })
        .returning()
      saved.push(row)
    }
    return saved
  })
}
