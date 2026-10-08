/**
 * Placeholder data for the static shell. Nothing here is read from disk;
 * it will be replaced by the real workspace index.
 */

export type Inline = { kind: "text"; text: string } | { kind: "code"; text: string };

export type Block =
  | { kind: "heading"; level: 1 | 2; text: string }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "tags"; tags: string[] }
  | { kind: "shell"; commands: string[] }
  /** Raw Markdown task lines, e.g. `- [ ] update runbook`. */
  | { kind: "tasks"; lines: string[] };

export interface NoteFixture {
  /** Workspace-relative path, also used as a stable id. */
  path: string;
  file: string;
  summary: string;
  /** Short relative age of the last edit, e.g. `2m`. */
  age: string;
  body: Block[];
}

export interface FolderFixture {
  /** Top-level folder name. */
  name: string;
  /** Raw lines of the folder's `tasks.md`. */
  tasks: string[];
  notes: NoteFixture[];
}

export interface SyncFixture {
  branch: string;
  state: "synced" | "paused";
  label: string;
}

function note(folder: string, file: string, summary: string, age: string): NoteFixture {
  const title = file.replace(/\.md$/, "").replace(/-/g, " ");
  return {
    path: `${folder}/${file}`,
    file,
    summary,
    age,
    body: [
      { kind: "heading", level: 1, text: title.charAt(0).toUpperCase() + title.slice(1) },
      { kind: "paragraph", inlines: [{ kind: "text", text: `${summary}.` }] },
    ],
  };
}

const deploy: NoteFixture = {
  path: "api-payments/deploy.md",
  file: "deploy.md",
  summary: "Steps to ship api-payments to production",
  age: "2m",
  body: [
    { kind: "heading", level: 1, text: "Deploy" },
    {
      kind: "paragraph",
      inlines: [
        {
          kind: "text",
          text: "Steps to ship api-payments to production. Always run from a clean ",
        },
        { kind: "code", text: "main" },
        { kind: "text", text: " branch." },
      ],
    },
    { kind: "tags", tags: ["devops", "snippet"] },
    { kind: "heading", level: 2, text: "Release" },
    {
      kind: "shell",
      commands: ["git checkout main && git pull", "pnpm build", "fly deploy --app api-payments"],
    },
    { kind: "heading", level: 2, text: "Checklist" },
    {
      kind: "tasks",
      lines: [
        "- [x] configure CI",
        "- [ ] rotate DB credentials #security",
        "- [ ] update runbook",
      ],
    },
  ],
};

export const inbox: FolderFixture = {
  name: "inbox",
  tasks: [
    "- [ ] try pino vs slog for structured logs",
    "- [ ] read postgres 16 release notes",
    "- [ ] renew TLS certificate for staging",
  ],
  notes: [note("inbox", "reading-list.md", "Articles and talks to get to", "1d")],
};

export const projects: FolderFixture[] = [
  {
    name: "api-payments",
    tasks: [
      "- [ ] check timeouts on /checkout #bug",
      "- [ ] add idempotency keys to refunds",
      "- [ ] rotate DB credentials #security",
      "- [ ] update runbook",
      "- [x] configure CI",
    ],
    notes: [
      note("api-payments", "architecture.md", "Services, queues and payment flow", "3d"),
      deploy,
      note("api-payments", "postgres-migration.md", "Move from 14 to 16, minimal downtime", "1w"),
      note("api-payments", "rate-limits.md", "Per-merchant limits and bursts", "2w"),
    ],
  },
  {
    name: "dotfiles",
    tasks: [
      "- [ ] switch shell prompt to starship",
      "- [ ] sync editor config across machines",
      "- [ ] document the bootstrap script",
    ],
    notes: [note("dotfiles", "bootstrap.md", "Setting up a new machine from scratch", "4d")],
  },
  {
    name: "homelab",
    tasks: ["- [ ] replace failing SSD in the NAS"],
    notes: [note("homelab", "network.md", "VLANs, DNS and the reverse proxy", "1mo")],
  },
  {
    name: "personal",
    tasks: [],
    notes: [note("personal", "books.md", "Books to read this year", "3w")],
  },
];

export const sync: SyncFixture = { branch: "main", state: "synced", label: "synced 12s ago" };

export const initialSelection = { folder: "api-payments", item: deploy.path } as const;
