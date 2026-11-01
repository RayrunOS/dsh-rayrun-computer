/**
 * Server-sent-event helpers for the Rayrun `/events` stream.
 *
 * Extracted from index.js so the agent tool and the delegation path read the
 * same frames the same way.
 */

/** Read an SSE response body into parsed JSON data frames. */
export async function* sseFrames(res, signal) {
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
export function kindOf(event) {
  return String(event?.kind ?? event?.type ?? event?.event ?? '')
}

/** Whether a frame finishes the prompt the caller is waiting on. */
export function isFinished(kind) {
  return /(^|\.)(exited|done|completed|failed|cancelled)$/.test(kind) || kind === 'agent.exit'
}

/** Parse an `agent.raw` line: the sandbox agent's own stream-json output. */
export function parseLine(line) {
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
export function readFrame(event, kind) {
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
