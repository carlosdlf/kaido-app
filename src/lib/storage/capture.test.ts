import { describe, expect, it, vi } from "vitest";
import { MemoryCaptureBus, type CaptureResult, type CaptureSubmit } from "./capture";

describe("MemoryCaptureBus", () => {
  it("delivers messages between the two sides", async () => {
    const bus = new MemoryCaptureBus();
    const submits: CaptureSubmit[] = [];
    const requests = vi.fn();
    const results: CaptureResult[] = [];
    const projects = vi.fn();
    const shown = vi.fn();
    const stopSubmit = await bus.host.onSubmit((submit) => submits.push(submit));
    await bus.host.onProjectsRequest(requests);
    await bus.channel.onResult((result) => results.push(result));
    await bus.channel.onProjects(projects);
    const stopShown = await bus.channel.onShown(shown);

    const submit: CaptureSubmit = { id: "1", kind: "task", text: "a", project: "inbox" };
    await bus.channel.submit(submit);
    await bus.channel.requestProjects();
    await bus.host.sendResult({ id: "1", ok: true, message: "Added to inbox" });
    await bus.host.sendProjects({ projects: ["inbox"], workspaceOpen: true });
    bus.show();

    expect(submits).toEqual([submit]);
    expect(requests).toHaveBeenCalledOnce();
    expect(results).toEqual([{ id: "1", ok: true, message: "Added to inbox" }]);
    expect(projects).toHaveBeenCalledWith({ projects: ["inbox"], workspaceOpen: true });
    expect(shown).toHaveBeenCalledOnce();

    stopSubmit();
    stopShown();
    await bus.channel.submit(submit);
    bus.show();
    expect(submits).toHaveLength(1);
    expect(shown).toHaveBeenCalledOnce();
  });

  it("tracks the capture window's visibility and height", async () => {
    const bus = new MemoryCaptureBus();
    bus.show();
    expect(bus.visible).toBe(true);
    await bus.channel.hide();
    expect(bus.visible).toBe(false);
    await bus.channel.show();
    expect(bus.visible).toBe(true);
    await bus.channel.resize(200);
    expect(bus.height).toBe(200);
  });

  it("reports the shortcut status", async () => {
    await expect(new MemoryCaptureBus().host.shortcutStatus()).resolves.toMatchObject({
      registered: true,
    });
    const taken = { registered: false, shortcut: "Ctrl+Alt+Space" };
    await expect(new MemoryCaptureBus({ shortcut: taken }).host.shortcutStatus()).resolves.toBe(
      taken,
    );
  });
});
