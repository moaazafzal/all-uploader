'use client'

/**
 * Measure dimensions and duration in the browser.
 *
 * With direct-to-bucket uploads the file never reaches the server, so this is
 * the only chance to capture metadata. It feeds composer warnings only -- the
 * server re-reads the true byte size from the bucket.
 */
export async function probe(file: File): Promise<{ width: number | null; height: number | null; durationMs: number | null }> {
  const url = URL.createObjectURL(file)
  try {
    if (file.type.startsWith('image/')) {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('could not decode image'))
        img.src = url
      })
      return { width: img.naturalWidth, height: img.naturalHeight, durationMs: null }
    }

    if (file.type.startsWith('video/')) {
      const video = document.createElement('video')
      video.preload = 'metadata'
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('could not decode video'))
        video.src = url
      })
      return {
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
      }
    }
  } catch {
    // A codec the browser cannot decode is not fatal; the platform will judge it.
  } finally {
    URL.revokeObjectURL(url)
  }
  return { width: null, height: null, durationMs: null }
}

/** PUT straight to the bucket, reporting progress. XHR because fetch cannot report upload progress. */
export function putWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (HTTP ${xhr.status})`))
    xhr.onerror = () => reject(new Error('Upload failed -- check the bucket CORS policy allows PUT from this origin.'))
    xhr.send(file)
  })
}
