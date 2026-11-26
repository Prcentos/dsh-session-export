/**
 * dsh-session-export — DSH plugin entry.
 *
 * Two model tools and one slash command:
 *   - session_export      export one session (defaults to the current one)
 *   - session_export_all  export every session under the session root
 *   - /export-sessions    [all] [lean|full] [session-id]
 *
 * The export itself lives in `lib/export.mjs` and has no DSH dependency, so
 * the same code powers the tools, the command and the tests.
 */

import os from 'node:os'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  exportAllSessions,
  exportSessionFile,
  findSessionFile,
} from './lib/export.mjs'

export const name = 'session-export'

// No hard service dependency: tools and command are registered through
// `ctx.inject` below, so a profile without either surface simply gets no row
// for this plugin instead of a stuck "pending" plugin.
export const inject = []

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Mount the plugin.'),
  sessionRoot: Schema.string().default('').description('Root of the DSH session store; empty = $DSH_HOME/sessions.'),
  outputDir: Schema.string().default('').description('Directory transcripts are written to; empty = $DSH_HOME/session-export.'),
  lean: Schema.boolean().default(false).description('Default to compact transcripts (no tool results, truncated tool arguments).'),
  registerCommand: Schema.boolean().default(true).description('Register the /export-sessions command.'),
  registerTools: Schema.boolean().default(true).description('Register the session_export and session_export_all tools.'),
})

const FORMATS = ['md', 'json', 'both']
const PLUGIN = 'dsh-session-export'

function defaultHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), '.dsh')
}

/** Normalise the raw (already Schema-validated) config into absolute paths. */
export function resolveConfig(config = {}) {
  const home = defaultHome()
  const sessionRoot = String(config.sessionRoot ?? '').trim()
  const outputDir = String(config.outputDir ?? '').trim()
  return {
    enabled: config.enabled !== false,
    sessionRoot: sessionRoot === '' ? path.join(home, 'sessions') : sessionRoot,
    outputDir: outputDir === '' ? path.join(home, 'session-export') : outputDir,
    lean: config.lean === true,
    registerCommand: config.registerCommand !== false,
    registerTools: config.registerTools !== false,
  }
}

function normaliseFormat(value) {
  return FORMATS.includes(value) ? value : 'both'
}

/** Keep only defined keys: the host rejects tool results that are not lossless JSON. */
function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function makeExportTool(config, warn) {
  return defineTool({
    name: 'session_export',
    description:
      'Export one DSH session as portable Markdown and/or JSON transcript files. '
      + 'Defaults to the current session and to writing both formats. '
      + 'Returns the absolute paths that were written.',
    parameters: {
      sessionId: { type: 'string', description: 'Session id to export; omit for the current session.' },
      format: { type: 'string', enum: FORMATS, description: 'md, json, or both (default both).' },
      lean: { type: 'boolean', description: 'Compact transcript: drop tool results, truncate tool arguments.' },
      outputDir: { type: 'string', description: 'Directory to write into; omit for the plugin default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          turns: { type: 'integer' },
          frames: { type: 'integer' },
          files: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.ok !== true) {
          return [{ type: 'text', text: `session_export failed: ${value.error ?? 'unknown error'}` }]
        }
        const lines = [
          `Exported "${value.title ?? value.sessionId}" — ${value.turns ?? 0} turn(s), ${value.frames ?? 0} zstd frame(s).`,
          ...(value.files ?? []).map((file) => `  ${file}`),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      const sessionId = args.sessionId || exec.agent?.session?.id
      if (!sessionId) {
        return { ok: false, error: 'no sessionId was supplied and this tool call has no current session' }
      }
      const outputDir = args.outputDir || config.outputDir
      const hit = findSessionFile(config.sessionRoot, sessionId)
      if (hit === null) {
        return { ok: false, sessionId, error: `session ${sessionId} was not found under ${config.sessionRoot}` }
      }
      try {
        const result = exportSessionFile(hit.file, outputDir, {
          lean: args.lean ?? config.lean,
          format: normaliseFormat(args.format),
        })
        return compact({
          ok: true,
          sessionId: result.sessionId,
          title: result.title,
          turns: result.turns,
          frames: result.frames,
          files: result.files,
        })
      } catch (error) {
        warn?.(`session_export failed: ${error?.message ?? error}`)
        return { ok: false, sessionId, error: String(error?.message ?? error) }
      }
    },
  })
}

function makeExportAllTool(config, warn) {
  return defineTool({
    name: 'session_export_all',
    description:
      'Export every DSH session found under the plugin session root as portable Markdown and/or JSON transcripts. '
      + 'Returns the number exported, the output directory, and any per-session failures.',
    parameters: {
      outputDir: { type: 'string', description: 'Directory to write into; omit for the plugin default.' },
      lean: { type: 'boolean', description: 'Compact transcripts: drop tool results, truncate tool arguments.' },
      format: { type: 'string', enum: FORMATS, description: 'md, json, or both (default both).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'integer' },
          outDir: { type: 'string' },
          failed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.ok === false && value.error !== undefined) {
          return [{ type: 'text', text: `session_export_all failed: ${value.error}` }]
        }
        const failed = value.failed ?? []
        const lines = [`Exported ${value.count ?? 0} session(s) to ${value.outDir ?? ''}.`]
        if (failed.length > 0) {
          lines.push(`Failed: ${failed.length}`)
          for (const item of failed) lines.push(`  ${item.sessionId}: ${item.error}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      const outputDir = args.outputDir || config.outputDir
      try {
        const result = exportAllSessions(config.sessionRoot, outputDir, {
          lean: args.lean ?? config.lean,
          format: normaliseFormat(args.format),
        })
        return {
          ok: result.ok,
          count: result.count,
          outDir: result.outDir,
          failed: result.failed,
        }
      } catch (error) {
        warn?.(`session_export_all failed: ${error?.message ?? error}`)
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  })
}

function describeExported(list) {
  if (list.length === 0) return 'nothing was exported'
  return list
    .map((item) => `  ${item.title ?? item.sessionId} — ${item.turns} turn(s) → ${item.files.join(', ')}`)
    .join('\n')
}

const COMMAND_USAGE =
  'Usage: /export-sessions [all] [lean|full] [session-id] — export transcripts as Markdown and JSON '
  + '(no session id exports the current session; "all" exports every session under the session root).'

/** Parse `/export-sessions [all] [lean|full] [session-id]` and run the export. */
async function handleCommand(invocation, config) {
  const tokens = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens[0] === 'help' || tokens[0] === '?') return { kind: 'success', text: COMMAND_USAGE }
  const all = tokens.includes('all')
  const lean = tokens.includes('lean') ? true : tokens.includes('full') ? false : config.lean
  const sessionId = tokens.find((token) => token !== 'all' && token !== 'lean' && token !== 'full')

  try {
    if (all) {
      const result = exportAllSessions(config.sessionRoot, config.outputDir, { lean, format: 'both' })
      if (!result.ok && result.count === 0) {
        return { kind: 'error', text: `Export failed:\n${result.failed.map((item) => `  ${item.sessionId}: ${item.error}`).join('\n')}` }
      }
      const failed = result.failed.length > 0
        ? `\nFailed:\n${result.failed.map((item) => `  ${item.sessionId}: ${item.error}`).join('\n')}`
        : ''
      return {
        kind: 'success',
        text: `Exported ${result.count} session(s) to ${result.outDir}.${failed}`,
      }
    }

    const targetId = sessionId || invocation.agent?.session?.id
    if (!targetId) return { kind: 'success', text: COMMAND_USAGE }
    const hit = findSessionFile(config.sessionRoot, targetId)
    if (hit === null) return { kind: 'error', text: `Session ${targetId} was not found under ${config.sessionRoot}` }
    const result = exportSessionFile(hit.file, config.outputDir, { lean, format: 'both' })
    return {
      kind: 'success',
      text: `Exported "${result.title}" — ${result.turns} turn(s).\n${result.files.map((file) => `  ${file}`).join('\n')}`,
    }
  } catch (error) {
    return { kind: 'error', text: `Export failed: ${error?.message ?? error}` }
  }
}

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const logger = typeof ctx.logger === 'function' ? ctx.logger(PLUGIN) : undefined
  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // Logging is best-effort; never let it break an export.
    }
  }

  if (resolved.registerTools) {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.tools.register(makeExportTool(resolved, warn))
      toolCtx.tools.register(makeExportAllTool(resolved, warn))
    })
  }

  if (resolved.registerCommand) {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'export-sessions',
        description: 'Export DSH session transcripts as portable Markdown/JSON files.',
        input: { hint: '[all] [lean|full] [session-id]' },
        async handler(invocation) {
          return handleCommand(invocation, resolved)
        },
      })
    })
  }
}
