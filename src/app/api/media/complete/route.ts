import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { db } from '@/db'
import { mediaAssets } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { kindFor, usingS3 } from '@/lib/storage'
import { bad, handle } from '@/lib/api'

export const runtime = 'nodejs'

/**
 * Records an asset the browser uploaded straight to the bucket.
 *
 * Dimensions and duration are measured in the browser, because the file never
 * passes through the server. That metadata only drives composer warnings, and
 * the size is re-read from the bucket rather than trusted, so a wrong value
 * costs a platform-side rejection at worst.
 */
export async function POST(req: Request) {
  return handle(async () => {
    if (!usingS3) throw bad('This deployment writes to local disk; upload through /api/media instead.')

    const { workspaceId, storageKey, filename, mimeType, width, height, durationMs } = await req.json()
    if (!workspaceId || !storageKey || !filename) throw bad('workspaceId, storageKey and filename are required')
    const { user } = await requireMembership(workspaceId)

    // The key is minted per workspace in /presign; re-check it here so a caller
    // cannot register an object belonging to another workspace.
    if (!String(storageKey).startsWith(`${workspaceId}/`)) throw bad('That storage key is not in this workspace.')

    const client = new S3Client({
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    })

    const head = await client
      .send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: storageKey }))
      .catch(() => {
        throw bad('That upload did not land in the bucket. Try again.')
      })

    const [row] = await db
      .insert(mediaAssets)
      .values({
        workspaceId,
        kind: kindFor(filename, mimeType ?? ''),
        filename,
        mimeType: mimeType || head.ContentType || 'application/octet-stream',
        bytes: head.ContentLength ?? 0,
        width: width ?? null,
        height: height ?? null,
        durationMs: durationMs ?? null,
        storageKey,
        checksum: head.ETag?.replace(/"/g, '') ?? null,
        uploadedByUserId: user.id,
      })
      .returning()

    return row
  })
}
