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
   git clone https://github.com/carlosdlf/kaido-app.git
   cd kaido-app
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
| `pnpm test` | Run frontend tests (Vitest) with coverage; fails if coverage drops below the thresholds |
| `pnpm test:watch` | Run frontend tests in watch mode, without coverage |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run Rust tests |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Lint Rust code, tests included |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Check Rust formatting |

The Rust commands need a `dist/` folder to exist. Run `pnpm build` once, or create an empty one with `mkdir -p dist`.

## Project layout

```
src/            Svelte frontend (Vite single-page app)
  main.ts         Entry point: loads fonts and global styles, mounts App.svelte
  lib/core/       Platform-independent logic and its tests
  lib/config/     Settings schemas and parsing (platform independent)
  lib/storage/    Storage interface and implementations
  lib/ui/         Components, app state, design tokens (tokens.css) and base styles
src-tauri/      Rust backend (filesystem, git, OS integration)
  capabilities/   Permissions granted to the webview
docs/           Architecture and contributor documentation
```

Code in `src/lib/core` and `src/lib/config` must stay platform independent: no DOM APIs and no imports from Tauri or Svelte. `pnpm check` and `pnpm lint` enforce this. UI code reaches the platform through `src/lib/storage`.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Testing

- **Every bug fix needs a regression test** that fails without the fix.
- New behavior comes with tests. Logic belongs in `src/lib/core` or `src/lib/config`, where it is easy to test without a UI.
- Frontend tests run with Vitest. Component tests (`src/lib/ui`, `src/App.test.ts`) use [Testing Library](https://testing-library.com/docs/svelte-testing-library/intro/) in jsdom; everything else runs in plain Node, so it cannot rely on DOM globals. Use `MemoryStorage` instead of real files.
- Rust tests live next to the code (`#[cfg(test)]` modules) and use temporary folders.

### Coverage

CI fails if coverage drops below these thresholds:

| Area | Lines, statements, functions | Branches |
|---|---|---|
| `src/lib/core` | 95% | 90% |
| `src/lib/storage` | 95% | 90% |
| `src/lib/config` | 95% | 90% |
| `src/lib/ui` | 80% | 75% |
| Rust (`src-tauri/src`, except `lib.rs` and `main.rs`) | 90% of lines | – |

Frontend coverage is part of `pnpm test`; an HTML report is written to `coverage/`.

```sh
pnpm test
```

Rust coverage uses [cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov). Install it once:

```sh
rustup component add llvm-tools-preview
cargo install cargo-llvm-cov
```

Then run the same check as CI:

```sh
cargo llvm-cov --manifest-path src-tauri/Cargo.toml --summary-only \
  --ignore-filename-regex '/src/(lib|main)\.rs$' --fail-under-lines 90
```

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
2. Keep each PR focused on one change. Add or update tests when behavior changes; bug fixes include a regression test (see [Testing](#testing)).
3. Make sure `pnpm check`, `pnpm lint`, `pnpm test`, Rust formatting, Clippy and the Rust coverage check pass.
4. Use a Conventional Commit style PR title; PRs are squash-merged with that title.
5. Don't edit `CHANGELOG.md` by hand; it is updated automatically on release.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please). It keeps a release PR open with the next version and changelog; merging it tags the release and builds the installers.

## License

By contributing, you agree that your contributions will be dual licensed under the [MIT](LICENSE-MIT) and [Apache-2.0](LICENSE-APACHE) licenses, as described in the [README](README.md#license).
