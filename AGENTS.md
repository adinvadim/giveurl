# Project instructions

- Keep the default path configless: inspect locally installed and authenticated providers before asking for setup.
- Keep runtime dependencies at zero unless a dependency materially deepens the provider interface.
- Providers own detection, publishing, status, and cleanup; shared CLI code owns parsing and output contracts.
- Print the resulting URL to stdout and diagnostics to stderr. Preserve stable `--json` output.
- Add tests for provider routing, path safety, lifecycle cleanup, and user-visible CLI behavior.
- Update `README.md` and `CHANGELOG.md` for user-visible changes.
