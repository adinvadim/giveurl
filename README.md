# giveurl

Turn a local file, directory, or service into a URL with zero configuration.

```console
$ npx giveurl ./report.html
https://laptop.example.ts.net/giveurl/20260802T154500Z-a1b2c3d4e5f60708/artifact.html
```

`giveurl` inspects providers already installed and authenticated on the current machine. Tailscale works today; GitHub Gists and Cloudflare are visible in discovery and fit behind the same provider interface as future transports.

## Why

Agents and their harnesses often run on different machines. A screenshot, Markdown handoff, HTML lesson, or localhost preview should cross that boundary without choosing ports, editing configuration, or uploading private material to an arbitrary third party.

With Tailscale, each share gets a unique HTTPS route on the source machine. Files and directories are served from an OS-assigned loopback port behind Tailscale Serve, so concurrent machines and agents do not contend for ports. Access remains governed by the tailnet and its ACLs.

## Requirements

- Node.js 20 or newer
- Tailscale installed, signed in, and running
- MagicDNS and HTTPS available for the tailnet

No runtime npm dependencies are installed.

## Usage

Share a file, a directory with relative assets, or a localhost service:

```bash
npx giveurl screenshot.png
npx giveurl ./lesson
npx giveurl http://127.0.0.1:3000
npx giveurl 3000
```

The URL is the only value written to stdout. Human diagnostics and the cleanup command go to stderr, so command substitution stays clean:

```bash
url="$(npx giveurl -- ./report.md)"
curl -fL "$url"
```

For agents and scripts, use stable JSON:

```bash
npx giveurl ./report.md --json
npx giveurl providers --json
npx giveurl status --json
```

Preview a change without creating a server or Tailscale route:

```bash
npx giveurl ./site --dry-run
```

Shares remain available while the source machine and local backend are running. Remove only the route created for a particular URL:

```bash
npx giveurl stop https://laptop.example.ts.net/giveurl/ID/artifact.html
```

## Provider discovery

```console
$ npx giveurl providers
PROVIDER         INSTALLED  AUTHENTICATED  SUPPORT  DETAIL
Tailscale        yes        yes            ready    laptop.example.ts.net
GitHub Gists     yes        yes            planned  authenticated; provider planned
Cloudflare       no         no             planned  not installed
```

Provider selection defaults to `auto`. The provider name can be pinned for reproducible automation:

```bash
npx giveurl ./report.html --provider tailscale
```

Current provider status:

| Provider | Discovery | Publishing |
| --- | --- | --- |
| Tailscale | `tailscale status --json` | Supported |
| GitHub Gists | `gh auth status` | Planned |
| Cloudflare | `wrangler whoami` | Planned |

## Security and lifetime

`giveurl` does not make Tailscale shares public to the internet. Any tailnet peer permitted by your Tailscale policy may be able to read the shared route, so publish the narrowest useful file or directory. Filesystem shares start a detached loopback server and persist across terminal sessions until `giveurl stop` is run or the source machine restarts.

Existing Tailscale Serve handlers are preserved. Cleanup turns off the exact `/giveurl/<id>` route and its matching loopback process rather than resetting the machine's Serve configuration.

## Agent skill

The small skill in [`skills/share/SKILL.md`](skills/share/SKILL.md) teaches an agent when to publish, verify, consume, and stop a share. Install or link it using the skill mechanism supported by your agent harness.

## Development

```bash
npm test
npm pack --dry-run
npm run smoke:tailscale -- --receiver root@runner
# Or use regular SSH over a Tailscale IP:
npm run smoke:tailscale -- --receiver-ssh mini@100.64.0.1 --identity ~/.ssh/id_ed25519
# If the receiver intentionally has MagicDNS disabled:
npm run smoke:tailscale -- --receiver root@runner --resolve-source
```

The live smoke test publishes every supported MIME type, directories, concurrent shares, HTTP ports, localhost URLs, and an `https+insecure` service. With `--receiver`, every artifact is fetched from another tailnet machine over Tailscale SSH; `--receiver-ssh` supports regular SSH over a Tailscale IP. It also verifies exact bytes, content types, Range requests, nested-route cleanup, and restoration of the previous Serve configuration. `--resolve-source` preserves TLS hostname validation while routing directly to the source Tailscale IP, which is useful only when the receiver has MagicDNS intentionally disabled.

The CLI uses only Node.js built-ins. Provider-specific behavior lives under `src/providers/` so new transports do not complicate the default command.
