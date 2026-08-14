import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const STORAGE_ROOT = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(process.cwd(), 'storage', 'media')

export const appUrl = () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')

export interface StoredFile {
  storageKey: string
  absolutePath: string
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
  const absolutePath = path.join(STORAGE_ROOT, storageKey)

  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, data)

  const kind = kindFor(filename, mimeType)
  const probed = kind === 'image' ? await probeImage(absolutePath) : await probeVideo(absolutePath)

  return { storageKey, absolutePath, bytes: data.length, checksum, kind, ...probed }
}

export const pathFor = (storageKey: string) => path.join(STORAGE_ROOT, storageKey)

/**
 * Public URL for the asset. Instagram, Threads, TikTok photo posts and
 * Pinterest all fetch media themselves rather than accepting an upload, so this
 * has to resolve from the public internet for those platforms to work at all.
 */
export const publicUrlFor = (mediaId: string) => `${appUrl()}/api/media/${mediaId}/raw`

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
 * aspect-ratio validation is skipped and the platform rejects the file instead
 * of the composer -- worse, but not fatal.
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
