---
name: giveurl
description: "Share or retrieve an artifact, preview, or handoff across machines."
---

# Giveurl

When a local file, directory, or localhost service must be opened on another machine, run:

```bash
npx --yes giveurl <target> --json
```

Return or consume the `url` from stdout. Verify the intended resource responds with `curl -fsSL --range 0-0 -o /dev/null <url>` before continuing the calling task.

Share a single file for exact bytes. Share the narrowest containing directory when HTML or Markdown depends on relative assets, then append the artifact's relative path to the returned directory URL. This composes with screenshot, teach, and handoff workflows.

Tailscale shares require the source machine to remain online; GitHub Gist shares remain hosted after it goes offline. When the consumer is finished, run `npx --yes giveurl stop <url>` from the Tailscale source machine or the GitHub account that created the Gist. Use `npx --yes giveurl status --json` to inspect active shares.
