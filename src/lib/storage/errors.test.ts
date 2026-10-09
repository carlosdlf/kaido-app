import { describe, expect, it } from "vitest";
import { isStorageError, StorageError, toStorageError } from "./errors";

describe("toStorageError", () => {
  it("keeps storage errors as they are", () => {
    const error = new StorageError("NotFound", "gone");
    expect(toStorageError(error)).toBe(error);
  });

  it("converts serialized backend errors", () => {
    const error = toStorageError({ kind: "PermissionDenied", message: "nope" });
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe("PermissionDenied");
    expect(error.message).toBe("nope");
    expect(error.name).toBe("StorageError");
  });

  it.each(["TooLarge", "Superseded", "Conflict"])("knows the %s kind", (kind) => {
    expect(toStorageError({ kind, message: "x" }).kind).toBe(kind);
  });

  it("treats unknown kinds and other values as I/O errors", () => {
    expect(toStorageError({ kind: "Weird", message: "x" }).kind).toBe("Io");
    expect(toStorageError(new Error("boom"))).toMatchObject({ kind: "Io", message: "boom" });
    expect(toStorageError("plain text")).toMatchObject({ kind: "Io", message: "plain text" });
    expect(toStorageError(42)).toMatchObject({ kind: "Io", message: "Unknown storage error" });
  });
});

describe("isStorageError", () => {
  it("checks the class and optionally the kind", () => {
    const error = new StorageError("NotFound", "gone");
    expect(isStorageError(error)).toBe(true);
    expect(isStorageError(error, "NotFound")).toBe(true);
    expect(isStorageError(error, "Io")).toBe(false);
    expect(isStorageError(new Error("x"))).toBe(false);
  });
});
