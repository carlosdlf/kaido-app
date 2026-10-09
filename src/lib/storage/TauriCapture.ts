/**
 * Quick capture for the desktop app's two windows.
 *
 * The capture window has no generic window or event permissions: it calls
 * app commands, and the backend relays its submits and project requests to
 * the main window as events. The main window answers with events sent to
 * the capture window.
 */

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import * as v from "valibot";
import {
  CAPTURE_PROJECTS,
  CAPTURE_PROJECTS_REQUEST,
  CAPTURE_RESULT,
  CAPTURE_SHOWN,
  CAPTURE_SUBMIT,
  CAPTURE_WINDOW,
  CaptureProjectsSchema,
  CaptureResultSchema,
  CaptureSubmitSchema,
  ShortcutStatusSchema,
  type CaptureChannel,
  type CaptureHost,
  type CaptureProjects,
  type CaptureResult,
  type CaptureSubmit,
  type ShortcutStatus,
} from "./capture";
import { StorageError, toStorageError } from "./errors";
import type { Unsubscribe } from "./types";

/**
 * Listens to `event` and hands valid payloads to `handler`. Malformed
 * payloads are dropped: they can only come from a bug, never from the user.
 */
async function on<T>(
  event: string,
  schema: v.GenericSchema<unknown, T>,
  handler: (payload: T) => void,
): Promise<Unsubscribe> {
  try {
    return await listen<unknown>(event, (message) => {
      const parsed = v.safeParse(schema, message.payload);
      if (parsed.success) handler(parsed.output);
    });
  } catch (error) {
    throw toStorageError(error);
  }
}

async function send(target: string, event: string, payload: unknown): Promise<void> {
  try {
    await emitTo(target, event, payload);
  } catch (error) {
    throw toStorageError(error);
  }
}

async function call(command: string, args?: Record<string, unknown>): Promise<void> {
  try {
    await invoke(command, args);
  } catch (error) {
    throw toStorageError(error);
  }
}

const Anything = v.unknown();

/** The capture window's side. */
export class TauriCaptureChannel implements CaptureChannel {
  onShown(handler: () => void): Promise<Unsubscribe> {
    return on(CAPTURE_SHOWN, Anything, () => handler());
  }

  onProjects(handler: (projects: CaptureProjects) => void): Promise<Unsubscribe> {
    return on(CAPTURE_PROJECTS, CaptureProjectsSchema, handler);
  }

  onResult(handler: (result: CaptureResult) => void): Promise<Unsubscribe> {
    return on(CAPTURE_RESULT, CaptureResultSchema, handler);
  }

  requestProjects(): Promise<void> {
    return call("capture_request_projects");
  }

  submit(submit: CaptureSubmit): Promise<void> {
    const { id, kind, text, project } = submit;
    return call("capture_submit", { payload: { id, kind, text, project } });
  }

  hide(): Promise<void> {
    return call("capture_hide");
  }

  show(): Promise<void> {
    return call("capture_show");
  }

  /** The backend keeps the width and limits the height to what the window allows. */
  resize(height: number): Promise<void> {
    return call("capture_set_height", { height });
  }
}

/** The main window's side. */
export class TauriCaptureHost implements CaptureHost {
  onSubmit(handler: (submit: CaptureSubmit) => void): Promise<Unsubscribe> {
    return on(CAPTURE_SUBMIT, CaptureSubmitSchema, handler);
  }

  onProjectsRequest(handler: () => void): Promise<Unsubscribe> {
    return on(CAPTURE_PROJECTS_REQUEST, Anything, () => handler());
  }

  sendResult(result: CaptureResult): Promise<void> {
    return send(CAPTURE_WINDOW, CAPTURE_RESULT, result);
  }

  sendProjects(projects: CaptureProjects): Promise<void> {
    return send(CAPTURE_WINDOW, CAPTURE_PROJECTS, projects);
  }

  async shortcutStatus(): Promise<ShortcutStatus> {
    let result: unknown;
    try {
      result = await invoke<unknown>("capture_shortcut_status");
    } catch (error) {
      throw toStorageError(error);
    }
    const parsed = v.safeParse(ShortcutStatusSchema, result);
    if (!parsed.success) {
      throw new StorageError("Io", "Unexpected response from capture_shortcut_status.");
    }
    return parsed.output;
  }
}
