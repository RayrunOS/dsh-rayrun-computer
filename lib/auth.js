/**
 * Rayrun account login and automatic API-token creation.
 *
 * Password login talks to `<api>/auth/login`, keeps the returned
 * `rayrun_session` cookie in memory, and immediately exchanges it for a
 * personal API token through `<api>/tokens`. WeChat login is a browser OAuth
 * flow: the desktop Host opens a Rayrun login window, waits for the session
 * cookie in that window's Electron session, and then performs the same token
 * exchange through the dashboard BFF.
 *
 * Passwords and session cookies are never persisted or logged.
 */
import { hostname } from 'node:os'
import { LocalError } from './rayrun.js'

const LOGIN_TIMEOUT = 25000
const TOKEN_TIMEOUT = 20000

function deadline(ms = LOGIN_TIMEOUT) {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

/** Dashboard origin that fronts the browser BFF for this API deployment. */
export function dashboardBaseFor(baseUrl) {
  const url = new URL(baseUrl)
  if (url.hostname === 'api.rayrunos.com') return 'https://dashboard.rayrunos.com'
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    return `${url.protocol}//${url.hostname}:5173`
  }
  return url.origin
}

/** One user-facing token name; the plaintext is shown only to this process. */
export function tokenNameFor() {
  const host = String(hostname() || 'local').slice(0, 40)
  return `DeepSeek Harness (${host})`
}

async function failure(res, fallbackCode) {
  let text = ''
  try {
    text = await res.text()
  } catch {
    // ignore unreadable bodies
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  const code = typeof data?.error === 'string' ? data.error : fallbackCode
  const message =
    (typeof data?.message === 'string' && data.message) ||
    (typeof data?.details?.reason === 'string' && data.details.reason) ||
    text.trim().slice(0, 300) ||
    res.statusText ||
    'Rayrun request failed'
  const error = new LocalError(code, message)
  error.status = res.status
  const retry = Number(data?.retry_after_seconds ?? data?.details?.retry_after_seconds ?? 0)
  if (Number.isFinite(retry) && retry > 0) error.retryAfterSeconds = retry
  return error
}

/** Ask the dashboard BFF whether WeChat login is enabled for this deployment. */
export async function loginMethods(baseUrl) {
  const dashboardBase = dashboardBaseFor(baseUrl)
  const fallback = {
    wechat: false,
    dashboardBase,
    loginUrl: `${dashboardBase}/login`,
    wechatUrl: `${dashboardBase}/_api/v1/auth/wechat/login`,
  }
  try {
    const res = await fetch(`${dashboardBase}/_api/v1/auth/providers`, {
      headers: { Accept: 'application/json' },
      signal: deadline(8000),
    })
    if (!res.ok) return fallback
    const data = await res.json()
    return { ...fallback, wechat: data?.wechat === true }
  } catch {
    return fallback
  }
}

/** Exchange a logged-in session cookie for a new personal API token. */
async function createToken(tokenUrl, cookieHeader, name, extraHeaders = {}) {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      ...extraHeaders,
    },
    body: JSON.stringify({ name }),
    signal: deadline(TOKEN_TIMEOUT),
  })
  if (!res.ok) throw await failure(res, 'token_create_failed')
  const data = await res.json()
  if (!data || typeof data.token !== 'string' || !data.token) {
    throw new LocalError('token_create_failed', 'Rayrun did not return a token.')
  }
  return {
    token: data.token,
    tokenId: data.token_id ?? data.id ?? null,
    name: typeof data.name === 'string' ? data.name : name,
    expiresAt: data.expires_at ?? null,
    createdAt: data.created_at ?? null,
  }
}

/** Username/email + password login, followed by automatic token creation. */
export async function passwordLogin({ baseUrl, username, password, name = tokenNameFor() }) {
  if (!username || !username.trim()) throw new LocalError('username_required', 'Enter your Rayrun username or email.')
  if (!password) throw new LocalError('password_required', 'Enter your Rayrun password.')

  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password }),
    signal: deadline(LOGIN_TIMEOUT),
  })
  if (!res.ok) throw await failure(res, 'login_failed')

  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const cookieHeader = cookies.map((cookie) => cookie.split(';')[0]).join('; ')
  if (!/(^|;\s*)rayrun_session=/.test(cookieHeader)) {
    throw new LocalError('login_no_session', 'Rayrun accepted the login but returned no session cookie.')
  }

  const created = await createToken(`${baseUrl}/tokens`, cookieHeader, name)
  let user = null
  try {
    const me = await fetch(`${baseUrl}/auth/me`, {
      headers: { Accept: 'application/json', Cookie: cookieHeader },
      signal: deadline(8000),
    })
    if (me.ok) user = await me.json()
  } catch {
    // profile display is optional
  }
  return { ...created, user }
}

/** Create a token with a dashboard session cookie captured during WeChat login. */
export async function wechatToken({ baseUrl, cookie, name = tokenNameFor() }) {
  if (!cookie) throw new LocalError('login_no_session', 'The WeChat login produced no session cookie.')
  const dashboardBase = dashboardBaseFor(baseUrl)
  return createToken(`${dashboardBase}/_api/v1/tokens`, cookie, name, {
    Origin: dashboardBase,
    Referer: `${dashboardBase}/`,
  })
}

/** Best-effort revocation of a token created by this plugin. */
export async function revokeToken({ baseUrl, token, tokenId }) {
  if (!tokenId || !token) return false
  try {
    const res = await fetch(`${baseUrl}/tokens/${encodeURIComponent(tokenId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: deadline(10000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Map Rayrun/dashboard callback error codes to one actionable message. */
export function wechatErrorText(code) {
  switch (code) {
    case 'wechat_not_configured':
      return 'WeChat login is not enabled on this Rayrun deployment.'
    case 'wechat_state_invalid':
      return 'The WeChat login expired. Start it again.'
    case 'wechat_cancelled':
      return 'WeChat login was cancelled.'
    case 'wechat_provider_error':
      return 'WeChat authorization failed. Try again.'
    case 'wechat_registration_disabled':
      return 'Registration is closed; sign in with a password first, then bind WeChat.'
    case 'wechat_account_disabled':
      return 'This Rayrun account is disabled.'
    case 'wechat_unbound':
      return 'This WeChat was unbound; sign in with a password first.'
    case 'wechat_bound_elsewhere':
      return 'This WeChat is already bound to another Rayrun account.'
    case 'wechat_busy':
      return 'WeChat login is busy; try again in a moment.'
    default:
      return code ? `WeChat login failed: ${code}` : 'WeChat login failed.'
  }
}
