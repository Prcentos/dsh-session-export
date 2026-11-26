# dsh-session-export

Export any DeepSeek Harness (DSH) session as a **portable Markdown or JSON transcript** — readable by a human, resumable in another agent, or re-importable on another machine.

It adds two model tools and one slash command to a DSH host profile:

| Surface | What it does |
| --- | --- |
| `session_export` tool | Export one session (defaults to the current one) to `.md` and/or `.json`. |
| `session_export_all` tool | Export every session under the session root in one call. |
| `/export-sessions [all] [lean\|full] [session-id]` | The same two operations from the prompt box. |

No cloud service, no account, no git remote. The transcripts are plain files you can copy, email, upload, or feed to any LLM.

## Install

From a checkout:

```sh
dsh plugin --profile <profile> add ./plugins/dsh-session-export
```

Or from npm (once published):

```sh
dsh plugin --profile <profile> add dsh-session-export
```

`--profile` is `web` for the web profile, `desktop` for DSH Desktop.

In DSH Desktop the same install is available from the Plugins page ("install from folder") — point it at this directory. The plugin is host-only: no build step, no dependencies, no network access.

## Usage

```text
/export-sessions
/export-sessions all
/export-sessions all lean
/export-sessions <session-id>
```

By default files land in `$DSH_HOME/session-export` (normally `~/.dsh/session-export`), named `<title-slug>-<session-id-first-8>.md` and `.json`. A title collision cannot overwrite another session because the id suffix is part of the name.

`lean` mode drops tool results and truncates tool-call arguments, which is the right choice when the transcript is meant as a prompt for another model rather than a full audit log.

## Configuration

All keys live in the plugin's `cordis.patch.yml` config block:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Mount the plugin. |
| `sessionRoot` | string | `''` | Root of the DSH session store; empty means `$DSH_HOME/sessions`. |
| `outputDir` | string | `''` | Where transcripts are written; empty means `$DSH_HOME/session-export`. |
| `lean` | boolean | `false` | Default to compact transcripts. |
| `registerCommand` | boolean | `true` | Register `/export-sessions`. |
| `registerTools` | boolean | `true` | Register the two model tools. |

## What goes into a transcript

A transcript contains only real conversation turns: a turn starts at a `user/message` whose `source.kind` is `user`. Synthetic context injected by the host (skill catalog, time context, model selection, runtime reminders) is not part of the conversation and is dropped.

Each turn records, when present:

- the user message;
- the assistant's visible text;
- the assistant's reasoning blocks;
- tool calls (name and arguments);
- tool results (full mode only, truncated to 4 KB per result).

Markdown gets YAML front matter (`schema`, `session_id`, `title`, `cwd`, `created_at`, `model`) followed by one `## Turn N` section per turn. JSON uses the `dsh-session-transcript/v1` schema:

```json
{
  "schema": "dsh-session-transcript/v1",
  "exportedAt": "2026-11-26T14:00:00.000Z",
  "session": { "id": "...", "title": "...", "cwd": "...", "createdAt": "...", "model": { "provider": "...", "model": "..." } },
  "turns": [
    { "turn": 1, "user": "...", "assistant": ["..."], "reasoning": ["..."],
      "toolCalls": [{ "name": "...", "arguments": {} }],
      "toolResults": [{ "name": "...", "output": "..." }] }
  ]
}
```

## Format notes

DSH's JSONL session backend stores a session as a sequence of lines, its current on-disk format is `session.v4.jsonl.zstd`, and each appended batch is sealed as its own **zstd frame** — the file is a concatenation of frames, not one frame. Node's `zlib.zstdDecompressSync` only decodes the first frame, so this plugin splits the file on the zstd magic (`28 b5 2f fd`) and decompresses frame by frame. Plain uncompressed logs (`compression: 'none'`) are read as UTF-8 directly.

The reader tolerates a torn tail: lines that are not valid JSON are counted and skipped rather than aborting the export.

## Limits

- The export is **read-only**: it never writes into the session store.
- Session ids may be given with or without the `session-` prefix.
- A session whose store is still being appended to by a live writer is exported from the bytes that exist at read time (append-only files are safe to read).
- Thinking/reasoning content is exported when the model produced it and the host recorded it; otherwise the transcript simply has no reasoning blocks.

## Development

```sh
node --test test/
```

The export core (`lib/export.mjs`) has no DSH dependency, so tests run with plain Node; the plugin itself is a Host-only bundle (`cordis.patch.yml` inserts it by `id`/`name`).

## License

MIT. See [LICENSE](./LICENSE).
