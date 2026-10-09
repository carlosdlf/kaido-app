/**
 * Quick capture: the small capture window and the main window talk through
 * events. The capture window never touches the disk; it sends what was typed
 * to the main window, which writes it and replies with the outcome.
 *
 * `CaptureChannel` is the capture window's side, `CaptureHost` the main
 * window's. `MemoryCaptureBus` connects both in memory, for tests and for
 * running the capture page in a plain browser.
 */

import * as v from "valibot";
import type { Unsubscribe } from "./types";

export const CAPTURE_SUBMIT = "capture:submit";
export const CAPTURE_RESULT = "capture:result";
export const CAPTURE_PROJECTS_REQUEST = "capture:projects-request";
export const CAPTURE_PROJECTS = "capture:projects";
/** Sent to the capture window every time it is shown. */
export const CAPTURE_SHOWN = "capture:shown";

/** Window labels. */
export const MAIN_WINDOW = "main";
export const CAPTURE_WINDOW = "capture";

export const CaptureSubmitSchema = v.object({
  id: v.string(),
  kind: v.picklist(["task", "note"]),
  text: v.string(),
  project: v.string(),
});
export const CaptureResultSchema = v.object({
  id: v.string(),
  ok: v.boolean(),
  message: v.string(),
});
export const CaptureProjectsSchema = v.object({
  projects: v.array(v.string()),
  workspaceOpen: v.boolean(),
});
export const ShortcutStatusSchema = v.object({
  registered: v.boolean(),
  shortcut: v.string(),
});

export type CaptureKind = "task" | "note";
export type CaptureSubmit = v.InferOutput<typeof CaptureSubmitSchema>;
export type CaptureResult = v.InferOutput<typeof CaptureResultSchema>;
export type CaptureProjects = v.InferOutput<typeof CaptureProjectsSchema>;
/** Whether the global capture shortcut could be registered. */
export type ShortcutStatus = v.InferOutput<typeof ShortcutStatusSchema>;

/** The capture window's side. */
export interface CaptureChannel {
  /** The window was shown (by the global shortcut). */
  onShown(handler: () => void): Promise<Unsubscribe>;
  onProjects(handler: (projects: CaptureProjects) => void): Promise<Unsubscribe>;
  onResult(handler: (result: CaptureResult) => void): Promise<Unsubscribe>;
  requestProjects(): Promise<void>;
  submit(submit: CaptureSubmit): Promise<void>;
  hide(): Promise<void>;
  /** Shows the window again and focuses it, e.g. after a failed capture. */
  show(): Promise<void>;
  /** Sets the window's height in logical pixels; the width stays. */
  resize(height: number): Promise<void>;
}

/** The main window's side. */
export interface CaptureHost {
  onSubmit(handler: (submit: CaptureSubmit) => void): Promise<Unsubscribe>;
  onProjectsRequest(handler: () => void): Promise<Unsubscribe>;
  sendResult(result: CaptureResult): Promise<void>;
  sendProjects(projects: CaptureProjects): Promise<void>;
  shortcutStatus(): Promise<ShortcutStatus>;
}

type Handlers<T> = Set<(value: T) => void>;

function subscribe<T>(handlers: Handlers<T>, handler: (value: T) => void): Promise<Unsubscribe> {
  handlers.add(handler);
  return Promise.resolve(() => {
    handlers.delete(handler);
  });
}

function deliver<T>(handlers: Handlers<T>, value: T): Promise<void> {
  for (const handler of [...handlers]) handler(value);
  return Promise.resolve();
}

export interface MemoryCaptureBusOptions {
  shortcut?: ShortcutStatus;
}

/** Both sides of quick capture, connected in memory. Messages are delivered synchronously. */
export class MemoryCaptureBus {
  /** Whether the capture window is shown. */
  visible = false;
  /** The capture window's height. */
  height: number | null = null;
  shortcut: ShortcutStatus;

  readonly #shown: Handlers<void> = new Set();
  readonly #projects: Handlers<CaptureProjects> = new Set();
  readonly #results: Handlers<CaptureResult> = new Set();
  readonly #submits: Handlers<CaptureSubmit> = new Set();
  readonly #requests: Handlers<void> = new Set();

  readonly channel: CaptureChannel;
  readonly host: CaptureHost;

  constructor(options: MemoryCaptureBusOptions = {}) {
    this.shortcut = options.shortcut ?? {
      registered: true,
      shortcut: "CommandOrControl+Alt+Space",
    };
    this.channel = {
      onShown: (handler) => subscribe(this.#shown, handler),
      onProjects: (handler) => subscribe(this.#projects, handler),
      onResult: (handler) => subscribe(this.#results, handler),
      requestProjects: () => deliver(this.#requests, undefined),
      submit: (submit) => deliver(this.#submits, submit),
      hide: () => {
        this.visible = false;
        return Promise.resolve();
      },
      show: () => {
        this.visible = true;
        return Promise.resolve();
      },
      resize: (height) => {
        this.height = height;
        return Promise.resolve();
      },
    };
    this.host = {
      onSubmit: (handler) => subscribe(this.#submits, handler),
      onProjectsRequest: (handler) => subscribe(this.#requests, handler),
      sendResult: (result) => deliver(this.#results, result),
      sendProjects: (projects) => deliver(this.#projects, projects),
      shortcutStatus: () => Promise.resolve(this.shortcut),
    };
  }

  /** Shows the capture window, as the global shortcut does. */
  show(): void {
    this.visible = true;
    void deliver(this.#shown, undefined);
  }
}
