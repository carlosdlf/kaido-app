# Contributing to Kaido

Thanks for your interest in Kaido! This guide explains how to set up the project and how changes get merged.

## Ground rules

- Be kind. Everyone taking part must follow the [code of conduct](CODE_OF_CONDUCT.md).
- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), never public issues.

## Development setup

1. Install [Node.js](https://nodejs.org) 22 or newer, [pnpm](https://pnpm.io), [Rust](https://rustup.rs) (stable, 1.85 or newer) and `git`.
2. Install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. On Linux this includes the WebKitGTK and other system development packages; for example, on Debian or Ubuntu:

   ```sh
   sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
     libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
   ```

3. Clone and run:

   ```sh
   git clone https://github.com/kaidoapp/kaido.git
   cd kaido
   pnpm install
   pnpm tauri dev
   ```

### Useful commands

| Command | What it does |
|---|---|
| `pnpm tauri dev` | Run the app in development mode |
| `pnpm dev` | Run only the frontend in a browser (no Tauri APIs) |
| `pnpm build` | Build the frontend into `dist/` |
| `pnpm tauri build` | Build the desktop app and installers |
| `pnpm check` | Type-check the frontend, the Vite config, and the core without DOM types |
| `pnpm lint` | Lint with ESLint and check formatting with Prettier |
| `pnpm format` | Format all files with Prettier |
| `pnpm test` | Run frontend unit tests (Vitest) |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run Rust tests |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | Lint Rust code |

## Project layout

```
src/            Svelte frontend (Vite single-page app)
  main.ts         Entry point: loads fonts and global styles, mounts App.svelte
  lib/core/       Platform-independent logic and its tests
  lib/storage/    Storage interface and implementations
  lib/ui/         Components, design tokens (tokens.css) and base styles
src-tauri/      Rust backend (filesystem, git, OS integration)
  capabilities/   Permissions granted to the webview
docs/           Architecture and contributor documentation
```

Code in `src/lib/core` must stay platform independent: no DOM APIs and no imports from Tauri or Svelte. `pnpm check` and `pnpm lint` enforce this. UI code reaches the platform through `src/lib/storage`.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). The changelog and version numbers are generated from them, so the format matters:

```
<type>(<optional scope>): <short summary>
```

Common types: `feat` (new feature), `fix` (bug fix), `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
Add `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer for breaking changes.

Examples:

```
feat(tasks): reorder tasks with alt+arrow keys
fix(sync): keep local changes when the remote is unreachable
docs: explain the notes folder layout
```

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep each PR focused on one change. Add or update tests when behavior changes.
3. Make sure `pnpm check`, `pnpm lint`, `pnpm test`, and the Rust tests and Clippy pass.
4. Use a Conventional Commit style PR title; PRs are squash-merged with that title.
5. Don't edit `CHANGELOG.md` by hand; it is updated automatically on release.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please). It keeps a release PR open with the next version and changelog; merging it tags the release and builds the installers.

## License

By contributing, you agree that your contributions will be dual licensed under the [MIT](LICENSE-MIT) and [Apache-2.0](LICENSE-APACHE) licenses, as described in the [README](README.md#license).
