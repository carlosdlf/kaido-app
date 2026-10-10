/**
 * Moves of files and folders inside the workspace, and where a path ends
 * up after them. Paths are workspace-relative and `/`-separated.
 */

/** A file moved to another path, or (`folder`) everything inside a folder. */
export interface PathMove {
  from: string;
  to: string;
  /** `from` and `to` are folders: every path inside `from` moves along. */
  folder: boolean;
}

/** Whether `path` is inside `folder` (never `folder` itself). */
export function isInside(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

/** Where `path` is after one move, or `null` when the move does not touch it. */
export function applyMove(path: string, move: PathMove): string | null {
  if (move.folder) return isInside(path, move.from) ? move.to + path.slice(move.from.length) : null;
  return path === move.from ? move.to : null;
}

/** Where `path` is after all `moves`, applied in order. */
export function movedPath(path: string, moves: readonly PathMove[]): string {
  let current = path;
  for (const move of moves) current = applyMove(current, move) ?? current;
  return current;
}

/** The moves that undo `moves`. */
export function reverseMoves(moves: readonly PathMove[]): PathMove[] {
  return [...moves]
    .reverse()
    .map((move) => ({ from: move.to, to: move.from, folder: move.folder }));
}

/** The folder of a file path, `""` at the workspace root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * The relative path from the folder `from` to `to` (both workspace paths),
 * with `../` where it must climb: `relativePath("a", "b/x.md")` is
 * `../b/x.md`.
 */
export function relativePath(from: string, to: string): string {
  const base = from === "" ? [] : from.split("/");
  const target = to.split("/");
  let common = 0;
  // The file name itself is never a common folder.
  while (common < base.length && common < target.length - 1 && base[common] === target[common]) {
    common += 1;
  }
  const up = base.slice(common).map(() => "..");
  return [...up, ...target.slice(common)].join("/");
}
