/**
 * Checks for the computer-use tool: the X11 programs `rayrun_desktop` sends to
 * the machine (lib/desktop.js) and its registration in the real `apply` export.
 *
 * Nothing here touches the Rayrun API: argument rules are rejected before a
 * machine is resolved, and the rest is pure string handling.
 *
 *   node test/desktop.mjs
 */
import assert from 'node:assert/strict'
import { DESKTOP_ACTIONS, buildDesktopCommand, decodeScreenshot, desktopFailure } from '../lib/desktop.js'
import { apply } from '../index.js'

const tools = []
const store = { resolve: async () => undefined, set: async () => {}, unset: async () => {} }

const child = {
  effect(fn) {
    fn()
    return () => {}
  },
  get: (name) => (name === 'credentials' ? store : undefined),
  webServer: { register: () => () => {}, getOrigin: () => 'http://127.0.0.1:1' },
}

const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  inject(deps, callback) {
    if (Array.isArray(deps) && deps.includes('webServer')) callback(child)
    if (Array.isArray(deps) && deps.includes('systemPrompt')) {
      callback({ effect: (fn) => fn(), systemPrompt: { context: () => ({}) } })
    }
    return () => {}
  },
  get(name) {
    if (name === 'credentials') return store
    if (name === 'profileContext') return { name: 'desktop', dir: null }
    return undefined
  },
  tools: {
    register(tool) {
      tools.push(tool)
    },
    guard() {
      return () => {}
    },
  },
}

apply(ctx, {})

const desktop = tools.find((tool) => tool.name === 'rayrun_desktop')

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('rayrun_desktop is registered with every action', () => {
  assert.ok(desktop, 'rayrun_desktop is registered')
  assert.deepEqual(desktop.parameters.properties.action.enum, DESKTOP_ACTIONS)
  assert.deepEqual(desktop.parameters.required, ['action'])
  assert.equal(desktop.parameters.properties.sandbox.type, 'string')
  assert.match(desktop.description, /screenshot/)
  assert.match(desktop.description, /xdotool/)
})

check('bad arguments are rejected before any machine is resolved', async () => {
  const cases = [
    [{ action: 'click' }, /`x` must be an integer/],
    [{ action: 'click', x: 1 }, /`y` must be an integer/],
    [{ action: 'click', x: 1, y: 2, button: 'wheel' }, /`button` must be/],
    [{ action: 'click', x: 1, y: 2, count: 99 }, /`count` must be from 1 through 10/],
    [{ action: 'type' }, /`text` is required/],
    [{ action: 'key', keys: 'rm -rf /' }, /`keys` may only contain/],
    [{ action: 'scroll', x: 1, y: 2, direction: 'left' }, /`direction` must be/],
    [{ action: 'scroll', x: 1, y: 2, amount: 0 }, /`amount` must be from 1 through 20/],
    [{ action: 'drag' }, /Unknown action "drag"/],
  ]
  for (const [args, pattern] of cases) {
    await assert.rejects(
      () => desktop.execute(args, { signal: undefined }),
      (error) => pattern.test(String(error?.message)),
      `${JSON.stringify(args)} should be refused`,
    )
  }
})

check('typed text travels as a positional argument, never as shell source', () => {
  const text = `'; rm -rf / # $(id)`
  const { argv } = buildDesktopCommand('type', { text })
  assert.equal(argv[0], '/bin/sh')
  assert.equal(argv[1], '-c')
  assert.equal(argv.at(-2), text, 'the text is a positional argument')
  assert.ok(!argv[2].includes('rm -rf'), 'the script itself carries no user text')
  assert.match(argv[2], /"\$1"/)
})

check('every action discovers the display and reports missing xdotool', () => {
  const click = buildDesktopCommand('click', { x: 10, y: 20 }).argv[2]
  assert.match(click, /\/tmp\/\.X11-unix\/X\*/, 'the display comes from the X socket')
  assert.match(click, /DISPLAY=":\$\{sock##\*\/X\}"/)
  assert.match(click, /: "\$\{DISPLAY:=:0\}"/, 'and still falls back to :0')
  assert.match(click, /apt-get install -y xdotool/)
  assert.match(click, /mousemove --sync "\$1" "\$2"/)
  const screenshot = buildDesktopCommand('screenshot')
  assert.match(screenshot.argv[2], /scrot/)
  assert.match(screenshot.argv[2], /imagemagick/)
  assert.equal(screenshot.timeout_seconds, 90)
  assert.match(buildDesktopCommand('probe').argv[2], /reachable=/, 'probe says whether the display answers')
})

check('button, count, direction and amount map to X11 numbers', () => {
  assert.deepEqual(buildDesktopCommand('click', { x: 0, y: 0, button: 'right', count: 2 }).argv.slice(-4), [
    '0',
    '0',
    '3',
    '2',
  ])
  assert.deepEqual(buildDesktopCommand('scroll', { x: 5, y: 6, direction: 'up', amount: 4 }).argv.slice(-4), [
    '5',
    '6',
    '4',
    '4',
  ])
})

check('a screenshot round-trips through base64', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  assert.deepEqual(decodeScreenshot(png.toString('base64')), png)
  assert.throws(() => decodeScreenshot(''), /no screenshot bytes/)
  assert.throws(() => decodeScreenshot(Buffer.from('not a png').toString('base64')), /not a PNG/)
})

check('failures keep the machine-side message', () => {
  assert.equal(desktopFailure({ exit_code: 0 }), undefined)
  assert.equal(
    desktopFailure({ exit_code: 78, stderr: 'rayrun_desktop: no screenshot backend on this machine\n' }),
    'no screenshot backend on this machine',
  )
  assert.equal(desktopFailure({ exit_code: 1, stderr: 'boom\n' }), 'boom')
  assert.equal(desktopFailure({ exit_code: null, timed_out: true }), 'the desktop command timed out')
})

check('render emits a text block, plus the image for a screenshot', () => {
  const textOnly = desktop.output.render(undefined, { action: 'click', sandbox: 'box', detail: 'clicked 1,2' })
  assert.equal(textOnly.length, 1)
  assert.equal(textOnly[0].type, 'text')
  assert.match(textOnly[0].text, /clicked 1,2/)

  const withImage = desktop.output.render(undefined, {
    action: 'screenshot',
    sandbox: 'box',
    detail: '10 B PNG',
    image: { attachmentId: 'abc', mediaType: 'image/png', bytes: 10, width: 1280, height: 800, name: 'box-desktop.png' },
  })
  assert.equal(withImage.length, 2)
  assert.deepEqual(withImage[1], {
    type: 'image',
    attachment: { attachmentId: 'abc', mediaType: 'image/png', bytes: 10, width: 1280, height: 800, name: 'box-desktop.png' },
  })
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
  }
}
console.log(`${checks.length - failed}/${checks.length} checks passed`)
if (failed) process.exitCode = 1
