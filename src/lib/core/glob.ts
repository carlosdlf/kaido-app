/**
 * Minimal glob matching for workspace ignore patterns.
 *
 * Patterns follow a small, gitignore-like subset:
 * - `*` matches any run of characters except `/`; `?` matches one such character.
 * - `**` matches across folders. As a leading or middle segment it matches
 *   zero or more folders (for example `**` + `/drafts`); at the end, as in
 *   `notes/**`, it matches everything inside.
 * - A pattern without a `/` (ignoring a trailing one) matches a file or
 *   folder name at any depth: `drafts`, `*.draft.md`.
 * - A pattern containing a `/` is anchored at the workspace root. A leading
 *   `/` is optional: `/scratch` and `scratch/old` are both root-relative.
 * - A trailing `/` matches folders only: `tmp/` ignores folders named `tmp`
 *   but not a file named `tmp`.
 * - Ignoring a folder ignores everything inside it.
 * - Blank patterns and `#` comments are skipped. Negation (`!`) and
 *   character classes (`[abc]`) are not supported; `!` patterns are skipped
 *   and brackets match literally.
 */

interface CompiledPattern {
  regex: RegExp;
  /** Matches against single names instead of root-relative paths. */
  anyDepth: boolean;
  dirOnly: boolean;
}

/** Returns true if a workspace-relative path (`/`-separated) is ignored. */
export type PathMatcher = (path: string) => boolean;

const SPECIAL = /[.+^${}()|[\]\\]/;

function toRegexSource(glob: string): string {
  let source = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob.charAt(index);
    if (char === "*" && glob.charAt(index + 1) === "*") {
      const atStart = index === 0 || glob.charAt(index - 1) === "/";
      const end = index + 2;
      if (atStart && glob.charAt(end) === "/") {
        // `**/` matches zero or more leading folders.
        source += "(?:.*/)?";
        index = end + 1;
      } else {
        source += ".*";
        index = end;
      }
      // Collapse runs such as `***`.
      while (glob.charAt(index) === "*") index += 1;
      continue;
    }
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (SPECIAL.test(char)) source += `\\${char}`;
    else source += char;
    index += 1;
  }
  return source;
}

function compile(raw: string): CompiledPattern | null {
  let pattern = raw.trim();
  if (pattern === "" || pattern.startsWith("#") || pattern.startsWith("!")) return null;
  const dirOnly = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  const anyDepth = !pattern.includes("/");
  pattern = pattern.replace(/^\/+/, "");
  if (pattern === "") return null;
  return { regex: new RegExp(`^${toRegexSource(pattern)}$`, "u"), anyDepth, dirOnly };
}

function matches(compiled: CompiledPattern, segments: string[]): boolean {
  // Folders are every proper prefix of the path; the last segment is the file.
  const last = compiled.dirOnly ? segments.length - 1 : segments.length;
  if (compiled.anyDepth) {
    for (let i = 0; i < last; i += 1) {
      if (compiled.regex.test(segments[i] ?? "")) return true;
    }
    return false;
  }
  let prefix = "";
  for (let i = 0; i < last; i += 1) {
    prefix = i === 0 ? (segments[0] ?? "") : `${prefix}/${segments[i] ?? ""}`;
    if (compiled.regex.test(prefix)) return true;
  }
  return false;
}

/** Compiles ignore patterns once into a matcher for many paths. */
export function createIgnoreMatcher(patterns: readonly string[]): PathMatcher {
  const compiled = patterns.map(compile).filter((item) => item !== null);
  if (compiled.length === 0) return () => false;
  return (path) => {
    const segments = path.split("/");
    return compiled.some((item) => matches(item, segments));
  };
}
