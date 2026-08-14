import { api, form } from '@/platforms/http'
import { OAUTH_PROVIDERS, redirectUri } from './providers'
import type { PlatformId } from '@/platforms'

export interface RawTokens {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
  scopes?: string[]
  /** Provider-specific extras, e.g. TikTok's open_id. */
  extra?: Record<string, unknown>
}

/** Shape shared by every provider's token endpoint, plus TikTok's `data` nesting. */
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number | string
  scope?: string
  open_id?: string
  id_token?: string
  data?: TokenResponse
}

/** Authorization-code exchange, normalised across providers. */
export async function exchangeCode(
  platform: PlatformId,
  code: string,
  codeVerifier?: string | null,
): Promise<RawTokens> {
  const p = OAUTH_PROVIDERS[platform]
  if (!p) throw new Error(`${platform} does not use OAuth`)

  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(platform),
  }
  if (codeVerifier) params.code_verifier = codeVerifier

  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (p.tokenAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${p.clientId()}:${p.clientSecret()}`).toString('base64')}`
    // X still wants client_id in the body alongside Basic auth for PKCE flows.
    if (platform === 'x') params.client_id = p.clientId()!
  } else if (platform === 'tiktok') {
    // TikTok is the one provider that renamed the standard fields.
    params.client_key = p.clientId()!
    params.client_secret = p.clientSecret()!
  } else {
    params.client_id = p.clientId()!
    params.client_secret = p.clientSecret()!
  }
  if (platform === 'reddit') headers['User-Agent'] = process.env.REDDIT_USER_AGENT ?? 'all-uploader/1.0'

  const res = await api<TokenResponse>(p.tokenUrl, {
    label: `${platform} token exchange`,
    method: 'POST',
    headers,
    body: form(params),
  })

  // TikTok nests some responses under data, others at the root.
  const body: TokenResponse = res.data?.access_token ? res.data : res
  const expiresIn = Number(body.expires_in ?? 0)

  return {
    accessToken: body.access_token!,
    refreshToken: body.refresh_token ?? null,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    scopes: typeof body.scope === 'string' ? body.scope.split(/[ ,]/).filter(Boolean) : undefined,
    extra: { open_id: body.open_id, id_token: body.id_token },
  }
}

export function buildAuthorizeUrl(
  platform: PlatformId,
  state: string,
  challenge?: string,
): string {
  const p = OAUTH_PROVIDERS[platform]
  if (!p) throw new Error(`${platform} does not use OAuth`)
  const sep = p.scopeSeparator ?? ' '

  const q = new URLSearchParams({
    response_type: 'code',
    redirect_uri: redirectUri(platform),
    state,
    scope: p.scopes.join(sep),
    ...(p.extraAuthParams ?? {}),
  })
  // TikTok's authorize endpoint also uses client_key, not client_id.
  q.set(platform === 'tiktok' ? 'client_key' : 'client_id', p.clientId()!)
  if (p.pkce && challenge) {
    q.set('code_challenge', challenge)
    q.set('code_challenge_method', 'S256')
  }
  return `${p.authorizeUrl}?${q}`
}
