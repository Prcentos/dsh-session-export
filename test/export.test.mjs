import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import {
  buildTranscript,
  decodeSessionText,
  exportSessionFile,
  renderJson,
  renderMarkdown,
} from '../lib/export.mjs'

function writeTemp(dir, name, data) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, data)
  return file
}

function userEvent(text, kind = 'user') {
  return { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text }], source: { kind } } }
}

test('buildTranscript anchors turns on real user messages and drops synthetic context', () => {
  const events = [
    { type: 'session', id: 'session-abc', cwd: 'C:\\work', createdAt: 1795600623511, version: 4 },
    { type: 'session/title', data: { title: 'Demo' } },
    { type: 'model/selection', data: { provider: 'p', model: 'm' } },
    userEvent('hello'),
    userEvent('SKILLS CONTEXT', 'skill-catalog'),
    userEvent('now is ...', 'time-context'),
    {
      type: 'assistant/message',
      data: { message: { content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'hi there' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
      ] } },
    },
    { type: 'tool/result', data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'a.txt' }] } } },
    userEvent('second question'),
  ]

  const { session, messages } = buildTranscript(events)

  assert.equal(session.id, 'session-abc')
  assert.equal(session.title, 'Demo')
  assert.equal(session.createdAt, '2026-11-25T09:57:03.511Z')
  assert.deepEqual(session.model, { provider: 'p', model: 'm' })

  // Only the two human messages are turns.
  assert.equal(messages.length, 2)
  assert.equal(messages[0].user, 'hello')
  assert.equal(messages[1].user, 'second question')
  assert.equal(messages[0].reasoning[0], 'think')
  assert.equal(messages[0].text[0], 'hi there')
  assert.equal(messages[0].toolCalls[0].name, 'bash')
  assert.equal(messages[0].toolResults[0].name, 'bash')
  assert.equal(messages[0].toolResults[0].output, 'a.txt')
})

test('buildTranscript ignores a turn that never had a user message', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'compaction note' }] } } },
    userEvent('real'),
  ]
  const { messages } = buildTranscript(events)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].user, 'real')
})

test('decodeSessionText reads multi-frame zstd and plain logs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-export-test-'))
  try {
    const lines = [JSON.stringify(userEvent('one')), JSON.stringify(userEvent('two', 'runtime-context'))]
    const frame1 = zlib.zstdCompressSync(Buffer.from(`${lines[0]}\n`, 'utf8'))
    const frame2 = zlib.zstdCompressSync(Buffer.from(`${lines[1]}\n`, 'utf8'))
    const zstdFile = writeTemp(dir, 'session.v4.jsonl.zstd', Buffer.concat([frame1, frame2]))
    const zstd = decodeSessionText(zstdFile)
    assert.equal(zstd.plain, false)
    assert.equal(zstd.frames, 2)
    assert.ok(zstd.text.includes('"one"'))
    assert.ok(zstd.text.includes('"two"'))

    const plainFile = writeTemp(dir, 'session.v4.jsonl', '{"type":"x"}\n')
    const plain = decodeSessionText(plainFile)
    assert.equal(plain.plain, true)
    assert.equal(plain.text, '{"type":"x"}\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('exportSessionFile names files uniquely and renders both formats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-export-test-'))
  try {
    const events = [
      { type: 'session', id: 'session-bf53fa3f-1e43-4acc-a05e-c27f5dd816de', cwd: 'C:\\w', createdAt: 1795600623511, version: 4 },
      { type: 'session/title', data: { title: '跨设备 会话' } },
      userEvent('问题一'),
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答一' }] } } },
    ]
    const log = writeTemp(dir, 'session.v4.jsonl', `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)

    const outDir = path.join(dir, 'out')
    const result = exportSessionFile(log, outDir, { format: 'both' })
    assert.equal(result.turns, 1)
    assert.equal(result.files.length, 2)
    assert.ok(result.files[0].endsWith('.md'))
    assert.ok(result.files[0].includes('bf53fa3f'))
    assert.ok(result.files[1].endsWith('.json'))

    const md = fs.readFileSync(result.files[0], 'utf8')
    assert.ok(md.includes('schema: dsh-session-transcript/v1'))
    assert.ok(md.includes('> 问题一'))
    assert.ok(md.includes('答一'))

    const json = JSON.parse(fs.readFileSync(result.files[1], 'utf8'))
    assert.equal(json.schema, 'dsh-session-transcript/v1')
    assert.equal(json.turns[0].user, '问题一')
    assert.equal(json.turns[0].assistant[0], '答一')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('lean mode drops tool results and truncates tool arguments', () => {
  const session = { id: 's', title: 'T', cwd: 'C:\\w', createdAt: '2026-01-01T00:00:00.000Z' }
  const messages = [{
    turn: 1,
    user: 'q',
    reasoning: [],
    text: ['a'],
    toolCalls: [{ name: 'bash', arguments: `{"cmd":"${'x'.repeat(500)}"}` }],
    toolResults: [{ name: 'bash', output: 'secret' }],
  }]

  const full = renderJson(session, messages, { lean: false })
  assert.equal(full.turns[0].toolResults.length, 1)
  assert.ok(full.turns[0].toolCalls[0].arguments.length > 300)

  const lean = renderJson(session, messages, { lean: true })
  assert.equal(lean.turns[0].toolResults, undefined)
  assert.ok(JSON.stringify(lean.turns[0].toolCalls[0].arguments).length < 400)

  const mdLean = renderMarkdown(session, messages, { lean: true })
  assert.ok(!mdLean.includes('secret'))
})
