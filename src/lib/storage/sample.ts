/** A small workspace served from memory when the UI runs outside the desktop app. */

export const SAMPLE_ROOT = "/sample-workspace";

export const sampleWorkspace: Record<string, string> = {
  "inbox/tasks.md": [
    "- [ ] try pino vs slog for structured logs",
    "- [ ] read postgres 16 release notes",
    "- [ ] renew TLS certificate for staging",
    "",
  ].join("\n"),
  "inbox/reading-list.md": "# Reading list\n\nArticles and talks to get to.\n",
  "api-payments/tasks.md": [
    "- [ ] check timeouts on /checkout #bug",
    "- [ ] add idempotency keys to refunds",
    "- [ ] rotate DB credentials #security",
    "- [ ] update runbook",
    "- [x] configure CI",
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
