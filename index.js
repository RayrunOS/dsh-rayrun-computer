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
import { existsSync, readFileSync } from 'node:fs'
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
import { applyUpdate, canAutoUpdate, fetchLatestVersion, isNewer } from './lib/update.js'
import { fileURLToPath } from 'node:url'
import { exportProfileProjection, readCloudWorker, readPluginFiles, syncCloudWorker } from './lib/cloud-dsh.js'
import { pullWorkspace, pushWorkspace, cloudWorkspaceRoot, readCloudState } from './lib/cloud-workspace.js'
import { delegateTask } from './lib/delegate.js'
import { isFinished, kindOf, readFrame, sseFrames } from './lib/sse.js'
import { WorkspaceLocks } from './lib/workspace-lock.js'

export const name = 'rayrun-cloud'
export const inject = ['tools']

const ROUTE = '/plugins/rayrun'
const MAX_TEXT = 12000
const MAX_BODY = 1024 * 1024

const PACKAGE_ID = 'dsh-rayrun-computer'
/** This package's own directory: the source of the files a cloud worker receives. */
const PACKAGE_DIR = fileURLToPath(new URL('./', import.meta.url))
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const UPDATE_REFRESH_MS = 5 * 60 * 1000
const UPDATE_TIMEOUT_MS = 10_000

/**
 * What a cloud worker tells its own model. The worker profile ships this plugin
 * for parity, but it holds no Rayrun credentials and has no route to the API, so
 * the cloud-computer controls stay off and the agent says what host it is on.
 */
const CLOUD_WORKER_CONTEXT = [
  '[Rayrun 云上 worker]',
  '本机是 Rayrun 云电脑上的 DSH worker：shell 与文件工具直接在本机执行。',
  '云电脑管理工具（创建/销毁/切换机器）在此不可用；需要新机器请在本地会话里操作。',
].join('\n')

/** This build's version, read once: the bundle cannot be newer than its manifest. */
const ownVersion = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

/** The last registry answer, shared by every turn and by the open page. */
let updateCheck = { latest: null, checkedAt: 0, error: '' }
let updateCheckRunning = null

/** Ask the registry, unless the last answer is still fresh or a check is running. */
function checkForUpdate() {
  if (updateCheckRunning) return updateCheckRunning
  if (updateCheck.checkedAt && Date.now() - updateCheck.checkedAt < UPDATE_REFRESH_MS) {
    return Promise.resolve(updateCheck)
  }
  updateCheckRunning = (async () => {
    try {
      const latest = await fetchLatestVersion(PACKAGE_ID, { timeoutMs: UPDATE_TIMEOUT_MS })
      updateCheck = { latest, checkedAt: Date.now(), error: '' }
    } catch (error) {
      updateCheck = { ...updateCheck, checkedAt: Date.now(), error: String(error?.message ?? error) }
    } finally {
      updateCheckRunning = null
    }
    return updateCheck
  })()
  return updateCheckRunning
}

/** What the page needs to decide whether to offer an update. */
async function updateView(ctx) {
  const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined
  let source = ''
  if (manager) {
    try {
      const bundle = (await manager.listBundles()).find((item) => item.name === PACKAGE_ID)
      source = typeof bundle?.source === 'string' ? bundle.source : ''
    } catch {
      source = ''
    }
  }
  const available = isNewer(updateCheck.latest, ownVersion)
  return {
    current: ownVersion,
    latest: updateCheck.latest,
    checkedAt: updateCheck.checkedAt,
    error: updateCheck.error,
    source,
    available,
    canApply: available && Boolean(manager) && canAutoUpdate(source, PACKAGE_ID),
  }
}

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

/** First 8 hex characters of a projection revision, for one-line summaries. */
function shortRev(value) {
  return typeof value === 'string' && value ? value.slice(0, 8) : 'none'
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

  // A cloud worker profile ships this plugin for parity, but it has no Rayrun
  // credentials and no route to the API. Keep the controls off (so the cloud
  // agent cannot recurse into machine management) and say what host this is.
  if (settings.cloudMode) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(
        () =>
          promptCtx.systemPrompt.context({
            name: 'rayrun-cloud-worker',
            order: 900,
            text: () => CLOUD_WORKER_CONTEXT,
          }),
        'rayrun: cloud worker context',
      )
    })
    return
  }

  // Check once on load and then twice a day; the page only reads the last
  // answer, so a slow registry never blocks a request.
  ctx.effect(() => {
    void checkForUpdate()
    const timer = setInterval(() => void checkForUpdate(), UPDATE_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'rayrun: update check')

  /**
   * Per-session execution target chosen by the composer toggle. It is a runtime
   * fact, not durable session state: the client restores its own copy after a
   * reload and pushes it back through the RPC route.
   */
  const taskTargets = new Map()

  /**
   * Single-writer guard for a machine's workspace. A cloud task (agent or exec)
   * holds it; `rayrun_workspace push` refuses to replace a busy tree. In-memory:
   * a Host restart forgets it, like the task targets above.
   */
  const workspaceLocks = new WorkspaceLocks()

  const lockReason = (label, text) => `${label}: ${String(text ?? '').replace(/\s+/g, ' ').slice(0, 60)}`

  /**
   * Idle stop is opt-in (`idle_stop_minutes`). It only ever stops a machine, and
   * skips the stop when the cloud workspace holds changes that were never pulled:
   * stopping there would hide work the user has not reviewed yet.
   */
  const idleStops = new Map()

  const cancelIdleStop = (machineId) => {
    const timer = idleStops.get(machineId)
    if (timer) {
      clearTimeout(timer)
      idleStops.delete(machineId)
    }
  }

  const stopWhenIdle = async (machine) => {
    if (workspaceLocks.status(machine.id)) return 'busy'
    try {
      const root = await cloudWorkspaceRoot(ray, machine.id)
      const cloud = await readCloudState(ray, machine.id, root)
      const state = cloud.state
      const drifted = state
        ? cloud.head !== state.head || cloud.digest !== state.digest
        : cloud.statusLines > 0
      if (drifted) return 'unpulled-changes'
      await ray.machineAction(machine.id, 'stop')
      return 'stopped'
    } catch {
      return 'skipped'
    }
  }

  const scheduleIdleStop = (machine) => {
    if (!settings.idleStopMinutes) return null
    cancelIdleStop(machine.id)
    const timer = setTimeout(() => {
      idleStops.delete(machine.id)
      void stopWhenIdle(machine)
    }, settings.idleStopMinutes * 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    idleStops.set(machine.id, timer)
    return settings.idleStopMinutes
  }

  const targetOf = (sessionId) => (taskTargets.get(String(sessionId ?? '')) === 'cloud' ? 'cloud' : 'local')

  /** Prompt context that tells the model where this task must run. */
  const targetInstruction = (sessionId) => {
    if (targetOf(sessionId) === 'cloud') {
      return [
        '[Rayrun 工作任务目标]',
        '当前任务运行在「云上电脑」：Rayrun 云电脑。',
        `- 默认机器名：${settings.sandboxName}；不存在时用 rayrun_sandbox 创建（需要桌面时 remote_desktop=true，内存至少 2048 MB）。`,
        '- 整段任务优先用 `rayrun_dsh delegate` 委托给云上 DSH worker：它会先镜像 workspace、校验 profile 投影、交付 Context Pack（handoff.md / manifest.json / workspace.patch / profile.json）并回显版本三元组，结果取回本地 `.dsh/results/<taskId>/`。',
        '- 委托前把目标、约束、已做决策、未决问题、验收标准填进 `objective` / `acceptance` / `constraints` / `decisions` / `open_questions`；缺目标或验收会被拒绝。',
        '- `rayrun_exec` / `rayrun_files` 只用于委托之外的细粒度操作（查状态、传单个文件）。',
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

  /**
   * Best-effort model credential creation for cloud agents. The key comes from
   * the connection form or the host environment and is only forwarded to Rayrun.
   */
  const storeModelCredential = async (input) => {
    const entered = String(input?.modelKey ?? '').trim()
    const key = entered || String(process.env.DEEPSEEK_API_KEY ?? '').trim()
    if (!key) return {}
    try {
      return { modelCredential: await ray.ensureModelCredential(key) }
    } catch (error) {
      // A key picked up from the environment is best effort; a typed one must report.
      if (!entered) return {}
      return { modelCredentialError: errorPayload(error).message }
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
        // A destroyed sandbox still answers GET with status "Terminated"; reusing
        // it makes every later call fail with "sandbox_not_running".
        if (byId && byId.status !== 'Terminated') return ray.wake(byId, signal)
      } catch {
        // fall through to a fresh lookup
      }
      pinned.delete(key)
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
              if (action === 'update') {
                reply(res, 200, { ok: true, update: await updateView(child) })
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
              case 'account':
                reply(res, 200, { ok: true, account: await ray.account() })
                return
              case 'credentials.list':
                reply(res, 200, { ok: true, credentials: await ray.listCredentials() })
                return
              case 'connection.save': {
                const connection = await ray.saveConnection(body)
                reply(res, 200, { ok: true, connection, ...(await storeModelCredential(body)) })
                return
              }
              case 'connection.test': {
                const result = await ray.testConnection(body)
                reply(res, 200, { ok: true, result })
                return
              }
              case 'login.methods':
                reply(res, 200, { ok: true, methods: await loginMethodsFor(body.baseUrl) })
                return
              case 'login.password': {
                const connection = await loginWithPassword(body)
                reply(res, 200, { ok: true, connection, ...(await storeModelCredential(body)) })
                return
              }
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
                const input = { ...body }
                if (String(body.modelKey ?? '').trim()) {
                  // A key typed in the create dialog becomes this machine's credential.
                  const created = await ray.ensureModelCredential(body.modelKey)
                  const list = Array.isArray(body.credentials) ? body.credentials : []
                  input.credentials = [...new Set([...list, created.name])]
                }
                const machine = await ray.createMachine(input)
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
              case 'update.check': {
                await checkForUpdate()
                reply(res, 200, { ok: true, update: await updateView(child) })
                return
              }
              case 'update.apply': {
                const manager = child.get('pluginManager')
                if (!manager) {
                  throw new LocalError('update_unavailable', 'The plugin manager is not mounted in this profile.')
                }
                const before = await updateView(child)
                if (!before.latest || !isNewer(before.latest, ownVersion)) {
                  throw new LocalError('up_to_date', 'This build is already the newest version.')
                }
                if (!before.canApply) {
                  throw new LocalError('update_locked', 'This install cannot update itself; reinstall it from the Plugins page.')
                }
                const result = await applyUpdate(manager, { name: PACKAGE_ID, from: ownVersion, to: before.latest })
                reply(res, 200, { ok: true, update: { ...before, available: false, canApply: false }, result })
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
      const holder = `exec on ${machine.name ?? machine.id}`
      cancelIdleStop(machine.id)
      workspaceLocks.acquire(machine.id, {
        holder,
        reason: lockReason('exec', args.command ?? (args.argv ?? []).join(' ')),
        ttlMs: (timeout + 120) * 1000,
      })
      let result
      try {
        result = await ray.exec(
          machine.id,
          {
            ...(args.command ? { command: String(args.command) } : { argv: args.argv.map(String) }),
            ...(args.cwd ? { cwd: String(args.cwd) } : {}),
            ...(args.env && typeof args.env === 'object' ? { env: args.env } : {}),
            timeout_seconds: timeout,
          },
          { timeoutMs: (timeout + 120) * 1000, signal: exec.signal },
        )
      } finally {
        workspaceLocks.release(machine.id, holder)
      }
      scheduleIdleStop(machine)
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
      const holder = `agent task on ${machine.name ?? machine.id}`
      cancelIdleStop(machine.id)
      workspaceLocks.acquire(machine.id, {
        holder,
        reason: lockReason('agent', args.prompt),
        ttlMs: budget + 120_000,
      })
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
        scheduleIdleStop(machine)
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
        workspaceLocks.release(machine.id, holder)
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

  /**
   * The cloud worker layer. Phase 0 established that the machine agent is a DSH
   * boot inside the guest (`dsh --profile headless` with $DSH_HOME on the
   * workspace), so the profile under `$DSH_HOME/profiles/headless` decides what
   * that agent can do. `sync` writes the local projection there; `status` reads
   * it back and compares revisions instead of assuming the upload landed.
   */
  const localProfile = () => {
    try {
      const context = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
      if (context && typeof context.dir === 'string' && context.dir) {
        return { name: String(context.name ?? 'unknown'), dir: context.dir }
      }
    } catch {
      // a Host without a profile context still gets a projection, just no provenance
    }
    return { name: null, dir: null }
  }

  const projectWorker = async () => {
    const profile = localProfile()
    return exportProfileProjection({
      sourceProfile: profile.name,
      sourceDir: profile.dir,
      plugin: { name: PACKAGE_ID, version: ownVersion },
      pluginFiles: await readPluginFiles(PACKAGE_DIR),
    })
  }

  /** The local session's event count, used as the delegation's sessionSeq. */
  const sessionSeqOf = (agent) => {
    try {
      const session = agent?.session
      const id = typeof session === 'string' ? session : session?.id
      const store = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      const live = (id && typeof store?.get === 'function' && store.get(id)) || (session && typeof session === 'object' ? session : undefined)
      const length = live?.log?.length
      return Number.isSafeInteger(length) ? length : null
    } catch {
      return null
    }
  }

  ctx.tools.register({
    name: 'rayrun_dsh',
    description:
      'Manage the DSH worker layer of a Rayrun cloud computer, and delegate tasks to it. The machine agent is a DSH boot inside the guest, so the profile under its $DSH_HOME decides what it may do: `sync` writes the local profile projection (worker layer plus this plugin) into that profile and verifies it landed, `status` reads it back. `delegate` mirrors the workspace, hands the worker a Context Pack (.dsh/handoff/<taskId>/), waits for the run, checks that the worker echoed the version triple, and pulls back what it wrote to .dsh/results/<taskId>/.',
    parameters: objectSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['sync', 'status', 'delegate'],
        description: 'sync (write and verify the worker layer) | status (read it back) | delegate (hand one task to the cloud worker).',
      },
      sandbox: sandboxParam,
      objective: {
        type: 'string',
        description: 'delegate, required: the one task the cloud worker must complete, stated once and completely.',
      },
      acceptance: {
        type: 'array',
        items: { type: 'string' },
        description: 'delegate, required: how the result will be judged; the worker reads it from handoff.md.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'delegate: limits the worker must respect.',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description: 'delegate: decisions already made locally that the worker must not revisit.',
      },
      open_questions: {
        type: 'array',
        items: { type: 'string' },
        description: 'delegate: questions to report back instead of guessing.',
      },
      context: {
        type: 'string',
        description: 'delegate: short local context worth carrying over (decisions, findings); goes to conversation.md.',
      },
      task_id: {
        type: 'string',
        description:
          'delegate: continue an existing task (same .dsh/handoff/<task_id>, next round). Omit to start a new task; the reply reports the task id.',
      },
      timeout_seconds: {
        type: 'integer',
        minimum: 1,
        maximum: 3600,
        description: 'delegate: give up after this many seconds. Defaults to 900.',
      },
    }),
    output: {
      schema: { type: 'string', description: 'Worker profile path, revision matches, and the cloud DSH/Node versions.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const action = String(args.action)
      const projection = await projectWorker()
      const pluginLine = (plugin) =>
        plugin ? `plugin ${plugin.name} ${shortRev(plugin.remoteRev)}${plugin.synced === false ? ' (stale)' : ''}` : 'plugin not projected'
      if (action === 'status') {
        const machine = await resolveExisting(args.sandbox)
        const remote = await readCloudWorker(ray, machine, projection, { signal: exec.signal })
        const layerSynced = remote.remoteRev === projection.rev
        const pluginSynced = remote.plugin?.remoteRev === projection.pluginRev
        return [
          `${machine.name ?? machine.id}: ${layerSynced && pluginSynced ? 'projection synced' : 'projection stale'}`,
          `profile ${remote.profile.dir} · layer local ${shortRev(projection.rev)} / remote ${shortRev(remote.remoteRev)}`,
          `plugin ${PACKAGE_ID} local ${ownVersion} · projected ${shortRev(projection.pluginRev)} / remote ${shortRev(remote.plugin?.remoteRev)}`,
          `dsh ${remote.dsh ?? 'unknown'} · node ${remote.node ?? 'unknown'} · cloudMode ${remote.layerRows > 0 ? 'applied' : 'not applied'}`,
          remote.manifest?.sourceProfile
            ? `synced from the "${remote.manifest.sourceProfile}" profile${remote.manifest.generatedAt ? ` at ${remote.manifest.generatedAt}` : ''}`
            : 'no projection manifest on the machine',
        ].join('\n')
      }
      if (action === 'delegate') {
        const machine = await resolveSandbox(args.sandbox, exec.signal)
        cancelIdleStop(machine.id)
        const result = await delegateTask({
          ray,
          machine,
          localDir: localDirectory(exec.agent),
          brief: {
            objective: args.objective,
            acceptance: args.acceptance,
            constraints: args.constraints,
            decisions: args.decisions,
            openQuestions: args.open_questions,
          },
          notes: args.context,
          taskId: args.task_id,
          timeoutMs: Math.min(Number(pick(args.timeout_seconds, 900)), 3600) * 1000,
          signal: exec.signal,
          locks: workspaceLocks,
          project: projectWorker,
          sessionSeq: sessionSeqOf(exec.agent),
        })
        const idleMinutes = scheduleIdleStop(machine)
        return [
          `${result.taskId} on ${result.machine}: round ${result.round} ${result.finished ? 'finished' : 'still running'}${result.outcome ? ` (${result.outcome})` : ''}`,
          `revs sessionSeq=${result.revs.sessionSeq ?? 'null'} workspaceRev=${shortRev(result.revs.workspaceRev)} profileRev=${shortRev(result.revs.profileRev)} · echoed: ${result.echoed ? 'matched' : 'MISSING'}`,
          result.echoed
            ? ''
            : '⚠ worker 没有回显 revs：它可能没读到 handoff；先在云端确认 .dsh/handoff/<taskId>/ 是否存在',
          `pack ${result.packDir} · results ${result.results.length ? `${result.resultsDir} (${result.results.join(', ')})` : 'none'}${result.resynced ? ' · profile resynced' : ''}${result.cost ? ` · cost $${result.cost.toFixed(4)}` : ''}${result.vmHours ? ` · ${result.vmHours.toFixed(3)} vm-h` : ''}`,
          result.results.includes('questions.md')
            ? `worker 有未决问题：见 ${result.resultsDir}/questions.md；用 task_id=${result.taskId} 再委托一轮带上答案`
            : '',
          idleMinutes ? `auto-stop in ${idleMinutes} min` : '',
          result.text ? `--- worker result ---\n${clamp(result.text)}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      }
      if (action !== 'sync') throw new Error('Unknown action; use "sync", "status" or "delegate".')
      const machine = await resolveSandbox(args.sandbox, exec.signal)
      const result = await syncCloudWorker(ray, machine, projection, { signal: exec.signal })
      if (!result.synced) {
        throw new LocalError(
          'projection_not_applied',
          `The cloud profile kept a different layer (remote ${shortRev(result.remoteRev)}, local ${shortRev(projection.rev)}); check the machine's write permissions.`,
        )
      }
      if (result.plugin && !result.plugin.synced) {
        throw new LocalError(
          'plugin_not_applied',
          `The cloud profile kept different plugin files (remote ${shortRev(result.plugin.remoteRev)}, local ${shortRev(result.plugin.rev)}); check the machine's write permissions.`,
        )
      }
      return [
        `${machine.name ?? machine.id}: projection synced`,
        `profile ${result.profile.dir} · layer rev ${shortRev(result.rev)}`,
        `wrote ${result.uploaded.join(', ')} · profile backup ${result.backup}`,
        `${pluginLine(result.plugin)}${result.bundleAdded ? ' · bundle added' : ' · bundle present'} · cloudMode ${result.layerRows > 0 ? 'applied' : 'not applied'}`,
        `dsh ${result.dsh ?? 'unknown'} · node ${result.node ?? 'unknown'}`,
        projection.manifest.sourceProfile ? `source profile "${projection.manifest.sourceProfile}"` : '',
      ]
        .filter(Boolean)
        .join('\n')
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Rayrun DSH ${args.action}${args.sandbox ? ` ${args.sandbox}` : ''}`,
      kind: 'other',
    }),
  })

  /**
   * Workspace projection. `push` mirrors the checkout into the cloud workspace
   * and proves the result (same HEAD, same dirty-patch digest); `pull` only
   * brings the cloud's changes back for review, because the local tree stays the
   * merge authority.
   */
  ctx.tools.register({
    name: 'rayrun_workspace',
    description:
      'Mirror the local git checkout to a Rayrun cloud computer and bring its changes back. `push` sends the commits (git bundle) plus dirty and untracked files, then verifies the cloud HEAD and dirty-patch digest; it refuses while a cloud task holds the workspace or when the cloud tree moved since the last push, unless `force` is set. `pull` writes the cloud diff into .dsh/incoming for local review and applies nothing.',
    parameters: objectSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['push', 'pull'],
        description: 'push (local → cloud, verified) | pull (cloud → .dsh/incoming, not applied).',
      },
      sandbox: sandboxParam,
      force: {
        type: 'boolean',
        description:
          'push only: replace a busy or drifted cloud workspace anyway. Discards cloud-side files that were never pulled, so use it only when that is intended.',
      },
    }),
    output: {
      schema: { type: 'string', description: 'Cloud workspace path, HEAD and digest match, or the downloaded diff location.' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const action = String(args.action)
      const localDir = localDirectory(exec.agent)
      if (action === 'pull') {
        const machine = await resolveExisting(args.sandbox)
        const result = await pullWorkspace(ray, machine, { localDir, signal: exec.signal })
        return [
          `${machine.name ?? machine.id}: pulled workspace changes`,
          `cloud HEAD ${shortRev(result.cloudHead)} · ${result.changed} changed entries · ${result.patchFiles} files in the diff`,
          `patch ${result.patchBytes} B → ${result.patchPath}`,
          'nothing applied: review the patch, then `git apply` (or discard) locally',
        ].join('\n')
      }
      if (action !== 'push') throw new Error('Unknown action; use "push" or "pull".')
      const machine = await resolveSandbox(args.sandbox, exec.signal)
      const result = await pushWorkspace(ray, machine, {
        localDir,
        force: args.force === true,
        lock: workspaceLocks.status(machine.id),
        signal: exec.signal,
      })
      if (!result.headMatched || !result.digestMatched || !result.applied) {
        throw new LocalError(
          'workspace_not_mirrored',
          [
            `The cloud workspace did not mirror the local checkout`,
            `HEAD local ${shortRev(result.head)} / cloud ${shortRev(result.cloudHead)}`,
            `digest local ${shortRev(result.localDigest)} / cloud ${shortRev(result.cloudDigest)}`,
            result.applyError ? `git apply: ${result.applyError}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        )
      }
      return [
        `${machine.name ?? machine.id}: workspace mirrored at ${result.root}`,
        `HEAD ${shortRev(result.head)} (matched) · dirty digest ${shortRev(result.localDigest)} (matched) · ${result.decision}`,
        `dirty patch ${result.patchBytes} B / ${result.patchFiles} files · untracked ${result.untracked.length} files (${result.untrackedBytes} B) · bundle ${result.bundleBytes} B`,
        `cloud status entries: ${result.cloudStatusLines}`,
      ].join('\n')
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Rayrun workspace ${args.action}${args.sandbox ? ` ${args.sandbox}` : ''}`,
      kind: 'other',
    }),
  })
}
