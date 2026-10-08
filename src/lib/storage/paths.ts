import { isStoragePath } from "$lib/core/workspace";
import { StorageError } from "./errors";

/** Largest file storage reads or writes: 8 MiB. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Checks a path given to `readFile` or `writeFile`. It must be relative,
 * `/`-separated, without empty, `.` or `..` segments, backslashes or NUL
 * bytes, and it must be a note or the workspace configuration file. Every
 * violation is an `InvalidPath` error, as in the desktop backend.
 */
export function checkStoragePath(path: string): void {
  if (path === "" || path.includes("\0") || path.includes("\\")) {
    throw new StorageError("InvalidPath", "The path is empty or contains invalid characters.");
  }
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    throw new StorageError("InvalidPath", "The path must be relative to the workspace.");
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new StorageError("InvalidPath", "The path contains an empty, . or .. segment.");
    }
  }
  if (!isStoragePath(path)) {
    throw new StorageError(
      "InvalidPath",
      "Only Markdown notes and the workspace configuration can be accessed.",
    );
  }
}
