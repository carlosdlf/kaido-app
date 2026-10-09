/**
 * The workspace setup lines, as `MemoryStorage` applies them. The desktop
 * backend follows the same rules: lines are only ever appended, the file's
 * line endings are kept, and a missing trailing newline is added first.
 */

export const GITATTRIBUTES = ".gitattributes";
export const GITIGNORE = ".gitignore";

/** Lets git merge task lists line by line. */
export const UNION_LINES: readonly string[] = ["tasks.md merge=union"];
/** The app's temp files and trash folders never belong in the repository. */
export const IGNORE_LINES: readonly string[] = [".kaido-*.tmp", ".Trash-*"];

function lines(text: string | null): string[] {
  return text === null ? [] : text.split(/\r?\n/).map((line) => line.trim());
}

/** Whether a line already sets `merge=union` for `tasks.md`. */
export function hasUnionLine(text: string | null): boolean {
  return lines(text).some((line) => {
    const [pattern, ...attributes] = line.split(/\s+/);
    return (
      (pattern === "tasks.md" ||
        pattern === "**/tasks.md" ||
        pattern === "*.md" ||
        pattern === "**/*.md") &&
      attributes.includes("merge=union")
    );
  });
}

/** The ignore lines `text` does not have yet. */
export function missingIgnoreLines(text: string | null): string[] {
  const present = new Set(lines(text));
  return IGNORE_LINES.filter((line) => !present.has(line) && !present.has(`**/${line}`));
}

/** `text` with `added` appended, in the file's own line endings. */
export function appendLines(text: string | null, added: readonly string[]): string {
  const current = text ?? "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const separator = current === "" || current.endsWith("\n") ? "" : eol;
  return `${current}${separator}${added.map((line) => `${line}${eol}`).join("")}`;
}
