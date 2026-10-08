/**
 * Effective configuration. Precedence: built-in defaults, then the
 * workspace's `.kaido/config.json`, then this device's `settings.json`.
 */

import type { DeviceSettings } from "./settings";
import type { WorkspaceConfig } from "./workspaceConfig";

export interface EffectiveConfig {
  /** Absolute path of the workspace to open, or `null` if none was chosen. */
  workspace: string | null;
  ignore: string[];
}

export const DEFAULT_CONFIG: Readonly<EffectiveConfig> = Object.freeze({
  workspace: null,
  ignore: [],
});

type Layer = { [K in keyof EffectiveConfig]?: EffectiveConfig[K] | undefined };

/** Later layers win; `undefined` values never override. */
export function mergeLayers(...layers: Layer[]): EffectiveConfig {
  const result: EffectiveConfig = { ...DEFAULT_CONFIG, ignore: [...DEFAULT_CONFIG.ignore] };
  for (const layer of layers) {
    if (layer.workspace !== undefined) result.workspace = layer.workspace;
    if (layer.ignore !== undefined) result.ignore = [...layer.ignore];
  }
  return result;
}

export function resolveConfig(
  workspace: WorkspaceConfig | null,
  device: DeviceSettings | null,
): EffectiveConfig {
  return mergeLayers({ ignore: workspace?.ignore }, { workspace: device?.workspace });
}
