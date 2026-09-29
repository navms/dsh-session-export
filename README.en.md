English | [简体中文](README.md)

# dsh-session-export

Export DeepSeek Harness sessions as **Markdown / HTML / JSON**, choosing exactly which **turns** and which **event types** to include.

Data is read straight from the session log on local disk (the event array behind `readSession`) — no extra service, no network request.

![Export session dialog](images/image.png)

## Features

| Capability | Description |
|---|---|
| Three formats | `Markdown` (raw Markdown transcript), `HTML` (single self-contained file you can open offline), `JSON` (the raw event array) |
| Turn selection | Pick turns one by one, select all / none, filter by turn number or prompt text; events before the first `turn/start` are offered separately as the **session preamble** |
| Event-type selection | 13 switches you can combine freely — see the table below |
| Live counts | Each turn shows its event count, each event type shows how many matches the current turn selection; types with nothing to export are greyed out |
| Advanced options | Max tool-result characters, embed images in HTML, collapse thinking blocks |
| Reusable panel | The dialog stays open after an export, so you can switch format or selection and export again in one session |
| Safe by default | The HTML export escapes first and then renders, so `<script>`, `</style>`, `javascript:` links and `onerror=` inside session text cannot escape |
| Tiny footprint | The plugin declares no runtime dependencies; installing it is one symlink plus one config line |

**Only “User messages” and “Assistant messages” are enabled by default**, so the first export is a clean conversation transcript. Thinking, tool calls/results, images, file attachments, injected context, token usage, turn/step markers, failed attempts, raw stream records and other events all start disabled — tick them in the dialog when you need them.

### Event types

| Event type | Default | What is exported |
|---|:--:|---|
| User messages | ✅ | Prompts you typed (`user/message` with `source.kind === 'user'`) |
| Assistant messages | ✅ | The model's visible reply text |
| Thinking | ☐ | The model's reasoning content, collapsed by default in HTML |
| Tool calls | ☐ | Tool name plus its arguments (raw JSON, pretty-printed) |
| Tool results | ☐ | What each tool returned; truncatable via “Max tool-result characters”, and every cut says how much was omitted |
| Images | ☐ | Image attachments in messages (embedded as data URIs in HTML, described in Markdown) |
| File attachments | ☐ | File references in messages (name and size, not file contents) |
| Injected context | ☐ | System prompt, developer messages, and context injected automatically (tool results, nested AGENTS.md, skill content, …) |
| Token usage | ☐ | Input / output / cached tokens per model call |
| Turn & step markers | ☐ | `turn/start`, `turn/end`, `step/start`, `step/end` timeline markers |
| Incomplete attempts | ☐ | Model calls that failed, were retried, or were interrupted (`assistant/attempt`) |
| Raw stream records | ☐ | The model's raw streaming output — the most detailed and largest option |
| Other events | ☐ | Everything not covered above: permission preset, sandbox mode, approval policy, plan mode, injected records in the preamble, … |

## Requirements

- DeepSeek Harness with the Web profile (`dsh web` / `dsh --profile web`)
- Node.js ≥ 22 for the install script (the plugin itself starts no extra process inside Harness)

## Installation

```sh
git clone git@github.com:navms/dsh-session-export.git
# or: git clone https://github.com/navms/dsh-session-export.git
cd dsh-session-export
node scripts/install.mjs
```

The installer does two things (idempotent, safe to re-run):

1. Creates a symlink to this directory under `$DSH_HOME/profiles/web/node_modules/`;
2. Appends the plugin entry to `$DSH_HOME/profiles/web/cordis.patch.yml` (backed up to `*.dsh-session-export.bak` before its first change).

Useful flags:

```sh
node scripts/install.mjs --dry-run            # print the actions without writing anything
node scripts/install.mjs --profile web        # target another profile (default: web)
node scripts/install.mjs --home /path/to/.dsh # target another Harness home (default: $DSH_HOME or ~/.dsh)
node scripts/install.mjs --uninstall          # remove the symlink and the config entry, restoring the original file byte for byte
```

After installing or updating, **restart `dsh web` and refresh the browser page**.

### Manual installation

If you prefer not to run the script:

```sh
ln -s "$PWD" ~/.dsh/profiles/web/node_modules/dsh-session-export
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'YAML'

- insert:
    - id: session-transcript-export
      name: 'dsh-session-export'
YAML
```

## Usage

1. Open any session and click the **export button** (download icon) in the session header;
2. Pick a **format**: Markdown / HTML / JSON;
3. Choose the **turns** to export (select all / none, or filter by turn number or prompt text when there are many);
4. Choose the **event types** to include (expand “Advanced” to tune truncation and embedding);
5. Click **Export** and the browser starts downloading; the dialog stays open so you can export another combination.

The file name is generated server-side: `dsh-session-<session-id>-<YYYYMMDD-HHmm>.<extension>` (UTC).

### Selection rules

- **Unchecked turns** never appear in the output.
- A **checked turn that the event types filtered down to nothing** is skipped in Markdown / HTML (the header notes how many turns were skipped), while JSON keeps the turn with `events: []`.
- **Session preamble**: the events before the first `turn/start` (session-level records such as the permission preset, sandbox mode and approval policy). They all belong to the “Other events” category, so ticking the preamble while “Other events” stays off exports nothing from it. A session with no preamble events does not show that row at all.
- **Messages with no exportable content**: an image-only message produces nothing while “Images” is off.
- **Very long sessions**: the number of turns per export is capped by `maxTurns` (2000 by default); the dialog asks you to narrow the selection first.

### Export formats

**Markdown** — the header carries the session facts (id, creation time, working directory, model, selected turns, export time), then one `## Turn N` section per turn with its events in chronological order. Thinking blocks use collapsible `<details>`, tool arguments and results use fenced code blocks whose fence grows automatically when the payload contains backticks.

**HTML** — one file, inline styles, no external resources: easy to send to someone or open offline. It follows the system light/dark theme, has a table of contents at the top, and — with “Embed images in HTML” enabled — inlines images as data URIs under a total byte budget, falling back to a placeholder note beyond it.

**JSON** — the raw event array, filtered by your selection, for further processing. Events keep the session log's exact shape (`type` / `seq` / `time` / `data`).

```json
{
  "format": "dsh-session-transcript",
  "version": 1,
  "exportedAt": "2026-09-29T04:13:20.000Z",
  "generator": { "name": "dsh-session-export", "version": "0.1.0" },
  "selection": {
    "format": "json",
    "turns": [1, 2],
    "includePreamble": true,
    "sections": { "user": true, "assistant": true, "thinking": false, "…": false },
    "options": { "maxToolResultChars": 20000 }
  },
  "session": {
    "id": "session-…",
    "createdAt": 0,
    "cwd": "…",
    "model": { "provider": "…", "model": "…" },
    "title": "…"
  },
  "preamble": { "eventCount": 3, "events": [{ "type": "permission/preset", "seq": 0, "time": 0, "data": { "preset": "workspace-write" } }] },
  "turns": [
    {
      "turn": 1,
      "startSeq": 3,
      "endSeq": 11,
      "startedAt": 0,
      "endedAt": 0,
      "endReason": "completed",
      "open": false,
      "eventCount": 9,
      "events": [{ "type": "user/message", "seq": 4, "time": 0, "data": { "…": "…" } }]
    }
  ]
}
```

Filtering rules: turning off “Raw stream records” deletes `data.stream`, turning off “Token usage” deletes `data.usage`, and turning off “Thinking”, “Assistant messages”, “Tool calls”, “Images” or “File attachments” removes the corresponding blocks from `data.message.content`.

## Configuration

Override the defaults from the profile's `cordis.patch.yml`:

```yaml
- id: session-transcript-export
  name: 'dsh-session-export'
  config:
    maxTurns: 2000                  # maximum turns per export
    maxToolResultChars: 20000       # truncation threshold for tool results / other events
    maxOutputBytes: 33554432        # maximum artifact size in bytes
    maxEmbeddedImageBytes: 8388608  # total budget for images embedded in HTML
    defaultSections:                # list only what you want to change
      thinking: true
      toolCalls: true
```

## FAQ

| Question | Answer |
|---|---|
| I ticked “Session preamble” but nothing shows up | Preamble events all belong to “Other events”; tick that one too |
| Images are missing from the export | “Images” is off by default, and an image-only message exports nothing while it is off |
| A turn disappeared | That turn was filtered down to nothing; Markdown / HTML skip it (JSON keeps `events: []`) |
| The dialog shows a red error | The session log could not be read, or the session was removed; adjust and hit “Retry” |
| I only want the last few turns | Hit “Select none”, then tick the turns you want, or filter by turn number / keyword |
| Can I export twice? | Yes — the dialog stays open; change the format or selection and click “Export” again |

## Known limitations

- One export covers the **current session** only: subagent sessions are not walked recursively and attachments are not bundled (Harness ships an `/export` command that produces a ZIP archive instead).
- The only entry point is the session-header button; no slash command is registered.
- Markdown inside the HTML export is rendered by a built-in subset (headings, fenced code, quotes, lists, rules, paragraphs, inline code/bold/italic/strikethrough/links); tables, footnotes, math and raw HTML come out as escaped text.
- An export loads the whole session log into memory, so very large sessions are bounded by “Max tool-result characters” and the artifact byte cap.
- More than `maxTurns` turns requires narrowing the selection first.

## License

[MIT](LICENSE)
