import crypto from 'node:crypto'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { requireMembership } from '@/lib/auth'
import { usingS3 } from '@/lib/storage'
import { bad, handle } from '@/lib/api'

export const runtime = 'nodejs'

/**
 * Hands the browser a URL it can PUT the file to directly.
 *
 * Serverless platforms cap request bodies well below video size (4.5MB on
 * Vercel), so routing uploads through the API would make video impossible.
 * Going straight to the bucket sidesteps the limit and keeps large files off
 * the function entirely.
 */
export async function POST(req: Request) {
  return handle(async () => {
    if (!usingS3) throw bad('Direct upload needs S3 storage; this deployment writes to local disk.')

    const { workspaceId, filename, mimeType, bytes } = await req.json()
    if (!workspaceId || !filename) throw bad('workspaceId and filename are required')
    await requireMembership(workspaceId)

    const max = Number(process.env.MAX_UPLOAD_BYTES ?? 2_000_000_000)
    if (Number(bytes) > max) throw bad(`That file is larger than the ${(max / 1e9).toFixed(1)}GB limit.`)

    const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120)
    // Random prefix, not a content hash: the bytes are still in the browser.
    const storageKey = `${workspaceId}/${crypto.randomBytes(8).toString('hex')}-${safe}`

    const client = new S3Client({
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    })

    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET!,
        Key: storageKey,
        ContentType: mimeType || 'application/octet-stream',
      }),
      { expiresIn: 3600 },
    )

    return { uploadUrl, storageKey }
  })
}
