# Changelog

## Unreleased

## 0.2.0 - 2026-08-02

- Normalize the npm executable path after the 0.1.0 release.
- Document global `giveurl` skill installation through the Skills CLI.
- Add GitHub CLI publishing for secret Gists with direct raw URLs, provider fallback, status discovery, and guarded cleanup.

## 0.1.0 - 2026-08-02

- Add zero-config sharing for files, directories, and localhost services through Tailscale Serve.
- Detect locally available Tailscale, GitHub CLI, and Wrangler providers.
- Add stable JSON output, dry-run previews, status inspection, and exact-route cleanup.
- Add a cross-machine Tailscale smoke suite covering every supported MIME type, directories, concurrent routes, and localhost services.
- Rename the bundled agent skill from `share` to `giveurl`.
