import { adapters, SETUP_TIER } from '@/platforms'
import { isConfigured } from '@/lib/oauth/providers'
import { handle } from '@/lib/api'
import type { PlatformId } from '@/platforms'

/** Everything the composer and connect screen need to know about each platform. */
export async function GET() {
  return handle(async () =>
    Object.values(adapters).map((a) => ({
      id: a.id,
      label: a.label,
      color: a.color,
      capabilities: a.capabilities,
      connect: { kind: a.connect.kind, docsUrl: a.connect.docsUrl, fields: 'fields' in a.connect ? a.connect.fields : [] },
      caveats: a.caveats ?? [],
      setup: SETUP_TIER[a.id as PlatformId],
      configured: isConfigured(a.id as PlatformId),
    })),
  )
}
