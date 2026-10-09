import * as v from "valibot";

export const STORAGE_ERROR_KINDS = [
  "NoWorkspace",
  "NotFound",
  "NotADirectory",
  "OutsideWorkspace",
  "InvalidPath",
  "InvalidUtf8",
  "TooLarge",
  "Superseded",
  "PermissionDenied",
  "Conflict",
  "Io",
] as const;

export type StorageErrorKind = (typeof STORAGE_ERROR_KINDS)[number];

/** A storage failure with a machine-readable kind and an English message. */
export class StorageError extends Error {
  override readonly name = "StorageError";

  constructor(
    readonly kind: StorageErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const SerializedError = v.object({
  kind: v.picklist(STORAGE_ERROR_KINDS),
  message: v.string(),
});

/** Normalizes anything thrown by a storage backend into a `StorageError`. */
export function toStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const parsed = v.safeParse(SerializedError, error);
  if (parsed.success) return new StorageError(parsed.output.kind, parsed.output.message);
  if (error instanceof Error) return new StorageError("Io", error.message);
  return new StorageError("Io", typeof error === "string" ? error : "Unknown storage error");
}

export function isStorageError(error: unknown, kind?: StorageErrorKind): error is StorageError {
  return error instanceof StorageError && (kind === undefined || error.kind === kind);
}
