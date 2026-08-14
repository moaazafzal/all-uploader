import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'

const exec = promisify(execFile)

/**
 * Two storage backends. Local disk is fine when web and worker share a
 * filesystem. In a serverless deploy they do not, so anything real uses S3 --
 * which also solves the public-URL requirement for the platforms that fetch
 * media themselves instead of accepting an upload.
 */
export const usingS3 = Boolean(process.env.S3_BUCKET)

export const STORAGE_ROOT = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(process.cwd(), 'storage', 'media')

export const appUrl = () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')

let client: S3Client | null = null
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
      // R2 and most S3-compatible providers require path-style addressing.
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    })
  }
  return client
}

export interface StoredFile {
  storageKey: string
  bytes: number
  checksum: string
  kind: 'image' | 'video'
  width: number | null
  height: number | null
  durationMs: number | null
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'])

export function kindFor(filename: string, mimeType: string): 'image' | 'video' {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  throw new Error(`Cannot tell whether ${filename} is an image or a video.`)
}

export async function store(workspaceId: string, filename: string, mimeType: string, data: Buffer): Promise<StoredFile> {
  const checksum = crypto.createHash('sha256').update(data).digest('hex')
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120)
  const storageKey = `${workspaceId}/${checksum.slice(0, 16)}-${safe}`
  const kind = kindFor(filename, mimeType)

  // Probing needs a real file on disk either way; S3 uploads from a temp copy.
  const scratch = usingS3
    ? path.join(os.tmpdir(), `au-${checksum.slice(0, 16)}-${safe}`)
    : path.join(STORAGE_ROOT, storageKey)
  await fs.mkdir(path.dirname(scratch), { recursive: true })
  await fs.writeFile(scratch, data)

  const probed = kind === 'image' ? await probeImage(scratch) : await probeVideo(scratch)

  if (usingS3) {
    await s3().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET!,
        Key: storageKey,
        Body: data,
        ContentType: mimeType || 'application/octet-stream',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )
    await fs.unlink(scratch).catch(() => {})
  }

  return { storageKey, bytes: data.length, checksum, kind, ...probed }
}

/**
 * Adapters need a real path on disk (chunked uploads, multipart bodies). With
 * S3 the object is pulled into the OS temp directory first; the caller is
 * expected to leave cleanup to the process exiting.
 */
export async function localCopy(storageKey: string): Promise<string> {
  if (!usingS3) return path.join(STORAGE_ROOT, storageKey)

  const cached = path.join(os.tmpdir(), 'au-media', storageKey.replace(/\//g, '_'))
  try {
    await fs.access(cached)
    return cached
  } catch {
    // not cached yet
  }

  const res = await s3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: storageKey }))
  const body = Buffer.from(await res.Body!.transformToByteArray())
  await fs.mkdir(path.dirname(cached), { recursive: true })
  await fs.writeFile(cached, body)
  return cached
}

export async function remove(storageKey: string) {
  if (usingS3) {
    await s3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: storageKey })).catch(() => {})
  } else {
    await fs.unlink(path.join(STORAGE_ROOT, storageKey)).catch(() => {})
  }
}

/**
 * Public URL for the asset. Instagram, Threads, TikTok photo posts and
 * Pinterest fetch media from here with no credentials of ours, so it has to
 * resolve from the public internet for those platforms to work at all.
 *
 * With an S3 public base URL the platforms hit the bucket directly, which
 * avoids proxying large videos through a serverless function.
 */
export function publicUrlFor(mediaId: string, storageKey?: string) {
  const base = process.env.S3_PUBLIC_URL?.replace(/\/$/, '')
  if (base && storageKey) return `${base}/${storageKey}`
  return `${appUrl()}/api/media/${mediaId}/raw`
}

async function probeImage(file: string) {
  try {
    const meta = await sharp(file).metadata()
    return { width: meta.width ?? null, height: meta.height ?? null, durationMs: null }
  } catch {
    return { width: null, height: null, durationMs: null }
  }
}

/**
 * ffprobe if it is on PATH, otherwise null dimensions. Without it, duration and
 * aspect-ratio checks are skipped and the platform rejects the file instead of
 * the composer -- worse, but not fatal. Serverless hosts have no ffprobe.
 */
async function probeVideo(file: string) {
  try {
    const { stdout } = await exec('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      file,
    ])
    const j = JSON.parse(stdout)
    const stream = j.streams?.[0] ?? {}
    const duration = Number(j.format?.duration ?? 0)
    return {
      width: stream.width ?? null,
      height: stream.height ?? null,
      durationMs: duration ? Math.round(duration * 1000) : null,
    }
  } catch {
    return { width: null, height: null, durationMs: null }
  }
}

export async function hasFfprobe(): Promise<boolean> {
  try {
    await exec('ffprobe', ['-version'])
    return true
  } catch {
    return false
  }
}
