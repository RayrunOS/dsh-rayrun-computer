/**
 * X11 desktop automation for a Rayrun cloud computer.
 *
 * The `rayrun_desktop` tool is a thin wrapper: this module owns the shell
 * programs sent to the machine and the decoding of what comes back, so the
 * rules are pure and testable without a machine or an API call.
 *
 * Arguments always travel as positional parameters of `/bin/sh -c`, never
 * interpolated into the script: pasted text and key chords cannot become shell
 * syntax.
 */

/** Actions `rayrun_desktop` exposes, in the order the model should try them. */
export const DESKTOP_ACTIONS = ['screenshot', 'click', 'type', 'key', 'scroll', 'probe']

/** X11 button numbers behind the friendly names. */
const BUTTONS = { left: 1, middle: 2, right: 3 }

/** Wheel ticks: X11 sends button 4/5 rather than a scroll event. */
const WHEEL = { up: 4, down: 5 }

/**
 * A PNG above this size cannot survive the round trip: the machine truncates
 * command output at 4 MiB, and base64 costs a third on top.
 */
const MAX_SHOT_BYTES = 2_900_000

/** xdotool key syntax: names and chords, nothing that could be a shell word. */
const KEY_CHORD = /^[A-Za-z0-9_+.\- ]+$/

function integer(value, name) {
  const number = Number(value)
  if (!Number.isInteger(number)) throw new Error(`\`${name}\` must be an integer.`)
  return number
}

function coordinate(value, name) {
  const number = integer(value, name)
  if (number < 0) throw new Error(`\`${name}\` must be zero or greater.`)
  return number
}

function bounded(value, name, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const number = integer(value, name)
  if (number < min || number > max) throw new Error(`\`${name}\` must be from ${min} through ${max}.`)
  return number
}

/**
 * Build the `/bin/sh -c` argument vector for one desktop action.
 *
 * @param action - one of {@link DESKTOP_ACTIONS}.
 * @param params - tool arguments; only the ones the action needs are read.
 * @returns the argument vector plus the time to allow on the machine.
 * @throws Error naming the bad argument, before any machine call happens.
 */
export function buildDesktopCommand(action, params = {}) {
  const verb = String(action ?? '')
  if (!DESKTOP_ACTIONS.includes(verb)) {
    throw new Error(`Unknown action "${verb}"; use ${DESKTOP_ACTIONS.map((name) => `"${name}"`).join(', ')}.`)
  }

  const head = [
    'set -u',
    // The image runs its desktop on a display number the exec environment does
    // not export (:99 as of 2026-11); discover it from the X socket instead of
    // assuming :0.
    'if [ -z "${DISPLAY:-}" ]; then',
    '  for sock in /tmp/.X11-unix/X*; do',
    '    [ -e "$sock" ] || continue',
    '    DISPLAY=":${sock##*/X}"',
    '    break',
    '  done',
    'fi',
    ': "${DISPLAY:=:0}"',
    'export DISPLAY',
    'fail() { printf "rayrun_desktop: %s\\n" "$1" >&2; exit 78; }',
    'need() { command -v "$1" >/dev/null 2>&1; }',
  ]
  const NO_XDOTOOL = 'xdotool is missing on this machine; install it (apt-get install -y xdotool) and retry'

  const pack = (body, positional, timeoutSeconds) => ({
    argv: ['/bin/sh', '-c', [...head, ...body].join('\n'), 'rayrun-desktop', ...positional],
    timeout_seconds: timeoutSeconds,
  })

  if (verb === 'probe') {
    return pack(
      [
        'printf "display=%s\\n" "$DISPLAY"',
        'if need xdpyinfo; then',
        '  if xdpyinfo >/dev/null 2>&1; then printf "reachable=yes\\n"; else printf "reachable=no\\n"; fi',
        'fi',
        'for tool in xdotool scrot import ffmpeg xdpyinfo; do',
        '  if need "$tool"; then printf "%s=yes\\n" "$tool"; else printf "%s=no\\n" "$tool"; fi',
        'done',
        'if [ -d /tmp/.X11-unix ]; then for sock in /tmp/.X11-unix/*; do [ -e "$sock" ] && printf "socket=%s\\n" "${sock##*/}"; done; fi',
      ],
      [],
      30,
    )
  }

  if (verb === 'screenshot') {
    return pack(
      [
        'out="${TMPDIR:-/tmp}/rayrun-desktop-$$.png"',
        'rm -f "$out"',
        'if need scrot; then',
        '  scrot -o "$out" >/dev/null 2>&1 || fail "scrot could not capture $DISPLAY"',
        'elif need import; then',
        '  import -window root "$out" >/dev/null 2>&1 || fail "ImageMagick import could not capture $DISPLAY"',
        'elif need ffmpeg; then',
        '  ffmpeg -loglevel error -f x11grab -i "$DISPLAY" -frames:v 1 -y "$out" >/dev/null 2>&1 || fail "ffmpeg could not capture $DISPLAY"',
        'else',
        '  fail "no screenshot backend on this machine: install scrot or imagemagick, then retry"',
        'fi',
        '[ -s "$out" ] || fail "the screenshot file is empty"',
        'bytes=$(wc -c < "$out" | tr -d " ")',
        `[ "$bytes" -le ${MAX_SHOT_BYTES} ] || { rm -f "$out"; fail "the screenshot is $bytes bytes, above the ${MAX_SHOT_BYTES}-byte limit; lower the desktop resolution and retry"; }`,
        'base64 < "$out" | tr -d "\\n"',
        'rm -f "$out"',
      ],
      [],
      90,
    )
  }

  if (verb === 'click') {
    const x = coordinate(params.x, 'x')
    const y = coordinate(params.y, 'y')
    const button = String(params.button ?? 'left')
    if (!(button in BUTTONS)) throw new Error('`button` must be "left", "middle" or "right".')
    const count = bounded(params.count, 'count', 1, 1, 10)
    return pack(
      [
        `need xdotool || fail "${NO_XDOTOOL}"`,
        'xdotool mousemove --sync "$1" "$2" || fail "could not move the pointer to $1,$2"',
        'xdotool click --repeat "$4" --delay 120 "$3" || fail "could not click button $3"',
        'printf "clicked %s,%s button=%s count=%s\\n" "$1" "$2" "$3" "$4"',
      ],
      [String(x), String(y), String(BUTTONS[button]), String(count)],
      30,
    )
  }

  if (verb === 'type') {
    const text = String(params.text ?? '')
    if (text.length === 0) throw new Error('`text` is required for type.')
    return pack(
      [
        `need xdotool || fail "${NO_XDOTOOL}"`,
        'delay="${2:-12}"',
        'xdotool type --delay "$delay" -- "$1" || fail "xdotool could not type the text; non-ASCII input may need a keyboard layout"',
        'printf "typed %s bytes\\n" "${#1}"',
      ],
      [text, '12'],
      60,
    )
  }

  if (verb === 'key') {
    const keys = String(params.keys ?? '')
    if (keys.length === 0) throw new Error('`keys` is required for key, e.g. "Return" or "ctrl+s".')
    if (!KEY_CHORD.test(keys)) throw new Error('`keys` may only contain letters, digits, and - _ + . and spaces.')
    return pack(
      [
        `need xdotool || fail "${NO_XDOTOOL}"`,
        'xdotool key -- "$1" || fail "xdotool could not send the key chord $1"',
        'printf "sent key %s\\n" "$1"',
      ],
      [keys],
      30,
    )
  }

  const x = coordinate(params.x, 'x')
  const y = coordinate(params.y, 'y')
  const direction = String(params.direction ?? 'down')
  if (!(direction in WHEEL)) throw new Error('`direction` must be "up" or "down".')
  const amount = bounded(params.amount, 'amount', 3, 1, 20)
  return pack(
    [
      `need xdotool || fail "${NO_XDOTOOL}"`,
      'xdotool mousemove --sync "$1" "$2" || fail "could not move the pointer to $1,$2"',
      'xdotool click --repeat "$4" --delay 60 "$3" || fail "could not scroll at $1,$2"',
      'printf "scrolled %s ticks at %s,%s\\n" "$4" "$1" "$2"',
    ],
    [String(x), String(y), String(WHEEL[direction]), String(amount)],
    30,
  )
}

/**
 * Turn a failed `rayrun_exec` result into the one line the model should read.
 *
 * @param result - the exec result (`exit_code`, `stderr`, `timed_out`).
 * @returns the message, or undefined when the command succeeded.
 */
export function desktopFailure(result) {
  if (result?.timed_out) return 'the desktop command timed out'
  const code = Number(result?.exit_code ?? 0)
  if (code === 0) return undefined
  const stderr = String(result?.stderr ?? '').trim()
  const marked = /rayrun_desktop:\s*([\s\S]+)/.exec(stderr)
  if (marked) return marked[1].trim()
  return stderr || `the desktop command exited ${code}`
}

/**
 * Decode the base64 PNG a screenshot action prints on stdout.
 *
 * @param stdout - the command's standard output.
 * @returns the PNG bytes.
 * @throws Error when the machine printed nothing or something else.
 */
export function decodeScreenshot(stdout) {
  const encoded = String(stdout ?? '').replace(/\s+/g, '')
  if (!encoded) throw new Error('the machine returned no screenshot bytes')
  const data = Buffer.from(encoded, 'base64')
  if (data.length < 8 || data[0] !== 0x89 || data.toString('latin1', 1, 4) !== 'PNG') {
    throw new Error('the machine returned data that is not a PNG screenshot')
  }
  return data
}
