# Configuration

Kaido keeps its settings in two JSON files. Most of them can be changed in the app (**Settings**, `Ctrl+,` or `Cmd+,` on macOS); you can also edit the files by hand.

| File | What it holds | Shared |
|---|---|---|
| `settings.json` | Settings of this device | No, it stays on this computer |
| `.kaido/config.json` | Settings of a workspace | Yes, it is committed and synced with your notes |

Both files have a `version` field (`1`). Their formats are described by JSON Schemas in [`schemas/`](../schemas), which editors such as VS Code can use for completion and checks:

```json
{
  "$schema": "https://raw.githubusercontent.com/carlosdlf/kaido-app/main/schemas/settings.schema.json"
}
```

Kaido does not add `$schema` itself, but keeps it (and any other field it does not know) when it saves the file.

## Device settings: `settings.json`

Location:

| OS | Path |
|---|---|
| Linux | `~/.config/dev.kaidoapp.kaido/settings.json` |
| macOS | `~/Library/Application Support/dev.kaidoapp.kaido/settings.json` |
| Windows | `%APPDATA%\dev.kaidoapp.kaido\settings.json` |

| Field | Default | Description |
|---|---|---|
| `workspace` | – | Absolute path of the last opened workspace, reopened when Kaido starts |
| `recentWorkspaces` | `[]` | Up to 5 recently opened workspaces, most recent first, shown on the start screen |
| `editorFontSize` | `15` | Text size of notes and task lists in pixels, a whole number from 12 to 20 |
| `autoSync` | `true` | Commit and sync with git in the background. When `false`, nothing is committed until you use **Sync now** (`Ctrl+Shift+S`) |
| `captureShortcut` | `"CommandOrControl+Alt+Space"` | Global shortcut for quick capture. `CommandOrControl` is `Cmd` on macOS and `Ctrl` elsewhere. It needs at least one of `CommandOrControl`, `Control`, `Alt` or `Super`, plus a key. `null` turns it off |
| `hideDone` | `{}` | For each workspace, the task lists whose done tasks are hidden (`"~/all-tasks"` is the All tasks view). The 20 most recently changed workspaces are kept |
| `dismissedSetup` | `[]` | Workspaces where you chose **Not now** on the setup suggestion |

Example:

```json
{
  "version": 1,
  "workspace": "/home/me/notes",
  "editorFontSize": 16,
  "autoSync": false,
  "captureShortcut": "CommandOrControl+Shift+Space"
}
```

Changes you save in another editor are applied while Kaido runs, except `workspace`, which only takes effect on the next start.

## Workspace settings: `.kaido/config.json`

| Field | Default | Description |
|---|---|---|
| `ignore` | `[]` | Extra paths to hide from Kaido, in a small gitignore-like syntax: `drafts` (a name anywhere), `/scratch` (from the workspace root), `tmp/` (folders only), `*`, `?` and `**` |

```json
{ "version": 1, "ignore": ["drafts/", "*.draft.md"] }
```

## Invalid values

Kaido never refuses to start because of a setting:

- A field with a wrong value uses its default, and Kaido says so once. Your value is kept in the file until you change that setting in the app.
- A file that is not valid JSON, or that was written by a newer version of Kaido, is ignored and never overwritten. Fix or remove it to let Kaido save settings again.
- If you edit `settings.json` while Kaido runs, a wrong value keeps the setting as it was instead of resetting it, and a file that is not valid JSON changes nothing. Auto-sync is only turned back on by `"autoSync": true`.
- Lists longer than their limit are shortened when read; the extra entries are ignored.

## Git setup files

When you create a workspace, or click **Set up** on the suggestion shown for an existing folder, Kaido adds these lines. It only appends lines that are missing and never changes yours:

- `.gitattributes`: `tasks.md merge=union`, so task lists edited on two devices merge line by line instead of conflicting.
- `.gitignore`: `.kaido-*.tmp` and `.Trash-*`, temporary files that should never be committed.
