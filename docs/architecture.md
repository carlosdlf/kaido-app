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
| `src/lib/storage/` | The `Storage` interface and its implementations | `core`, `@tauri-apps/*` |
| `src/lib/ui/` | Svelte components, `tokens.css` (design tokens), `base.css` | `core`, `storage`, `svelte` |

The `$lib` alias points to `src/lib`. Fonts (JetBrains Mono, Geist) are bundled with the app, so nothing is loaded from the network.

### Enforced boundaries

These rules are checked by `pnpm check` and `pnpm lint`, so a violation fails the build checks:

- **No platform types in the core.** `tsconfig.core.json` type-checks `src/lib/core` with only the `ES2022` library and no ambient types. Using `document`, `window` or other DOM APIs there is a type error.
- **No Tauri, Svelte, UI or storage in the core.** ESLint rejects imports of `@tauri-apps/*`, `svelte`, `*.svelte`, `$lib/ui` and `$lib/storage` from `src/lib/core`.
- **Platform access only through storage.** ESLint rejects `@tauri-apps/*` imports anywhere in `src/` except `src/lib/storage`.

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

## Storage model

A Kaido workspace is a git repository of Markdown files:

```
workspace/
├── inbox/              default project for quick capture
│   └── tasks.md
├── <project>/          one folder per project
│   ├── tasks.md        the project's task list (reserved name)
│   └── <note>.md       notes
├── _archive/           archived projects
├── .kaido/config.json  workspace settings (synced)
└── .gitattributes
```

- A **project** is a top-level folder. Archiving moves it into `_archive/`.
- A **note** is a Markdown file. Its title is the first `#` heading, or the file name.
- A **task** is a Markdown checkbox (`- [ ]` / `- [x]`). Each project has a `tasks.md`; checkboxes inside notes also show up in task views.

The files are the source of truth. The search index and caches live in the app's data directory, never in the workspace.

## Sync

Kaido runs the `git` binary installed on the system, so it reuses the user's SSH keys and credential helpers and works with any remote.

- Changes are written to disk immediately and committed after a short idle delay, grouped into one commit.
- Pull uses `--rebase` to keep history linear; push runs in the background.
- Sync never blocks the UI. Without a network connection, changes stay committed locally.
- If the same lines change on two devices, both versions are kept as separate files and the user is notified. `tasks.md` uses git's `merge=union` driver so list edits merge cleanly.
- If the repository is in an unexpected state (rebase in progress, detached HEAD), sync pauses until it is resolved.

## Configuration

Settings are JSON, validated with a schema, and carry a `version` field for migrations.

| File | Scope | Location |
|---|---|---|
| `settings.json` | this device: workspace path, theme, shortcuts, sync interval | the OS app config directory |
| `.kaido/config.json` | the workspace: project order, ignored paths | inside the workspace (synced) |

Device settings override workspace settings, which override built-in defaults. Secrets are never stored in these files; they go to the OS keychain.

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

**Capabilities.** The main window has a single capability (`src-tauri/capabilities/default.json`) granting `core:default`. New permissions are added only when a feature needs them, scoped as narrowly as possible.

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
