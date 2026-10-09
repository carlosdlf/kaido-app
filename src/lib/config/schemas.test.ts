/**
 * The JSON Schemas in `schemas/` document the configuration files for
 * editors and users. These tests keep them in line with the valibot
 * formats the app actually parses with.
 */

import { describe, expect, it } from "vitest";
import settingsSchema from "../../../schemas/settings.schema.json";
import workspaceSchema from "../../../schemas/workspace-config.schema.json";
import {
  DEFAULT_CAPTURE_SHORTCUT,
  DEFAULT_EDITOR_FONT_SIZE,
  effectiveSettings,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  MAX_DISMISSED_SETUP,
  MAX_HIDE_DONE_PATHS,
  MAX_HIDE_DONE_ROOTS,
  MAX_RECENT_WORKSPACES,
  SETTINGS_VERSION,
  settingsFormat,
  settingsSchemas,
} from "./settings";
import {
  WORKSPACE_CONFIG_VERSION,
  workspaceConfigFormat,
  workspaceConfigSchemas,
} from "./workspaceConfig";

/** The parts of a valibot schema object these tests read. */
interface ValibotNode {
  type: string;
  wrapped?: ValibotNode;
  item?: ValibotNode;
  value?: ValibotNode;
  pipe?: readonly { type: string; requirement?: unknown }[];
}

/** The JSON Schema type a valibot schema accepts. */
function jsonType(schema: ValibotNode): string | string[] {
  switch (schema.type) {
    case "nullable": {
      const inner = schema.wrapped ? jsonType(schema.wrapped) : "unknown";
      return [...(Array.isArray(inner) ? inner : [inner]), "null"];
    }
    case "record":
      return "object";
    case "number":
      return hasAction(schema, "integer") ? "integer" : "number";
    default:
      return schema.type;
  }
}

function hasAction(schema: ValibotNode, type: string): boolean {
  return schema.pipe?.some((action) => action.type === type) ?? false;
}

function requirement(schema: ValibotNode, type: string): unknown {
  return schema.pipe?.find((action) => action.type === type)?.requirement;
}

interface PropertySchema {
  type: string | string[];
  description?: string;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  default?: unknown;
  items?: { type: string };
  additionalProperties?: { type: string; items?: { type: string }; maxItems?: number };
}

function properties(schema: { properties: object }): Record<string, PropertySchema> {
  return schema.properties as Record<string, PropertySchema>;
}

describe("settings.schema.json", () => {
  const props = properties(settingsSchema);
  const schemas = settingsSchemas as unknown as Record<string, ValibotNode>;

  it("describes exactly the fields the app reads", () => {
    expect(Object.keys(props).sort()).toEqual(
      ["version", ...Object.keys(settingsFormat.fields)].sort(),
    );
    expect(Object.keys(schemas).sort()).toEqual(Object.keys(settingsFormat.fields).sort());
    expect(settingsSchema.properties.version.const).toBe(SETTINGS_VERSION);
    expect(settingsSchema.required).toEqual(["version"]);
  });

  it("gives every field the type valibot accepts", () => {
    for (const [name, schema] of Object.entries(schemas)) {
      expect({ name, type: props[name]?.type }).toEqual({ name, type: jsonType(schema) });
    }
  });

  it("matches the font size range and default", () => {
    const fontSize = settingsSchemas.editorFontSize as unknown as ValibotNode;
    expect(requirement(fontSize, "min_value")).toBe(EDITOR_FONT_SIZE_MIN);
    expect(requirement(fontSize, "max_value")).toBe(EDITOR_FONT_SIZE_MAX);
    expect(props["editorFontSize"]).toMatchObject({
      minimum: EDITOR_FONT_SIZE_MIN,
      maximum: EDITOR_FONT_SIZE_MAX,
      default: DEFAULT_EDITOR_FONT_SIZE,
    });
  });

  it("describes the list caps as truncation, not as limits that reject the file", () => {
    // The app ignores extra entries instead of rejecting the field, so the
    // schema must not flag longer lists as errors.
    expect(props["recentWorkspaces"]?.maxItems).toBeUndefined();
    expect(props["dismissedSetup"]?.maxItems).toBeUndefined();
    expect(props["hideDone"]?.additionalProperties?.maxItems).toBeUndefined();
    expect(props["recentWorkspaces"]?.description).toContain(
      `first ${MAX_RECENT_WORKSPACES} are used; extra entries are ignored`,
    );
    expect(props["dismissedSetup"]?.description).toContain(
      `last ${MAX_DISMISSED_SETUP} are used; extra entries are ignored`,
    );
    expect(props["hideDone"]?.description).toContain(
      `last ${MAX_HIDE_DONE_ROOTS} workspaces, and the last ${MAX_HIDE_DONE_PATHS} lists of each, are used; extra entries are ignored`,
    );
  });

  it("matches item types", () => {
    const recent = schemas["recentWorkspaces"];
    const dismissed = schemas["dismissedSetup"];
    const hideDone = schemas["hideDone"];
    expect(props["recentWorkspaces"]?.items?.type).toBe(recent?.item?.type);
    expect(props["dismissedSetup"]?.items?.type).toBe(dismissed?.item?.type);
    expect(props["hideDone"]?.additionalProperties?.type).toBe(hideDone?.value?.type);
    expect(props["hideDone"]?.additionalProperties?.items?.type).toBe(hideDone?.value?.item?.type);
  });

  it("states the defaults the app uses", () => {
    const defaults = effectiveSettings({ version: SETTINGS_VERSION });
    expect(props["autoSync"]?.default).toBe(defaults.autoSync);
    expect(props["captureShortcut"]?.default).toBe(DEFAULT_CAPTURE_SHORTCUT);
    expect(props["recentWorkspaces"]?.default).toEqual(defaults.recentWorkspaces);
  });
});

describe("workspace-config.schema.json", () => {
  const props = properties(workspaceSchema);
  const schemas = workspaceConfigSchemas as unknown as Record<string, ValibotNode>;

  it("describes exactly the fields the app reads", () => {
    expect(Object.keys(props).sort()).toEqual(
      ["version", ...Object.keys(workspaceConfigFormat.fields)].sort(),
    );
    expect(Object.keys(schemas).sort()).toEqual(Object.keys(workspaceConfigFormat.fields).sort());
    expect(workspaceSchema.properties.version.const).toBe(WORKSPACE_CONFIG_VERSION);
  });

  it("gives every field the type and default valibot uses", () => {
    const defaults = workspaceConfigFormat.defaults() as unknown as Record<string, unknown>;
    for (const [name, schema] of Object.entries(schemas)) {
      expect(props[name]?.type).toEqual(jsonType(schema));
      expect(props[name]?.default).toEqual(defaults[name]);
    }
    expect(props["ignore"]?.items?.type).toBe(schemas["ignore"]?.item?.type);
  });
});
