# Architecture

This document describes how Kaido is put together. It is meant for contributors; user documentation lives elsewhere.

## Overview

Kaido is a [Tauri v2](https://tauri.app) desktop app. The interface is written in Svelte and TypeScript and runs in the system webview; a small Rust backend handles everything that needs the operating system.

```
┌──────────────────── Svelte UI ────────────────────┐
│  lib/ui        components, design tokens          │
│  lib/core      parsing, index, search, app state  │  platform-independent TypeScript
│  lib/storage   Storage interface                  │
│    └─ TauriStorage ──► Tauri commands ──► Rust: filesystem, git, file watcher
└───────────────────────────────────────────────────┘
```

Most logic lives in `lib/core` as plain TypeScript with no platform dependencies. The Rust side stays thin: file I/O, running `git`, watching the notes folder, and OS integration (tray, global shortcuts, notifications). Keeping the core in TypeScript lets future clients (web, mobile) reuse it by providing a different `Storage` implementation.

## Frontend structure

The frontend is a single-page app built with Vite and Svelte 5 (no SvelteKit). `src/main.ts` loads the bundled fonts and global styles, then mounts `src/App.svelte`.

| Path | Contents | May import |
|---|---|---|
| `src/lib/core/` | Platform-independent logic and its unit tests (`*.test.ts`) | Other `core` modules only |
| `src/lib/config/` | Settings schemas, parsing with per-field fallback, precedence | `core`, `valibot` |
| `src/lib/storage/` | The `Storage` interface, `TauriStorage` (desktop) and `MemoryStorage` (tests and browser preview) | `core`, `valibot`, `@tauri-apps/*` |
| `src/lib/ui/` | Svelte components, app state (`appState.svelte.ts`), `tokens.css` (design tokens), `base.css` | `core`, `config`, `storage`, `svelte` |

The `$lib` alias points to `src/lib`. Fonts (JetBrains Mono, Geist) are bundled with the app, so nothing is loaded from the network.

### Enforced boundaries

These rules are checked by `pnpm check` and `pnpm lint`, so a violation fails the build checks:

- **No platform types in the core or config.** `tsconfig.core.json` type-checks `src/lib/core` and `src/lib/config` with only the `ES2022` library and no ambient types. Using `document`, `window` or other DOM APIs there is a type error.
- **Core and config stay platform independent.** In `src/lib/core` and `src/lib/config`, ESLint rejects imports of `@tauri-apps/*`, `svelte` and `svelte/*`, `*.svelte` files, the UI layer (`$lib/ui`, or any relative `ui` path) and the storage layer (`$lib/storage`, or any relative `storage` path).
- **Core is the bottom layer.** `src/lib/core` additionally may not import the config layer (`$lib/config`, or any relative `config` path).
- **Storage builds on core only.** In `src/lib/storage`, ESLint rejects imports of `svelte` and `svelte/*`, `*.svelte` files, the UI layer and the config layer. Constants shared by storage and config (such as the workspace config path) live in core.
- **Platform access only through storage.** ESLint rejects `@tauri-apps/*` imports in every `.ts` and `.svelte` file under `src/` except `src/lib/storage`.

## Tech stack

| Area | Choice |
|---|---|
| Shell | Tauri v2 |
| UI | Svelte 5, TypeScript, Vite |
| Styling | Plain CSS with design tokens (CSS custom properties) |
| Editor | CodeMirror 6 with Markdown live preview |
| Search | MiniSearch (in-memory full-text index) |
| Validation | valibot |
| Backend | Rust: `notify` for file watching, system `git` for version control |
| Tests | Vitest (TypeScript), `cargo test` (Rust) |

## Workspace layout

A Kaido workspace is a folder (normally a git repository) of Markdown files:

```
workspace/
├── inbox/              default project for quick capture
│   └── tasks.md
├── <project>/          one folder per project
│   ├── tasks.md        the project's task list (reserved name)
│   ├── <note>.md       notes
│   └── <sub>/<note>.md notes in subfolders
├── <loose>.md          shown in the inbox
├── _archive/           archived projects
│   └── <project>/
├── .kaido/config.json  workspace settings (synced)
└── .gitattributes
```

The rules live in `src/lib/core/workspace.ts` (`classifyPath`, `buildWorkspace`):

| Path | Becomes |
|---|---|
| `<project>/tasks.md` | The project's task list |
| `<project>/**/<name>.md` | A note of the project, named by its path inside the project (`api/auth.md`). A `tasks.md` in a subfolder is an ordinary note. |
| `<name>.md` at the root | A note in `inbox` (a root `tasks.md` is a note too) |
| `_archive/<project>/...` | An archived project, built with the same rules |
| `_archive/<name>.md` | Not shown |

- Only files ending in `.md` (any case) count. Everything else is ignored.
- `inbox` always exists, even when the folder does not.
- Names starting with `.` (`.git`, `.kaido`, temp files) and `node_modules` are ignored at any depth.
- Paths matching the workspace `ignore` patterns (see [Configuration](#configuration)) are ignored.
- Folder symlinks are not followed. A file symlink is listed only if it resolves to a note or the workspace config file inside the workspace.
- A **note**'s title is its first heading, or the file name.
- A **task** is a Markdown checkbox (`- [ ]` / `- [x]`). Open tasks are counted only in task lists.

The files are the source of truth. The search index and caches live in the app's data directory, never in the workspace.

### Ignore patterns

`ignore` in `.kaido/config.json` takes a small gitignore-like subset (`src/lib/core/glob.ts`):

| Pattern | Matches |
|---|---|
| `drafts`, `*.draft.md` | A name at any depth (no `/` in the pattern) |
| `scratch/old`, `/scratch` | A path anchored at the workspace root |
| `tmp/` | Folders only |
| `*`, `?` | Any run of characters / one character, never `/` |
| `**` | Any number of folders (`**/drafts`, `notes/**`) |

Ignoring a folder ignores everything inside it. Blank lines and `#` comments are skipped. Negation (`!`) is not supported and such patterns are skipped; brackets match literally.

## Storage layer

All platform access goes through the `Storage` interface (`src/lib/storage/types.ts`). Paths are relative to the workspace root and `/`-separated (`api-payments/deploy.md`).

| Method | Does |
|---|---|
| `pickWorkspaceFolder()` | Shows the native folder picker; resolves to an absolute path or `null` |
| `openWorkspace(path)` | Opens an existing folder, replacing the current workspace and its watcher |
| `listFiles()` | Lists every listable Markdown file, sorted by path |
| `readFile(path)` | Reads a note or `.kaido/config.json`; resolves to `{ contents, hash }` |
| `writeFile(path, contents, { expectedHash? })` | Atomically writes a note or `.kaido/config.json`; resolves to its `FileEntry` plus the new `hash`. See [Conditional writes](#conditional-writes) |
| `renameFile(from, to)` | Renames a note within its folder without replacing another file; resolves to the `FileEntry` and `hash` of the file at `to` |
| `deleteFile(path, expectedHash)` | Moves a note to the system trash, only if it still has `expectedHash`. The note is removed permanently only where no trash is available: on Linux, when the trash folders cannot be written (missing, no permission, read-only, full). On Windows and macOS a failed trash move is reported and the note is kept, as is any other trash failure on Linux. Notes over 8 MiB cannot be renamed or deleted, since no hash is handed out for them |
| `readSettings()` / `writeSettings(contents)` | Reads or writes the raw device `settings.json` (`null` if missing) |
| `watch(listener)` | Subscribes to workspace changes, including the app's own writes |
| `onCloseRequested(handler)` | Runs `handler` before the window closes; it resolves to `false` to keep the window open |

`createStorage()` in `src/lib/storage/index.ts` picks the backend:

| Backend | Used for |
|---|---|
| `TauriStorage` | The desktop app. Calls the Rust commands and listens to the watcher event. Responses are validated with valibot; an unexpected response becomes an `Io` error, and a malformed change event is treated as a rescan. |
| `MemoryStorage` | Tests and `pnpm dev` in a browser (serves a sample workspace). Follows the same path, size, read-only, conditional write, rename and delete rules as the desktop backend and can simulate external edits. Deleted notes are kept in its `trash` list. Its hash is a fast non-cryptographic content hash; like the desktop hash, equal contents always give equal hashes. |

### Commands

The Rust commands live in `src-tauri/src/commands.rs`. Each one runs its disk work on a blocking thread, so the UI never waits on I/O. Every command is listed in `src-tauri/build.rs` and granted explicitly in the window capability.

| Command | Arguments | Returns |
|---|---|---|
| `pick_workspace_folder` | – | `string \| null` |
| `open_workspace` | `path` (absolute) | `{ root }`, the canonical absolute root |
| `list_files` | – | `FileEntry[]` |
| `read_file` | `path` | `{ contents, hash }` |
| `write_file` | `path`, `contents`, optional `expectedHash` | `FileEntry` and `hash` |
| `rename_file` | `from`, `to` | `FileEntry` and `hash` of the file at `to` |
| `delete_file` | `path`, `expectedHash` | – |
| `read_settings` | – | `string \| null` |
| `write_settings` | `contents` | – |

`FileEntry` is `{ path, size, modified }`, with `modified` in milliseconds since the Unix epoch. `hash` is the lowercase hex SHA-256 of the file's bytes; the frontend only compares hashes and never computes them.

### Conditional writes

`expectedHash` makes a write safe against changes made outside the app:

| `expectedHash` | Writes when |
|---|---|
| omitted | Always (used for `.kaido/config.json`) |
| `null` | The file does not exist yet |
| a hash | The file exists and its current hash matches |

Otherwise the write fails with `Conflict` and the file is left untouched. The check runs right before the atomic rename; a change landing between the check and the rename is not detected.

### Renaming and deleting

- `rename_file` and `delete_file` accept notes only, never `.kaido/config.json` (`InvalidPath`).
- A rename stays in the same folder (`InvalidPath` otherwise; the folder part is compared exactly). It never replaces a file: an existing `to`, including `to` equal to `from`, is a `Conflict`. A case-only rename (`a.md` to `A.md`) works, also on case-insensitive file systems. The note must be readable and at most 8 MiB (`TooLarge`). A missing `from` is `NotFound`.
- A delete needs the hash of the version the user has seen; a different hash is a `Conflict`, so a newer version is never deleted. A missing file is `NotFound`.

Calls to `open_workspace` run one at a time and the most recently issued one wins: an older call still waiting fails with `Superseded`, which the UI ignores. A failed open keeps the previous workspace.

### Errors

Errors cross the boundary as `{ kind, message }` and become a `StorageError` in TypeScript (`src/lib/storage/errors.ts`). Messages are in English and only mention workspace-relative paths, never absolute ones.

| Kind | When |
|---|---|
| `NoWorkspace` | A workspace command was called before a workspace was opened |
| `NotFound` | The file or folder does not exist |
| `NotADirectory` | The workspace path, or a parent of the target, is not a folder |
| `OutsideWorkspace` | The path resolves outside the workspace through a symlink |
| `InvalidPath` | The path is malformed, or is not a note or the workspace config file |
| `InvalidUtf8` | The file is not valid UTF-8 text |
| `TooLarge` | The file or contents exceed 8 MiB |
| `PermissionDenied` | The OS denied access, or the target file is read-only |
| `Superseded` | A newer `open_workspace` call overtook this one |
| `Conflict` | A conditional write found the file missing, present or changed (see [Conditional writes](#conditional-writes)) |
| `Io` | Any other failure |

### Change event

The watcher emits `workspace://changed` with this payload:

```ts
{
  paths: string[];       // changed, created or removed files, sorted and deduplicated
  entries: FileEntry[];  // fresh metadata for each path that still exists
  rescan: boolean;       // the listing may be stale in ways `paths` cannot describe
}
```

A path in `paths` without an entry in `entries` was removed. `paths` covers listable Markdown files and `.kaido/config.json`. The app's own writes are reported like any other change; the core (`applyChange`) skips entries whose size and modification time did not change, and an open note recognizes its own saves by their hash.

### File access rules

Enforced in `src-tauri/src/paths.rs` and `fs_ops.rs`, and mirrored by `MemoryStorage`:

- **Malformed paths are rejected** with `InvalidPath`: empty paths, absolute paths, empty, `.` or `..` segments, backslashes, NUL bytes, and `:` on Windows.
- **Allowlist.** `read_file` and `write_file` accept only listable notes (`*.md`, no segment starting with `.`, no `node_modules` segment) and exactly `.kaido/config.json`. Anything else (`.git/config`, hooks, other files) is `InvalidPath`.
- **Symlink targets are checked too.** A path is resolved on disk and its real location must be inside the workspace (`OutsideWorkspace` otherwise) and must itself pass the allowlist (`InvalidPath` otherwise). A note that links to `.git/config` is refused like the target would be. Links to missing locations are `InvalidPath`.
- **Size limit.** Files larger than 8 MiB are not read, and contents larger than 8 MiB are not written (`TooLarge`).
- **Atomic writes.** Contents go to a hidden temp file (`.kaido-<pid>-<n>.tmp`) in the same folder, are flushed to disk and then renamed over the target, so readers never see a partial file. Right before the rename the folder is checked again to still be inside the workspace. On failure the temp file is removed. Missing parent folders are created. The replaced file keeps its permissions; writing through a symlink updates the link's target.
- **Read-only files are never replaced.** Writing to an existing read-only file fails with `PermissionDenied`.
- **Temp file cleanup.** When a workspace is opened, temp files left by crashed writes are removed from the note folders and `.kaido/`. Only files of other processes that are at least 10 minutes old are removed, so a second running instance is not affected.

The device `settings.json` uses the same atomic write and 8 MiB read limit.

## File watcher

The watcher (`src-tauri/src/watcher.rs`, `watch_tree.rs`) uses `notify` and runs on its own thread.

- **Debounce.** Events are coalesced until the filesystem has been quiet for 200 ms, then emitted as one batch. A continuous stream of events delays a batch by at most 2 s.
- **Filtering.** Events in ignored locations (dot folders, `node_modules`, temp files) and on non-Markdown files are dropped. The only non-Markdown file reported is `.kaido/config.json`.
- **Selective watching on Linux.** inotify costs one kernel watch per folder, so on Linux each non-ignored folder is watched individually and non-recursively. `.git`, `node_modules` and other ignored folders are never watched; `.kaido/` is watched without its subfolders. New folders are watched as they appear and removed folders are released. Folder symlinks are not followed. On macOS and Windows a single recursive watch on the root is used instead, and the same filtering applies to events.
- **Rescans.** `rescan: true` is sent when the watcher cannot describe the change precisely: watcher errors or event overflow, folder creation, removal or rename, events on the root itself, or a folder that could not be watched. The frontend then lists the workspace again.
- **Startup.** `open_workspace` returns once the root is watched. Subfolders are registered in the background after the temp file cleanup; if any were registered, one `rescan` batch follows so changes made meanwhile are not missed.
- **Replacement.** Opening another workspace stops the previous watcher. Once `open_workspace` returns, the old watcher never emits again.

## Configuration

Settings are JSON with a `version` field for migrations. Parsing and validation happen in TypeScript (`src/lib/config/`); the backend only stores raw text.

| File | Scope | Location | Fields |
|---|---|---|---|
| `settings.json` | This device, never synced | The OS app config directory | `workspace`: absolute path of the last opened workspace |
| `.kaido/config.json` | The workspace, synced with it | Inside the workspace | `ignore`: list of [ignore patterns](#ignore-patterns) |

**Precedence.** Built-in defaults, then the workspace config, then device settings (`src/lib/config/resolve.ts`). Later layers win; missing values never override. Secrets are never stored in these files; they go to the OS keychain.

**Parsing never fails** (`src/lib/config/parse.ts`):

| Input | Result |
|---|---|
| File missing | Defaults, no warning |
| A field has the wrong type | That field falls back to its default; a warning is shown. The raw value is written back unchanged unless the app sets a new value. |
| Unknown fields | Kept and written back |
| Missing or invalid `version` | Current version assumed; a warning is shown |
| Not valid JSON, not a JSON object, or a newer `version` | Defaults; a warning is shown and **the file is never overwritten** |
| File unreadable (for example not UTF-8) | Defaults; a warning is shown and the file is never overwritten |

If `settings.json` cannot be overwritten, the app still works but cannot remember the workspace, and says so.

**Hot reload.** When the watcher reports `.kaido/config.json` (created, changed or deleted), the frontend reads it again, applies the new ignore patterns and rebuilds the model. A rescan re-reads it as well.

## Startup flow

`AppState` in `src/lib/ui/appState.svelte.ts` drives startup:

1. Read `settings.json`. Without a saved workspace, show the "open a folder" screen.
2. Open the workspace. Subscribe to change events **before** listing, so no change in between is missed.
3. Read `.kaido/config.json` and list files in parallel, build the model and render. The first render needs only the listing.
4. Save the opened workspace to `settings.json` in the background; a failure becomes a warning, never a blocking error.
5. After the first render, read titles and open task counts in the background (**summaries**):
   - task lists first (they drive the sidebar counts), then the selected project, then the rest;
   - up to 8 files at a time;
   - results published at most once per frame;
   - files larger than 1 MiB get the file name as title without being read;
   - unreadable files keep that fallback title until they change.
6. A note's full contents are read when it is selected.

Change events are queued until the initial load finishes, then applied one at a time:

- `rescan` events list the workspace again. If the listing fails, the model stays as it was, a notice is shown, and later events are handled as rescans until one succeeds.
- Other events update the listing from `entries` without a new listing, re-read summaries of changed files, and reload the open note if it was touched.
- If the open note is deleted it is shown as missing; a file over 8 MiB is shown as too large to open.

Opening another workspace drops background work of the previous one (queued summary reads, change events still waiting). Unsaved edits are handled as described in [Editing and autosave](#editing-and-autosave).

## Editing and autosave

The editor (`src/lib/ui/EditorPane.svelte`, `src/lib/ui/editor/`) is CodeMirror 6 with Markdown highlighting. One editor view is shared by all notes; each recently opened note keeps its own editor state (text, selection, undo history) in a small cache, so switching back restores it. Markdown markers stay visible but dimmed, headings are sized, prose uses Geist and code JetBrains Mono. Languages for fenced code blocks are loaded on demand.

Tables use the monospace font so aligned columns line up. Inside a table, `Tab` aligns the columns (keeping `:---`, `---:` and `:---:` alignment markers) and moves to the next cell, adding a row after the last one; `Shift+Tab` moves to the previous cell. As in GFM, every `|` splits cells, also inside code spans, unless it is escaped (`\|`). The parsing and formatting live in `src/lib/core/markdownTable.ts`. Outside tables, `Tab` moves focus out of the editor.

Saving is handled per note by `SaveSession` (`src/lib/core/saveMachine.ts`), a platform-independent state machine that gets storage access and timers passed in:

- An edit only records how to read the new text and restarts a 500 ms timer. Nothing is copied, compared or written while typing.
- Selecting another note, leaving the window and closing the app save immediately.
- At most one write per note is in flight. Edits made during a write are saved after it.
- Every write passes the hash of the last known disk version as `expectedHash` (or `null` if the file was deleted), so a newer version on disk is never overwritten.
- When the watcher reports the open note, the file is read again. The same hash as the last save is the app's own write and is ignored. Without unsaved edits, the new version replaces the editor text. With unsaved edits, both versions are kept.
- **Keeping both versions.** The disk version is written next to the note as `<name> (conflict YYYY-MM-DD HHmm).md` (with ` 2`, ` 3`… if taken; a name too long for the suffix is shortened so the copy fits in 255 bytes), then the editor text replaces the note. If the file changes again meanwhile, this is retried up to three times. Once a version is kept in a copy, later retries only write the editor text, so the same version is never copied twice. A notice names the copy.
- A note deleted outside the app is shown as missing, unless it has unsaved edits; then the next save creates it again.
- Other failures keep the text, show `save failed — retrying` in the header and retry with a growing delay, and on the next edit.

The header shows `saved · 2m ago`, `saving…`, `unsaved` or `save failed — retrying`. Notes with pending saves stay in memory until they are written, and an edit that arrives for a note just left is still saved to it.

Line endings are kept as they are: each note is edited with the line separator it uses (`\n`, `\r\n` or `\r`, taken from its first line break), new lines and pasted text use it too, and a note that is shown but not edited is never rewritten.

**Switching workspaces and closing.** Before another workspace opens, pending saves are written in the current one (waiting at most a few seconds). If some edits are still unsaved after that, because saving failed or took too long, the switch is refused: the current workspace and editor stay as they are and a notice names the notes. Closing the window works the same way, and also counts saves of a previous workspace that are still running. Trying the same action again right away goes ahead without the unsaved edits. That consent only covers the very next attempt: any edit, any successful save, or a check that finds nothing unsaved withdraws it.

**Note actions.** Right-clicking a note in the list, or pressing `Shift+F10` or the context menu key on the focused row, opens a menu with **Rename** (`F2`), **Copy path** (the workspace-relative path) and **Delete** (`Del`). `F2` and `Delete` also work directly on the focused row, never while typing in the editor.

- **Rename** edits the file name in the row, with the name before `.md` selected. `Enter` or leaving the field confirms (switching to another window does not), `Esc` cancels; an unchanged name just ends editing, even one the rules below would refuse. The name is used as typed, trimmed, with `.md` added when missing (`src/lib/core/noteNames.ts`). Names that break on Linux, macOS or Windows are refused with the reason shown next to the field: `/`, `\`, control characters, `<>:"|?*`, a leading dot, a trailing space or dot, Windows device names (`CON`, `NUL`, `COM1`…), names over 200 UTF-8 bytes (leaving room for conflict copies and the trash within the usual 255-byte limit), `tasks.md`, names already used in the folder (compared case-insensitively, except the note's own name; this includes an open note whose file was deleted elsewhere and the selected note shown as missing), and names hidden by the ignore patterns. Unsaved edits are saved first; an open note then keeps its text, undo history and save state under the new path, without being read again.
- **Delete** asks for no confirmation. Pending edits are saved first, then the file is moved to the system trash, the next row is selected and a toast offers **Undo** for a few seconds (`Ctrl+Z` / `Cmd+Z` while the toast or the list has focus; in the list it undoes the most recent delete). Holding `Delete` deletes one note. Undo writes the deleted contents back, including edits that could not be saved, with `expectedHash: null`, so a file that took the name meanwhile is kept and a notice says so.
- Notes over 8 MiB cannot be renamed or deleted from the app.
- Both run in the same queue as change events and update the model right away, so the watcher's later report of the change is a no-op. Failures show a notice and change nothing.

**New notes.** `Ctrl+N` (`Cmd+N` on macOS) or the `+ new note` button in the list pane creates an empty note in the selected project, or in `inbox/` when All tasks is selected (`src/lib/core/newNote.ts`). It is named `untitled.md`, then `untitled 2.md`, `untitled 3.md`…, skipping names already in the workspace (compared case-insensitively) or hidden by the ignore patterns. The file is written with `expectedHash: null`; if a file with that name appeared on disk meanwhile, the next name is tried, a few times at most. The note is added to the model, selected and opened with the editor focused right away, without waiting for the watcher; its autosave starts from the hash of that first write. A failure shows a notice and changes nothing else.

## Sync

Sync is not implemented yet. This is the planned design.

Kaido runs the `git` binary installed on the system, so it reuses the user's SSH keys and credential helpers and works with any remote.

- Changes are written to disk immediately and committed after a short idle delay, grouped into one commit.
- Pull uses `--rebase` to keep history linear; push runs in the background.
- Sync never blocks the UI. Without a network connection, changes stay committed locally.
- If the same lines change on two devices, both versions are kept as separate files and the user is notified. `tasks.md` uses git's `merge=union` driver so list edits merge cleanly.
- If the repository is in an unexpected state (rebase in progress, detached HEAD), sync pauses until it is resolved.

## Security

The webview runs with a strict Content Security Policy, defined in `src-tauri/tauri.conf.json` (`app.security.csp`, plus `devCsp` for development):

| Directive | Value | Notes |
|---|---|---|
| `default-src` | `'self'` | |
| `script-src` | `'self'` | Only scripts bundled with the app. No inline scripts, no `eval`. |
| `style-src` | `'self' 'unsafe-inline'` | See below. |
| `font-src` | `'self'` | Fonts are bundled. |
| `img-src` | `'self' data: blob:` | |
| `connect-src` | `'self' ipc: http://ipc.localhost` | IPC to the Rust backend. `devCsp` also allows the Vite dev server websocket. |
| `object-src`, `form-action`, `frame-ancestors` | `'none'` | |

**Inline styles.** Svelte and Vite in development, and the editor at runtime, inject `<style>` elements. By default Tauri adds hashes and nonces to the CSP, which would make browsers ignore `'unsafe-inline'`. Setting `dangerousDisableAssetCspModification: ["style-src"]` turns that off for `style-src` only, so inline styles work. This exception applies to styles only and must never be extended to `script-src`.

**Capabilities.** The main window has a single capability (`src-tauri/capabilities/default.json`) granting `core:default` and one `allow-<command>` permission per app command (generated from the list in `src-tauri/build.rs`). The folder picker runs on the Rust side, so the webview gets no dialog or filesystem plugin permissions. New permissions are added only when a feature needs them, scoped as narrowly as possible. See [File access rules](#file-access-rules) for what the file commands accept.

## Performance budget

Kaido should feel instant. These targets guide implementation choices:

| Interaction | Target |
|---|---|
| Launch to usable | < 500 ms |
| Keystroke latency | < 16 ms |
| Switching notes | < 50 ms |
| Search across 10k notes | < 50 ms |
| Saving, toggling a task | immediate, never a spinner |

In practice: optimistic UI, a persisted index loaded at startup, virtualized lists, and all git and filesystem work off the UI thread.
