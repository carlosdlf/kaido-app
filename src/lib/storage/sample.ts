/** A small workspace served from memory when the UI runs outside the desktop app. */

export const SAMPLE_ROOT = "/sample-workspace";
/** How long each git operation of the sample repository takes. */
export const SAMPLE_GIT_DELAY_MS = 400;

export const sampleWorkspace: Record<string, string> = {
  "inbox/tasks.md": [
    "- [ ] try pino vs slog for structured logs",
    "- [ ] read postgres 16 release notes",
    "  - [ ] logical replication changes",
    "  - [x] new pg_stat_io view",
    "- [ ] renew TLS certificate for staging",
    "- [x] book dentist appointment",
    "",
  ].join("\n"),
  "inbox/reading-list.md": "# Reading list\n\nArticles and talks to get to.\n",
  "api-payments/tasks.md": [
    "# This week",
    "",
    "- [ ] check timeouts on /checkout #bug [note](architecture.md)",
    "  Started after the gateway upgrade; only card payments are affected.",
    "  - [ ] reproduce with a slow card issuer",
    "  - [ ] add a metric for p99 latency",
    "- [ ] add idempotency keys to refunds",
    "- [x] configure CI",
    "",
    "# Later",
    "",
    "- [ ] rotate DB credentials #security",
    "- [ ] update runbook",
    "",
  ].join("\n"),
  "api-payments/deploy.md": [
    "# Deploy",
    "",
    "Steps to ship api-payments to production. Always run from a clean `main` branch.",
    "",
    "#devops #snippet",
    "",
    "## Release",
    "",
    "```sh",
    "git checkout main && git pull",
    "pnpm build",
    "fly deploy --app api-payments",
    "```",
    "",
    "## Checklist",
    "",
    "- [x] configure CI",
    "- [ ] rotate DB credentials #security",
    "- [ ] update runbook",
    "",
  ].join("\n"),
  "api-payments/architecture.md": "# Architecture\n\nServices, queues and payment flow.\n",
  "api-payments/runbooks/rate-limits.md": "# Rate limits\n\nPer-merchant limits and bursts.\n",
  "dotfiles/tasks.md":
    "- [ ] switch shell prompt to starship\n- [ ] document the bootstrap script\n",
  "dotfiles/bootstrap.md": "# Bootstrap\n\nSetting up a new machine from scratch.\n",
  "personal/books.md": "# Books\n\nBooks to read this year.\n",
  "_archive/old-blog/ideas.md": "# Blog ideas\n",
};
