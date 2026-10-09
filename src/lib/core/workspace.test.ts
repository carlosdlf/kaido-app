import { describe, expect, it } from "vitest";
import { createIgnoreMatcher } from "./glob";
import {
  buildWorkspace,
  classifyPath,
  compareNames,
  diffFiles,
  findProject,
  applyChange,
  isListablePath,
  isTaskListPath,
  workspaceFiles,
  type FileEntry,
  type Workspace,
} from "./workspace";

const none = { ignore: [] };

function file(path: string, modified = 1, size = 10): FileEntry {
  return { path, size, modified };
}

function build(paths: string[], ignore: string[] = []): Workspace {
  return buildWorkspace(
    paths.map((path) => file(path)),
    { ignore },
  );
}

/** A compact view of the model: project name to task file and note names. */
function shape(projects: Workspace["projects"]) {
  return projects.map((project) => ({
    name: project.name,
    tasks: project.tasks?.path ?? null,
    notes: project.notes.map((note) => note.name),
  }));
}

describe("buildWorkspace", () => {
  it("always has an inbox, even for an empty workspace", () => {
    expect(shape(build([]).projects)).toEqual([{ name: "inbox", tasks: null, notes: [] }]);
    expect(build([]).archived).toEqual([]);
  });

  it("turns top-level folders into projects with their task list and notes", () => {
    const workspace = build(["api/tasks.md", "api/deploy.md", "api/architecture.md"]);
    expect(shape(workspace.projects)).toEqual([
      { name: "inbox", tasks: null, notes: [] },
      { name: "api", tasks: "api/tasks.md", notes: ["architecture.md", "deploy.md"] },
    ]);
  });

  it("keeps file metadata on notes and task lists", () => {
    const workspace = buildWorkspace([file("api/tasks.md", 5, 7), file("api/a.md", 9, 3)], none);
    const api = findProject(workspace, "api");
    expect(api?.tasks).toEqual({ path: "api/tasks.md", size: 7, modified: 5 });
    expect(api?.notes).toEqual([{ path: "api/a.md", name: "a.md", size: 3, modified: 9 }]);
  });

  it("puts loose root files into the inbox", () => {
    const workspace = build(["inbox/tasks.md", "inbox/idea.md", "loose.md", "tasks.md"]);
    expect(shape(workspace.projects)).toEqual([
      { name: "inbox", tasks: "inbox/tasks.md", notes: ["idea.md", "loose.md", "tasks.md"] },
    ]);
    const paths = workspace.projects[0]?.notes.map((note) => note.path);
    expect(paths).toEqual(["inbox/idea.md", "loose.md", "tasks.md"]);
  });

  it("flattens subfolders into the project with relative names", () => {
    const workspace = build(["api/auth/flow.md", "api/auth/tasks.md", "api/z.md"]);
    expect(shape(workspace.projects)[1]).toEqual({
      name: "api",
      tasks: null,
      notes: ["auth/flow.md", "auth/tasks.md", "z.md"],
    });
  });

  it("sorts inbox first, then projects and notes by name, ignoring case", () => {
    const workspace = build(["zeta/a.md", "Beta/a.md", "alpha/b.md", "alpha/A.md", "inbox/x.md"]);
    expect(workspace.projects.map((project) => project.name)).toEqual([
      "inbox",
      "alpha",
      "Beta",
      "zeta",
    ]);
    expect(workspace.projects[1]?.notes.map((note) => note.name)).toEqual(["A.md", "b.md"]);
  });

  it("sorts the inbox notes too, including loose root files", () => {
    const workspace = build(["inbox/zeta.md", "inbox/Beta.md", "alpha.md", "inbox/a.md"]);
    expect(workspace.projects[0]?.notes.map((note) => note.name)).toEqual([
      "a.md",
      "alpha.md",
      "Beta.md",
      "zeta.md",
    ]);
  });

  it("sorts numbers naturally", () => {
    const workspace = build(["p/note-10.md", "p/note-2.md", "p/note-1.md"]);
    expect(workspace.projects[1]?.notes.map((note) => note.name)).toEqual([
      "note-1.md",
      "note-2.md",
      "note-10.md",
    ]);
  });

  it("does not depend on input order", () => {
    const paths = ["b/x.md", "a/tasks.md", "a/y.md", "root.md", "_archive/old/n.md"];
    expect(build(paths)).toEqual(build([...paths].reverse()));
  });

  it("collects archived projects separately with the same rules", () => {
    const workspace = build([
      "_archive/old/tasks.md",
      "_archive/old/sub/n.md",
      "_archive/ancient/a.md",
      "_archive/loose.md",
      "live/a.md",
    ]);
    expect(shape(workspace.projects).map((project) => project.name)).toEqual(["inbox", "live"]);
    expect(shape(workspace.archived)).toEqual([
      { name: "ancient", tasks: null, notes: ["a.md"] },
      { name: "old", tasks: "_archive/old/tasks.md", notes: ["sub/n.md"] },
    ]);
  });

  it("ignores hidden names and node_modules at any depth", () => {
    const workspace = build([
      ".kaido/notes.md",
      ".hidden.md",
      "api/.draft.md",
      "api/.private/a.md",
      "node_modules/pkg/readme.md",
      "api/node_modules/x.md",
      "_archive/.old/a.md",
      "api/ok.md",
    ]);
    expect(shape(workspace.projects)).toEqual([
      { name: "inbox", tasks: null, notes: [] },
      { name: "api", tasks: null, notes: ["ok.md"] },
    ]);
    expect(workspace.archived).toEqual([]);
  });

  it("ignores files that are not Markdown and accepts any case of .md", () => {
    const workspace = build(["api/image.png", "api/notes.txt", "api/md", "api/README.MD"]);
    expect(shape(workspace.projects)[1]?.notes).toEqual(["README.MD"]);
  });

  it("ignores malformed paths with empty segments", () => {
    expect(shape(build(["api//a.md", "/a.md"]).projects)).toHaveLength(1);
  });

  it("applies extra ignore patterns", () => {
    const workspace = build(
      ["drafts/a.md", "api/drafts/b.md", "api/c.tmp.md", "api/tasks.md", "templates/t.md"],
      ["drafts", "*.tmp.md", "/templates"],
    );
    expect(shape(workspace.projects)).toEqual([
      { name: "inbox", tasks: null, notes: [] },
      { name: "api", tasks: "api/tasks.md", notes: [] },
    ]);
  });

  it("keeps an inbox folder that only exists on disk", () => {
    const workspace = build(["inbox/tasks.md"]);
    expect(workspace.projects[0]?.tasks?.path).toBe("inbox/tasks.md");
  });

  it("builds 10k files quickly", () => {
    const files = Array.from({ length: 10_000 }, (_, i) => file(`p${i % 50}/sub/n${i}.md`));
    const start = Date.now();
    const workspace = buildWorkspace(files, { ignore: ["drafts", "**/tmp/**"] });
    expect(Date.now() - start).toBeLessThan(200);
    expect(workspace.projects).toHaveLength(51);
  });
});

describe("classifyPath", () => {
  const keep = createIgnoreMatcher([]);

  it("classifies task lists and notes", () => {
    expect(classifyPath("api/tasks.md", keep)).toEqual({
      kind: "tasks",
      project: "api",
      archived: false,
    });
    expect(classifyPath("api/x/y.md", keep)).toEqual({
      kind: "note",
      project: "api",
      archived: false,
      name: "x/y.md",
    });
    expect(classifyPath("_archive/old/tasks.md", keep)).toEqual({
      kind: "tasks",
      project: "old",
      archived: true,
    });
  });

  it("returns null for paths that are not shown", () => {
    expect(classifyPath("a.txt", keep)).toBeNull();
    expect(classifyPath(".git/x.md", keep)).toBeNull();
    expect(classifyPath("_archive/x.md", keep)).toBeNull();
    expect(classifyPath("drafts/x.md", createIgnoreMatcher(["drafts"]))).toBeNull();
  });
});

describe("compareNames", () => {
  it("is stable for names that differ only in case", () => {
    expect(compareNames("a", "A")).not.toBe(0);
    expect(compareNames("A", "a")).toBe(-compareNames("a", "A"));
    expect(compareNames("a", "a")).toBe(0);
  });
});

describe("workspaceFiles", () => {
  it("indexes every shown file, including archived ones", () => {
    const workspace = build(["api/tasks.md", "api/a.md", "_archive/old/b.md", "x.txt"]);
    expect([...workspaceFiles(workspace).keys()].sort()).toEqual([
      "_archive/old/b.md",
      "api/a.md",
      "api/tasks.md",
    ]);
  });
});

describe("findProject", () => {
  it("finds active projects only", () => {
    const workspace = build(["api/a.md", "_archive/old/b.md"]);
    expect(findProject(workspace, "api")?.name).toBe("api");
    expect(findProject(workspace, "old")).toBeUndefined();
  });
});

describe("isListablePath", () => {
  it("accepts Markdown outside hidden folders and node_modules", () => {
    expect(isListablePath("a/b.md")).toBe(true);
    expect(isListablePath("_archive/p/B.MD")).toBe(true);
    expect(isListablePath("a/b.txt")).toBe(false);
    expect(isListablePath(".kaido/config.json")).toBe(false);
    expect(isListablePath(".kaido/x.md")).toBe(false);
    expect(isListablePath("a/.hidden.md")).toBe(false);
    expect(isListablePath("a/node_modules/x.md")).toBe(false);
    expect(isListablePath("a//b.md")).toBe(false);
  });
});

describe("applyChange", () => {
  const files = [file("a.md", 1, 1), file("b.md", 1, 1)];

  it("updates changed files with fresh metadata", () => {
    const result = applyChange(files, {
      paths: ["a.md"],
      entries: [file("a.md", 2, 5)],
      rescan: false,
    });
    expect(result).toEqual({
      files: [file("a.md", 2, 5), file("b.md", 1, 1)],
      updated: ["a.md"],
      removed: [],
    });
  });

  it("adds new files and removes paths without an entry", () => {
    const result = applyChange(files, {
      paths: ["c.md", "b.md", "gone-already.md"],
      entries: [file("c.md", 3, 3)],
      rescan: false,
    });
    expect(result.files.map((entry) => entry.path)).toEqual(["a.md", "c.md"]);
    expect(result.updated).toEqual(["c.md"]);
    expect(result.removed).toEqual(["b.md"]);
  });

  it("does not report entries whose metadata did not change", () => {
    const result = applyChange(files, {
      paths: ["a.md", "a.md"],
      entries: [file("a.md", 1, 1)],
      rescan: false,
    });
    expect(result.updated).toEqual([]);
    expect(result.files).toEqual(files);
  });

  it("detects a size change with the same modification time", () => {
    const event = { paths: ["a.md"], entries: [file("a.md", 1, 2)], rescan: false };
    expect(applyChange(files, event).updated).toEqual(["a.md"]);
  });

  it("skips paths that are never listed", () => {
    const result = applyChange(files, {
      paths: [".kaido/config.json", "img.png", "node_modules/x.md"],
      entries: [file(".kaido/config.json"), file("img.png"), file("node_modules/x.md")],
      rescan: false,
    });
    expect(result).toEqual({ files, updated: [], removed: [] });
  });

  it("does not change its input", () => {
    const input = [...files];
    applyChange(input, { paths: ["a.md"], entries: [], rescan: false });
    expect(input).toEqual(files);
  });
});

describe("diffFiles", () => {
  it("reports added, removed and changed paths", () => {
    const before = [file("a.md", 1, 1), file("b.md", 1, 1), file("c.md", 1, 1), file("d.md", 1, 1)];
    const after = [file("a.md", 1, 1), file("b.md", 2, 1), file("c.md", 1, 2), file("e.md")];
    expect(diffFiles(before, after)).toEqual({
      added: ["e.md"],
      removed: ["d.md"],
      changed: ["b.md", "c.md"],
    });
  });

  it("reports nothing for identical listings", () => {
    const files = [file("a.md")];
    expect(diffFiles(files, files)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe("isTaskListPath", () => {
  it("matches project task lists only", () => {
    expect(isTaskListPath("api/tasks.md")).toBe(true);
    expect(isTaskListPath("_archive/old/tasks.md")).toBe(true);
    expect(isTaskListPath("api/sub/tasks.md")).toBe(false);
    expect(isTaskListPath("tasks.md")).toBe(false);
    expect(isTaskListPath(".kaido/tasks.md")).toBe(false);
  });
});
