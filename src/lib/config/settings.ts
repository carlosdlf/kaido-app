/** Device settings: `settings.json` in the app config directory. Never synced. */

import * as v from "valibot";
import {
  field,
  parseConfig,
  serializeConfig,
  type ConfigFormat,
  type ParseResult,
  type Preserved,
} from "./parse";

export const SETTINGS_VERSION = 1;

export interface DeviceSettings {
  version: number;
  /** Absolute path of the last opened workspace. */
  workspace?: string;
}

/** POSIX (`/home/a`), Windows drive (`C:\a`, `C:/a`) or UNC (`\\server\share`) paths. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

const WorkspacePath = v.pipe(v.string(), v.minLength(1), v.check(isAbsolutePath));

export const settingsFormat: ConfigFormat<DeviceSettings> = {
  name: "settings.json",
  version: SETTINGS_VERSION,
  defaults: () => ({ version: SETTINGS_VERSION }),
  fields: {
    workspace: field(WorkspacePath, "an absolute folder path"),
  },
};

export function parseSettings(text: string | null): ParseResult<DeviceSettings> {
  return parseConfig(settingsFormat, text);
}

export function serializeSettings(settings: DeviceSettings, original?: Preserved): string {
  return serializeConfig(settingsFormat, settings, original);
}
