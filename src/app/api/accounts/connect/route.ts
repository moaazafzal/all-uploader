import { db } from '@/db'
import { auditLog } from '@/db/schema'
import { requireMembership } from '@/lib/auth'
import { saveAccount, publicAccount } from '@/lib/accounts'
import { bad, handle } from '@/lib/api'
import { getAdapter } from '@/platforms'
import { api, bearer } from '@/platforms/http'
import { AtpAgent } from '@atproto/api'

/**
 * Non-OAuth connections: Bluesky app password, Mastodon token, Telegram bot,
 * Discord webhook. Each is verified against the platform before it is stored,
 * so a typo surfaces here rather than at publish time.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const { workspaceId, platform, fields } = await req.json()
    if (!workspaceId || !platform) throw bad('workspaceId and platform are required')
    const { user } = await requireMembership(workspaceId, 'admin')

    const adapter = getAdapter(platform)
    if (adapter.connect.kind === 'oauth2') throw bad(`${adapter.label} connects through OAuth, not credentials.`)

    const verified = await verify(platform, fields ?? {})
    const row = await saveAccount({
      workspaceId,
      platform,
      ...verified,
      connectedByUserId: user.id,
    })

    await db.insert(auditLog).values({
      workspaceId, userId: user.id, action: 'account.connected', subject: platform, detail: { handle: row.handle },
    })
    return publicAccount(row)
  })
}

async function verify(platform: string, f: Record<string, string>) {
  switch (platform) {
    case 'bluesky': {
      const service = f.service || 'https://bsky.social'
      const agent = new AtpAgent({ service })
      try {
        await agent.login({ identifier: f.handle, password: f.appPassword })
      } catch (err) {
        throw bad(`Bluesky rejected those credentials: ${(err as Error).message}`)
      }
      const profile = await agent.getProfile({ actor: agent.session!.did })
      return {
        externalId: agent.session!.did,
        handle: profile.data.handle,
        displayName: profile.data.displayName ?? profile.data.handle,
        avatarUrl: profile.data.avatar ?? null,
        // The app password IS the credential for Bluesky; it is stored encrypted.
        accessToken: f.appPassword,
        refreshToken: null,
        tokenExpiresAt: null,
        meta: { service },
      }
    }
    case 'mastodon': {
      const host = f.instanceUrl.replace(/\/$/, '')
      const me = await api<{ id: string; username: string; display_name: string; avatar: string }>(
        `${host}/api/v1/accounts/verify_credentials`,
        { label: 'Mastodon verify', headers: bearer(f.accessToken) },
      ).catch(() => {
        throw bad('Mastodon rejected that token. Check the instance URL and that the token has write scope.')
      })
      return {
        externalId: me.id,
        handle: `@${me.username}@${new URL(host).host}`,
        displayName: me.display_name || me.username,
        avatarUrl: me.avatar ?? null,
        accessToken: f.accessToken,
        refreshToken: null,
        tokenExpiresAt: null,
        meta: { instanceUrl: host },
      }
    }
    case 'telegram': {
      const bot = await api<{ result: { id: number; username: string; first_name: string } }>(
        `https://api.telegram.org/bot${f.botToken}/getMe`,
        { label: 'Telegram getMe' },
      ).catch(() => {
        throw bad('Telegram rejected that bot token.')
      })
      // Confirm the bot can actually reach the target chat.
      const chat = await api<{ result: { id: number; title?: string; username?: string } }>(
        `https://api.telegram.org/bot${f.botToken}/getChat?chat_id=${encodeURIComponent(f.chatId)}`,
        { label: 'Telegram getChat' },
      ).catch(() => {
        throw bad(`The bot cannot see ${f.chatId}. Add @${bot.result.username} to the channel as an admin first.`)
      })
      return {
        externalId: String(chat.result.id),
        handle: chat.result.username ? `@${chat.result.username}` : String(chat.result.id),
        displayName: chat.result.title ?? `via @${bot.result.username}`,
        avatarUrl: null,
        accessToken: f.botToken,
        refreshToken: null,
        tokenExpiresAt: null,
        meta: { chatId: f.chatId, botUsername: bot.result.username },
      }
    }
    case 'discord': {
      const hook = await api<{ id: string; name: string; channel_id: string; guild_id?: string }>(f.webhookUrl, {
        label: 'Discord webhook check',
      }).catch(() => {
        throw bad('That webhook URL is not reachable. Copy it again from the channel settings.')
      })
      return {
        externalId: hook.id,
        handle: hook.name,
        displayName: f.username || hook.name,
        avatarUrl: null,
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
        meta: { webhookUrl: f.webhookUrl, channelId: hook.channel_id, username: f.username || null },
      }
    }
    default:
      throw bad(`${platform} cannot be connected this way.`)
  }
}
