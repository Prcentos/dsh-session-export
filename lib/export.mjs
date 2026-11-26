/**
 * dsh-session-export — session transcript export core.
 *
 * Dependency-free functions shared by the tools, the `/export-sessions`
 * command and the tests. Nothing in here touches DSH services, so it can run
 * under plain Node (>= 22.15 for `zlib.zstdDecompressSync`) and under the DSH
 * Electron runtime alike.
 *
 * The one non-obvious piece of the format: DSH's JSONL backend seals every
 * appended batch as its own independent zstd frame, so a compressed
 * `session.vN.jsonl.zstd` file is a *concatenation* of frames. Node's zstd
 * helpers decode only the first frame, so `decodeSessionText` splits the file
 * on the frame magic and decompresses frame by frame before concatenating.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** Frame magic of a zstd frame (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Schema identifier written into every exported JSON transcript. */
export const TRANSCRIPT_SCHEMA = 'dsh-session-transcript/v1'

/** True only for messages a human actually typed; synthetic runtime context has other kinds. */
const USER_KIND = 'user'

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode a session log file into its raw JSONL text.
 *
 * @param {string} file - absolute path to `session.vN.jsonl` or `session.vN.jsonl.zstd`.
 * @returns {{ text: string, frames: number, plain: boolean }} decoded text plus frame count.
 */
export function decodeSessionText(file) {
  const raw = fs.readFileSync(file)
  if (raw.length === 0) return { text: '', frames: 0, plain: false }
  const firstMagic = raw.indexOf(ZSTD_MAGIC)
  if (firstMagic === -1) {
    // No zstd magic at all: this is a plain `compression: 'none'` log.
    return { text: raw.toString('utf8'), frames: 0, plain: true }
  }
  if (firstMagic !== 0) {
    throw new Error(
      `unexpected ${firstMagic} leading byte(s) before the first zstd frame in ${path.basename(file)}`,
    )
  }
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('this Node.js runtime has no zlib.zstdDecompressSync; use Node.js >= 22.15')
  }
  const parts = []
  let frames = 0
  let offset = 0
  while (offset < raw.length) {
    const next = raw.indexOf(ZSTD_MAGIC, offset + 4)
    const end = next === -1 ? raw.length : next
    parts.push(zlib.zstdDecompressSync(raw.subarray(offset, end)))
    frames += 1
    offset = end
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames, plain: false }
}

/**
 * Parse raw session text into events, tolerating (and counting) broken lines.
 *
 * @param {string} text - decoded JSONL text.
 * @returns {{ events: object[], bad: number }}
 */
export function parseEvents(text) {
  const events = []
  let bad = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      bad += 1
    }
  }
  return { events, bad }
}

// ---------------------------------------------------------------------------
// Transcript construction
// ---------------------------------------------------------------------------

/** Content blocks carried by an event, whether under `content` or `message.content`. */
function blocksOf(event) {
  const data = event?.data ?? {}
  if (Array.isArray(data.content)) return data.content
  if (Array.isArray(data.message?.content)) return data.message.content
  return []
}

function textBlocks(event) {
  return blocksOf(event)
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

function toolCallId(block) {
  return block.id ?? block.callId ?? block.toolCallId ?? ''
}

/**
 * Fold raw events into ordered turns, each anchored on a real user message.
 *
 * `user/message` events with a `source.kind` other than `user` are synthetic
 * runtime context (skill catalog, time context, model selection, ...): they
 * are not turns and are deliberately dropped.
 *
 * @param {object[]} events - parsed session events.
 * @returns {{ session: object, messages: object[] }}
 */
export function buildTranscript(events) {
  const session = {}
  const messages = []
  let current = null
  const callNames = new Map()

  const startTurn = (turn) => {
    current = {
      turn,
      user: null,
      reasoning: [],
      text: [],
      toolCalls: [],
      toolResults: [],
    }
    return current
  }

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    switch (event.type) {
      case 'session': {
        // The header event carries its fields at the top level; older logs may
        // wrap them in `data`, so accept either shape.
        const data = event.data && (event.data.id || event.data.cwd) ? event.data : event
        if (typeof data.id === 'string') session.id = data.id
        if (typeof data.cwd === 'string') session.cwd = data.cwd
        if (typeof data.createdAt === 'number') session.createdAt = new Date(data.createdAt).toISOString()
        else if (typeof data.createdAt === 'string') session.createdAt = data.createdAt
        if (typeof data.version === 'number') session.version = data.version
        break
      }
      case 'session/title': {
        const title = event.data?.title
        if (typeof title === 'string') session.title = title
        break
      }
      case 'model/selection': {
        const data = event.data ?? {}
        if (data.provider && data.model) session.model = { provider: data.provider, model: data.model }
        break
      }
      case 'turn/start': {
        if (current !== null) messages.push(current)
        startTurn(event.data?.turn ?? messages.length + 1)
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== USER_KIND) break
        const text = textBlocks(event)
        if (current === null || current.user !== null) {
          if (current !== null) messages.push(current)
          startTurn(messages.length + 1)
        }
        current.user = text
        break
      }
      case 'assistant/message': {
        if (current === null) break
        for (const block of blocksOf(event)) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'text') {
            current.text.push(block.text ?? '')
          } else if (block.type === 'reasoning') {
            current.reasoning.push(block.text ?? '')
          } else if (block.type === 'tool-call') {
            const id = toolCallId(block)
            if (block.name) callNames.set(id, block.name)
            current.toolCalls.push({ id, name: block.name ?? '(anonymous)', arguments: block.arguments })
          }
        }
        break
      }
      case 'tool/call': {
        if (current === null) break
        const data = event.data ?? {}
        const id = data.callId ?? data.id ?? ''
        if (data.name) callNames.set(id, data.name)
        current.toolCalls.push({ id, name: data.name ?? '(anonymous)', arguments: data.arguments })
        break
      }
      case 'tool/result': {
        if (current === null) break
        const data = event.data ?? {}
        const id = data.toolCallId ?? data.message?.toolCallId ?? ''
        current.toolResults.push({
          id,
          name: callNames.get(id) ?? data.name ?? '(anonymous)',
          output: textBlocks(event),
        })
        break
      }
      default:
        break
    }
  }
  if (current !== null) messages.push(current)

  // Turns that never got a user message are synthetic (e.g. compaction) and
  // add noise to a portable transcript; keep only anchored turns.
  const anchored = messages.filter((message) => message.user !== null)
  return { session, messages: anchored }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function truncate(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (${text.length - max} chars truncated)`
}

function blockquote(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

function formatArguments(args, lean) {
  if (args === undefined || args === null) return ''
  let text
  if (typeof args === 'string') {
    try {
      text = JSON.stringify(JSON.parse(args))
    } catch {
      text = args
    }
  } else {
    try {
      text = JSON.stringify(args)
    } catch {
      text = String(args)
    }
  }
  return ` — \`${truncate(text, lean ? 200 : 2000).replace(/`/g, "'")}\``
}

function truncateJson(value, max) {
  // Arguments are strings in the session log but objects in-memory; keep the
  // source text and cut it, rather than parsing a cut string back.
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return truncate(text, max)
}

/**
 * Render a transcript as Markdown (front matter + one section per turn).
 */
export function renderMarkdown(session, messages, options = {}) {
  const { lean = false, sourceFile = '' } = options
  const lines = []
  lines.push('---')
  lines.push(`schema: ${TRANSCRIPT_SCHEMA}`)
  lines.push(`session_id: ${session.id ?? 'unknown'}`)
  lines.push(`title: ${JSON.stringify(session.title ?? 'Untitled session')}`)
  if (session.cwd) lines.push(`cwd: ${JSON.stringify(session.cwd)}`)
  if (session.createdAt) lines.push(`created_at: ${JSON.stringify(session.createdAt)}`)
  if (session.model) lines.push(`model: ${JSON.stringify(`${session.model.provider}/${session.model.model}`)}`)
  lines.push('---', '')
  lines.push(`# ${session.title ?? 'Untitled session'}`, '')

  const meta = []
  if (session.id) meta.push(`\`${session.id}\``)
  if (session.cwd) meta.push(`workspace \`${session.cwd}\``)
  if (session.createdAt) meta.push(`started ${session.createdAt}`)
  meta.push(`${messages.length} turn(s)`)
  lines.push(`> ${meta.join(' · ')}`, '')
  if (sourceFile) lines.push(`Source: \`${sourceFile}\``, '')

  messages.forEach((message, index) => {
    lines.push(`## Turn ${message.turn ?? index + 1}`, '')
    if (message.user !== null && message.user !== '') {
      lines.push('**User**', '', blockquote(message.user), '')
    }

    const reasoning = message.reasoning.filter((chunk) => chunk.trim() !== '')
    if (reasoning.length > 0) {
      lines.push(`**Reasoning** (collapsed${lean ? ', omitted in lean mode' : ''})`, '')
      if (!lean) {
        for (const chunk of reasoning) lines.push(blockquote(chunk), '')
      }
    }

    if (message.toolCalls.length > 0) {
      lines.push(`**Tool calls** (${message.toolCalls.length})`, '')
      for (const call of message.toolCalls) {
        lines.push(`- \`${call.name}\`${formatArguments(call.arguments, lean)}`, '')
      }
    }

    if (!lean && message.toolResults.length > 0) {
      lines.push(`**Tool results** (${message.toolResults.length})`, '')
      for (const result of message.toolResults) {
        lines.push(`<details><summary><code>${result.name}</code></summary>`, '', '```', truncate(result.output, 4000), '```', '', '</details>', '')
      }
    }

    const assistantText = message.text.filter((chunk) => chunk.trim() !== '')
    if (assistantText.length > 0) {
      lines.push('**Assistant**', '', assistantText.join('\n\n'), '')
    }

    lines.push('---', '')
  })

  return `${lines.join('\n')}\n`
}

/**
 * Render a transcript as a stable, agent-agnostic JSON object.
 */
export function renderJson(session, messages, options = {}) {
  const { lean = false } = options
  const turns = messages.map((message, index) => {
    const turn = {
      turn: message.turn ?? index + 1,
      user: message.user ?? '',
    }
    if (message.reasoning.length > 0) turn.reasoning = message.reasoning
    if (message.text.length > 0) turn.assistant = message.text
    if (message.toolCalls.length > 0) {
      turn.toolCalls = message.toolCalls.map((call) => ({
        name: call.name,
        arguments: lean ? truncateJson(call.arguments, 300) : call.arguments,
      }))
    }
    if (!lean && message.toolResults.length > 0) {
      turn.toolResults = message.toolResults.map((result) => ({
        name: result.name,
        output: truncate(result.output, 4000),
      }))
    }
    return turn
  })

  return {
    schema: TRANSCRIPT_SCHEMA,
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      createdAt: session.createdAt,
      version: session.version,
      model: session.model,
    },
    turns,
  }
}

// ---------------------------------------------------------------------------
// Files, discovery, batch export
// ---------------------------------------------------------------------------

function slugify(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug === '' ? 'session' : slug
}

function idShort(id) {
  const hex = String(id ?? '').replace(/^session-/, '').replace(/[^0-9a-f]/gi, '')
  return hex.slice(0, 8) || 'unknown'
}

/**
 * Write one session's transcript(s).
 *
 * @param {string} file - session log file.
 * @param {string} outDir - directory to create/write into.
 * @param {{ lean?: boolean, format?: 'md'|'json'|'both' }} options
 * @returns {{ ok: true, sessionId: string, title: string, turns: number, frames: number, plain: boolean, badLines: number, files: string[] }}
 */
export function exportSessionFile(file, outDir, options = {}) {
  const { lean = false, format = 'both' } = options
  const { text, frames, plain } = decodeSessionText(file)
  const { events, bad } = parseEvents(text)
  const { session, messages } = buildTranscript(events)

  const id = session.id ?? path.basename(path.dirname(file))
  const title = session.title ?? id
  const base = `${slugify(title)}-${idShort(id)}`
  fs.mkdirSync(outDir, { recursive: true })

  const files = []
  if (format === 'md' || format === 'both') {
    const target = path.join(outDir, `${base}.md`)
    fs.writeFileSync(target, renderMarkdown(session, messages, { lean, sourceFile: file }), 'utf8')
    files.push(target)
  }
  if (format === 'json' || format === 'both') {
    const target = path.join(outDir, `${base}.json`)
    fs.writeFileSync(target, `${JSON.stringify(renderJson(session, messages, { lean }), null, 2)}\n`, 'utf8')
    files.push(target)
  }

  return { ok: true, sessionId: id, title, turns: messages.length, frames, plain, badLines: bad, files }
}

/** Walk a session root and return every session log file with its id. */
export function listSessionFiles(root) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && /^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) {
        found.push({ file: full, id: path.basename(dir) })
      }
    }
  }
  walk(root)
  return found
}

/** Resolve one session id to its log file, accepting an optional `session-` prefix. */
export function findSessionFile(root, sessionId) {
  const wanted = String(sessionId ?? '').replace(/^session-/, '')
  if (wanted === '') return null
  return listSessionFiles(root).find((entry) => entry.id.replace(/^session-/, '') === wanted) ?? null
}

/**
 * Export every session under `root`.
 *
 * @returns {{ ok: boolean, count: number, outDir: string, exported: object[], failed: { sessionId: string, error: string }[] }}
 */
export function exportAllSessions(root, outDir, options = {}) {
  const exported = []
  const failed = []
  for (const entry of listSessionFiles(root)) {
    try {
      exported.push(exportSessionFile(entry.file, outDir, options))
    } catch (error) {
      failed.push({ sessionId: entry.id, error: String(error?.message ?? error) })
    }
  }
  return { ok: failed.length === 0, count: exported.length, outDir, exported, failed }
}
