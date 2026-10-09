import { describe, expect, it } from "vitest";
import { filterCommands, PALETTE_COMMANDS, paletteMode } from "./palette";

describe("paletteMode", () => {
  it("searches by default", () => {
    expect(paletteMode("  deploy api ")).toEqual({ kind: "search", query: "deploy api" });
    expect(paletteMode("")).toEqual({ kind: "search", query: "" });
  });

  it("lists commands after >", () => {
    expect(paletteMode(">")).toEqual({ kind: "commands", query: "" });
    expect(paletteMode(" > sync ")).toEqual({ kind: "commands", query: "sync" });
  });

  it("reserves # for tags", () => {
    expect(paletteMode("#work")).toEqual({ kind: "tags", query: "work" });
  });
});

describe("filterCommands", () => {
  it("keeps every command for an empty query", () => {
    expect(filterCommands(PALETTE_COMMANDS, " ")).toEqual(PALETTE_COMMANDS);
  });

  it("filters by plain substring, ignoring case", () => {
    expect(filterCommands(PALETTE_COMMANDS, "NEW").map((command) => command.id)).toEqual([
      "new-note",
      "new-project",
    ]);
    expect(filterCommands(PALETTE_COMMANDS, "list / t").map((command) => command.id)).toEqual([
      "switch-view",
    ]);
    expect(filterCommands(PALETTE_COMMANDS, "nope")).toEqual([]);
  });
});
