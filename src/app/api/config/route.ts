import { usingS3 } from '@/lib/storage'
import { handle } from '@/lib/api'

/** Deployment shape the browser needs to know about. */
export async function GET() {
  return handle(async () => ({
    // When true the composer uploads straight to the bucket, bypassing the
    // request-body limit that would otherwise make video uploads impossible.
    directUpload: usingS3,
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 2_000_000_000),
  }))
}
