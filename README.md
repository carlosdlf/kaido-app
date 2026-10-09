<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/kaido-mark-light.svg">
  <img src="docs/assets/kaido-mark-dark.svg" alt="Kaido logo" width="112">
</picture>

# Kaido

**Notes and to-dos for developers, stored in your own git repo.**

![Status: alpha](https://img.shields.io/badge/status-alpha-F2A93B?labelColor=24272C)
[![License: MIT or Apache 2.0](https://img.shields.io/badge/license-MIT%20or%20Apache%202.0-F2A93B?labelColor=24272C)](#license)
[![CI](https://img.shields.io/github/actions/workflow/status/carlosdlf/kaido-app/ci.yml?branch=main&label=ci&labelColor=24272C)](https://github.com/carlosdlf/kaido-app/actions/workflows/ci.yml)

<!--
Enable once coverage upload and the first release exist:
[![Coverage](https://img.shields.io/codecov/c/github/carlosdlf/kaido-app?labelColor=24272C)](https://codecov.io/gh/carlosdlf/kaido-app)
[![Release](https://img.shields.io/github/v/release/carlosdlf/kaido-app?include_prereleases&color=F2A93B&labelColor=24272C)](https://github.com/carlosdlf/kaido-app/releases)
-->

</div>

## What is Kaido?

Kaido is a small, fast desktop app for the notes and task lists you keep while you work: meeting notes, runbooks, ideas, and the to-dos for each project. Think of a notes app without the bloat, built for people who already live in a terminal and a git repo.

- **Your files, not a database.** Every note is a plain Markdown file and every project is a folder. Open them in any editor, grep them, diff them.
- **Your git repo is the sync.** Kaido will commit and sync in the background with the `git` you already use (in progress). No account, no server, no subscription, no lock-in.
- **Organized by project.** Each project has its notes and one task list. An inbox catches everything that doesn't have a home yet.
- **Keyboard first and instant.** Built with [Tauri](https://tauri.app) and Svelte. Opening the app, switching notes and searching should never make you wait.
- **Safe by design.** Autosave never overwrites a newer version: if a file changed elsewhere, both versions are kept. Deleted notes go to the system trash and can be undone.

> [!NOTE]
> Kaido is in early development and not ready for daily use yet. Follow the [changelog](CHANGELOG.md) for progress.

## Features

| | |
|---|---|
| ✅ Available | Open any folder as a workspace · projects and notes from your folder structure · Markdown editor with autosave · new notes (`Ctrl+N`) and projects (`Ctrl+Shift+N`) · rename and delete with undo · table editing · task lists with keyboard shortcuts, subtasks, detail and done tasks kept in place · notes linked from tasks · **All tasks** view across projects · picks up changes made by other editors |
| 🚧 Next | Background git sync |
| 🗺️ Planned | Command palette (`Ctrl+K`) and instant search · global quick-capture shortcut · links between notes and per-note history · due dates and reminders · a CLI · web and mobile apps |

## How it works

Your notes live in a regular git repository. Each project is a folder; each note is a Markdown file; each project's tasks live in a `tasks.md` checklist:

```
my-notes/
├── inbox/
│   └── tasks.md
├── api-payments/
│   ├── tasks.md
│   ├── architecture.md
│   └── deploy.md
└── personal/
    └── tasks.md
```

Kaido uses the `git` installed on your system, so it works with any remote (GitHub, GitLab, Gitea, your own server) and your existing SSH keys or credential helper.

### Your notes folder

You can open any existing folder. Kaido reads it like this:

- Each top-level folder is a project. Its `tasks.md` is the project's task list.
- Every other `.md` file is a note, including files in subfolders (`api-payments/auth/login.md`).
- `.md` files at the top of the folder show up in the inbox.
- Folders inside `_archive/` are archived projects.
- Everything else is left alone: non-Markdown files, hidden files and folders (`.git`, anything starting with `.`), and `node_modules`.
- To hide more paths, list them under `ignore` in `.kaido/config.json`:

  ```json
  { "version": 1, "ignore": ["drafts/", "*.draft.md"] }
  ```

Kaido picks up changes you make with other editors while it is running.

## Building from source

Requirements: [Node.js](https://nodejs.org) 22+, [pnpm](https://pnpm.io), [Rust](https://rustup.rs) (stable), `git`, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```sh
git clone https://github.com/carlosdlf/kaido-app.git
cd kaido-app
pnpm install
pnpm tauri dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [docs/](docs/) for architecture notes.

## Contributing

Contributions are welcome. Please read the [contributing guide](CONTRIBUTING.md) and our [code of conduct](CODE_OF_CONDUCT.md) first. To report a security issue, see [SECURITY.md](SECURITY.md).

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.

---

Named after Kaido, a very good dog.
