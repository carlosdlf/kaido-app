import { describe, expect, it } from "vitest";
import { checkStoragePath } from "./paths";

describe("checkStoragePath", () => {
  it.each(["a.md", "inbox/a.MD", "a/b/c.md", ".kaido/config.json", "año/日本.md", "a:b.md"])(
    "accepts %j",
    (path) => {
      expect(() => checkStoragePath(path)).not.toThrow();
    },
  );

  it.each([
    "",
    "a\0.md",
    "a\\b.md",
    "a//b.md",
    "./a.md",
    "a/",
    "/etc/passwd.md",
    "C:/x.md",
    "../x.md",
    "a/../../x.md",
    "notes.txt",
    ".kaido/other.json",
    ".git/x.md",
    "a/.hidden.md",
    "node_modules/x.md",
  ])("rejects %j as InvalidPath", (path) => {
    expect(() => checkStoragePath(path)).toThrow(expect.objectContaining({ kind: "InvalidPath" }));
  });
});
