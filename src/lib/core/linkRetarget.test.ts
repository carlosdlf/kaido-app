import { describe, expect, it } from "vitest";
import { retargetLinks } from "./linkRetarget";
import type { PathMove } from "./pathMoves";

const folder = (from: string, to: string): PathMove => ({ from, to, folder: true });
const file = (from: string, to: string): PathMove => ({ from, to, folder: false });

describe("retargetLinks", () => {
  it.each([
    // [list, line, moves, expected]
    ["a/tasks.md", "- [ ] t [n](x.md)", [file("a/x.md", "a/y.md")], "- [ ] t [n](y.md)"],
    ["a/tasks.md", "- [ ] t [n](x.md)", [file("a/x.md", "b/x.md")], "- [ ] t [n](../b/x.md)"],
    [
      "a/tasks.md",
      "- [ ] t [n](my%20note.md)",
      [file("a/my note.md", "a/C# (1).md")],
      "- [ ] t [n](C%23%20%281%29.md)",
    ],
    ["b/tasks.md", "- [ ] [n](../a/x.md)", [folder("a", "c")], "- [ ] [n](../c/x.md)"],
    [
      "b/tasks.md",
      "- [ ] [n](../a/x.md)",
      [folder("a", "_archive/a")],
      "- [ ] [n](../_archive/a/x.md)",
    ],
    ["a/tasks.md", "- [ ] [n](x.md#top)", [file("a/x.md", "a/z.md")], "- [ ] [n](z.md#top)"],
    [
      "a/tasks.md",
      "- [ ] [one](x.md) [two](x.md)",
      [file("a/x.md", "a/y.md")],
      "- [ ] [one](y.md) [two](y.md)",
    ],
    ["a/tasks.md", "  detail [n](sub/x.md)", [file("a/sub/x.md", "a/x.md")], "  detail [n](x.md)"],
  ] as const)("in %s rewrites %j", (list, line, moves, expected) => {
    expect(retargetLinks(`${line}\n`, list, moves)).toEqual({ text: `${expected}\n`, lines: [0] });
  });

  it("rewrites links that leave a moved list, keeping links inside it", () => {
    const text = "- [ ] [in](notes.md)\n- [ ] [out](../b/x.md)\n- [ ] [sub](s/y.md)\n";
    expect(retargetLinks(text, "a/tasks.md", [folder("a", "_archive/a")])).toEqual({
      text: "- [ ] [in](notes.md)\n- [ ] [out](../../b/x.md)\n- [ ] [sub](s/y.md)\n",
      lines: [1],
    });
    // Renaming keeps the depth, so nothing changes.
    expect(retargetLinks(text, "a/tasks.md", [folder("a", "c")])).toBeNull();
    // Unarchiving climbs one level less.
    expect(
      retargetLinks("- [ ] [out](../../b/x.md)\n", "_archive/a/tasks.md", [
        folder("_archive/a", "a"),
      ]),
    ).toEqual({ text: "- [ ] [out](../b/x.md)\n", lines: [0] });
  });

  it("rewrites relative to an explicit new list path, e.g. for a task moved to another list", () => {
    expect(retargetLinks("- [ ] [n](x.md)", "a/tasks.md", [], "b/tasks.md")).toEqual({
      text: "- [ ] [n](../a/x.md)",
      lines: [0],
    });
  });

  it("keeps untouched lines and line endings byte-identical", () => {
    const text = "# Head  \r\n- [ ] [n](x.md)  \r\n- [ ] [k](keep.md)\r\n\tplain\r\n";
    expect(retargetLinks(text, "a/tasks.md", [file("a/x.md", "b/x.md")])).toEqual({
      text: "# Head  \r\n- [ ] [n](../b/x.md)  \r\n- [ ] [k](keep.md)\r\n\tplain\r\n",
      lines: [1],
    });
  });

  it("leaves links to notes that did not move, URLs and code alone", () => {
    const moves = [folder("a", "b")];
    const text = [
      "- [ ] [n](other.md)",
      "- [ ] [web](https://a/x.md)",
      "- [ ] `[c](../a/x.md)`",
      "```",
      "[c](../a/x.md)",
      "```",
      "- [ ] [abs](/a/x.md)",
      "- [ ] [bad](%E0%A4%A.md)",
      "- [ ] [up](../../x.md)",
    ].join("\n");
    expect(retargetLinks(text, "c/tasks.md", moves)).toBeNull();
    expect(retargetLinks("no links here", "c/tasks.md", moves)).toBeNull();
  });

  it("skips front matter and fences of any length and kind", () => {
    const text = [
      "---",
      "see: [n](x.md)",
      "---",
      "~~~~",
      "[n](x.md)",
      "~~~",
      "~~~~",
      "- [ ] [n](x.md)",
    ].join("\n");
    expect(retargetLinks(text, "a/tasks.md", [file("a/x.md", "a/y.md")])).toEqual({
      text: text.replace(/- \[ \] \[n\]\(x\.md\)$/, "- [ ] [n](y.md)"),
      lines: [7],
    });
    // A front matter that is never closed is ordinary text.
    expect(retargetLinks("---\n[n](x.md)", "a/tasks.md", [file("a/x.md", "a/y.md")])).toEqual({
      text: "---\n[n](y.md)",
      lines: [1],
    });
  });

  it("rewrites a link to a moved task list too", () => {
    expect(retargetLinks("- [ ] [list](../a/tasks.md)", "b/tasks.md", [folder("a", "c")])).toEqual({
      text: "- [ ] [list](../c/tasks.md)",
      lines: [0],
    });
  });
});
