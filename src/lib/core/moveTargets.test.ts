import { describe, expect, it } from "vitest";
import { filterTargets, noteMoveTargets, taskMoveTargets } from "./moveTargets";
import { buildWorkspace } from "./workspace";

const workspace = buildWorkspace(
  [
    "inbox/a.md",
    "api/tasks.md",
    "api/docs/old/x.md",
    "api/docs/y.md",
    "api/Notes/z.md",
    "web/w.md",
    "_archive/old/o.md",
  ].map((path) => ({ path, size: 1, modified: 1 })),
  { ignore: [] },
);

describe("move targets", () => {
  it("lists active projects with their folders, the inbox first", () => {
    expect(noteMoveTargets(workspace, null)).toEqual([
      { folder: "inbox", label: "inbox", depth: 0 },
      { folder: "api", label: "api", depth: 0 },
      { folder: "api/docs", label: "api/docs/", depth: 1 },
      { folder: "api/docs/old", label: "api/docs/old/", depth: 2 },
      { folder: "api/Notes", label: "api/Notes/", depth: 1 },
      { folder: "web", label: "web", depth: 0 },
    ]);
  });

  it("leaves out the current folder", () => {
    expect(noteMoveTargets(workspace, "api/docs").map((target) => target.folder)).not.toContain(
      "api/docs",
    );
    expect(taskMoveTargets(workspace, "api").map((target) => target.folder)).toEqual([
      "inbox",
      "web",
    ]);
  });

  it("filters by label, ignoring case", () => {
    const targets = noteMoveTargets(workspace, null);
    expect(filterTargets(targets, " DOCS ").map((target) => target.folder)).toEqual([
      "api/docs",
      "api/docs/old",
    ]);
    expect(filterTargets(targets, "")).toHaveLength(targets.length);
  });
});
