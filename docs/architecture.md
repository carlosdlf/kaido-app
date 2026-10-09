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
| Icons | [Lucide](https://lucide.dev) line icons (`@lucide/svelte`, ISC), imported one by one so only the icons used are bundled |
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
- A **task** is a Markdown checkbox (`- [ ]` / `- [x]`) in a task list. See [Tasks](#tasks) for how task lists are read and edited.

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
| `git_status` | – | `GitStatus`, see [Git sync](#git-sync) |
| `git_commit` | `message` | `{ commit, paths }` |
| `git_sync` | – | `SyncResult` |

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
| `GitUnavailable` | Git is not installed (`git-missing`) or the workspace is not in a repository (`not-a-repo`); the message is the reason |
| `GitPaused` | The repository is in a state where the git command must not run; the message starts with the [paused reason](#status) or `pull-conflict` |
| `GitNetwork` | The remote could not be reached, or a reading or network git command timed out |
| `GitAuth` | The remote refused the credentials |
| `GitFailed` | Any other git failure, with git's sanitized output (including a writing command stopped after its time limit) |

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
5. After the first render, read titles and open task counts in the background (**summaries**); task lists read this way also fill the [task index](#all-tasks):
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

## Tasks

Each project's tasks live in `<project>/tasks.md`; the inbox's in `inbox/tasks.md`. The file stays plain GitHub-flavored Markdown. The model and every edit live in `src/lib/core/taskDocument.ts`.

**Reading a task list.**

- A **task block** is a task line at the start of a line (`- [ ] text`, `- [x] text`; bullets `-`, `*` or `+`; state ` `, `x` or `X`) plus every following line that starts with a space or a tab: subtasks and continuation lines. Blank lines followed by more indented lines stay in the block (a loose list item, as in CommonMark); the block ends before the next non-blank line that does not start with a space or a tab, and blank lines at its end are not part of it.
- Indented task lines inside a block are **subtasks**. They are shown one level in, whatever their depth, and can be toggled, edited and deleted (with the lines indented deeper below them). Subtasks are not created or reordered from the task view.
- Headings are shown as section labels, in file order: ATX headings (`#` to `######`) and setext headings (a paragraph underlined with `===` or `---`). As in CommonMark, `---` after a blank line, a task, a list item or a line that lazily continues a task is a thematic break, not a heading. Headings without open tasks are left out.
- Front matter at the top of the file and fenced code blocks are skipped, so their checkboxes are not tasks. A fence opened inside a task block ends with the block.
- Everything else (paragraphs, blank lines, other lists) is not shown and is never changed.
- Task text is shown as plain text; inline Markdown is not rendered.

**Editing.** Edits are line-level and as small as possible, so they merge well with git's `merge=union` driver:

| Edit | Changes |
|---|---|
| Toggle | Only the state character between the brackets |
| Add | One new line `- [ ] text` after the block of the focused task (or at the end of the file for an empty list), using the file's line separator. A file whose last line has no line break keeps it that way. A file that ends inside a fenced code block that is never closed gets the task just before that fence, so the task is not swallowed by the code block and the file's own lines stay untouched. Line breaks in the text become spaces |
| Edit | Only the text after the checkbox; indentation, bullet, state, the spacing after the checkbox and trailing whitespace stay |
| Delete | The block's lines (a subtask: its line and the lines indented deeper below it) |
| Move | Swaps the block with the previous or next open task of the same section (between the same headings). Done tasks and other lines between them stay where they are |

Every other line keeps its bytes and its own line break. Done tasks are never moved in the file: "done at the bottom" is only how the view shows them.

**Finding the task again.** The views address a task by its line number together with the exact text of that line (`TaskRef`). The list can change between showing a task and acting on it: an edit from disk or from the text editor. If the line still has that text, the edit applies there; otherwise it applies to the one task line that has exactly that text. When there is no such line, or more than one, nothing changes and a toast says "The task changed on disk". An open edit or new task field closes (with the same toast) as soon as the line it belongs to changes.

**Saving.** A task list uses the same `SaveSession` as a note: edits change the list's text and the view right away, and the session saves 500 ms later, immediately on switching items, leaving the window or closing the app. Changes on disk reload the view when there are no unsaved edits; with unsaved edits both versions are kept, exactly as for notes. The other version is written as `tasks (conflict YYYY-MM-DD HHmm).md` next to the list; since only `tasks.md` is a task list, that copy shows up as a note of the project and its tasks are not counted or shown in the task views. The list pane marks conflict copies (names ending in ` (conflict YYYY-MM-DD HHmm).md`, optionally numbered) with a warning icon. The **View as** switch at the right end of the header (`list` / `text`, a radio group: arrow keys or a click change it, and focus stays on it) shows the same file, with the same session, in the text editor or as the task view; it sits at the same place in both headers. `Ctrl+Shift+M` (`Cmd+Shift+M`) toggles it while a project's task list is selected, also from inside the text editor but not while typing in another field; it moves focus into the editor, or to the task list. A task edit that reaches the list while it is shown as text (an undo from a toast) is handed to the editor like a change from disk, so the next keystroke keeps it.

**Task view.** Selecting a project's task list shows its tasks in file order under their headings. Done tasks stay where they are, struck through and dimmed; **hide done** in the header hides them (and done subtasks), remembered per list while the app runs. Toggling never moves a task, so focus stays on it.

Each row shows a chevron when the task has detail, the subtask counter (`done/total`) when it has subtasks, and a `↗ <note>` chip when it links to a note (see [Linked notes](#linked-notes)). Icons are [Lucide](https://lucide.dev) line icons drawn with the text color: muted, the accent color on the selected row, and hidden from assistive technology.

| Key | On a focused task |
|---|---|
| `Space` | Toggle (also a click on the checkbox) |
| `Enter` | New task below; in the field, `Enter` adds it and opens another, `Tab` makes it a subtask of the task above and `Shift+Tab` a task again (one level), `Esc` closes the field without adding (in an empty list's field it clears the text), leaving the field adds what was typed |
| `F2`, double-click | Edit the text, links included; `Enter` or leaving the field saves, `Esc` cancels. Empty text changes nothing |
| `→`, chevron | Show the task's detail in a text area below it. In the text area, `Ctrl+Enter` (`Cmd+Enter`), `Esc`, `←` at the very start (nothing selected), the chevron or leaving it saves and hides it; `Esc` saves too |
| `Ctrl+Enter` (`Cmd+Enter`), chip | Open the linked note, with focus in the editor |
| `Shift+F10`, context menu key, right-click | Task menu: **Edit**, **Create note from task** or **Open note**, **Copy text** (the task text as written), **Delete** |
| `Delete` | Delete, with an undo toast (`Ctrl+Z` / `Cmd+Z` in the list or the toast) |
| `Alt+↑` / `Alt+↓` | Move among the open tasks of the section |
| `↑` / `↓`, `Home` / `End` | Move focus |

The list has a single tab stop. Each task is a real checkbox labelled by its text and described by its linked note and subtask progress. When the focused task leaves the view (hidden as done, or deleted), focus goes to the task now in its place. An empty list shows an "Add a task…" field; `+ new task` opens the field after the last open task. Undo puts the deleted lines back and focuses the task. If the list has not changed since the delete, they go back exactly where they were. Otherwise they go after the line that preceded them, else before the line that followed them (each only if exactly one line has that text), else at their old line number, moved to the end of any block it falls in, so a restored task never ends up inside another task's block.

**Detail.** A task's detail is the indented lines of its block that are not subtasks (or under a subtask), shown without their common indentation. `→` opens it for any top-level task, also one without detail yet. Closing it without changes writes nothing. Saving rewrites only that block: the task line, then the detail lines, then the subtasks with their own lines, in their order. Lines the user did not change keep their exact bytes (trailing spaces of a hard break, tabs); new or changed lines get the detail's indentation, the prefix of its least indented line (else the subtasks' indentation, else two spaces). Blank lines at either end are dropped and whitespace-only lines become empty; blank lines inside the detail are kept, which keeps them in the block. A fenced code block left open in the detail is closed with a matching fence line at its end, so the subtasks after it stay tasks. Other blocks are never touched.

**Subtasks from the UI.** A new subtask (`Tab` in the new task field) is added as the last subtask of the block, indented like its existing subtasks (else its detail, else two spaces). If the block ends inside a code block that is never closed, the subtask goes just before that code block instead, so it is not swallowed by it.

### Linked notes

A task links to a note with a plain Markdown link in its text, `[label](path.md)`, with the path relative to the task list, so the link also works on GitHub and in other editors (`src/lib/core/taskLinks.ts`). Links the app writes percent-encode spaces and the characters that would end or change a CommonMark link destination: `#`, `%`, `(`, `)`, `<`, `>`, `[`, `]` (`C%23%20notes.md`); other characters, including non-ASCII ones, stay as they are. Only relative links to `.md` files inside the workspace count; URLs, absolute paths, anchors, links inside inline code and links to task lists (`<project>/tasks.md`) are left alone. The task's **linked note** is the first link to an existing note; if none of its links exists, the first one is shown as missing. The row shows the link as a chip with the note's name instead of the Markdown.

- **Open note** (`Ctrl+Enter`, the chip or the menu) selects the note in its project and focuses the editor. For a missing note a toast offers **Create**, which writes `# <task text>` to that path with `expectedHash: null` and opens it; a file that appeared meanwhile is never replaced. A hand-written link whose file name breaks the [note name rules](#editing-and-autosave) (or starts or ends with a space) is not created; the toast gives the reason.
- **Create note from task** (menu, for tasks without a link) names the note after the task text without links: characters not allowed in file names (`/ \ < > : " | ? *`, control characters) become spaces, spaces are collapsed, a trailing `.md` is dropped, leading dots and trailing dots and spaces are dropped, and the name is cut to fit 200 bytes with `.md` on a character boundary. A name that is still not valid (empty, `tasks`, a Windows device name) becomes `untitled`. The note goes into the task list's folder as `<name>.md`, `<name> 2.md`… like new notes (a long name is shortened so the number still fits in 200 bytes), created with `# <task text>` and `expectedHash: null`. Then ` [note](<name>.md)` is appended to the task (one line edit, finding the task by its text) and the note opens with editor focus. If the task changed meanwhile so that it cannot be found, the note is still opened and a toast says it was created but not linked. Asking again for the same task while its note is being created does nothing.

### All tasks

`~/all-tasks` in the sidebar shows the combined view: the tasks of every task list (done ones in place, struck through, unless **hide done** is on for All tasks), the inbox first, then projects in sidebar order, each under a header with its open count. Archived projects are left out. The list pane also lists each task list, to open it on its own. The same keys work as in the task view; `Enter` adds to the focused task's list, and `Alt+↑/↓` moves within it.

The view reads the **task index** (`src/lib/core/taskIndex.ts`): the parsed text of every task list, with the hash of the disk version it matches. It is filled by the background summary reads (lists over 1 MiB are skipped; a list that grows over that size is dropped, and All tasks names the lists it cannot show), updated from change events, and from the app's own edits and saves; each change parses only the list it touches. A list with an open session is kept current by the session, so a background read never replaces edits that are not saved yet. Edits from All tasks create a session on demand from the index entry (no read needed); it is saved like any other and dropped once everything is on disk. If the file changed on disk before the index caught up, the save conflicts; the session then reads the newer version and applies the same edits to it once, finding each task again by its text. Only if that fails are both versions kept, as above. The sidebar counts come from the same parsed lists: open top-level tasks, subtasks not counted.

### New projects

`+ new project` in the sidebar (or `Ctrl+Shift+N`, `Cmd+Shift+N` on macOS) opens a name field. `Enter` creates the project, `Esc` or leaving the field cancels. The name is used as typed (trimmed) for the folder (`src/lib/core/projectNames.ts`): the [note name rules](#editing-and-autosave) apply without adding `.md`, plus names starting with `_` (including `_archive`), `inbox`, `node_modules`, existing project names (ignoring case), names hidden by the ignore patterns, and names over 100 UTF-8 bytes are refused with the reason shown. The project is created by writing an empty `<name>/tasks.md` with `expectedHash: null`, so an existing list is never replaced. The new project is selected with its task list open and the "Add a task…" field focused.

## Git sync

The workspace is stored in a git repository the user owns. The Rust side (`src-tauri/src/git.rs`, `sync.rs`) runs the `git` installed on the system; the frontend decides when to commit and sync.

### Running git

- `git` is looked up in `PATH` and started with explicit arguments, never through a shell, as `git -C <workspace root> …`. It always runs on a background thread.
- Environment: `GIT_TERMINAL_PROMPT=0` (never prompt), `LC_ALL=C` (parseable output), `GIT_EDITOR=true` (never open an editor), and `GIT_OPTIONAL_LOCKS=0` for read-only commands. Inherited variables that would point git at another repository or inject configuration are removed: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_PREFIX`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*`. For `fetch` and `push`, if neither `GIT_SSH_COMMAND`, `GIT_SSH` nor `core.sshCommand` is set, `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` is used so SSH fails instead of asking for a password (a key with a passphrase must be loaded in the SSH agent).
- Everything else is the user's own setup: identity, hooks, commit signing, credential helpers and configuration.
- Time limits depend on what a command does:

| Commands | Limit | On timeout |
|---|---|---|
| Reading (`status`, `rev-parse`, `config`, `diff`, `log`, `cat-file`) | 10 s | Killed with the processes it started (its process group on Unix); `GitNetwork` |
| Network (`fetch`, `push`) | 120 s | Killed the same way; `GitNetwork`. Also killed when the app exits |
| Writing (`add`, `commit`, `checkout --merge`, `update-ref`, `rebase` and its `--continue`, `--skip`, `--abort`) | 10 min | Never sent `SIGKILL`. On Unix it is asked to stop with `SIGTERM` (git removes its lock files and exits cleanly) and waited for until it exits; elsewhere it is waited for without a limit. `GitFailed` |

- Messages built from git's output are sanitized: `hint:` lines are dropped, credentials in URLs (`user:token@`) and the query parameters `access_token`, `token`, `password` and `private_token` are removed, paths inside the workspace become workspace-relative, other absolute paths become `<path>`, and the text is cut to 500 characters.

### Workspace inside a repository

The workspace may be the root of a repository or a folder inside one (for example notes kept in a code repository). `add`, `commit` and `diff` use the pathspec of the workspace folder, so nothing outside it is staged or committed, even files the user staged. The app's temp files (`.kaido-*.tmp`) and trash folders (`.Trash-*`) are always excluded.

### Status

`git_status` only reads: it takes no lock and never changes the repository. It returns one of:

```ts
type GitStatus =
  | { state: "unavailable"; reason: "git-missing" | "not-a-repo" }
  | {
      state: "ready" | "paused";
      pausedReason?:
        | "operation-in-progress" | "index-locked" | "unmerged-files" | "detached-head" | "no-identity"
        | "upstream-mismatch" | "upstream-gone" | "local-merges" | "outside-commits" | "outside-changes";
      pausedMessage?: string;    // extra explanation, e.g. for a rebase Kaido started
      operation?: "rebase" | "merge" | "cherry-pick" | "revert" | "bisect";
      branch: string | null;     // null when HEAD is detached
      upstream: string | null;   // e.g. "origin/main"; null: commit only, no pull or push
      remote: boolean;           // any remote configured
      ahead: number;             // vs the upstream as last fetched
      behind: number;
      changed: string[];         // workspace-relative paths with uncommitted changes, untracked included
      gitVersion: string;
    };
```

Paused reasons, in order of priority (only the first one found is reported):

| Reason | When | Commits |
|---|---|---|
| `operation-in-progress` | A rebase, merge, cherry-pick, revert or bisect is in progress (`operation` says which). For a rebase Kaido started, `pausedMessage` says so (see [Rebases started by the app](#rebases-started-by-the-app)) | Refused |
| `index-locked` | `<git dir>/index.lock` is at least 5 s old and still there when checked again 1.5 s later: a git command is stuck, or one crashed and left it. A younger lock belongs to a command that is still running and is not reported | Refused |
| `unmerged-files` | The index has unmerged files | Refused |
| `detached-head` | HEAD is not on a branch | Refused |
| `no-identity` | `user.name` or `user.email` is not set (in the git configuration or the environment) | Refused |
| `upstream-mismatch` | The upstream is not the branch of the same name on a remote (a local upstream `.`, another branch name), the branch pushes to another remote (`branch.<name>.pushRemote` or `remote.pushDefault`), or the remote or branch name starts with `-` | Allowed |
| `upstream-gone` | The upstream is configured but its remote-tracking branch does not exist: it was never pushed, or a sync found it deleted on the remote (for example after a merged pull request) and removed the stale tracking branch, like `git fetch --prune` (which also deletes that tracking branch's reflog). Both cases look the same, so the user pushes the branch once with git, or picks another upstream | Allowed |
| `local-merges` | Local commits not on the upstream include merge commits; a rebase would flatten them and could drop or rewrite their changes | Allowed |
| `outside-commits` | Local commits not on the upstream change files outside the workspace folder; they would be pushed with the notes | Allowed |
| `outside-changes` | Files outside the workspace folder have uncommitted changes, tracked or untracked | Allowed |

The app never repairs these states.

### Commit

`git_commit { message }` stages everything in the workspace (`git add -A -- <workspace>`) and commits only those paths (`git commit -m <message> -- <workspace>`). It returns `{ commit: string | null, paths: string[] }`: the new commit's hash and its workspace-relative paths, or `null` and `[]` when there was nothing to commit. Hooks run normally; a failing hook is a `GitFailed` error with its output. Refused (`GitPaused`) for the reasons marked "Refused" above. File writes are not held back while it runs; a write that lands meanwhile is picked up by the next commit.

### Sync

`git_sync` needs an upstream branch (`GitFailed` otherwise) and runs:

1. Paused states are checked. `upstream-gone`, `local-merges` and `outside-commits` may change with a fetch, so for those the sync still fetches and checks again afterwards (the frontend only calls it for them on "Sync now"); every other paused state is refused right away with `GitPaused`.
2. `git fetch -- <remote> refs/heads/<branch>`. If the branch does not exist on the remote, the stale remote-tracking branch is removed and the error is `GitPaused("upstream-gone")`. Then every paused state is checked again and refused with `GitPaused`.
3. If behind: the working tree lock is taken (file writes wait from here until the rebase is over) and the status read again. If the workspace has uncommitted changes, nothing is pulled or pushed and the result has `deferred: true` (the rebase would refuse; the frontend commits and syncs again). Otherwise `git rebase @{upstream}` runs, with `rebase.autoStash`, `rebase.updateRefs` and `rebase.autoSquash` turned off, so history stays linear and no other branch moves. Local commits are always replayed (no fork-point guessing), so a commit is never dropped even if the upstream was force-pushed; a commit the upstream rewrote shows up as a conflict and both versions are kept.
4. If ahead: `git push -- <remote> HEAD:refs/heads/<branch>`, never forced, never other branches. If the push is rejected because the remote moved meanwhile, the sync starts over from step 1 once, then fails with `GitFailed`.

It returns:

```ts
type SyncResult = {
  pulled: number;                              // commits integrated from the upstream
  pushed: number;                              // commits pushed
  changed: string[];                           // workspace-relative paths changed by the pull
  conflicts: { path: string; copy: string }[];
  deferred: boolean;                           // skipped because of uncommitted workspace changes
};
```

**Conflicts.** During the rebase every unmerged path is checked first. Only notes (listable `*.md` files inside the workspace, stored as regular files; `.kaido/config.json` excluded) are resolved. Any other conflict ends the rebase (see below) and fails with `GitPaused` whose message is `pull-conflict: <paths>` (paths outside the workspace are relative to the repository root): pulling would conflict on files Kaido does not merge. `pull-conflict` is never a status; after it the repository is as before the sync. For notes, content is never lost:

| Conflict | Resolution |
|---|---|
| Both sides changed or added the note | The upstream version stays at its path; this device's version is written to a conflict copy |
| One side deleted or renamed it, the other changed it | The changed version is kept |
| Both sides renamed it differently | Both names are kept |

Versions are written as a checkout would write them (`git cat-file --filters`), so line-ending settings and other checkout filters apply. The conflict copy is `<folder>/<stem> (conflict YYYY-MM-DD HHmm).md` in local time, the same name the editor uses for its own conflicts, with ` 2`, ` 3`… appended if taken and the stem shortened to fit 255 bytes. Existing files are never replaced. A step is resolved all or nothing: if any conflicted file of the step changed after git wrote it (its content differs, or it was modified after the git command returned), nothing is written and the rebase is left for the user. Before `git rebase --continue`, everything staged must be either a file the app wrote (unchanged since) or what git staged for the commit being replayed (`REBASE_HEAD`); otherwise the rebase stops the same way, so nothing staged by someone else is committed. After the rebase, paused states are checked again before pushing. A commit that becomes empty is dropped.

`tasks.md` merges line by line when `.gitattributes` sets `tasks.md merge=union`; without it, conflicting task lists follow the same keep-both rule.

### Rebases started by the app

Before the rebase starts, the app writes `<git dir>/kaido-rebase` with the commit HEAD was on (`orig-head`) and the upstream commit (`onto`), and removes it when its rebase finishes or is undone. The marker is informational only: while a rebase in progress matches it, the status reports `operation-in-progress` with a `pausedMessage` saying Kaido started the rebase and how to finish it (`git rebase --continue` after resolving the conflicts) or undo it (`git rebase --abort`). The same text follows `operation-in-progress: ` in `GitPaused` errors. A marker left with no rebase in progress is removed by the next `git_commit` or `git_sync`.

A rebase is undone (`git rebase --abort`) only by the sync that started it, right after one of its own steps failed (a git error, a `pull-conflict`, a writing command stopped after its time limit), and only if that cannot lose anything someone else did:

- every file the app wrote, or that git wrote for a conflict, still has the contents recorded at that moment (a conflict file modified after the git command returned is someone else's);
- there is no other unmerged file, unstaged change or new untracked file (the app's temp files aside);
- every other staged change is exactly what the commit being replayed (`REBASE_HEAD`) has at that path.

If a step fails half-way (before its resolutions are staged), the conflict copies it wrote are kept (an extra file loses nothing) and the conflict markers are put back in the notes it had overwritten (`git checkout --merge`), so the working tree shows both versions again and `git rebase --continue` refuses until the user resolves them. The same check runs before `git rebase --skip`. If it fails, for example because a file was edited in another program during the rebase, the rebase and its marker are left in place and the error is `GitPaused` with the `operation-in-progress` message above.

The app never undoes a rebase later: a rebase interrupted by an app exit or a crash, or one that could not be undone safely, stays until the user finishes or aborts it with git. Sync stays paused meanwhile; commits are refused.

### Error classification

For `fetch` and `push`, git's error output is matched case-insensitively (`AUTH_PATTERNS` and `NETWORK_PATTERNS` in `git.rs`), authentication first:

| Kind | Output contains |
|---|---|
| `GitAuth` | `permission denied`, `authentication failed`, `could not read username`, `could not read password`, `terminal prompts disabled`, `invalid username or password`, `invalid credentials`, `bad credentials`, `access denied`, `host key verification failed`, `returned error: 401`, `returned error: 403`, `repository not found` |
| `GitNetwork` | `could not resolve host`, `name or service not known`, `temporary failure in name resolution`, `nodename nor servname`, `no address associated`, `network is unreachable`, `no route to host`, `connection refused`, `connection timed out`, `operation timed out`, `timed out`, `connection reset`, `connection closed`, `failed to connect`, `couldn't connect`, `could not connect`, `unable to access`, `remote end hung up`, `early eof`, `does not appear to be a git repository` (for example a remote on an unmounted drive), `could not read from remote repository` |
| `GitFailed` | Anything else, and every failure of a local command |

Messages read `git <command> failed: <sanitized output>`.

### Stopping on exit

When the app exits (`RunEvent::ExitRequested` / `Exit`), `SyncControl::shutdown` in `sync.rs`:

1. refuses new commits and syncs (`GitFailed`, "stopped because the app is closing");
2. kills `fetch` or `push` in flight; writing commands are never killed;
3. lets a running sync stop at its next safe point (before fetching, before pushing, between conflict resolutions);
4. waits up to 3 seconds for running operations, then lets the app exit.

Nothing is aborted on exit or afterwards. A rebase still in progress, including one whose writing command is still running (git runs in its own process group and finishes on its own), keeps its marker and is reported as described in [Rebases started by the app](#rebases-started-by-the-app).

### Workspace operation locks

Each repository has two async locks (`src-tauri/src/state.rs`):

| Lock | Taken by | Purpose |
|---|---|---|
| git (mutex) | `git_commit`, `git_sync` | One git operation at a time |
| working tree (read/write) | `write_file`, `rename_file`, `delete_file` (shared); `git_sync` (exclusive) only while it rebases and resolves conflicts | File writes never land in the middle of a rebase |

File writes never wait for `git add`, `git commit`, fetch or push; only for a rebase. `git_status`, `read_file` and `list_files` take no lock.

- The locks are keyed by the repository's git common folder (`git rev-parse --git-common-dir`, canonicalized, shared by all worktrees), or by the workspace folder outside a repository. Reopening the same folder, or another folder of the same repository, gives the same locks, so two operations on one repository never overlap.
- They are only taken after the workspace state's own locks are released, always git before working tree, never twice by one command, and neither the watcher nor `open_workspace` take them, so they cannot deadlock.
- A git command still waiting for its lock when another workspace is opened fails with `Superseded` instead of running. A file command waiting the same way still completes on the folder it was issued for, so no text is lost.

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
