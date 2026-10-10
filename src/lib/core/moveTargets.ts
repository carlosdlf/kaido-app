/** Where notes and tasks can be moved to: projects and their folders. */

import { compareNames, type Workspace } from "./workspace";

export interface MoveTarget {
  /** Workspace folder the item moves into, e.g. `api` or `api/docs`. */
  folder: string;
  /** What the picker shows, e.g. `api` or `api/docs/`. */
  label: string;
  /** 0 for a project, 1 and more for its folders. */
  depth: number;
}

/** The folders that contain notes of a project, relative to it, sorted (`docs`, `docs/old`). */
function subfolders(names: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const name of names) {
    const segments = name.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      folders.add(segments.slice(0, depth).join("/"));
    }
  }
  return [...folders].sort(compareNames);
}

/**
 * Where a note can be moved: every active project (the inbox first) and,
 * under each, the folders that already hold notes. `current` (the note's
 * folder) is left out.
 */
export function noteMoveTargets(workspace: Workspace, current: string | null): MoveTarget[] {
  const targets: MoveTarget[] = [];
  for (const project of workspace.projects) {
    targets.push({ folder: project.name, label: project.name, depth: 0 });
    for (const sub of subfolders(project.notes.map((note) => note.name))) {
      targets.push({
        folder: `${project.name}/${sub}`,
        label: `${project.name}/${sub}/`,
        depth: sub.split("/").length,
      });
    }
  }
  return targets.filter((target) => target.folder !== current);
}

/** Where a task can be moved: every active project but its own, the inbox first. */
export function taskMoveTargets(workspace: Workspace, current: string | null): MoveTarget[] {
  return workspace.projects
    .filter((project) => project.name !== current)
    .map((project) => ({ folder: project.name, label: project.name, depth: 0 }));
}

/** The targets whose label contains `query`, ignoring case and surrounding spaces. */
export function filterTargets(targets: readonly MoveTarget[], query: string): MoveTarget[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...targets];
  return targets.filter((target) => target.label.toLowerCase().includes(needle));
}
