/**
 * Shared parsing for versioned JSON configuration files.
 *
 * Parsing never throws. Invalid fields fall back to their defaults and are
 * reported as warnings, so a typo in one setting does not reset the others.
 */

import * as v from "valibot";

export interface ConfigWarning {
  /** Dotted field name, or an empty string for the whole file. */
  field: string;
  message: string;
}

export interface ParseResult<T> {
  value: T;
  warnings: ConfigWarning[];
  /**
   * Fields this version does not know. They are kept when the file is
   * written back, so newer or hand-added settings are not lost.
   */
  unknown: Record<string, unknown>;
  /**
   * Raw values of known fields that failed validation. They are written back
   * unchanged unless the app sets a new value, so a typo is never silently
   * replaced by a default.
   */
  invalid: Record<string, unknown>;
  /**
   * False when the file must not be overwritten: it is not valid JSON, not a
   * JSON object, or was written by a newer version of the app. Defaults are
   * used in that case.
   */
  writable: boolean;
}

/** What a write needs to keep from the file that was read. */
export type Preserved = Pick<ParseResult<unknown>, "unknown" | "invalid">;

/** A field validator: returns the parsed value or a warning message. */
export type FieldParser<T> = (
  input: unknown,
) => { ok: true; value: T } | { ok: false; message: string };

export interface ConfigFormat<T extends { version: number }> {
  /** Name used in warnings, e.g. `settings.json`. */
  name: string;
  version: number;
  defaults: () => T;
  fields: { [K in Exclude<keyof T, "version">]-?: FieldParser<T[K]> };
}

/** Wraps a valibot schema as a field parser with a readable message. */
export function field<T>(schema: v.GenericSchema<unknown, T>, expected: string): FieldParser<T> {
  return (input) => {
    const result = v.safeParse(schema, input);
    return result.success
      ? { ok: true, value: result.output }
      : { ok: false, message: `expected ${expected}` };
  };
}

const VersionSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a configuration file. `text` is `null` when the file does not
 * exist, which silently yields the defaults.
 */
export function parseConfig<T extends { version: number }>(
  format: ConfigFormat<T>,
  text: string | null,
): ParseResult<T> {
  const defaults = format.defaults();
  const result: ParseResult<T> = {
    value: defaults,
    warnings: [],
    unknown: {},
    invalid: {},
    writable: true,
  };
  if (text === null) return result;

  const warn = (field: string, message: string) => {
    result.warnings.push({
      field,
      message: `${format.name}: ${field ? `${field}: ` : ""}${message}`,
    });
  };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    warn("", "not valid JSON; using defaults and leaving the file unchanged");
    result.writable = false;
    return result;
  }
  if (!isRecord(data)) {
    warn("", "expected a JSON object; using defaults and leaving the file unchanged");
    result.writable = false;
    return result;
  }

  if (!("version" in data)) {
    warn("version", `missing; assuming ${format.version}`);
  } else if (!v.is(VersionSchema, data["version"])) {
    warn("version", `expected a positive integer; assuming ${format.version}`);
  } else if (data["version"] > format.version) {
    warn(
      "version",
      `written by a newer version of Kaido (${data["version"]}); using defaults and leaving the file unchanged`,
    );
    result.writable = false;
    return result;
  }

  const value: Record<string, unknown> = { ...defaults, version: format.version };
  const parsers: Record<string, FieldParser<unknown>> = format.fields;
  for (const [key, input] of Object.entries(data)) {
    if (key === "version") continue;
    const parse = parsers[key];
    if (!parse) {
      result.unknown[key] = input;
      continue;
    }
    const parsed = parse(input);
    if (parsed.ok) {
      value[key] = parsed.value;
    } else {
      result.invalid[key] = input;
      warn(key, `${parsed.message}; using the default`);
    }
  }
  // Every known key was either parsed or left at its default, so `value`
  // has the shape of `T`.
  result.value = value as T;
  return result;
}

/**
 * Serializes a configuration file. Unknown fields from the original are
 * kept, and invalid fields keep their raw value unless `value` sets
 * something other than the default.
 */
export function serializeConfig<T extends { version: number }>(
  format: ConfigFormat<T>,
  value: T,
  original: Preserved = { unknown: {}, invalid: {} },
): string {
  const defaults: Record<string, unknown> = format.defaults();
  const known: [string, unknown][] = Object.entries(value).map(([key, current]) => {
    const unchanged = JSON.stringify(current) === JSON.stringify(defaults[key]);
    return key in original.invalid && unchanged ? [key, original.invalid[key]] : [key, current];
  });
  for (const [key, raw] of Object.entries(original.invalid)) {
    if (!(key in value)) known.push([key, raw]);
  }
  // `version` goes first and always matches this app; undefined fields are
  // dropped by JSON.stringify.
  const fields = [...known, ...Object.entries(original.unknown)];
  const data = Object.fromEntries([
    ["version", format.version],
    ...fields.filter(([key]) => key !== "version"),
  ]);
  return `${JSON.stringify(data, null, 2)}\n`;
}
