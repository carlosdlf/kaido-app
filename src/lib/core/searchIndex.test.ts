import MiniSearch from "minisearch";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  firstMatch,
  foldTerm,
  FULL_TEXT_MAX_BYTES,
  highlightSegments,
  lineAt,
  matchRanges,
  RECENT_LIMIT,
  SearchIndex,
  snippetAround,
  SNIPPET_LENGTH,
  tokenize,
  type SearchResult,
} from "./searchIndex";
import { parseTaskDocument } from "./taskDocument";

const ids = (results: readonly SearchResult[]) => results.map((result) => result.id);
const highlighted = (text: string, ranges: readonly { start: number; end: number }[]) =>
  ranges.map((range) => text.slice(range.start, range.end));

describe("tokenize and foldTerm", () => {
  it("splits on separators and keeps letters, digits and marks", () => {
    expect(tokenize("api-payments/deploy_v2.md and  café")).toEqual([
      "api",
      "payments",
      "deploy",
      "v2",
      "md",
      "and",
      "café",
    ]);
    // A decomposed accent stays in its word.
    expect(tokenize("café au lait")).toEqual(["café", "au", "lait"]);
    expect(tokenize("--- // ...")).toEqual([]);
  });

  it("folds case and diacritics", () => {
    expect(foldTerm("Café")).toBe("cafe");
    expect(foldTerm("CAFÉ")).toBe("cafe");
    expect(foldTerm("Ñandú")).toBe("nandu");
    expect(foldTerm("́")).toBe("");
  });
});

describe("match helpers", () => {
  const terms = new Set(["deploy", "cafe"]);

  it("finds ranges of matching words", () => {
    const text = "Deploy the Café; redeploy later";
    expect(highlighted(text, matchRanges(text, terms))).toEqual(["Deploy", "Café"]);
    expect(matchRanges(text, new Set())).toEqual([]);
  });

  it("finds the first matching word, case-insensitively", () => {
    expect(firstMatch("redeploy then DEPLOY", terms)).toEqual({ start: 14, end: 20 });
    expect(firstMatch("deploy", terms)).toEqual({ start: 0, end: 6 });
    expect(firstMatch("nothing here", terms)).toBeNull();
    expect(firstMatch("anything", new Set())).toBeNull();
    expect(firstMatch("deploy deploy", terms, 1)).toEqual({ start: 7, end: 13 });
    expect(firstMatch("café café", new Set(["cafe"]), 1)).toEqual({ start: 5, end: 9 });
    expect(firstMatch("deploy", terms, 6)).toBeNull();
  });

  it("falls back to folding when only diacritics differ", () => {
    expect(firstMatch("a café", new Set(["cafe"]))).toEqual({ start: 2, end: 6 });
  });

  it("escapes terms used in the pattern", () => {
    expect(firstMatch("axb", new Set(["a.b"]))).toBeNull();
    expect(firstMatch("x a.b", new Set(["a.b"]))).toEqual({ start: 2, end: 5 });
  });

  it("counts lines with any kind of line break", () => {
    expect(lineAt("a\nb\r\nc\rd", 0)).toBe(0);
    expect(lineAt("a\nb\r\nc\rd", 2)).toBe(1);
    expect(lineAt("a\nb\r\nc\rd", 7)).toBe(3);
  });

  it("cuts a snippet from the matching line", () => {
    const text = "# Title\n  the deploy step\nmore";
    const match = firstMatch(text, new Set(["deploy"]));
    expect(match).not.toBeNull();
    if (!match) return;
    const snippet = snippetAround(text, match, new Set(["deploy"]));
    expect(snippet.text).toBe("the deploy step");
    expect(highlighted(snippet.text, snippet.ranges)).toEqual(["deploy"]);
  });

  it("shortens long lines around the match", () => {
    const text = `${"word ".repeat(40)}target ${"tail ".repeat(40)}`;
    const match = firstMatch(text, new Set(["target"]));
    if (!match) throw new Error("no match");
    const snippet = snippetAround(text, match, new Set(["target", "word"]));
    expect(snippet.text.startsWith("…")).toBe(true);
    expect(snippet.text.endsWith("…")).toBe(true);
    expect(snippet.text.length).toBeLessThanOrEqual(SNIPPET_LENGTH + 2);
    expect(highlighted(snippet.text, snippet.ranges)).toContain("target");
    for (const range of snippet.ranges) {
      expect(["target", "word"]).toContain(snippet.text.slice(range.start, range.end));
    }
  });
});

describe("SearchIndex", () => {
  function sample() {
    const index = new SearchIndex();
    index.upsertNote("api/deploy.md", "# Deploy checklist\nRun the migrations first.\n");
    index.upsertNote("inbox/ideas.md", "# Ideas\nWe could deploy on Fridays.\nCafé menu\n");
    index.upsertNote("web/readme.md", "# Readme\nNothing to see.\n");
    return index;
  }

  it("ranks a title match above a text match", () => {
    const results = sample().search("deploy");
    expect(ids(results)).toEqual(["api/deploy.md", "inbox/ideas.md"]);
    const [title, body] = results;
    expect(title?.titleRanges.length).toBe(1);
    expect(title?.line).toBeUndefined();
    expect(body?.snippet?.text).toBe("We could deploy on Fridays.");
    expect(body?.line).toBe(1);
  });

  it("matches prefixes, folded diacritics and small typos", () => {
    const index = sample();
    expect(ids(index.search("migra"))).toEqual(["api/deploy.md"]);
    expect(ids(index.search("CAFE"))).toEqual(["inbox/ideas.md"]);
    expect(ids(index.search("zzzz"))).toEqual([]);
    // Short words must match exactly or as a prefix.
    expect(ids(index.search("rnu"))).toEqual([]);
    expect(ids(index.search("cheklist"))).toEqual(["api/deploy.md"]);
  });

  it("searches only names while every word is short", () => {
    const index = sample();
    index.setTaskList("inbox/tasks.md", parseTaskDocument("- [ ] de facto\n"));
    index.setProjects(["inbox", "web"]);
    expect(ids(index.search("de"))).toEqual(["api/deploy.md"]);
    expect(ids(index.search("we"))).toEqual(["project:web", "web/readme.md"]);
    expect(ids(index.search("we could"))).toEqual(["inbox/ideas.md"]);
  });

  it("requires every word to match", () => {
    const index = sample();
    expect(ids(index.search("deploy fridays"))).toEqual(["inbox/ideas.md"]);
    expect(ids(index.search("deploy nothing"))).toEqual([]);
  });

  it("matches paths without the extension", () => {
    const index = sample();
    expect(ids(index.search("web"))).toEqual(["web/readme.md"]);
    expect(ids(index.search("md"))).toEqual([]);
  });

  it("gives title ranges and a snippet when the title and text both match", () => {
    const index = new SearchIndex();
    index.upsertNote("a.md", "# Deploy\nsteps to deploy\n");
    const [result] = index.search("deploy");
    expect(highlighted(result?.title ?? "", result?.titleRanges ?? [])).toEqual(["Deploy"]);
    expect(result?.snippet?.text).toBe("steps to deploy");
    expect(result?.line).toBeUndefined();
  });

  it("shows no snippet when the text matches only on the title's heading", () => {
    const index = new SearchIndex();
    index.upsertNote("a.md", "# Deploy ##\r\nnothing else\r\n");
    index.upsertNote("b.md", "## Deploy\nunder a subheading\n");
    const [a] = index.search("deploy").filter((result) => result.id === "a.md");
    expect(a?.snippet).toBeUndefined();
    const [b] = index.search("deploy").filter((result) => result.id === "b.md");
    expect(b?.title).toBe("b");
    expect(b?.snippet?.text).toBe("## Deploy");
    expect(b?.line).toBe(0);
  });

  it("indexes only the name of notes that were too large to read", () => {
    const index = new SearchIndex();
    index.upsertNote("inbox/huge log.md", null);
    const [result] = index.search("huge");
    expect(result).toMatchObject({ kind: "note", title: "huge log" });
    expect(result?.snippet).toBeUndefined();
  });

  it("replaces, renames and removes notes incrementally", () => {
    const index = sample();
    index.upsertNote("api/deploy.md", "# Release\nship it\n");
    expect(ids(index.search("checklist"))).toEqual([]);
    expect(ids(index.search("release"))).toEqual(["api/deploy.md"]);
    // Unchanged text is skipped.
    index.upsertNote("api/deploy.md", "# Release\nship it\n");
    expect(index.noteCount).toBe(3);

    index.renameNote("api/deploy.md", "api/ship.md");
    expect(ids(index.search("release"))).toEqual(["api/ship.md"]);
    expect(index.hasNote("api/deploy.md")).toBe(false);
    index.renameNote("missing.md", "other.md");
    index.renameNote("api/ship.md", "api/ship.md");
    expect(index.hasNote("other.md")).toBe(false);

    index.removeNote("api/ship.md");
    index.removeNote("api/ship.md");
    expect(ids(index.search("release"))).toEqual([]);
    expect(index.noteCount).toBe(2);
  });

  it("takes a title from the new name after a rename", () => {
    const index = new SearchIndex();
    index.upsertNote("inbox/old name.md", "no heading");
    index.renameNote("inbox/old name.md", "inbox/new name.md");
    expect(index.search("new")[0]?.title).toBe("new name");
  });

  it("drops notes that are not kept", () => {
    const index = sample();
    index.setProjects(["inbox"]);
    index.retainNotes((path) => path.startsWith("inbox/"));
    expect(index.noteCount).toBe(1);
    expect(ids(index.search("inbox"))).toEqual(["project:inbox", "inbox/ideas.md"]);
  });

  it("indexes top-level and nested tasks", () => {
    const index = new SearchIndex();
    const doc = parseTaskDocument("- [ ] Write docs [note](docs.md)\n  - [x] Draft docs\n");
    index.setTaskList("inbox/tasks.md", doc);
    expect(index.taskCount).toBe(2);
    const results = index.search("docs");
    expect(results.map((result) => [result.title, result.line, result.done])).toEqual([
      ["Write docs", 0, false],
      ["Draft docs", 1, true],
    ]);
    expect(results[0]).toMatchObject({
      kind: "task",
      path: "inbox/tasks.md",
      raw: "- [ ] Write docs [note](docs.md)",
    });
    expect(highlighted("Write docs", results[0]?.titleRanges ?? [])).toEqual(["docs"]);
    // The same document is not indexed again.
    index.setTaskList("inbox/tasks.md", doc);
    expect(index.taskCount).toBe(2);
  });

  it("updates only the tasks that changed", () => {
    const index = new SearchIndex();
    index.setTaskList("inbox/tasks.md", parseTaskDocument("- [ ] alpha\n- [ ] beta\n- [ ] beta\n"));
    expect(index.taskCount).toBe(3);
    index.setTaskList("inbox/tasks.md", parseTaskDocument("- [ ] alpha\n- [x] beta\n- [ ] beta\n"));
    const betas = index.search("beta").sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    expect(betas.map((result) => [result.line, result.done])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(ids(index.search("alpha"))).toHaveLength(1);
    index.removeTaskList("inbox/tasks.md");
    index.removeTaskList("inbox/tasks.md");
    expect(index.search("alpha")).toEqual([]);
  });

  it("syncs task lists with a map of documents", () => {
    const index = new SearchIndex();
    const docs = new Map([
      ["inbox/tasks.md", parseTaskDocument("- [ ] inbox task\n")],
      ["_archive/old/tasks.md", parseTaskDocument("- [ ] archived task\n")],
      ["web/tasks.md", parseTaskDocument("- [ ] web task\n")],
    ]);
    const active = (path: string) => !path.startsWith("_archive/");
    index.syncTaskLists(docs, active);
    expect(index.search("task").map((result) => result.path)).toEqual([
      "inbox/tasks.md",
      "web/tasks.md",
    ]);
    docs.delete("web/tasks.md");
    index.syncTaskLists(docs, active);
    expect(index.search("task").map((result) => result.path)).toEqual(["inbox/tasks.md"]);
  });

  it("indexes projects and keeps their order", () => {
    const index = new SearchIndex();
    index.setProjects(["inbox", "api", "web"]);
    index.setProjects(["inbox", "web", "zeta"]);
    expect(index.search("api")).toEqual([]);
    expect(index.search("zeta")).toEqual([
      {
        kind: "project",
        id: "project:zeta",
        path: "zeta",
        title: "zeta",
        titleRanges: [{ start: 0, end: 4 }],
      },
    ]);
    expect(ids(index.search(""))).toEqual(["project:inbox", "project:web", "project:zeta"]);
  });

  it("groups results by kind in order of their best result", () => {
    const index = new SearchIndex();
    index.setProjects(["inbox", "launch"]);
    index.upsertNote("inbox/plan.md", "# Plan\nthe launch is soon\n");
    index.setTaskList("inbox/tasks.md", parseTaskDocument("- [ ] launch\n- [ ] prepare launch\n"));
    index.upsertNote("inbox/launch.md", "# Launch\n");
    const kinds = index.search("launch").map((result) => result.kind);
    // Every kind appears in one run.
    const runs = kinds.filter((kind, position) => kinds[position - 1] !== kind);
    expect(new Set(runs).size).toBe(runs.length);
    expect(kinds).toHaveLength(5);
  });

  it("limits the number of results", () => {
    const index = new SearchIndex();
    for (let n = 0; n < 30; n += 1) index.upsertNote(`inbox/n${n}.md`, "same words");
    expect(index.search("same", { limit: 5 })).toHaveLength(5);
    expect(index.search("same")).toHaveLength(30);
  });

  it("lists recently opened notes and lists, then projects, for an empty query", () => {
    const index = sample();
    index.setProjects(["inbox", "api"]);
    index.setTaskList("inbox/tasks.md", parseTaskDocument(""));
    index.touch("api/deploy.md");
    index.touch("inbox/tasks.md");
    index.touch("gone.md");
    index.touch("api/deploy.md");
    expect(index.recent).toEqual(["api/deploy.md", "gone.md", "inbox/tasks.md"]);
    expect(index.search("  ")).toEqual([
      {
        kind: "note",
        id: "api/deploy.md",
        path: "api/deploy.md",
        title: "Deploy checklist",
        titleRanges: [],
      },
      {
        kind: "list",
        id: "inbox/tasks.md",
        path: "inbox/tasks.md",
        title: "inbox/tasks.md",
        titleRanges: [],
      },
      { kind: "project", id: "project:inbox", path: "inbox", title: "inbox", titleRanges: [] },
      { kind: "project", id: "project:api", path: "api", title: "api", titleRanges: [] },
    ]);
    expect(index.search("", { limit: 1 })).toHaveLength(1);
  });

  it("keeps recent entries in step with renames and removals", () => {
    const index = sample();
    index.setTaskList("inbox/tasks.md", parseTaskDocument("- [ ] a\n"));
    for (let n = 0; n < RECENT_LIMIT + 2; n += 1) index.touch(`x${n}.md`);
    expect(index.recent).toHaveLength(RECENT_LIMIT);
    index.touch("api/deploy.md");
    index.touch("inbox/tasks.md");
    index.renameNote("api/deploy.md", "api/release.md");
    expect(index.recent.slice(0, 2)).toEqual(["inbox/tasks.md", "api/release.md"]);
    index.removeNote("api/release.md");
    index.removeTaskList("inbox/tasks.md");
    expect(index.recent).not.toContain("api/release.md");
    expect(index.recent).not.toContain("inbox/tasks.md");
  });

  it("clears everything", () => {
    const index = sample();
    index.setProjects(["inbox"]);
    index.setTaskList("inbox/tasks.md", parseTaskDocument("- [ ] a\n"));
    index.touch("api/deploy.md");
    index.clear();
    expect(index.noteCount).toBe(0);
    expect(index.taskCount).toBe(0);
    expect(index.search("")).toEqual([]);
    expect(index.search("deploy")).toEqual([]);
    // Indexing works again after clearing.
    index.setProjects(["inbox"]);
    expect(ids(index.search("inbox"))).toEqual(["project:inbox"]);
  });

  it("treats a query without words as empty", () => {
    const index = sample();
    index.touch("web/readme.md");
    expect(ids(index.search("// --"))).toEqual(["web/readme.md"]);
  });
});

describe("SearchIndex incremental task updates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const list = (count: number, first = "") =>
    parseTaskDocument(
      `${first}${Array.from({ length: count }, (_, n) => `- [ ] task ${n}\n`).join("")}`,
    );

  function counted() {
    const add = vi.spyOn(MiniSearch.prototype, "add");
    const discard = vi.spyOn(MiniSearch.prototype, "discard");
    return () => {
      const touched = add.mock.calls.length + discard.mock.calls.length;
      add.mockClear();
      discard.mockClear();
      return touched;
    };
  }

  it("indexes only the new task when one is inserted at the top", () => {
    const index = new SearchIndex();
    index.setTaskList("inbox/tasks.md", list(3000));
    const touched = counted();
    index.setTaskList("inbox/tasks.md", list(3000, "- [ ] brand new\n"));
    expect(touched()).toBe(1);
    expect(index.taskCount).toBe(3001);
    // Lines of the tasks below moved with them.
    expect(index.search("task 0").find((result) => result.title === "task 0")?.line).toBe(1);
    expect(index.search("brand")[0]?.line).toBe(0);
  });

  it("indexes nothing again when tasks are reordered", () => {
    const index = new SearchIndex();
    index.setTaskList("inbox/tasks.md", parseTaskDocument("- [ ] alpha\n- [ ] beta\n"));
    const touched = counted();
    index.setTaskList("inbox/tasks.md", parseTaskDocument("- [ ] beta\n- [ ] alpha\n"));
    expect(touched()).toBe(0);
    expect(index.search("alpha")[0]?.line).toBe(1);
  });

  it("keeps identical task lines apart and adds one when another copy appears", () => {
    const index = new SearchIndex();
    index.setTaskList("inbox/tasks.md", parseTaskDocument("- [ ] same\n- [ ] same\n"));
    expect(index.taskCount).toBe(2);
    const touched = counted();
    index.setTaskList(
      "inbox/tasks.md",
      parseTaskDocument("- [ ] same\n- [ ] x\n- [ ] same\n- [ ] same\n"),
    );
    expect(touched()).toBe(2);
    expect(index.search("same").map((result) => result.line)).toEqual([0, 2, 3]);
  });
});

describe("SearchIndex large notes and the queue", () => {
  const padding = (bytes: number, char = "a") => char.repeat(bytes);

  it("indexes notes over the full-text limit by title and path only", () => {
    const index = new SearchIndex();
    const big = `# Huge\nneedle ${padding(FULL_TEXT_MAX_BYTES)}`;
    index.upsertNote("inbox/big.md", big);
    expect(index.search("needle")).toEqual([]);
    expect(ids(index.search("huge"))).toEqual(["inbox/big.md"]);
    expect(ids(index.search("big"))).toEqual(["inbox/big.md"]);
    // The same text again is not indexed again.
    index.upsertNote("inbox/big.md", big);
    expect(index.noteCount).toBe(1);
  });

  it("counts the limit in UTF-8 bytes", () => {
    const index = new SearchIndex();
    // Three bytes per character: fewer characters than the limit, more bytes.
    const tooMany = Math.floor(FULL_TEXT_MAX_BYTES / 3) + 10;
    index.upsertNote("a.md", `needle ${padding(tooMany, "€")}`);
    expect(index.search("needle")).toEqual([]);
    // Just under the limit, with some multi-byte characters.
    const fits = `needle ${padding(1000, "€")} ${padding(FULL_TEXT_MAX_BYTES - 3100)}`;
    index.upsertNote("b.md", fits);
    expect(ids(index.search("needle"))).toEqual(["b.md"]);
  });

  it("indexes queued notes on flush or before searching", () => {
    const index = new SearchIndex();
    expect(index.queueNote("a.md", "# Alpha\n")).toBe(true);
    expect(index.queueNote("b.md", "# Beta\n")).toBe(false);
    expect(index.queuedCount).toBe(2);
    expect(index.hasNote("a.md")).toBe(true);
    expect(index.noteCount).toBe(0);
    index.flushQueued();
    expect(index.noteCount).toBe(2);
    expect(index.queueNote("a.md", "# Alpha two\n")).toBe(true);
    expect(ids(index.search("two"))).toEqual(["a.md"]);
    expect(index.queuedCount).toBe(0);
    index.flushQueued();
  });

  it("keeps the queue in line with direct updates, renames and removals", () => {
    const index = new SearchIndex();
    index.queueNote("old.md", "# Old\n");
    index.upsertNote("old.md", "# Newer\n");
    expect(index.queuedCount).toBe(0);
    expect(ids(index.search("old"))).toEqual(["old.md"]);
    expect(index.search("newer")).toHaveLength(1);

    index.queueNote("old.md", "# Queued\n");
    index.renameNote("old.md", "moved.md");
    index.renameNote("only-queued.md", "x.md");
    index.queueNote("fresh.md", "# Fresh\n");
    index.renameNote("fresh.md", "renamed.md");
    expect(ids(index.search("queued"))).toEqual(["moved.md"]);
    expect(ids(index.search("fresh"))).toEqual(["renamed.md"]);

    index.queueNote("gone.md", "# Gone\n");
    index.removeNote("gone.md");
    index.queueNote("dropped.md", "# Dropped\n");
    index.retainNotes((path) => path !== "dropped.md");
    index.queueNote("cleared.md", "# Cleared\n");
    index.queueNote("kept.md", "# Kept\n");
    expect(index.search("gone")).toEqual([]);
    expect(index.search("dropped")).toEqual([]);
    index.queueNote("late.md", "# Cleared later\n");
    index.clear();
    expect(index.queuedCount).toBe(0);
    expect(index.search("cleared")).toEqual([]);
  });
});

describe("SearchIndex performance", () => {
  const SYLLABLES = ["ka", "do", "re", "mi", "lo", "ta", "su", "ne", "pi", "ro", "va", "ze"];
  /** A vocabulary of made-up words; word `n` is used about `1 / (n + 1)` as often as the first. */
  const VOCABULARY = Array.from({ length: 5000 }, (_, n) => {
    let word = "";
    let rest = n + SYLLABLES.length;
    while (rest > 0) {
      word += SYLLABLES[rest % SYLLABLES.length] ?? "";
      rest = Math.floor(rest / SYLLABLES.length);
    }
    return word;
  });
  const WEIGHTS = VOCABULARY.map((_, n) => 1 / (n + 1));
  const TOTAL = WEIGHTS.reduce((sum, weight) => sum + weight, 0);

  function pick(random: number): string {
    let target = random * TOTAL;
    for (let n = 0; n < WEIGHTS.length; n += 1) {
      target -= WEIGHTS[n] ?? 0;
      if (target <= 0) return VOCABULARY[n] ?? "";
    }
    return VOCABULARY[0] ?? "";
  }

  function body(seed: number): string {
    const words: string[] = [];
    let state = seed + 1;
    for (let n = 0; n < 150; n += 1) {
      state = (state * 1103515245 + 12345) % 2147483648;
      words.push(pick(state / 2147483648));
    }
    return `# Note ${seed}\n${words.join(" ")}\n`;
  }

  it("answers a query over 10k notes quickly", () => {
    const index = new SearchIndex();
    for (let n = 0; n < 10_000; n += 1) index.upsertNote(`project${n % 40}/note ${n}.md`, body(n));
    // A common word, a rare one, short prefixes, two words, a typo and a title.
    const [common = "", , , rare = ""] = VOCABULARY.slice(20);
    const queries = [
      common,
      VOCABULARY[3000] ?? "",
      "ka",
      "k",
      `${common} ${rare}`,
      "kadoreo",
      "note 42",
    ];
    const host = globalThis as {
      process?: { env: Record<string, string | undefined> };
      console?: { info(message: string): void };
    };
    let slowest = 0;
    for (const query of queries) {
      // The median of a few runs, so a garbage collection right after
      // indexing does not count as the query's time.
      const runs: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const start = Date.now();
        index.search(query);
        runs.push(Date.now() - start);
      }
      runs.sort((a, b) => a - b);
      slowest = Math.max(slowest, runs[2] ?? 0);
    }
    const env = host.process?.env;
    host.console?.info(`slowest query over 10k notes: ${slowest} ms`);
    // Shared CI machines are too noisy for a strict limit; the time is logged.
    if (env?.["CI"] === undefined) expect(slowest).toBeLessThan(50);
  }, 60_000);
});

describe("highlightSegments", () => {
  it("splits text into matched and unmatched parts", () => {
    expect(
      highlightSegments("deploy the api", [
        { start: 11, end: 14 },
        { start: 0, end: 6 },
      ]),
    ).toEqual([
      { text: "deploy", match: true },
      { text: " the ", match: false },
      { text: "api", match: true },
    ]);
    expect(highlightSegments("abc", [])).toEqual([{ text: "abc", match: false }]);
    expect(highlightSegments("", [])).toEqual([]);
  });

  it("ignores overlapping and out-of-range parts", () => {
    expect(
      highlightSegments("abcdef", [
        { start: 0, end: 3 },
        { start: 2, end: 4 },
        { start: 5, end: 99 },
        { start: 9, end: 12 },
      ]),
    ).toEqual([
      { text: "abc", match: true },
      { text: "d", match: true },
      { text: "e", match: false },
      { text: "f", match: true },
    ]);
  });
});
