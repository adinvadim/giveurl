---
name: giveurl
description: "Share or retrieve an artifact, preview, or handoff across machines."
---

# Giveurl

For a local file, directory, or localhost service that must open on another machine:

```bash
npx --yes giveurl <target> --json
```

Return or consume `url` from stdout. Verify the intended resource responds with `curl -fsSL --range 0-0 -o /dev/null <url>` before continuing the calling task.

Share a single file for exact bytes. Share the narrowest containing directory when HTML or Markdown depends on relative assets, then append the artifact's relative path to the directory URL.

Tailscale shares require the source machine online; GitHub Gists remain hosted. When finished, run `npx --yes giveurl stop <url>` from the Tailscale source machine or the Gist creator's GitHub account. Use `npx --yes giveurl status --json` to inspect these shares.

## Public temporary Vercel deployment

When a public link must work after the source machine disconnects, select Vercel explicitly:

```bash
npx --yes giveurl <file-or-directory> --provider vercel --json
```

Requires a current Vercel CLI with `vercel deploy --temporary` support and a giveurl build whose `--help` lists `vercel`. Until that build is published to npm, invoke `node <updated-giveurl-checkout>/bin/giveurl.js` instead of `npx --yes giveurl`. Inspect installed tools first; use `npm install -g vercel` if Vercel CLI is missing. No Vercel login is needed. Localhost services use Tailscale; Vercel publishes files or builds a directory. Build commands run locally.

Use the returned `url`; retain `expiresAt` (Unix milliseconds) and keep `claimUrl` private for the owner. Claiming transfers the deployment to their Vercel account so they can keep or manage it. The public URL expires at the returned time; do not promise a fixed lifetime. Temporary Vercel shares have `stopCommand: null`: anonymous listing and early deletion through giveurl are unsupported. Claim to manage earlier, or let the deployment expire.

Publish only material intended for public access. Giveurl stages a copy, excludes `.env*`, local credentials, `.git`, `.vercel`, and `node_modules`, rejects nested symlinks, and isolates Vercel login/project state. Vercel can refuse anonymous creation; report that error and use another authorized provider. The old claimable-deploy HTTP endpoints are retired.
