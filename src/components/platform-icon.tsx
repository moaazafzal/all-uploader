/** Monogram chip -- no external icon fonts, no network requests. */
export default function PlatformIcon({ platform, color, size = 32 }: { platform: string; color: string; size?: number }) {
  const letter = platform === 'x' ? 'X' : platform.slice(0, 1).toUpperCase()
  return (
    <span
      className="inline-grid place-items-center rounded-md font-bold text-white shrink-0"
      style={{ background: color, width: size, height: size, fontSize: size * 0.45 }}
      title={platform}
    >
      {letter}
    </span>
  )
}
