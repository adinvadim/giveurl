# Changelog

## Unreleased

- Normalize the npm executable path after the 0.1.0 release and prepare 0.1.1.
- Document global `giveurl` skill installation through the Skills CLI.

## 0.1.0 - 2026-08-02

- Add zero-config sharing for files, directories, and localhost services through Tailscale Serve.
- Detect locally available Tailscale, GitHub CLI, and Wrangler providers.
- Add stable JSON output, dry-run previews, status inspection, and exact-route cleanup.
- Add a cross-machine Tailscale smoke suite covering every supported MIME type, directories, concurrent routes, and localhost services.
- Rename the bundled agent skill from `share` to `giveurl`.
