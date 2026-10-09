/** Device settings: `settings.json` in the app config directory. Never synced. */

import * as v from "valibot";
import { isValidAccelerator } from "$lib/core/accelerator";
import {
  field,
  parseConfig,
  serializeConfig,
  type ConfigFormat,
  type ConfigWarning,
  type ParseResult,
  type Preserved,
} from "./parse";

export const SETTINGS_VERSION = 1;

/** Most recently opened workspaces remembered. */
export const MAX_RECENT_WORKSPACES = 5;
/** Editor and task view text size in pixels. */
export const EDITOR_FONT_SIZE_MIN = 12;
export const EDITOR_FONT_SIZE_MAX = 20;
export const DEFAULT_EDITOR_FONT_SIZE = 15;
export const DEFAULT_CAPTURE_SHORTCUT = "CommandOrControl+Alt+Space";
/** Task lists per workspace whose "hide done" state is remembered. */
export const MAX_HIDE_DONE_PATHS = 200;
/** Workspaces whose "hide done" state is remembered, the most recently changed ones. */
export const MAX_HIDE_DONE_ROOTS = 20;
/** Workspaces whose setup banner was dismissed. */
export const MAX_DISMISSED_SETUP = 50;
/** The `hideDone` key of the All tasks view. */
export const ALL_TASKS_KEY = "~/all-tasks";

export interface DeviceSettings {
  version: number;
  /** Absolute path of the last opened workspace. */
  workspace?: string;
  /** Recently opened workspaces, most recent first. */
  recentWorkspaces?: string[];
  editorFontSize?: number;
  /** Commit and sync in the background. */
  autoSync?: boolean;
  /** Quick capture accelerator; `null` turns the shortcut off. */
  captureShortcut?: string | null;
  /** Workspace root → task lists (or `~/all-tasks`) with done tasks hidden. */
  hideDone?: Record<string, string[]>;
  /** Workspace roots whose setup banner was dismissed. */
  dismissedSetup?: string[];
}

/** POSIX (`/home/a`), Windows drive (`C:\a`, `C:/a`) or UNC (`\\server\share`) paths. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Removes repeated entries, keeping the first of each. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const WorkspacePath = v.pipe(v.string(), v.minLength(1), v.check(isAbsolutePath));

/** Valibot schemas of the fields, shared with the JSON Schema parity test. */
export const settingsSchemas = {
  workspace: WorkspacePath,
  recentWorkspaces: v.pipe(
    v.array(WorkspacePath),
    v.transform((paths) => unique(paths).slice(0, MAX_RECENT_WORKSPACES)),
  ),
  editorFontSize: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(EDITOR_FONT_SIZE_MIN),
    v.maxValue(EDITOR_FONT_SIZE_MAX),
  ),
  autoSync: v.boolean(),
  captureShortcut: v.nullable(v.pipe(v.string(), v.check(isValidAccelerator))),
  hideDone: v.pipe(
    v.record(v.string(), v.array(v.string())),
    v.transform((record) =>
      Object.fromEntries(
        Object.entries(record)
          .slice(-MAX_HIDE_DONE_ROOTS)
          .map(([root, paths]) => [root, unique(paths).slice(-MAX_HIDE_DONE_PATHS)]),
      ),
    ),
  ),
  dismissedSetup: v.pipe(
    v.array(v.string()),
    v.transform((roots) => unique(roots).slice(-MAX_DISMISSED_SETUP)),
  ),
};

export const settingsFormat: ConfigFormat<DeviceSettings> = {
  name: "settings.json",
  version: SETTINGS_VERSION,
  defaults: () => ({ version: SETTINGS_VERSION }),
  fields: {
    workspace: field(settingsSchemas.workspace, "an absolute folder path"),
    recentWorkspaces: field(settingsSchemas.recentWorkspaces, "a list of absolute folder paths"),
    editorFontSize: field(
      settingsSchemas.editorFontSize,
      `a whole number from ${EDITOR_FONT_SIZE_MIN} to ${EDITOR_FONT_SIZE_MAX}`,
    ),
    autoSync: field(settingsSchemas.autoSync, "true or false"),
    captureShortcut: field(
      settingsSchemas.captureShortcut,
      'a shortcut such as "CommandOrControl+Alt+Space", or null',
    ),
    hideDone: field(settingsSchemas.hideDone, "an object of lists of paths"),
    dismissedSetup: field(settingsSchemas.dismissedSetup, "a list of folder paths"),
  },
};

export function parseSettings(text: string | null): ParseResult<DeviceSettings> {
  return parseConfig(settingsFormat, text);
}

/** The settings file read again while the app runs. */
export interface ReloadedSettings {
  /** The file as parsed: the base later writes patch. */
  file: ParseResult<DeviceSettings>;
  /** The settings to use from now on. */
  value: DeviceSettings;
  warnings: ConfigWarning[];
}

/** The fields of the settings file besides `version`. */
const SETTINGS_FIELDS = Object.keys(settingsFormat.fields) as Exclude<
  keyof DeviceSettings,
  "version"
>[];

/**
 * Applies a settings file that changed while the app runs. Unlike on start,
 * nothing falls back to a default: a file that cannot be used keeps every
 * current setting, and an invalid field keeps its current value. Auto-sync
 * is only turned on by an explicit `"autoSync": true`.
 */
export function reloadSettings(current: DeviceSettings, text: string | null): ReloadedSettings {
  const file = parseConfig(settingsFormat, text, { keepCurrent: true });
  if (!file.writable) return { file, value: current, warnings: file.warnings };
  const value: DeviceSettings = { ...file.value };
  for (const key of SETTINGS_FIELDS) {
    // An unset current value means the default, like a missing field.
    if (key in file.invalid) Object.assign(value, { [key]: current[key] });
  }
  if (current.autoSync === false && file.value.autoSync !== true) value.autoSync = false;
  return { file, value, warnings: file.warnings };
}

export function serializeSettings(settings: DeviceSettings, original?: Preserved): string {
  return serializeConfig(settingsFormat, settings, original);
}

/** Settings with defaults filled in, as the app uses them. */
export interface EffectiveSettings {
  recentWorkspaces: string[];
  editorFontSize: number;
  autoSync: boolean;
  captureShortcut: string | null;
}

export function effectiveSettings(settings: DeviceSettings): EffectiveSettings {
  return {
    recentWorkspaces: settings.recentWorkspaces ?? [],
    editorFontSize: settings.editorFontSize ?? DEFAULT_EDITOR_FONT_SIZE,
    autoSync: settings.autoSync ?? true,
    captureShortcut:
      settings.captureShortcut === undefined ? DEFAULT_CAPTURE_SHORTCUT : settings.captureShortcut,
  };
}

/** `root` as the last opened workspace and first of the recent ones. */
export function withOpenedWorkspace(settings: DeviceSettings, root: string): DeviceSettings {
  const recent = [root, ...(settings.recentWorkspaces ?? []).filter((path) => path !== root)];
  return {
    ...settings,
    workspace: root,
    recentWorkspaces: recent.slice(0, MAX_RECENT_WORKSPACES),
  };
}

/** Whether opening `root` would change the settings. */
export function isOpenedWorkspace(settings: DeviceSettings, root: string): boolean {
  return settings.workspace === root && settings.recentWorkspaces?.[0] === root;
}

/** Drops `path` from the recent workspaces. */
export function withoutRecentWorkspace(settings: DeviceSettings, path: string): DeviceSettings {
  return {
    ...settings,
    recentWorkspaces: (settings.recentWorkspaces ?? []).filter((recent) => recent !== path),
  };
}

/**
 * Remembers the lists of `root` with done tasks hidden. The most recently
 * changed lists and workspaces are kept when there are too many; a
 * workspace without any is dropped.
 */
export function withHideDone(
  settings: DeviceSettings,
  root: string,
  keys: Iterable<string>,
): DeviceSettings {
  const paths = unique([...keys]).slice(-MAX_HIDE_DONE_PATHS);
  const others = Object.entries(settings.hideDone ?? {}).filter(([key]) => key !== root);
  const entries = paths.length > 0 ? [...others, [root, paths]] : others;
  const hideDone = Object.fromEntries(entries.slice(-MAX_HIDE_DONE_ROOTS));
  return { ...settings, hideDone };
}

/** The lists of `root` with done tasks hidden. */
export function hideDoneOf(settings: DeviceSettings, root: string): string[] {
  return settings.hideDone?.[root] ?? [];
}

/** Remembers that the setup banner of `root` was dismissed. */
export function withDismissedSetup(settings: DeviceSettings, root: string): DeviceSettings {
  const roots = [...(settings.dismissedSetup ?? []).filter((path) => path !== root), root];
  return { ...settings, dismissedSetup: roots.slice(-MAX_DISMISSED_SETUP) };
}
