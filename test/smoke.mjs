/**
 * Smoke test for the export core: run under plain Node (>= 22.15) or the DSH
 * Electron runtime (`ELECTRON_RUN_AS_NODE=1`).
 *
 *   node test/smoke.mjs [sessionRoot] [outDir]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  exportAllSessions,
  exportSessionFile,
  findSessionFile,
  listSessionFiles,
} from '../lib/export.mjs'

const root = process.argv[2] || (process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'sessions')
  : path.join(os.homedir(), '.dsh', 'sessions'))
const outDir = process.argv[3] || path.join(os.tmpdir(), 'dsh-export-smoke')

fs.rmSync(outDir, { recursive: true, force: true })
const found = listSessionFiles(root)
console.log(`session root: ${root}`)
console.log(`session files found: ${found.length}`)

const all = exportAllSessions(root, outDir, { format: 'both' })
console.log(`exported: ${all.count}, failed: ${all.failed.length}, out: ${all.outDir}`)
for (const item of all.failed) console.log(`  FAILED ${item.sessionId}: ${item.error}`)

const sample = all.exported.filter((item) => item.turns > 1).slice(0, 3)
for (const item of sample) {
  console.log(`  - ${item.title} | ${item.turns} turns | ${item.frames} frames | ${item.badLines} bad | ${item.files.length} files`)
}

if (all.exported.length > 0) {
  const biggest = all.exported.slice().sort((a, b) => (b.turns - a.turns))[0]
  const md = biggest.files.find((file) => file.endsWith('.md'))
  if (md) {
    const text = fs.readFileSync(md, 'utf8')
    console.log(`\n--- ${path.basename(md)} head (${text.length} chars) ---`)
    console.log(text.slice(0, 1200))
  }
}

// Exact lookup must accept both `session-<uuid>` and `<uuid>`.
const first = found[0]
if (first) {
  const exact = findSessionFile(root, first.id)
  console.log(`\nfindSessionFile(${first.id}) -> ${exact ? path.basename(exact.file) : 'MISS'}`)
  const single = exportSessionFile(first.file, path.join(outDir, 'single'), { format: 'md', lean: true })
  console.log(`single export: ${single.turns} turns, files: ${single.files.map((f) => path.basename(f)).join(', ')}`)
}
