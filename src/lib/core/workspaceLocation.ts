/**
 * Where a new workspace goes: the folder name suggested for a clone URL,
 * checking a typed folder name, and joining it to the chosen parent folder.
 */

import { portableNameProblem, stemProblem } from "./noteNames";

/**
 * The folder name `git clone` would pick for `url`: its last path segment
 * without a trailing `.git` (`git@host:me/notes.git` → `notes`). Empty when
 * there is none yet.
 */
export function cloneFolderName(url: string): string {
  const trimmed = url.trim().replace(/[?#].*$/, "");
  const withoutSlashes = trimmed.replace(/[\\/]+$/, "");
  const segment = withoutSlashes.split(/[\\/:]/).pop() ?? "";
  const name = segment.replace(/\.git$/i, "");
  // `https://host` alone has the host as its last segment; that is no repository name.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i.test(withoutSlashes)) return "";
  return portableNameProblem(name) === null && stemProblem(name) === null ? name : "";
}

/** Why `name` cannot be used as a new folder's name, or `null`. */
export function folderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed !== name) return "Names cannot start or end with a space.";
  return portableNameProblem(trimmed) ?? stemProblem(trimmed);
}

/** `parent` joined with `name`, using the separator `parent` uses (`\` for Windows paths). */
export function joinPath(parent: string, name: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(parent) && !parent.includes("/");
  const separator = windows ? "\\" : "/";
  const base = parent.endsWith("/") || parent.endsWith("\\") ? parent.slice(0, -1) : parent;
  return `${base}${separator}${name}`;
}

/** The last segment of an absolute path, for showing a workspace by name. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
