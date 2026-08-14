import type { Capabilities, Issue, PlatformAdapter, ResolvedMedia } from './types'

const MB = (n: number) => `${(n / 1_000_000).toFixed(0)}MB`
const ext = (m: ResolvedMedia) => m.filename.split('.').pop()?.toLowerCase() ?? ''

/**
 * Generic capability check, driven purely by the adapter's declared limits.
 * The point is to fail in the composer, not halfway through a fan-out: a post
 * that is 400 chars is rejected for X before anything reaches Instagram.
 */
export function checkCapabilities(
  caps: Capabilities,
  input: { text: string; media: ResolvedMedia[]; options: Record<string, unknown> },
): Issue[] {
  const issues: Issue[] = []
  const { text, media, options } = input
  const images = media.filter((m) => m.kind === 'image')
  const videos = media.filter((m) => m.kind === 'video')

  if (text.length > caps.maxTextLength) {
    issues.push({
      level: 'error',
      field: 'text',
      message: `Text is ${text.length} characters, limit is ${caps.maxTextLength}.`,
    })
  }
  if (!text.trim() && !caps.textOptional && media.length === 0) {
    issues.push({ level: 'error', field: 'text', message: 'Text is required.' })
  }
  if (caps.requiresMedia && media.length === 0) {
    issues.push({ level: 'error', field: 'media', message: 'This platform cannot post text on its own -- attach an image or video.' })
  }
  if (images.length > 0 && videos.length > 0 && !caps.mixedMedia) {
    issues.push({ level: 'error', field: 'media', message: 'Images and video cannot be combined in one post here.' })
  }

  if (images.length > 0) {
    if (!caps.image) {
      issues.push({ level: 'error', field: 'media', message: 'Images are not supported here.' })
    } else {
      issues.push(...checkGroup(images, caps.image, 'image'))
    }
  }
  if (videos.length > 0) {
    if (!caps.video) {
      issues.push({ level: 'error', field: 'media', message: 'Video is not supported here.' })
    } else {
      issues.push(...checkGroup(videos, caps.video, 'video'))
    }
  }

  for (const field of caps.options ?? []) {
    if (!field.required) continue
    const v = options[field.key]
    if (v === undefined || v === null || v === '') {
      issues.push({ level: 'error', field: 'options', message: `${field.label} is required.` })
    }
  }

  return issues
}

function checkGroup(items: ResolvedMedia[], spec: import('./types').MediaSpec, kind: 'image' | 'video'): Issue[] {
  const issues: Issue[] = []

  if (items.length > spec.maxCount) {
    issues.push({
      level: 'error',
      field: 'media',
      message: `${items.length} ${kind}s attached, maximum is ${spec.maxCount}.`,
    })
  }

  for (const m of items) {
    if (spec.formats.length && !spec.formats.includes(ext(m))) {
      issues.push({ level: 'error', field: 'media', message: `${m.filename}: .${ext(m)} is not accepted (allowed: ${spec.formats.join(', ')}).` })
    }
    if (m.bytes > spec.maxBytes) {
      issues.push({ level: 'error', field: 'media', message: `${m.filename} is ${MB(m.bytes)}, limit is ${MB(spec.maxBytes)}.` })
    }
    if (m.width && spec.minWidth && m.width < spec.minWidth) {
      issues.push({ level: 'error', field: 'media', message: `${m.filename} is ${m.width}px wide, minimum is ${spec.minWidth}px.` })
    }
    if (m.height && spec.minHeight && m.height < spec.minHeight) {
      issues.push({ level: 'error', field: 'media', message: `${m.filename} is ${m.height}px tall, minimum is ${spec.minHeight}px.` })
    }
    if (m.durationMs != null) {
      const sec = m.durationMs / 1000
      if (spec.maxDurationSec && sec > spec.maxDurationSec) {
        issues.push({ level: 'error', field: 'media', message: `${m.filename} runs ${sec.toFixed(1)}s, maximum is ${spec.maxDurationSec}s.` })
      }
      if (spec.minDurationSec && sec < spec.minDurationSec) {
        issues.push({ level: 'error', field: 'media', message: `${m.filename} runs ${sec.toFixed(1)}s, minimum is ${spec.minDurationSec}s.` })
      }
    }
    if (spec.aspectRatio && m.width && m.height) {
      const r = m.width / m.height
      const [lo, hi] = spec.aspectRatio
      if (r < lo || r > hi) {
        issues.push({
          level: 'warning',
          field: 'media',
          message: `${m.filename} has a ${r.toFixed(2)}:1 ratio; this platform expects between ${lo}:1 and ${hi}:1 and will crop.`,
        })
      }
    }
  }

  return issues
}

/** Full pre-flight for one destination: generic limits plus adapter-specific rules. */
export function validateForAdapter(
  adapter: PlatformAdapter,
  input: { text: string; media: ResolvedMedia[]; options: Record<string, unknown> },
): Issue[] {
  const issues = checkCapabilities(adapter.capabilities, input)
  if (adapter.validate) issues.push(...adapter.validate({ ...input }))
  return issues
}
