/**
 * Host half of the Rayrun 云电脑 bundle.
 *
 * Two surfaces share one Rayrun client:
 *  - the 云电脑 page, through a same-origin `/plugins/rayrun/rpc` route;
 *  - four model-facing tools that create/execute on the same cloud machines.
 *
 * The Rest client and connection resolution live in ./lib/rayrun.js.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  loginMethods as probeLoginMethods,
  passwordLogin,
  revokeToken,
  tokenNameFor,
  wechatErrorText,
  wechatToken,
} from './lib/auth.js'
import { LocalError, RayrunError, TOKEN_REF, createRayrun, normalizeBaseUrl } from './lib/rayrun.js'

export const name = 'rayrun-cloud'
export const inject = ['tools']

const ROUTE = '/plugins/rayrun'
const MAX_TEXT = 12000
const MAX_BODY = 1024 * 1024

/** In-flight sandbox resolutions, keyed by base URL + sandbox name. */
const inflight = new Map()
/** Resolved sandbox ids, so later calls reuse the same sandbox by id rather than by name. */
const pinned = new Map()

function pick(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : value
}

/** Keep a result readable: head and tail with an explicit omission marker. */
function clamp(text, limit = MAX_TEXT) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const half = Math.floor(limit / 2)
  return `${value.slice(0, half)}\n… ${value.length - limit} characters omitted …\n${value.slice(-half)}`
}

/**
 * Turn an authored property map into the object schema the model API requires:
 * parameters must be `type: "object"`, and `required` is a name list.
 */
function objectSchema(properties) {
  const required = []
  const cleaned = {}
  for (const [name, node] of Object.entries(properties)) {
    const { required: isRequired, ...rest } = node ?? {}
    if (isRequired === true) required.push(name)
    cleaned[name] = rest
  }
  return { type: 'object', properties: cleaned, ...(required.length ? { required } : {}) }
}

/** One-line sandbox summary used by every tool result. */
function summarize(machine) {
  const name = machine.name ? `${machine.name} ` : ''
  const usage = machine.usage?.vm_hours ? ` · ${machine.usage.vm_hours.toFixed(2)} vm-h` : ''
  const desktop = machine.remote_desktop ? ' · desktop' : ''
  return `${name}(${machine.id}) ${machine.status}${desktop}${usage}`
}

/** Read an SSE response body into parsed JSON data frames. */
async function* sseFrames(res, signal) {
  if (!res.body) return
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body) {
    if (signal?.aborted) return
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
      if (data) {
        try {
          yield JSON.parse(data)
        } catch {
          yield { raw: data }
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

/** The event kind of a journal frame, whichever field carries it. */
function kindOf(event) {
  return String(event?.kind ?? event?.type ?? event?.event ?? '')
}

/** Whether a frame finishes the prompt the tool is waiting on. */
function isFinished(kind) {
  return /(^|\.)(exited|done|completed|failed|cancelled)$/.test(kind) || kind === 'agent.exit'
}

/** Parse an `agent.raw` line: the sandbox agent's own stream-json output. */
function parseLine(line) {
  if (typeof line !== 'string' || line[0] !== '{') return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * Classify one agent frame. `agent.message` carries the clean per-turn text; the
 * raw stream-json line carries the final result and the assistant narration.
 */
function readFrame(event, kind) {
  const payload = event?.payload
  if (kind === 'agent.message') {
    return typeof payload?.text === 'string' && payload.text ? { message: payload.text } : {}
  }
  const parsed = parseLine(payload?.line)
  if (!parsed) return {}
  if (parsed.type === 'result') return typeof parsed.result === 'string' ? { final: parsed.result } : {}
  if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
    const text = parsed.message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    return text ? { narration: text } : {}
  }
  return {}
}

/** Read a small JSON request body, refusing oversized payloads. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new LocalError('body_too_large', 'The request body is too large.')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    throw new LocalError('invalid_json', 'The request body is not valid JSON.')
  }
}

function reply(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

function errorPayload(error) {
  if (error instanceof LocalError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status ?? 400,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    }
  }
  if (error instanceof RayrunError) {
    const message =
      error.status === 401
        ? 'Rayrun rejected the API token (401). Save a valid token in the 云电脑 connection settings.'
        : error.message
    return { code: error.code, message, status: error.status }
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { code: 'timeout', message: 'The Rayrun request timed out or was cancelled.', status: 504 }
  }
  return { code: 'internal', message: String(error?.message ?? error), status: 500 }
}

/** Register the four Rayrun tools and the page RPC route. */
export function apply(ctx, config) {
  const ray = createRayrun(config, {
    lookupToken: async () => {
      try {
        const store = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
        if (!store) return undefined
        const resolved = await store.resolve(TOKEN_REF)
        return resolved?.value || undefined
      } catch {
        return undefined
      }
    },
    setToken: async (value) => {
      const store = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      if (!store) throw new LocalError('credential_store_unavailable', 'The Harness credential store is unavailable.')
      await store.set(TOKEN_REF, value)
    },
    clearToken: async () => {
      const store = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
      if (store) await store.unset(TOKEN_REF)
    },
  })

  const settings = ray.settings

  /**
   * Per-session execution target chosen by the composer toggle. It is a runtime
   * fact, not durable session state: the client restores its own copy after a
   * reload and pushes it back through the RPC route.
   */
  const taskTargets = new Map()

  const targetOf = (sessionId) => (taskTargets.get(String(sessionId ?? '')) === 'cloud' ? 'cloud' : 'local')

  /** Prompt context that tells the model where this task must run. */
  const targetInstruction = (sessionId) => {
    if (targetOf(sessionId) === 'cloud') {
      return [
        '[Rayrun 工作任务目标]',
        '当前任务运行在「云上电脑」：Rayrun 云电脑。',
        `- 默认机器名：${settings.sandboxName}；不存在时用 rayrun_sandbox 创建（需要桌面时 remote_desktop=true，内存至少 2048 MB）。`,
        '- 实际执行、代码修改、构建和产物都放在云电脑上；本地只读取必要输入、查看和汇总，不要在本地产生产物。',
        '- 云电脑不可用时明确说明原因，不要声称已在云端完成。',
      ].join('\n')
    }
    return [
      '[Rayrun 工作任务目标]',
      '当前任务运行在「本地电脑」：按常规使用本地工具执行；除非用户明确要求，不要调用 rayrun_* 工具。',
    ].join('\n')
  }

  // Register one global context (not one per agent): its text provider receives
  // the assembly scope, so it follows the session's current choice even after a
  // plugin reload and covers agents created after the profile booted.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.context({
          name: 'rayrun-task-target',
          order: 900,
          text: (context) => targetInstruction(context?.scope?.id ?? context?.agent?.id ?? ''),
        }),
      'rayrun: task-target context',
    )
  })

  const setTaskTarget = (sessionId, target) => {
    const id = String(sessionId ?? '').trim()
    if (!id) throw new LocalError('invalid_session', 'A session id is required.')
    if (target !== 'cloud' && target !== 'local') {
      throw new LocalError('invalid_target', 'The task target must be "cloud" or "local".')
    }
    taskTargets.set(id, target)
    return target
  }

  const getTaskTarget = (sessionId) => {
    const id = String(sessionId ?? '').trim()
    if (!id) throw new LocalError('invalid_session', 'A session id is required.')
    return targetOf(id)
  }

  /* ------------------------------------------------------------------ */
  /* Account login (password / WeChat) → automatic API token            */
  /* ------------------------------------------------------------------ */

  let electronPromise
  const wechatFlows = new Map()

  const electronApi = async () => {
    if (!process.versions?.electron) return null
    if (!electronPromise) electronPromise = import('electron').catch(() => null)
    const electron = await electronPromise
    return electron?.BrowserWindow && electron?.session ? electron : null
  }

  /** A local Chromium binary we can drive over CDP for the WeChat OAuth window. */
  const findChrome = () => {
    const configured = process.env.RAYRUN_CHROME_PATH || process.env.CHROME_PATH
    if (configured && existsSync(configured)) return configured
    const candidates =
      process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : process.platform === 'darwin'
          ? [
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            ]
          : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  const loginMethodsFor = async (draftBaseUrl) => {
    const conn = await ray.connection()
    const baseUrl = normalizeBaseUrl(draftBaseUrl || conn.baseUrl)
    const methods = await probeLoginMethods(baseUrl)
    const electron = methods.wechat ? await electronApi() : null
    const localWindow = electron || (methods.wechat && findChrome())
    return {
      baseUrl,
      password: true,
      wechat: methods.wechat,
      wechatMode: methods.wechat ? (localWindow ? 'window' : 'browser') : 'unavailable',
      dashboardBase: methods.dashboardBase,
      loginUrl: methods.loginUrl,
    }
  }

  const rememberLogin = async (baseUrl, created) => {
    await ray.saveConnection({ baseUrl })
    try {
      await ray.rememberAutoToken({
        tokenId: created.tokenId ?? null,
        name: created.name ?? tokenNameFor(),
        baseUrl,
        createdAt: created.createdAt ?? new Date().toISOString(),
      })
    } catch {
      // the token is already stored; metadata is best effort
    }
  }

  const loginWithPassword = async (input) => {
    const conn = await ray.connection()
    const baseUrl = normalizeBaseUrl(input.baseUrl || conn.baseUrl)
    const created = await passwordLogin({
      baseUrl,
      username: String(input.username ?? ''),
      password: String(input.password ?? ''),
      name: tokenNameFor(),
    })
    await ray.storeToken(created.token)
    await rememberLogin(baseUrl, created)
    return ray.connection()
  }

  const logoutRayrun = async () => {
    const conn = await ray.connection()
    const meta = await ray.autoToken()
    const resolved = await ray.token()
    if (meta?.tokenId && resolved?.value) {
      await revokeToken({ baseUrl: meta.baseUrl || conn.baseUrl, token: resolved.value, tokenId: meta.tokenId })
    }
    await ray.clearStoredToken()
    await ray.forgetAutoToken()
    return ray.connection()
  }

  const closeWechatWindow = async (flow) => {
    if (flow.timer) {
      clearInterval(flow.timer)
      flow.timer = null
    }
    if (flow.timeout) {
      clearTimeout(flow.timeout)
      flow.timeout = null
    }
    if (typeof flow.close === 'function') {
      try {
        await flow.close()
      } catch {
        // browser window already gone
      }
      return
    }
    try {
      if (flow.win && !flow.win.isDestroyed()) flow.win.destroy()
    } catch {
      // already gone
    }
    try {
      await flow.ses.clearStorageData()
    } catch {
      // session may already be disposed
    }
  }

  const finishWechat = async (flow, status, error) => {
    if (['authorized', 'error', 'cancelled', 'expired'].includes(flow.status)) return
    flow.status = status
    flow.error = error ?? null
    await closeWechatWindow(flow)
    setTimeout(() => {
      if (wechatFlows.get(flow.id) === flow) wechatFlows.delete(flow.id)
    }, 10 * 60 * 1000)
  }

  const startWechatLogin = async (draftBaseUrl) => {
    const baseUrl = normalizeBaseUrl(draftBaseUrl || (await ray.connection()).baseUrl)
    const methods = await probeLoginMethods(baseUrl)
    if (!methods.wechat) {
      throw new LocalError('wechat_not_configured', wechatErrorText('wechat_not_configured'))
    }
    const electron = await electronApi()
    if (!electron) {
      const chrome = findChrome()
      if (chrome && typeof WebSocket === 'function') {
        try {
          return await startChromeWechatFlow(baseUrl, methods, chrome)
        } catch {
          // fall through to the manual browser flow
        }
      }
      return { mode: 'browser', url: methods.loginUrl }
    }

    const id = randomUUID()
    const partition = `rayrun-wechat-${id}`
    const ses = electron.session.fromPartition(partition)
    const win = new electron.BrowserWindow({
      width: 460,
      height: 720,
      show: true,
      title: 'Rayrun 登录',
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    const flow = {
      id,
      status: 'pending',
      error: null,
      connection: null,
      win,
      ses,
      timer: null,
      timeout: null,
      baseUrl,
    }
    wechatFlows.set(id, flow)

    win.on('closed', () => {
      if (flow.timer) {
        clearInterval(flow.timer)
        flow.timer = null
      }
      if (flow.timeout) {
        clearTimeout(flow.timeout)
        flow.timeout = null
      }
      if (flow.status === 'pending' || flow.status === 'authorizing') {
        flow.status = 'cancelled'
        flow.error = null
      }
      void flow.ses.clearStorageData().catch(() => {})
      setTimeout(() => {
        if (wechatFlows.get(id) === flow) wechatFlows.delete(id)
      }, 10 * 60 * 1000)
    })

    const poll = async () => {
      if (flow.status !== 'pending') return
      try {
        const current = win.webContents.getURL()
        if (current.includes('wechat_error=')) {
          let code = 'wechat_provider_error'
          try {
            code = new URL(current).searchParams.get('wechat_error') || code
          } catch {
            // keep the generic code
          }
          await finishWechat(flow, 'error', wechatErrorText(code))
          return
        }
        const cookies = await ses.cookies.get({ url: methods.dashboardBase })
        const session = cookies.find((cookie) => cookie.name === 'rayrun_session')
        if (!session) return
        flow.status = 'authorizing'
        const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
        const created = await wechatToken({
          baseUrl,
          cookie: header,
          name: tokenNameFor(),
        })
        await ray.storeToken(created.token)
        await rememberLogin(baseUrl, created)
        flow.connection = await ray.connection()
        flow.status = 'authorized'
        await closeWechatWindow(flow)
      } catch (error) {
        await finishWechat(flow, 'error', String(error?.message ?? error))
      }
    }

    flow.timer = setInterval(() => void poll(), 1000)
    flow.timeout = setTimeout(() => void finishWechat(flow, 'expired', 'WeChat login timed out.'), 5 * 60 * 1000)
    void win.loadURL(methods.loginUrl).catch((error) => void finishWechat(flow, 'error', String(error?.message ?? error)))
    return { mode: 'window', flowId: id }
  }

  /**
   * Drive a local Chrome/Edge window over CDP for the WeChat OAuth flow.
   * Chrome sets the dashboard session cookie after the user scans; the Host
   * reads only that cookie and exchanges it for an API token.
   */
  const startChromeWechatFlow = async (baseUrl, methods, chromePath) => {
    const id = randomUUID()
    const dir = await mkdtemp(path.join(tmpdir(), 'rayrun-login-'))
    const child = spawn(
      chromePath,
      [
        '--remote-debugging-port=0',
        `--user-data-dir=${dir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--new-window',
        methods.loginUrl,
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    const flow = {
      id,
      status: 'pending',
      error: null,
      connection: null,
      baseUrl,
      child,
      dir,
      ws: null,
      timer: null,
      timeout: null,
      closed: false,
    }
    let resolveExit
    const exited = new Promise((resolve) => {
      resolveExit = resolve
    })
    const cleanupDir = async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    }
    flow.close = async () => {
      if (flow.closed) return
      flow.closed = true
      try {
        flow.ws?.close()
      } catch {
        // already closed
      }
      try {
        child.kill()
      } catch {
        // already gone
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))])
      await cleanupDir()
    }
    child.on('exit', () => {
      resolveExit()
      if (flow.timer) {
        clearInterval(flow.timer)
        flow.timer = null
      }
      if (flow.timeout) {
        clearTimeout(flow.timeout)
        flow.timeout = null
      }
      if (flow.status === 'pending' || flow.status === 'authorizing') {
        flow.status = 'cancelled'
        flow.error = null
      }
      void cleanupDir()
    })
    child.on('error', () => {
      if (flow.status === 'pending') {
        flow.status = 'error'
        flow.error = 'Chrome could not be started.'
      }
      resolveExit()
    })
    wechatFlows.set(id, flow)

    try {
      let port = ''
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          port = String(await readFile(path.join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim()
        } catch {
          // not written yet
        }
        if (port) break
        if (child.exitCode !== null) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!port) throw new LocalError('wechat_browser_unavailable', 'Chrome did not expose a DevTools port.')

      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = Array.isArray(targets) ? targets.find((target) => target.type === 'page') : undefined
      if (!page?.webSocketDebuggerUrl) {
        throw new LocalError('wechat_browser_unavailable', 'Chrome has no page target.')
      }

      const ws = new WebSocket(page.webSocketDebuggerUrl)
      flow.ws = ws
      const pending = new Map()
      let nextId = 1
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          const entry = pending.get(message.id)
          if (!entry) return
          pending.delete(message.id)
          if (message.error) entry.reject(new Error(message.error.message))
          else entry.resolve(message.result)
        } catch {
          // ignore malformed CDP frames
        }
      }
      ws.onclose = () => {
        for (const entry of pending.values()) entry.reject(new Error('Chrome DevTools connection closed.'))
        pending.clear()
      }
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const messageId = nextId++
          const timer = setTimeout(() => {
            pending.delete(messageId)
            reject(new Error('Chrome DevTools request timed out.'))
          }, 5000)
          pending.set(messageId, {
            resolve: (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            reject: (error) => {
              clearTimeout(timer)
              reject(error)
            },
          })
          ws.send(JSON.stringify({ id: messageId, method, params }))
        })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Chrome DevTools connection timed out.')), 8000)
        ws.onopen = () => {
          clearTimeout(timer)
          resolve()
        }
        ws.onerror = () => {
          clearTimeout(timer)
          reject(new Error('Chrome DevTools connection failed.'))
        }
      })
      await send('Network.enable')

      const readCookie = async () => {
        const result = await send('Network.getCookies', { urls: [methods.dashboardBase] })
        const cookies = result.cookies ?? []
        const session = cookies.find((cookie) => cookie.name === 'rayrun_session')
        if (!session) return null
        return {
          value: session.value,
          header: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
        }
      }
      const currentUrl = async () => {
        try {
          const result = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
          return String(result?.result?.value ?? '')
        } catch {
          return ''
        }
      }
      const poll = async () => {
        if (flow.status !== 'pending') return
        try {
          const current = await currentUrl()
          if (current.includes('wechat_error=')) {
            let code = 'wechat_provider_error'
            try {
              code = new URL(current).searchParams.get('wechat_error') || code
            } catch {
              // keep the generic code
            }
            await finishWechat(flow, 'error', wechatErrorText(code))
            return
          }
          const session = await readCookie()
          if (!session) return
          flow.status = 'authorizing'
          const created = await wechatToken({
            baseUrl,
            cookie: session.header,
            name: tokenNameFor(),
          })
          await ray.storeToken(created.token)
          await rememberLogin(baseUrl, created)
          flow.connection = await ray.connection()
          flow.status = 'authorized'
          await closeWechatWindow(flow)
        } catch (error) {
          await finishWechat(flow, 'error', String(error?.message ?? error))
        }
      }
      flow.timer = setInterval(() => void poll(), 1000)
      flow.timeout = setTimeout(() => void finishWechat(flow, 'expired', 'WeChat login timed out.'), 5 * 60 * 1000)
      return { mode: 'window', flowId: id }
    } catch (error) {
      wechatFlows.delete(id)
      await flow.close()
      throw error
    }
  }

  const wechatStatus = (flowId) => {
    const flow = wechatFlows.get(String(flowId ?? ''))
    if (!flow) throw new LocalError('flow_not_found', 'Unknown WeChat login flow.')
    return { status: flow.status, error: flow.error, connection: flow.connection }
  }

  const cancelWechat = async (flowId) => {
    const flow = wechatFlows.get(String(flowId ?? ''))
    if (!flow) return { status: 'cancelled' }
    if (flow.status === 'pending' || flow.status === 'authorizing') {
      flow.status = 'cancelled'
      flow.error = null
      await closeWechatWindow(flow)
    }
    return { status: flow.status }
  }


  /** Resolve the target sandbox, creating the configured default when needed. */
  const resolveSandbox = async (ref, signal) => {
    const connection = await ray.connection()
    const wanted = String(pick(ref, settings.sandboxName)).trim()
    const key = `${connection.baseUrl}#${wanted}`

    const running = inflight.get(key)
    if (running) return running

    const task = resolveOnce(wanted, key, signal)
    inflight.set(key, task)
    try {
      return await task
    } finally {
      inflight.delete(key)
    }
  }

  const resolveOnce = async (wanted, key, signal) => {
    const pinnedId = pinned.get(key)
    if (pinnedId) {
      try {
        const byId = await ray.machine(pinnedId)
        if (byId) return ray.wake(byId, signal)
      } catch {
        pinned.delete(key)
      }
    }

    const found = (await ray.listMachines()).find((item) => item.id === wanted || item.name === wanted)
    if (found) {
      pinned.set(key, found.id)
      return ray.wake(found, signal)
    }

    if (!settings.autoCreate) {
      throw new LocalError(
        'sandbox_missing',
        `Cloud computer "${wanted}" does not exist and autoCreate is disabled; create it with rayrun_sandbox first.`,
      )
    }

    try {
      const created = await ray.createMachine({
        name: wanted,
        agent: settings.defaultAgent,
        cpu_cores: settings.cpuCores,
        memory_mb: settings.memoryMb,
        workspace_mb: settings.workspaceMb,
        egress_allow: settings.egressAllow,
        credentials: settings.credentials,
        remote_desktop: settings.remoteDesktop,
      })
      pinned.set(key, created.id)
      return created
    } catch (error) {
      // Another process may have created it between the list and the create.
      if (error instanceof RayrunError && (error.status === 409 || /name_conflict/.test(error.code))) {
        const winner = (await ray.listMachines()).find((item) => item.name === wanted)
        if (winner) {
          pinned.set(key, winner.id)
          return ray.wake(winner, signal)
        }
      }
      throw error
    }
  }

  /** Look up a machine without creating one; lifecycle tools must not create by accident. */
  const resolveExisting = async (ref) => {
    const wanted = String(pick(ref, settings.sandboxName)).trim()
    const found = (await ray.listMachines()).find((item) => item.id === wanted || item.name === wanted)
    if (!found) {
      throw new LocalError('sandbox_missing', `Cloud computer "${wanted}" does not exist.`)
    }
    return found
  }

  /**
   * Resolve a caller-supplied local path the way the agent means it: relative to
   * the session working directory, not to the Host process directory.
   */
  const localDirectory = (agent) => {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory && agent?.session) return workingDirectory.get(agent.session)
      if (typeof workingDirectory?.defaultDirectory === 'string') return workingDirectory.defaultDirectory
    } catch {
      // fall back to the process directory
    }
    return process.cwd()
  }

  const localPath = (value, agent) => path.resolve(localDirectory(agent), String(value))

  const sandboxParam = {
    type: 'string',
    description: `Cloud computer name or id. Defaults to "${settings.sandboxName}"; exec/files/agent create it on first use.`,
  }

  /** Same-origin RPC used by the 云电脑 page. */
  ctx.inject(['webServer', 'credentials'], (child) => {
    child.effect(() =>
      child.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        async handler(req, res) {
          const url = new URL(req.url ?? '/', 'http://rayrun.local')
          if (url.pathname !== ROUTE && !url.pathname.startsWith(`${ROUTE}/`)) {
            reply(res, 404, { ok: false, error: { code: 'not_found', message: 'Unknown Rayrun route.', status: 404 } })
            return
          }
          const method = String(req.method ?? 'GET').toUpperCase()
          try {
            if (method === 'GET') {
              const action = url.searchParams.get('action') ?? 'status'
              if (action === 'status') {
                reply(res, 200, { ok: true, connection: await ray.connection() })
                return
              }
              if (action === 'overview') {
                reply(res, 200, await ray.overview())
                return
              }
              if (action === 'task-target') {
                const sessionId = url.searchParams.get('sessionId') ?? ''
                reply(res, 200, { ok: true, target: getTaskTarget(sessionId), machine: settings.sandboxName })
                return
              }
              throw new LocalError('unsupported_action', `Unknown Rayrun action "${action}".`)
            }
            if (method !== 'POST') {
              reply(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET or POST.', status: 405 } })
              return
            }
            const origin = req.headers.origin
            if (origin) {
              // Compare the Origin's host with the Host this request actually
              // reached. The configured bind origin is 127.0.0.1, while a local
              // browser may legitimately use localhost or a LAN address.
              let originHost = ''
              try {
                originHost = new URL(origin).host
              } catch {
                originHost = ''
              }
              let expectedHost = String(req.headers.host ?? '')
              if (!expectedHost) {
                try {
                  expectedHost = new URL(child.webServer.getOrigin()).host
                } catch {
                  expectedHost = ''
                }
              }
              if (!originHost || !expectedHost || originHost !== expectedHost) {
                reply(res, 403, { ok: false, error: { code: 'origin_mismatch', message: 'Cross-origin request refused.', status: 403 } })
                return
              }
            }
            const body = await readJsonBody(req)
            const action = String(body.action ?? '')
            switch (action) {
              case 'overview':
                reply(res, 200, await ray.overview())
                return
              case 'task.target.get':
                reply(res, 200, {
                  ok: true,
                  target: getTaskTarget(body.sessionId),
                  machine: settings.sandboxName,
                })
                return
              case 'task.target.set':
                reply(res, 200, {
                  ok: true,
                  target: setTaskTarget(body.sessionId, body.target),
                  machine: settings.sandboxName,
                })
                return
              case 'connection.status':
                reply(res, 200, { ok: true, connection: await ray.connection() })
                return
              case 'connection.save':
                reply(res, 200, { ok: true, connection: await ray.saveConnection(body) })
                return
              case 'connection.test': {
                const result = await ray.testConnection(body)
                reply(res, 200, { ok: true, result })
                return
              }
              case 'login.methods':
                reply(res, 200, { ok: true, methods: await loginMethodsFor(body.baseUrl) })
                return
              case 'login.password':
                reply(res, 200, { ok: true, connection: await loginWithPassword(body) })
                return
              case 'login.wechat.start':
                reply(res, 200, { ok: true, ...(await startWechatLogin(body.baseUrl)) })
                return
              case 'login.wechat.status':
                reply(res, 200, { ok: true, ...wechatStatus(body.flowId) })
                return
              case 'login.wechat.cancel':
                reply(res, 200, { ok: true, ...(await cancelWechat(body.flowId)) })
                return
              case 'login.logout':
                reply(res, 200, { ok: true, connection: await logoutRayrun() })
                return
              case 'machine.create': {
                const machine = await ray.createMachine(body)
                reply(res, 200, { ok: true, machine })
                return
              }
              case 'machine.get': {
                const machine = await ray.machine(String(body.id ?? ''))
                reply(res, 200, { ok: true, machine })
                return
              }
              case 'machine.action': {
                const machine = await ray.machineAction(String(body.id ?? ''), String(body.verb ?? ''), body)
                reply(res, 200, { ok: true, machine })
                return
              }
              case 'machine.password': {
                const result = await ray.desktopPassword(String(body.id ?? ''))
                reply(res, 200, { ok: true, result })
                return
              }
              case 'machine.desktopRepair': {
                const result = await ray.repairDesktop(String(body.id ?? ''))
                reply(res, 200, { ok: true, result })
                return
              }
              default:
                throw new LocalError('unsupported_action', `Unknown Rayrun action "${action}".`)
            }
          } catch (error) {
            const payload = errorPayload(error)
            if (payload.code === 'internal') console.error('[rayrun] request failed:', error)
            reply(res, 200, { ok: false, error: payload })
          }
        },
      }),
    )
  })

  ctx.tools.register({
    name: 'rayrun_sandbox',
    description:
      'Manage Rayrun cloud computers (sandboxes): disposable Linux machines with their own CPU, memory and persistent workspace, billed for every second they run. Create one with `remote_desktop: true` to get a browser-accessible Linux desktop; inspect or destroy machines you created before the work is finished.',
    parameters: objectSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'list', 'inspect', 'start', 'stop', 'pause', 'resume', 'destroy'],
        description: 'create (with `sandbox` as the new name) | list | inspect | start | stop | pause | resume | destroy.',
      },
      sandbox: sandboxParam,
      agent: {
        type: 'string',
        description: `Agent image for a new machine. Defaults to "${settings.defaultAgent}".`,
      },
      cpu_cores: { type: 'integer', minimum: 1, description: `vCPUs for a new machine. Defaults to ${settings.cpuCores}.` },
      memory_mb: {
        type: 'integer',
        minimum: 512,
        description: `Memory in MB for a new machine. Defaults to ${settings.memoryMb}; a remote desktop needs at least 2048.`,
      },
      workspace_mb: {
        type: 'integer',
        minimum: 0,
        description: 'Workspace disk in MB for a new machine. Defaults to the image default.',
      },
      remote_desktop: {
        type: 'boolean',
        description: 'Publish a noVNC desktop on the image desktop port. Requires at least 2048 MB memory.',
      },
      egress_allow: {
        type: 'array',
        items: { type: 'string' },
        description: 'Hosts a new machine may reach. The platform default is no outbound network at all.',
      },
      credentials: {
        type: 'array',
        items: { type: 'string' },
        description: 'Credential names to inject into a new machine; required before its agent can call a model.',
      },
      lifetime_seconds: {
        type: 'integer',
        description: 'Maximum lifetime for a new machine; it stops itself when reached. Omit for no limit.',
      },
    }),
    output: {
      schema: { type: 'string', description: 'One line per machine, or one detail block.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const action = String(args.action)
      if (action === 'list') {
        const machines = await ray.listMachines()
        if (machines.length === 0) return 'No live Rayrun machines.'
        return machines.map(summarize).join('\n')
      }
      if (action === 'create') {
        const machine = await ray.createMachine({
          name: String(pick(args.sandbox, settings.sandboxName)),
          agent: String(pick(args.agent, settings.defaultAgent)),
          cpu_cores: Number(pick(args.cpu_cores, settings.cpuCores)),
          memory_mb: Number(pick(args.memory_mb, settings.memoryMb)),
          workspace_mb: args.workspace_mb,
          lifetime_seconds: args.lifetime_seconds,
          egress_allow: Array.isArray(args.egress_allow) ? args.egress_allow : undefined,
          credentials: Array.isArray(args.credentials) ? args.credentials : undefined,
          remote_desktop: args.remote_desktop === true,
        })
        return `Created ${summarize(machine)}${machine.desktop_url ? ` · desktop ${machine.desktop_url}` : ''}`
      }
      const machine = await resolveExisting(args.sandbox)
      if (action === 'inspect') {
        const detail = await ray.machine(machine.id)
        return [
          `name: ${detail.name ?? '-'}`,
          `id: ${detail.id}`,
          `status: ${detail.status} · agent ${detail.agent}`,
          `spec: ${detail.cpu_cores} vCPU / ${detail.memory_mb} MB / ${detail.workspace_mb} MB workspace`,
          `ip: ${detail.ip ?? '-'}`,
          `desktop: ${detail.remote_desktop ? detail.desktop_url ?? `port ${detail.desktop_port} (${detail.desktop_reason})` : 'not enabled'}`,
          `created: ${detail.created_at ?? '-'}`,
        ].join('\n')
      }
      if (action === 'destroy') {
        await ray.machineAction(machine.id, 'destroy')
        return `Destroyed ${machine.name ?? machine.id}. The workspace is gone.`
      }
      const updated = await ray.machineAction(machine.id, action)
      return `${machine.name ?? machine.id}: ${action} requested${updated?.status ? ` → ${updated.status}` : ''}.`
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Rayrun ${args.action}${args.sandbox ? ` ${args.sandbox}` : ''}`,
      kind: 'other',
    }),
  })

  ctx.tools.register({
    name: 'rayrun_exec',
    description:
      'Run a non-interactive command inside a Rayrun cloud computer and return its exit code, stdout and stderr. Reach for it when a task needs Linux tooling, a clean throwaway machine, or a build that should not consume the local one.',
    parameters: objectSchema({
      sandbox: sandboxParam,
      command: {
        type: 'string',
        description: 'Shell command line, run through /bin/sh -c. Give either this or `argv`.',
      },
      argv: {
        type: 'array',
        items: { type: 'string' },
        description: 'Argument vector, executed directly without a shell. Give either this or `command`.',
      },
      cwd: {
        type: 'string',
        description: 'Absolute directory to run in. Defaults to the image workdir.',
      },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Extra environment variables merged over the machine baseline.',
      },
      timeout_seconds: {
        type: 'integer',
        minimum: 1,
        maximum: 3600,
        description: `Kill the command after this many seconds. Defaults to ${settings.defaultTimeout}; the maximum is 3600.`,
      },
    }),
    timeoutMs: 3_700_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sandbox', 'exit_code', 'stdout', 'stderr', 'duration_ms', 'timed_out', 'truncated'],
        properties: {
          sandbox: { type: 'string' },
          exit_code: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          duration_ms: { type: 'integer' },
          timed_out: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const status = value.timed_out ? 'timed out' : `exit ${value.exit_code}`
        const parts = [`${status} · ${value.duration_ms} ms · ${value.sandbox}`]
        if (value.stdout) parts.push(value.stdout)
        if (value.stderr) parts.push(`[stderr]\n${value.stderr}`)
        if (value.truncated) parts.push('[output truncated by the machine at 4 MiB]')
        return [{ type: 'text', text: clamp(parts.join('\n')) }]
      },
    },
    async execute(args, exec) {
      if (Boolean(args.command) === Boolean(args.argv)) {
        throw new Error('Give exactly one of `command` (through a shell) or `argv` (direct exec).')
      }
      const machine = await resolveSandbox(args.sandbox, exec.signal)
      const timeout = Math.min(Number(pick(args.timeout_seconds, settings.defaultTimeout)), 3600)
      const result = await ray.exec(
        machine.id,
        {
          ...(args.command ? { command: String(args.command) } : { argv: args.argv.map(String) }),
          ...(args.cwd ? { cwd: String(args.cwd) } : {}),
          ...(args.env && typeof args.env === 'object' ? { env: args.env } : {}),
          timeout_seconds: timeout,
        },
        { timeoutMs: (timeout + 120) * 1000, signal: exec.signal },
      )
      return {
        sandbox: machine.name ?? machine.id,
        exit_code: result?.exit_code ?? null,
        stdout: String(result?.stdout ?? ''),
        stderr: String(result?.stderr ?? ''),
        duration_ms: Number(result?.duration_ms ?? 0),
        timed_out: Boolean(result?.timed_out),
        truncated: Boolean(result?.truncated),
      }
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: 'Rayrun exec',
      description: clamp(String(args.command ?? (args.argv ?? []).join(' ')), 200),
      cwd: args.cwd,
    }),
  })

  ctx.tools.register({
    name: 'rayrun_files',
    description:
      'Move files between the local machine and a Rayrun cloud computer workspace: list a directory, upload a local file or inline text, or download a file into the workspace.',
    parameters: objectSchema({
      action: { type: 'string', required: true, enum: ['list', 'upload', 'download'], description: 'list | upload | download.' },
      sandbox: sandboxParam,
      path: {
        type: 'string',
        description: 'Path inside the machine workspace, relative to its root. Use an empty string for the root directory.',
      },
      local_path: {
        type: 'string',
        description:
          'Local file to read for upload, or the destination to write for download. Absolute, or relative to the session working directory.',
      },
      text: { type: 'string', description: 'Inline content to upload instead of a local file.' },
    }),
    output: {
      schema: { type: 'string', description: 'Listing entries, upload confirmation, or downloaded content.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const action = String(args.action)
      const machine = await resolveSandbox(args.sandbox, exec.signal)
      if (action === 'list') {
        const listing = await ray.listFiles(machine.id, String(args.path ?? ''))
        const entries = Array.isArray(listing?.entries) ? listing.entries : []
        if (entries.length === 0) return `${args.path || '/'}: empty`
        return entries
          .map((entry) => `${entry.type === 'dir' ? 'd' : '-'} ${entry.name}${entry.size != null ? `  ${entry.size} B` : ''}`)
          .join('\n')
      }
      if (action === 'upload') {
        if (!String(args.path ?? '').replace(/^\/+/, '')) throw new Error('`path` is required for upload.')
        const target = String(args.path).replace(/^\/+/, '')
        const payload =
          typeof args.text === 'string' ? Buffer.from(args.text, 'utf8') : await readFile(localPath(args.local_path, exec.agent))
        await ray.uploadFile(machine.id, target, payload, exec.signal)
        return `Uploaded ${payload.length} B to ${target} in ${machine.name ?? machine.id}.`
      }
      if (!String(args.path ?? '').replace(/^\/+/, '')) throw new Error('`path` is required for download.')
      const res = await ray.downloadFile(machine.id, String(args.path), exec.signal)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (args.local_path) {
        const destination = localPath(args.local_path, exec.agent)
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, bytes)
        return `Downloaded ${bytes.length} B to ${destination}.`
      }
      if (bytes.length > 60000) {
        throw new Error(`File is ${bytes.length} B; give \`local_path\` to write it to disk instead of returning it.`)
      }
      return bytes.toString('utf8')
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Rayrun files ${args.action}`,
      kind: 'other',
      rawInput: args.path,
    }),
  })

  ctx.tools.register({
    name: 'rayrun_agent',
    description:
      'Hand one whole task to the agent that runs inside a Rayrun cloud computer and wait for it to finish, streaming its progress. The machine agent owns the machine and runs its own tools, so this suits work that is many steps in the cloud rather than a single command.',
    parameters: objectSchema({
      sandbox: sandboxParam,
      prompt: { type: 'string', required: true, description: 'The task, stated once and completely.' },
      timeout_seconds: {
        type: 'integer',
        minimum: 1,
        maximum: 3600,
        description: 'Give up after this many seconds. Defaults to 900.',
      },
    }),
    timeoutMs: 3_700_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sandbox', 'finished', 'text', 'events'],
        properties: {
          sandbox: { type: 'string' },
          finished: { type: 'boolean' },
          text: { type: 'string' },
          events: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: clamp(
            [
              value.finished ? 'Agent finished.' : 'Agent still running when the call returned.',
              value.text || '',
              value.events ? `[events] ${value.events}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        },
      ],
    },
    async execute(args, exec) {
      const machine = await resolveSandbox(args.sandbox, exec.signal)
      const budget = Math.min(Number(pick(args.timeout_seconds, 900)), 3600) * 1000
      const controller = new AbortController()
      const onAbort = () => controller.abort(exec.signal?.reason)
      exec.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error('agent timeout')), budget)
      try {
        const streamed = ray.openEvents(machine.id, controller.signal)
        const posted = await ray.postPrompt(machine.id, String(args.prompt), controller.signal)
        const res = await streamed
        const messages = []
        const narration = []
        let final = ''
        let outcome = ''
        let cost = 0
        let finished = false
        const seen = new Map()
        for await (const event of sseFrames(res, controller.signal)) {
          const kind = kindOf(event)
          if (!kind) continue
          seen.set(kind, (seen.get(kind) ?? 0) + 1)
          if (kind === 'agent.raw' || kind === 'agent.message') {
            const frame = readFrame(event, kind)
            if (frame.final) final = frame.final
            else if (frame.message) messages.push(frame.message)
            else if (frame.narration) narration.push(frame.narration)
            continue
          }
          if (kind === 'agent.usage' && typeof event.payload?.cost_usd === 'number') {
            cost += event.payload.cost_usd
            continue
          }
          if (kind.startsWith('agent.') && isFinished(kind)) {
            finished = true
            const { class: klass, code } = event.payload ?? {}
            outcome = [klass, code != null ? `code ${code}` : ''].filter(Boolean).join(' ')
            break
          }
        }
        const digest = [...seen.entries()]
          .filter(([kind]) => kind !== 'api.request')
          .map(([kind, count]) => (count > 1 ? `${kind}×${count}` : kind))
          .join(', ')
        const answer = (final || messages.join('\n') || narration.join('\n')).trim()
        return {
          sandbox: machine.name ?? machine.id,
          finished,
          text: answer,
          events: [
            posted?.prompt_id ? `prompt ${posted.prompt_id}` : 'prompt accepted',
            digest,
            outcome ? `exited: ${outcome}` : '',
            cost ? `cost $${cost.toFixed(4)}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        }
      } finally {
        clearTimeout(timer)
        exec.signal?.removeEventListener('abort', onAbort)
        controller.abort()
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Rayrun agent task',
      kind: 'other',
      rawInput: clamp(String(args.prompt), 200),
    }),
  })
}
