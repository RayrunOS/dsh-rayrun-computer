/**
 * Rayrun REST client and local connection settings.
 *
 * This module owns everything that talks to a Rayrun deployment: the token and
 * base URL resolution order, the subset of the REST API the 云电脑 page and the
 * model-facing tools use, and the mapping from a Rayrun sandbox to the shape the
 * UI renders (including its published noVNC desktop URL).
 *
 * Only Node builtins are imported so the bundle stays self-contained.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const DEFAULT_BASE_URL = 'https://api.rayrunos.com/v1'
export const TOKEN_REF = 'RAYRUN_TOKEN'
export const DEFAULT_TOKEN_FILE = path.join(homedir(), '.rayrun', 'token')
export const SETTINGS_FILE = path.join(homedir(), '.rayrun', 'dsh.json')

const MAX_NAME = 64
const MIN_DESKTOP_MEMORY = 2048

/** A caller mistake or a local missing prerequisite, not an upstream failure. */
export class LocalError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LocalError'
    this.code = code
  }
}

/** A non-2xx answer from the Rayrun API. */
export class RayrunError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'RayrunError'
    this.status = status
    this.code = code
  }
}

function pick(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : value
}

/** Bound a request by both the caller's signal and a local deadline. */
function withTimeout(signal, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return signal
  if (typeof AbortSignal.timeout !== 'function') return signal
  const deadline = AbortSignal.timeout(timeoutMs)
  if (!signal) return deadline
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : deadline
}

/** Validate and canonicalise the deployment address: `<origin>/v1`. */
export function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return DEFAULT_BASE_URL
  let url
  try {
    url = new URL(text)
  } catch {
    throw new LocalError('invalid_base_url', `"${text}" is not an absolute URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LocalError('invalid_base_url', 'The Rayrun address must use http or https.')
  }
  return text.replace(/\/+$/, '')
}

/** Turn one error response into a single actionable message. */
async function failure(res) {
  let text = ''
  try {
    text = await res.text()
  } catch {
    // ignore unreadable bodies
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  let code = `http_${res.status}`
  let message = ''
  if (parsed && typeof parsed === 'object') {
    const error = parsed.error
    if (typeof error === 'string') {
      code = error
      const details = parsed.details
      if (details && typeof details === 'object') {
        message = [details.field, details.reason].filter(Boolean).join(': ')
      }
    } else if (error && typeof error === 'object') {
      code = typeof error.code === 'string' ? error.code : code
      message = String(error.message ?? error.detail ?? '')
    }
    if (!message && typeof parsed.message === 'string') message = parsed.message
  }
  if (!message && text) message = text.trim().slice(0, 400)
  if (!message) message = res.statusText || 'request failed'
  return new RayrunError(res.status, code, message)
}

/** One authenticated JSON call. `raw` hands the Response back for files/streams. */
async function api(baseUrl, token, method, route, options = {}) {
  const { json, body, headers, signal, timeoutMs = 30000, raw = false } = options
  const merged = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(headers ?? {}) }
  let payload = body
  if (json !== undefined) {
    merged['Content-Type'] = 'application/json'
    payload = JSON.stringify(json)
  }
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: merged,
    body: payload,
    signal: withTimeout(signal, timeoutMs),
  })
  if (!res.ok) throw await failure(res)
  if (raw) return res
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Resolve the desktop published for one sandbox, if the deployment returns one. */
export function desktopOf(sandbox) {
  const ingress = Array.isArray(sandbox?.ingress) ? sandbox.ingress : []
  const port = Number(sandbox?.desktop_port) || 0
  const entry = port ? ingress.find((item) => Number(item?.port) === port) : undefined
  const url = sandbox?.remote_desktop && entry && typeof entry.url === 'string' && entry.url ? entry.url : null
  let reason = null
  if (!sandbox?.remote_desktop) reason = 'not-enabled'
  else if (!entry) reason = 'not-published'
  else if (!url) reason = 'no-ingress'
  return { url, port, reason, visibility: entry?.visibility ?? null, protocol: entry?.protocol ?? null }
}

/** The compact sandbox shape both the page and the tools consume. */
export function shapeSandbox(sandbox) {
  const desktop = desktopOf(sandbox)
  return {
    id: String(sandbox.id ?? ''),
    name: sandbox.name ?? null,
    agent: sandbox.agent ?? '',
    status: String(sandbox.status ?? ''),
    cpu_cores: Number(sandbox.cpu_cores ?? 0),
    memory_mb: Number(sandbox.memory_mb ?? 0),
    workspace_mb: Number(sandbox.workspace_mb ?? 0),
    max_lifetime_seconds: sandbox.max_lifetime_seconds ?? null,
    ip: sandbox.ip ?? null,
    created_at: sandbox.created_at ?? null,
    destroyed_at: sandbox.destroyed_at ?? null,
    destroy_reason: sandbox.destroy_reason ?? null,
    remote_desktop: Boolean(sandbox.remote_desktop),
    desktop_port: desktop.port,
    desktop_url: desktop.url,
    desktop_reason: desktop.reason,
    desktop_visibility: desktop.visibility,
    agent_state: sandbox.agent_state ?? null,
    usage: sandbox.usage ?? null,
    pricing: sandbox.pricing ?? null,
    labels: sandbox.labels && typeof sandbox.labels === 'object' ? sandbox.labels : {},
    ingress: Array.isArray(sandbox.ingress)
      ? sandbox.ingress.map((item) => ({
          port: Number(item?.port) || 0,
          visibility: item?.visibility ?? null,
          protocol: item?.protocol ?? null,
          url: typeof item?.url === 'string' ? item.url : null,
        }))
      : [],
  }
}

/** The compact agent-image shape used by the create dialog. */
function shapeAgent(agent) {
  const name = String(agent?.name ?? '')
  const version = String(agent?.version ?? '')
  return {
    ref: version ? `${name}@${version}` : name,
    name,
    version,
    description: String(agent?.description ?? ''),
    supports_desktop: agent?.supports_desktop === true,
    desktop_port: Number(agent?.desktop_port ?? 0),
  }
}

const STATUS_RANK = { Running: 0, Paused: 1, Stopped: 2 }
const AGENT_REF = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const SANDBOX_ID = /^[0-9a-zA-Z-]{8,64}$/

/**
 * Build the operations object for one plugin row. `deps` supplies the harness
 * credential store seams; every call re-resolves the token, so a token saved in
 * the UI reaches the next operation without a reload.
 */
export function createRayrun(config = {}, deps = {}) {
  const settings = {
    baseUrl: config.baseUrl ? String(config.baseUrl) : undefined,
    token: typeof config.token === 'string' && config.token ? config.token : undefined,
    tokenFile: typeof config.token_file === 'string' && config.token_file ? config.token_file : DEFAULT_TOKEN_FILE,
    defaultAgent: String(pick(config.default_agent, pick(config.agent, 'ubuntu@1'))),
    cpuCores: Number(pick(config.cpu_cores, 2)),
    memoryMb: Number(pick(config.memory_mb, 2048)),
    workspaceMb: config.workspace_mb ? Number(config.workspace_mb) : undefined,
    egressAllow: Array.isArray(config.egress_allow) ? config.egress_allow.map(String) : [],
    credentials: Array.isArray(config.credentials) ? config.credentials.map(String) : [],
    autoCreate: config.autoCreate !== false,
    defaultTimeout: Number(pick(config.default_timeout_seconds, 300)),
    remoteDesktop: config.remote_desktop === true,
    sandboxName: String(pick(config.sandbox_name, pick(config.sandboxName, 'dsh-workspace'))),
  }

  async function readStored() {
    try {
      const text = await readFile(SETTINGS_FILE, 'utf8')
      const value = JSON.parse(text)
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  async function writeStored(patch) {
    const current = await readStored()
    const next = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null || value === '') delete next[key]
      else next[key] = value
    }
    await mkdir(path.dirname(SETTINGS_FILE), { recursive: true })
    await writeFile(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  }

  /** Resolve the token in precedence order: config, credential store, env, file. */
  async function token() {
    if (settings.token) return { value: settings.token, source: 'config' }
    if (typeof deps.lookupToken === 'function') {
      try {
        const stored = await deps.lookupToken()
        if (stored) return { value: String(stored), source: 'credentials' }
      } catch {
        // the store is optional; fall through to ambient sources
      }
    }
    const fromEnv = String(process.env.RAYRUN_TOKEN ?? '').trim()
    if (fromEnv) return { value: fromEnv, source: 'env' }
    try {
      const value = (await readFile(settings.tokenFile, 'utf8')).trim()
      if (value) return { value, source: 'file' }
    } catch {
      // no token file
    }
    return undefined
  }

  /** The address and token state the page shows, without ever returning the token. */
  async function connection() {
    const stored = await readStored()
    const envUrl = String(process.env.RAYRUN_API_URL ?? '').trim()
    const raw = stored.baseUrl || settings.baseUrl || envUrl || DEFAULT_BASE_URL
    const baseUrl = normalizeBaseUrl(raw)
    const baseUrlSource = stored.baseUrl ? 'saved' : settings.baseUrl ? 'config' : envUrl ? 'env' : 'default'
    const resolved = await token()
    return {
      baseUrl,
      baseUrlSource,
      configured: Boolean(resolved),
      tokenSource: resolved?.source ?? null,
      dashboardUrl: dashboardFor(baseUrl),
      autoToken: stored.autoToken ?? null,
    }
  }

  async function requireAuth() {
    const conn = await connection()
    const resolved = await token()
    if (!resolved) {
      throw new LocalError(
        'token_required',
        `No Rayrun token. Save one in the 云电脑 settings, write it to ${settings.tokenFile}, or set RAYRUN_TOKEN.`,
      )
    }
    return { baseUrl: conn.baseUrl, token: resolved.value }
  }

  /** Every live sandbox (terminated ones are hidden), running first. */
  async function listMachines() {
    const auth = await requireAuth()
    const result = await api(auth.baseUrl, auth.token, 'GET', '/sandboxes', { timeoutMs: 30000 })
    const list = Array.isArray(result?.sandboxes) ? result.sandboxes : []
    return list
      .filter((item) => item?.status !== 'Terminated')
      .map(shapeSandbox)
      .sort((a, b) => {
        const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
        if (rank !== 0) return rank
        return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
      })
  }

  async function machine(id) {
    if (!SANDBOX_ID.test(String(id ?? ''))) throw new LocalError('invalid_id', 'A sandbox id is required.')
    const auth = await requireAuth()
    const detail = await api(auth.baseUrl, auth.token, 'GET', `/sandboxes/${encodeURIComponent(id)}`, {
      timeoutMs: 30000,
    })
    return shapeSandbox(detail)
  }

  /** Poll one sandbox until `done` or the deadline; returns the last observation. */
  async function waitFor(id, done, timeoutMs = 60000, signal) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await machine(id)
      if (done(last)) return last
      if (signal?.aborted) return last
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    return last
  }

  /** Wake a stopped or paused machine so a desktop/exec call can use it. */
  async function wake(machineRef, signal) {
    let current = machineRef
    if (current.status === 'Paused') current = (await machineAction(current.id, 'resume')) ?? current
    else if (current.status === 'Stopped') current = (await machineAction(current.id, 'start')) ?? current
    else return current
    if (current.status === 'Running') return current
    return (await waitFor(current.id, (item) => item.status === 'Running', 60000, signal)) ?? current
  }

  function cleanName(value) {
    const text = String(value ?? '').trim()
    if (!text) return `cloud-${Math.random().toString(36).slice(2, 6)}`
    if (text.length > MAX_NAME) throw new LocalError('invalid_name', `Sandbox names are limited to ${MAX_NAME} characters.`)
    return text
  }

  async function createMachine(input = {}) {
    const auth = await requireAuth()
    const remote = input.remote_desktop !== false
    const agent = String(pick(input.agent, settings.defaultAgent)).trim()
    if (!AGENT_REF.test(agent)) throw new LocalError('invalid_agent', 'Pick an agent image such as ubuntu@1.')
    let memory = Math.max(512, Math.round(Number(pick(input.memory_mb, settings.memoryMb))))
    if (remote) memory = Math.max(MIN_DESKTOP_MEMORY, memory)
    const cpu = Math.max(1, Math.round(Number(pick(input.cpu_cores, settings.cpuCores))))
    const egress = Array.isArray(input.egress_allow)
      ? input.egress_allow.map(String).map((item) => item.trim()).filter(Boolean)
      : settings.egressAllow
    const credentials = Array.isArray(input.credentials) ? input.credentials.map(String).filter(Boolean) : settings.credentials
    const payload = {
      name: cleanName(input.name),
      agent,
      cpu_cores: cpu,
      memory_mb: memory,
      ...(input.workspace_mb ? { workspace_mb: Math.max(0, Math.round(Number(input.workspace_mb))) } : {}),
      ...(input.lifetime_seconds ? { max_lifetime_seconds: Math.max(1, Math.round(Number(input.lifetime_seconds))) } : {}),
      ...(remote ? { remote_desktop: true } : {}),
      ...(egress.length ? { egress: { allow: egress } } : {}),
      ...(credentials.length ? { credentials } : {}),
    }
    const created = await api(auth.baseUrl, auth.token, 'POST', '/sandboxes', {
      json: payload,
      timeoutMs: 180000,
    })
    return shapeSandbox(created)
  }

  async function machineAction(id, action, extra = {}) {
    if (!SANDBOX_ID.test(String(id ?? ''))) throw new LocalError('invalid_id', 'A sandbox id is required.')
    const auth = await requireAuth()
    const verb = String(action ?? '')
    if (verb === 'destroy') {
      await api(auth.baseUrl, auth.token, 'DELETE', `/sandboxes/${encodeURIComponent(id)}`, { timeoutMs: 60000 })
      return undefined
    }
    if (verb === 'rename') {
      const name = String(extra.name ?? '').trim()
      if (!name || name.length > MAX_NAME) throw new LocalError('invalid_name', 'A name of 1–64 characters is required.')
      await api(auth.baseUrl, auth.token, 'PUT', `/sandboxes/${encodeURIComponent(id)}/name`, {
        json: { name },
        timeoutMs: 30000,
      })
      return machine(id)
    }
    if (!['start', 'stop', 'pause', 'resume'].includes(verb)) {
      throw new LocalError('unsupported_action', `Unknown sandbox action "${verb}".`)
    }
    await api(auth.baseUrl, auth.token, 'POST', `/sandboxes/${encodeURIComponent(id)}/${verb}`, {
      timeoutMs: 120000,
    })
    try {
      return await machine(id)
    } catch {
      return undefined
    }
  }

  async function exec(id, payload, options = {}) {
    const auth = await requireAuth()
    return api(auth.baseUrl, auth.token, 'POST', `/sandboxes/${encodeURIComponent(id)}/exec`, {
      json: payload,
      timeoutMs: options.timeoutMs ?? 330000,
      signal: options.signal,
    })
  }

  async function listFiles(id, remotePath) {
    const auth = await requireAuth()
    const query = remotePath ? `?path=${encodeURIComponent(remotePath)}` : ''
    return api(auth.baseUrl, auth.token, 'GET', `/sandboxes/${encodeURIComponent(id)}/files${query}`, {
      timeoutMs: 60000,
    })
  }

  async function uploadFile(id, remotePath, payload, signal) {
    const auth = await requireAuth()
    const encoded = String(remotePath ?? '')
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')
    return api(auth.baseUrl, auth.token, 'PUT', `/sandboxes/${encodeURIComponent(id)}/files/${encoded}`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload,
      timeoutMs: 300000,
      signal,
    })
  }

  async function downloadFile(id, remotePath, signal) {
    const auth = await requireAuth()
    const encoded = String(remotePath ?? '')
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')
    return api(auth.baseUrl, auth.token, 'GET', `/sandboxes/${encodeURIComponent(id)}/files/${encoded}`, {
      raw: true,
      timeoutMs: 300000,
      signal,
    })
  }

  async function postPrompt(id, text, signal) {
    const auth = await requireAuth()
    return api(auth.baseUrl, auth.token, 'POST', `/sandboxes/${encodeURIComponent(id)}/prompts`, {
      json: { text },
      timeoutMs: 60000,
      signal,
    })
  }

  /** Open the SSE event stream; the caller reads and closes the body. */
  async function openEvents(id, signal) {
    const auth = await requireAuth()
    const res = await fetch(`${auth.baseUrl}/sandboxes/${encodeURIComponent(id)}/events`, {
      headers: { Authorization: `Bearer ${auth.token}`, Accept: 'text/event-stream' },
      signal,
    })
    if (!res.ok) throw await failure(res)
    return res
  }

  /** Ask the sandbox CLI for its noVNC password; the output is shown as-is. */
  async function desktopPassword(id) {
    return exec(id, { command: 'rayrun-desktop status', timeout_seconds: 20 }, { timeoutMs: 60000 })
  }

  /**
   * Repair the desktop image's empty /etc/hosts: websockify resolves its
   * upstream as `localhost:5900`, and without a localhost entry the ingress
   * WebSocket closes with 1011. Also starts the desktop service when needed.
   */
  async function repairDesktop(id) {
    const command = [
      "grep -qE '^127\\.0\\.0\\.1[[:space:]]+localhost([[:space:]]|$)' /etc/hosts 2>/dev/null || echo '127.0.0.1 localhost' >> /etc/hosts",
      "grep -qE '^::1[[:space:]]+localhost([[:space:]]|$)' /etc/hosts 2>/dev/null || echo '::1 localhost ip6-localhost ip6-loopback' >> /etc/hosts",
      "if command -v rayrun-desktop >/dev/null 2>&1; then rayrun-desktop status >/dev/null 2>&1 || rayrun-desktop start >/dev/null 2>&1 || true; fi",
      "getent hosts localhost >/dev/null 2>&1 || true",
      "printf 'desktop-hosts-ok\\n'",
    ].join('; ')
    return exec(id, { command, timeout_seconds: 60 }, { timeoutMs: 90000 })
  }

  async function overview() {
    const conn = await connection()
    const defaults = {
      agent: settings.defaultAgent,
      cpu_cores: settings.cpuCores,
      memory_mb: settings.memoryMb,
      remote_desktop: true,
    }
    if (!conn.configured) {
      return {
        ok: true,
        connection: conn,
        defaults,
        machines: [],
        agents: [],
        balance: null,
        usage: null,
        fetched_at: new Date().toISOString(),
      }
    }
    const auth = await requireAuth()
    const optional = (promise) => promise.catch(() => null)
    const [list, agents, balance, usage] = await Promise.all([
      api(auth.baseUrl, auth.token, 'GET', '/sandboxes', { timeoutMs: 30000 }),
      optional(api(auth.baseUrl, auth.token, 'GET', '/agents', { timeoutMs: 30000 })),
      optional(api(auth.baseUrl, auth.token, 'GET', '/billing/balance', { timeoutMs: 30000 })),
      optional(api(auth.baseUrl, auth.token, 'GET', '/usage', { timeoutMs: 30000 })),
    ])
    const machines = (Array.isArray(list?.sandboxes) ? list.sandboxes : [])
      .filter((item) => item?.status !== 'Terminated')
      .map(shapeSandbox)
      .sort((a, b) => {
        const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
        if (rank !== 0) return rank
        return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
      })
    return {
      ok: true,
      connection: conn,
      defaults,
      machines,
      agents: (Array.isArray(agents?.agents) ? agents.agents : []).map(shapeAgent),
      balance: balance && typeof balance === 'object' ? balance : null,
      usage: usage && typeof usage === 'object' ? usage : null,
      fetched_at: new Date().toISOString(),
    }
  }

  /** Save the user's address and/or token, then report the new state. */
  async function saveConnection(input = {}) {
    if (typeof input.baseUrl === 'string') {
      const text = input.baseUrl.trim()
      await writeStored({ baseUrl: text ? normalizeBaseUrl(text) : undefined })
    }
    if (input.clearToken) {
      if (typeof deps.clearToken === 'function') await deps.clearToken()
      else throw new LocalError('credential_store_unavailable', 'The Harness credential store is unavailable.')
      await writeStored({ autoToken: undefined })
    } else if (typeof input.token === 'string' && input.token.trim()) {
      if (typeof deps.setToken !== 'function') {
        throw new LocalError('credential_store_unavailable', 'The Harness credential store is unavailable.')
      }
      await deps.setToken(input.token.trim())
      // A manually pasted token is not the one this plugin created.
      await writeStored({ autoToken: undefined })
    }
    return connection()
  }

  /** Try a candidate address/token without saving either. */
  async function testConnection(input = {}) {
    const stored = await readStored()
    const baseUrl = normalizeBaseUrl(input.baseUrl || stored.baseUrl || settings.baseUrl || process.env.RAYRUN_API_URL || DEFAULT_BASE_URL)
    const draft = typeof input.token === 'string' ? input.token.trim() : ''
    const resolved = draft ? { value: draft } : await token()
    if (!resolved) throw new LocalError('token_required', 'Paste an API token to test the connection.')
    const [agents, sandboxes] = await Promise.all([
      api(baseUrl, resolved.value, 'GET', '/agents', { timeoutMs: 20000 }),
      api(baseUrl, resolved.value, 'GET', '/sandboxes', { timeoutMs: 20000 }),
    ])
    return {
      baseUrl,
      agents: Array.isArray(agents?.agents) ? agents.agents.length : 0,
      machines: Array.isArray(sandboxes?.sandboxes) ? sandboxes.sandboxes.length : 0,
    }
  }

  /** Store a token obtained through account login (never logged). */
  async function storeToken(value) {
    if (typeof deps.setToken !== 'function') {
      throw new LocalError('credential_store_unavailable', 'The Harness credential store is unavailable.')
    }
    await deps.setToken(value)
  }

  async function clearStoredToken() {
    if (typeof deps.clearToken === 'function') await deps.clearToken()
  }

  /** Non-secret metadata for the token this plugin created automatically. */
  async function autoToken() {
    return (await readStored()).autoToken ?? null
  }

  async function rememberAutoToken(meta) {
    await writeStored({ autoToken: meta })
  }

  async function forgetAutoToken() {
    await writeStored({ autoToken: undefined })
  }

  return {
    settings,
    connection,
    overview,
    listMachines,
    machine,
    createMachine,
    machineAction,
    wake,
    waitFor,
    exec,
    listFiles,
    uploadFile,
    downloadFile,
    postPrompt,
    openEvents,
    desktopPassword,
    repairDesktop,
    saveConnection,
    testConnection,
    storeToken,
    clearStoredToken,
    autoToken,
    rememberAutoToken,
    forgetAutoToken,
    token,
  }
}

/** Best-effort site URL for the same deployment (display only). */
export function dashboardFor(baseUrl) {
  try {
    const url = new URL(baseUrl)
    if (url.hostname === 'api.rayrunos.com') return 'http://rayrunos.com/'
    const host = url.hostname
    if (host === '127.0.0.1' || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return `${url.protocol}//${host}:5173`
    }
    return `${url.protocol}//${host}`
  } catch {
    return 'http://rayrunos.com/'
  }
}
