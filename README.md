# Kaido

**Notes and to-dos for developers, stored in your own git repo.**

Kaido is a minimal, keyboard-first desktop app for keeping notes and task lists organized by project. Everything is plain Markdown in a git repository you own. There is no account, no server, and no lock-in: you can read and edit your notes with any editor, and Kaido syncs them in the background.

> [!NOTE]
> Kaido is in early development and not ready for daily use yet. Follow the [changelog](CHANGELOG.md) for progress.

## Features

Planned for the first release:

- **Projects** with Markdown notes and a task list each
- **Inbox** and a global quick-capture shortcut
- **All tasks** view across every project
- **Command palette** (`Ctrl+K`) to search notes and tasks and run actions
- **Background git sync** with conflict handling that never loses data
- **Fast and light**: built with [Tauri](https://tauri.app), instant search, no waiting on the network

On the roadmap: links between notes, per-note history, due dates and reminders, a pomodoro timer, a CLI, and web and mobile apps.

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

## Building from source

Requirements: [Node.js](https://nodejs.org) 22+, [pnpm](https://pnpm.io), [Rust](https://rustup.rs) (stable), `git`, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```sh
git clone https://github.com/kaidoapp/kaido.git
cd kaido
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
