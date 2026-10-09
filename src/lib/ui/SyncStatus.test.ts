import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SyncView } from "$lib/core/syncStatus";
import { MemoryStorage } from "$lib/storage";
import { AppState } from "./appState.svelte";
import AppShell from "./AppShell.svelte";
import Sidebar from "./Sidebar.svelte";
import sidebarSource from "./Sidebar.svelte?raw";

const synced: SyncView = {
  icon: "synced",
  tone: "ok",
  text: "synced · 2m ago",
  details: ["branch: main", "upstream: origin/main"],
};

function renderSidebar(sync: SyncView | null, onsync = vi.fn()) {
  render(Sidebar, {
    entries: [],
    allOpen: 0,
    workspaceName: "notes",
    warnings: [],
    notice: null,
    onpick: vi.fn(),
    selected: "inbox",
    onselect: vi.fn(),
    sync,
    onsync,
    syncShortcut: { aria: "Control+Shift+S", hint: "^⇧S" },
  });
  return onsync;
}

describe("Sidebar sync status", () => {
  it("shows the status as a sync now button with details", async () => {
    const onsync = renderSidebar(synced);
    const button = screen.getByRole("button", { name: "Sync now, synced · 2m ago" });
    expect(button).toHaveAttribute("aria-keyshortcuts", "Control+Shift+S");
    expect(button).toHaveAttribute(
      "title",
      "branch: main\nupstream: origin/main\nClick or press ^⇧S to sync now.",
    );
    expect(button).toHaveAccessibleDescription("branch: main; upstream: origin/main");
    expect(button).toHaveAttribute("data-tone", "ok");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(button);
    expect(onsync).toHaveBeenCalledTimes(1);
  });

  it("can be used from the keyboard", async () => {
    const onsync = renderSidebar(synced);
    const button = screen.getByRole("button", { name: /^Sync now/ });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onsync).toHaveBeenCalledTimes(2);
  });

  it.each<[SyncView["icon"], SyncView["tone"], string]>([
    ["syncing", "busy", "syncing…"],
    ["paused", "warning", "paused: detached HEAD"],
    ["failed", "error", "sync failed"],
    ["offline", "muted", "offline · retrying in 1m"],
    ["local", "muted", "local only"],
    ["unavailable", "muted", "no git"],
    ["checking", "muted", "checking git…"],
  ])("shows the %s state", (icon, tone, text) => {
    renderSidebar({ icon, tone, text, details: [] });
    const button = screen.getByRole("button", { name: `Sync now, ${text}` });
    expect(button).toHaveAttribute("data-icon", icon);
    expect(button).toHaveAttribute("data-tone", tone);
  });

  it("announces state changes politely, but not transient states or time passing", async () => {
    const view = (icon: SyncView["icon"], tone: SyncView["tone"], text: string): SyncView => ({
      icon,
      tone,
      text,
      details: [],
    });
    const { rerender } = render(Sidebar, {
      entries: [],
      allOpen: 0,
      workspaceName: "notes",
      warnings: [],
      notice: null,
      onpick: vi.fn(),
      selected: "inbox",
      onselect: vi.fn(),
      sync: view("checking", "muted", "checking git…"),
    });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent(/^$/);
    await rerender({ sync: view("synced", "ok", "synced · just now") });
    expect(region).toHaveTextContent("synced");
    await rerender({ sync: view("syncing", "busy", "syncing…") });
    expect(region).toHaveTextContent(/^synced$/);
    await rerender({ sync: view("synced", "ok", "synced · 5m ago") });
    expect(region).toHaveTextContent(/^synced$/);
    await rerender({ sync: view("paused", "warning", "paused: upstream gone") });
    expect(region).toHaveTextContent("paused: upstream gone");
    await rerender({ sync: null });
    expect(region).toHaveTextContent(/^$/);
  });

  it("uses the warning color for paused and the danger color for failures", () => {
    const css = sidebarSource;
    expect(css).toMatch(/\.sync\[data-tone="warning"\] \{\s*color: var\(--color-warning\);/);
    expect(css).toMatch(/\.sync\[data-tone="error"\] \{\s*color: var\(--color-danger\);/);
  });

  it("is hidden without a sync state", () => {
    renderSidebar(null);
    expect(screen.queryByRole("button", { name: /^Sync now/ })).toBeNull();
  });

  it("explains the click without a shortcut", () => {
    render(Sidebar, {
      entries: [],
      allOpen: 0,
      workspaceName: "notes",
      warnings: [],
      notice: null,
      onpick: vi.fn(),
      selected: "inbox",
      onselect: vi.fn(),
      sync: synced,
    });
    const button = screen.getByRole("button", { name: /^Sync now/ });
    expect(button.getAttribute("title")).toMatch(/Click to sync now\.$/);
    expect(button).not.toHaveAttribute("aria-keyshortcuts");
  });
});

describe("AppShell sync", () => {
  async function ready() {
    const storage = new MemoryStorage({
      folders: { "/home/me/notes": { "inbox/a.md": "# A\n" } },
      settings: JSON.stringify({ version: 1, workspace: "/home/me/notes" }),
      git: { unavailable: null, upstream: "origin/main" },
    });
    const app = new AppState(storage, { defer: (task) => task() });
    render(AppShell, { app });
    await app.start();
    await app.settled();
    await app.syncIdle();
    return { storage, app };
  }

  it("shows the sync status in the sidebar", async () => {
    await ready();
    expect(
      await screen.findByRole("button", { name: "Sync now, synced · just now" }),
    ).toBeInTheDocument();
  });

  it("syncs on click and on Ctrl+Shift+S", async () => {
    const { storage, app } = await ready();
    const before = storage.git.calls.sync;
    await userEvent.click(screen.getByRole("button", { name: /^Sync now/ }));
    await app.syncIdle();
    expect(storage.git.calls.sync).toBe(before + 1);
    const notPrevented = await fireEvent.keyDown(window, {
      key: "S",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(notPrevented).toBe(false);
    await app.syncIdle();
    expect(storage.git.calls.sync).toBe(before + 2);
    await fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true, repeat: true });
    await app.syncIdle();
    expect(storage.git.calls.sync).toBe(before + 2);
  });

  it("shows git states as they change", async () => {
    const { storage, app } = await ready();
    const release = storage.git.hold("sync");
    app.syncNow();
    expect(await screen.findByRole("button", { name: "Sync now, syncing…" })).toBeInTheDocument();
    storage.git.failNext("sync", "GitAuth", "Permission denied (publickey).");
    release();
    await app.syncIdle();
    await app.syncIdle();
    storage.git.failNext("sync", "GitAuth", "Permission denied (publickey).");
    app.syncNow();
    await app.syncIdle();
    const button = await screen.findByRole("button", { name: "Sync now, sync failed" });
    expect(button.getAttribute("title")).toContain(
      "last error: Git could not authenticate with the remote: Permission denied (publickey).",
    );
  });

  it("shows a pause found while syncing as paused, and focus does not retry it", async () => {
    const { storage, app } = await ready();
    storage.git.failNext("sync", "GitPaused", "pull-conflict: image.png");
    app.syncNow();
    await app.syncIdle();
    const button = await screen.findByRole("button", {
      name: "Sync now, paused: pull would conflict",
    });
    expect(button).toHaveAttribute("data-tone", "warning");
    expect(button.getAttribute("title")).toContain(
      "Pulling would conflict in image.png (not notes). Pull and resolve it with git.",
    );
    const syncs = storage.git.calls.sync;
    await fireEvent.focus(window);
    await app.syncIdle();
    expect(storage.git.calls.sync).toBe(syncs);
    await userEvent.click(button);
    await app.syncIdle();
    expect(storage.git.calls.sync).toBe(syncs + 1);
    expect(await screen.findByRole("button", { name: /^Sync now, synced/ })).toBeInTheDocument();
  });

  it("re-checks an upstream that is gone only on Sync now", async () => {
    const { storage, app } = await ready();
    storage.git.pausedReason = "upstream-gone";
    await fireEvent.focus(window);
    await app.syncIdle();
    const button = await screen.findByRole("button", { name: "Sync now, paused: upstream gone" });
    const syncs = storage.git.calls.sync;
    await userEvent.click(button);
    await app.syncIdle();
    // Still gone: the re-check reports the pause again and nothing is pushed.
    expect(storage.git.calls.sync).toBe(syncs + 1);
    expect(storage.git.pausedReason).toBe("upstream-gone");
    expect(
      screen.getByRole("button", { name: "Sync now, paused: upstream gone" }),
    ).toBeInTheDocument();
    // Resolved with git meanwhile: the next Sync now syncs.
    storage.git.pausedReason = null;
    await userEvent.click(screen.getByRole("button", { name: /^Sync now/ }));
    await app.syncIdle();
    expect(storage.git.calls.sync).toBe(syncs + 2);
    expect(await screen.findByRole("button", { name: /^Sync now, synced/ })).toBeInTheDocument();
  });

  it("refreshes the status when the window gets focus", async () => {
    const { storage } = await ready();
    storage.git.pausedReason = "detached-head";
    await fireEvent.focus(window);
    const button = await screen.findByRole("button", { name: "Sync now, paused: detached HEAD" });
    await waitFor(() =>
      expect(button.getAttribute("title")).toContain(
        "Git is not on a branch. Check out a branch to resume syncing.",
      ),
    );
  });
});
