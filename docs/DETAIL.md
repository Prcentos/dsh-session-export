# dsh-session-export — design detail

## Why this exists

DSH keeps sessions as **local** files. The DeepSeek account is used for inference authentication only; there is no server-side session store, so two machines signed into the same account do not share history. This plugin closes that gap the boring way: it turns a session into a self-describing document that can be moved, mailed, pasted, or replayed into another agent.

## Read path

```
session.v4.jsonl.zstd
  └─ split on zstd frame magic (28 b5 2f fd)
       └─ zstdDecompressSync per frame
            └─ concat → UTF-8 JSONL text
                 └─ JSON.parse per line (bad lines counted, not fatal)
                      └─ buildTranscript → turns
                           ├─ renderMarkdown
                           └─ renderJson
```

DSH's JSONL backend seals each appended batch as an **independent zstd frame**, so the file is a frame concatenation and not a single frame. `zlib.zstdDecompressSync` decodes only the first frame, which is why the reader splits on the magic. A plain `compression: 'none'` log has no magic and is read as UTF-8 directly.

## Turn model

A turn begins at a `user/message` event whose `data.source.kind` is `user`. Everything else with a `user/message` type is synthetic host context:

| `source.kind` | example |
| --- | --- |
| `user` | the human's actual prompt |
| `runtime-context` | environment / platform footer |
| `skill-catalog` | the skills list |
| `time-context` | sampled timestamps |
| `model-selection` | model picker notice |

Only the first row is conversation. The exporter drops the rest, which is why a 13-message `user/message` log can yield 6 turns.

Within a turn the exporter keeps:

- `assistant/message` → visible text, reasoning blocks, `tool-call` blocks;
- `tool/call` → tool name and raw arguments (a JSON string in the log);
- `tool/result` → the tool output text, joined to its call by `toolCallId`.

## Output shapes

Markdown: YAML front matter plus `## Turn N` sections, tool results inside `<details>` so the file stays skimmable.

JSON: `dsh-session-transcript/v1`:

```json
{
  "schema": "dsh-session-transcript/v1",
  "exportedAt": "2026-11-26T14:00:00.000Z",
  "session": { "id": "...", "title": "...", "cwd": "...", "createdAt": "...", "version": 4,
               "model": { "provider": "...", "model": "..." } },
  "turns": [
    { "turn": 1,
      "user": "...",
      "assistant": ["..."],
      "reasoning": ["..."],
      "toolCalls": [{ "name": "...", "arguments": {} }],
      "toolResults": [{ "name": "...", "output": "..." }] }
  ]
}
```

Lean mode keeps `user`, `assistant`, `reasoning`, and tool names with 300-character argument previews; tool results are omitted.

## Portability

The JSON transcript is agent-agnostic: the `turns` array can be mapped directly onto a chat-completions `messages` array (`user` → `user`, `assistant` → `assistant`, tool calls/results → the target agent's tool protocol). The Markdown transcript is meant for humans and for `paste this document` style hand-offs.

## Safety

The plugin is read-only with respect to the session store: it opens session files for reading and writes only into `outputDir`. It never deletes, renames, or truncates a session log. A live session can be exported mid-write because the store is append-only; the export sees the bytes present at read time.
