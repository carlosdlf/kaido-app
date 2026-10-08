/** Workspace configuration: `.kaido/config.json` inside the workspace, synced with it. */

import * as v from "valibot";
import { WORKSPACE_CONFIG_PATH } from "$lib/core/workspace";
import {
  field,
  parseConfig,
  serializeConfig,
  type ConfigFormat,
  type ParseResult,
  type Preserved,
} from "./parse";

export const WORKSPACE_CONFIG_VERSION = 1;

export { WORKSPACE_CONFIG_PATH };

export interface WorkspaceConfig {
  version: number;
  /** Extra ignore patterns; see the workspace rules for their syntax. */
  ignore: string[];
}

export const workspaceConfigFormat: ConfigFormat<WorkspaceConfig> = {
  name: WORKSPACE_CONFIG_PATH,
  version: WORKSPACE_CONFIG_VERSION,
  defaults: () => ({ version: WORKSPACE_CONFIG_VERSION, ignore: [] }),
  fields: {
    ignore: field(v.array(v.string()), "a list of strings"),
  },
};

export function parseWorkspaceConfig(text: string | null): ParseResult<WorkspaceConfig> {
  return parseConfig(workspaceConfigFormat, text);
}

export function serializeWorkspaceConfig(config: WorkspaceConfig, original?: Preserved): string {
  return serializeConfig(workspaceConfigFormat, config, original);
}
