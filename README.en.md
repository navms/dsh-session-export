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
| Tiny footprint | No runtime dependencies; it ships as a DSH bundle, so installing it puts the package in the profile's `node_modules` and adds one row to `dsh.profile.bundles` |

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

- DeepSeek Harness **Desktop** (which owns the built-in `desktop` profile) or the **Web profile** (`dsh web`). Both render the same web client, so the plugin behaves identically on either.
- Node.js ≥ 20 for the install script (matching `package.json` `engines`; the plugin itself runs inside the Harness process and starts nothing extra).
- The plugin ships as a **DSH bundle**: `package.json` declares `dsh.bundle.patch`, and the package's own `cordis.patch.yml` carries the Loader row to mount. That is what lets the Desktop and Web Plugins panels install it straight from a GitHub link.

## Installation

The easy path is inside the app: open the **Plugins** panel and install the repository URL.

```
https://github.com/navms/dsh-session-export
```

The panel runs `pnpm add` to put the package in the current profile's `node_modules`, records it in
`dsh.profile.bundles`, and the package's own `cordis.patch.yml` then applies as one bundle layer that
mounts the export routes and the session-header button. **Reload the window with Cmd/Ctrl+R when it finishes.**

### Command-line installation

If you would rather script it, the installer offers two routes:

```sh
# 1) Install from GitHub: runs pnpm add, exactly like the Plugins panel
node scripts/install.mjs --github
#   Without a value the spec comes from package.json's repository; or name it:
node scripts/install.mjs --github https://github.com/navms/dsh-session-export
node scripts/install.mjs --github github:navms/dsh-session-export

# 2) Clone locally and symlink: edits take effect immediately, best for development
git clone https://github.com/navms/dsh-session-export.git
cd dsh-session-export
node scripts/install.mjs
```

Both routes do the same two things (idempotent, safe to re-run):

1. put the package under the profile's `node_modules` (`--github` leaves this to pnpm; the default symlinks this working copy);
2. add the package name to `dsh.profile.bundles` in `$DSH_HOME/profiles/<profile>/package.json`.

Without `--profile`, the target is chosen from `$DSH_PROFILE`, then an existing `desktop`, then an existing
`web`, then `desktop` — so a bare invocation lands on the profile the Desktop app uses.

Useful flags:

```sh
node scripts/install.mjs --dry-run             # print every action without writing anything
node scripts/install.mjs --profile web         # target another profile (default: desktop)
node scripts/install.mjs --home /path/to/.dsh  # target another Harness home (default: $DSH_HOME or ~/.dsh)
node scripts/install.mjs --dsh /path/to/dsh    # harness CLI used by --github (default: $DSH_BIN, then dsh on PATH)
node scripts/install.mjs --pnpm /path/to/pnpm  # force a direct pnpm install (default: $DSH_PNPM, then pnpm on PATH)
node scripts/install.mjs --uninstall           # remove the link/dependency, the bundle entry, and any legacy row
```

`--github` prefers `dsh plugin --profile <profile> add <spec>`: that brings the pnpm the installation
ships, plus the profile write lock, failure rollback and bundle activation — and only the Desktop app's own
launcher may touch the reserved `desktop` profile. With no CLI in reach it falls back to a direct
`pnpm add` followed by its own bundle registration; passing `--pnpm` skips the CLI entirely.

> The Desktop app's CLI lives at `<app>/Contents/Resources/runtime/cli/bin/dsh`
> (on macOS: `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`).
> If the `dsh` on your PATH points somewhere else or is stale, name it with `--dsh`.

After installing or updating, **reload the window**: Cmd/Ctrl+R on Desktop, or refresh the browser page.

> Earlier versions inserted the Loader row directly into the profile's `cordis.patch.yml`. The installer now
> uses the bundle layer and migrates that row away — leaving both in place would insert the same row id twice.

### Manual installation

The script's first two steps, by hand:

```sh
PROFILE=~/.dsh/profiles/desktop        # use web for the browser profile
mkdir -p "$PROFILE/node_modules"
ln -s "$PWD" "$PROFILE/node_modules/dsh-session-export"
```

Then append `dsh-session-export` to `dsh.profile.bundles` in `$PROFILE/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-session-export"]
    }
  }
}
```

You can also bypass the bundle mechanism and insert the row directly into the profile's `cordis.patch.yml`
(the package still has to resolve from `node_modules`):

```sh
cat >> "$PROFILE/cordis.patch.yml" <<'YAML'

- insert:
    - id: session-transcript-export
      name: 'dsh-session-export'
YAML
```

## Uninstalling

```sh
node scripts/install.mjs --uninstall
```

This removes the symlink or profile dependency, the `dsh.profile.bundles` entry, and the row older versions
left in `cordis.patch.yml`. On Desktop you can also disable or remove the plugin from the Plugins panel.

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

> **How message content is treated**
>
> - **User messages go into a code block** (tagged `text`): your prompt is preserved exactly, including its own `#` headings, lists, code fences, tables and leading indentation. The surrounding backticks **grow automatically** (three backticks in the prompt means four around it), so a fence inside a prompt is neither parsed nor able to swallow what follows.
> - **Assistant replies, injected context and thinking** are still rendered as Markdown (lists, code blocks and emphasis survive), but their headings are **shifted down** (`#` → `####`, `##` → `#####`), so they never sit beside the export's own `#` title or `## Turn N` sections.

**JSON** — the raw event array, filtered by your selection, for further processing. Events keep the session log's exact shape (`type` / `seq` / `time` / `data`).

```json
{
  "format": "dsh-session-transcript",
  "version": 1,
  "exportedAt": "2026-09-29T04:13:20.000Z",
  "generator": { "name": "dsh-session-export", "version": "0.2.0" },
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

Override the defaults from the profile's `cordis.patch.yml`. The bundle layer already declares the
`session-transcript-export` row, so the profile's patch addresses it by id:

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
| The Plugins panel says it is installed, but there is no export button in the session header | The package must declare `dsh.bundle` **and** be recorded in the profile's `dsh.profile.bundles`. The panel does that for you; a manual `pnpm add` does not, so add the entry yourself (or use `node scripts/install.mjs --github`). Check that `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json` lists `dsh-session-export` |
| The panel reports “Cannot access GitHub” or a connection timeout | A GitHub URL or a `.tgz` link is not fetched through the registry, so this machine has to reach `github.com` directly (or through a proxy). You can also `git clone` elsewhere and install with `node scripts/install.mjs`, which only symlinks |
| I installed it and nothing happened | Reload the window (Cmd/Ctrl+R on Desktop, refresh in the browser) so the new client bundle enters `window.__DSH_BOOT__` |
| An error about the same row id being inserted twice | The profile's `cordis.patch.yml` still holds the `session-transcript-export` row that earlier versions inserted; delete it, or re-run `node scripts/install.mjs`, which migrates it automatically |
| I ticked “Session preamble” but nothing shows up | Preamble events all belong to “Other events”; tick that one too |
| Images are missing from the export | “Images” is off by default, and an image-only message exports nothing while it is off |
| A turn disappeared | That turn was filtered down to nothing; Markdown / HTML skip it (JSON keeps `events: []`) |
| The dialog shows a red error | The session log could not be read, or the session was removed; adjust and hit “Retry” |
| I only want the last few turns | Hit “Select none”, then tick the turns you want, or filter by turn number / keyword |
| My prompt contains `#`, a code block or a table — will it become part of the export? | No. User messages are rendered as a code block, so that syntax is never parsed |
| Can I export twice? | Yes — the dialog stays open; change the format or selection and click “Export” again |

## Known limitations

- One export covers the **current session** only: subagent sessions are not walked recursively and attachments are not bundled (Harness ships an `/export` command that produces a ZIP archive instead).
- The only entry point is the session-header button; no slash command is registered.
- Markdown inside the HTML export is rendered by a built-in subset (headings, fenced code, quotes, lists, rules, paragraphs, inline code/bold/italic/strikethrough/links); tables, footnotes, math and raw HTML come out as escaped text.
- An export loads the whole session log into memory, so very large sessions are bounded by “Max tool-result characters” and the artifact byte cap.
- More than `maxTurns` turns requires narrowing the selection first.
- The plugin declares an optional peer range on `@deepseek-ai/dsh` (via `peerDependenciesMeta.optional`, so pnpm never installs it). When the running Harness falls outside that range, Harness **skips** this bundle layer and asks for an exact-version exemption instead of loading against an API that may have moved on.

## License

[MIT](LICENSE)
