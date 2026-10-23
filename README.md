# giveurl

Turn a local file, directory, or service into a URL with zero configuration.

```console
$ npx giveurl ./report.html
https://laptop.example.ts.net/giveurl/20260802T154500Z-a1b2c3d4e5f60708/artifact.html
```

`giveurl` inspects providers already installed on the current machine. Tailscale and GitHub Gists use existing authentication. Vercel offers public temporary deployments without login when explicitly selected. Cloudflare remains visible in discovery for a future transport.

## Why

Agents and their harnesses often run on different machines. A screenshot, Markdown handoff, HTML lesson, or localhost preview should cross that boundary without choosing ports, editing configuration, or uploading private material to an arbitrary third party.

With Tailscale, each share gets a unique HTTPS route on the source machine. Files and directories are served from an OS-assigned loopback port behind Tailscale Serve, so concurrent machines and agents do not contend for ports. Access remains governed by the tailnet and its ACLs.

## Requirements

- Node.js 20 or newer
- At least one ready provider:
  - Tailscale installed, signed in, and running with MagicDNS and HTTPS available
  - GitHub CLI installed and authenticated to `github.com` with the `gist` scope
  - A current Vercel CLI with `deploy --temporary` support (no login required; choose `--provider vercel`)

No runtime npm dependencies are installed. Standard `gh auth login` authentication includes the Gist scope.

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

Preview a change without publishing:

```bash
npx giveurl ./site --dry-run
```

Tailscale shares remain available while the source machine and local backend are running; GitHub Gists remain hosted until deleted. Stop a Tailscale or GitHub share represented by a particular URL:

```bash
npx giveurl stop https://laptop.example.ts.net/giveurl/ID/artifact.html
```

## Provider discovery

```console
$ npx giveurl providers
PROVIDER         INSTALLED  AUTHENTICATED  SUPPORT  DETAIL
Tailscale        yes        yes            ready    laptop.example.ts.net
GitHub Gists     yes        yes            ready    authenticated; UTF-8 text files ready
Cloudflare       no         no             planned  not installed
```

Provider selection defaults to `auto`, preferring Tailscale when it is ready and falling back to GitHub for compatible files. Vercel is selected explicitly because its deployments are public. The provider name can be pinned for reproducible automation:

```bash
npx giveurl ./report.html --provider tailscale
npx giveurl ./report.md --provider github
npx giveurl ./site --provider vercel
```

Current provider status:

| Provider | Discovery | Publishing |
| --- | --- | --- |
| Tailscale | `tailscale status --json` | Files, directories, and localhost services |
| GitHub Gists | `gh auth status` | UTF-8 text files up to 10 MB |
| Vercel temporary | `vercel deploy --help` | Files and directories, public, without login; explicit selection |
| Cloudflare | `wrangler whoami` | Planned |

## GitHub Gists

The GitHub provider creates a secret Gist and prints the direct raw file URL rather than the Gist HTML page:

```bash
npx giveurl ./report.md --provider github
```

GitHub Gists support one UTF-8 text file per share. Use Tailscale or Vercel for binary files and directories, and Tailscale for localhost services. `giveurl status` recognizes only Gists carrying its internal description marker, and `giveurl stop <url>` verifies the account, marker, and unmodified page or raw URL before deleting the Gist.

## Vercel temporary deployments

Install a current [Vercel CLI](https://vercel.com/docs/cli) that supports `deploy --temporary` (verified with 65.2.0), then publish:

```bash
npm install -g vercel
npx giveurl ./site --provider vercel --json
npx giveurl ./report.html --provider vercel --dry-run --json
```

This runs `vercel deploy --temporary --yes --json --non-interactive` on a disposable copy, with isolated global configuration and Vercel credential/project environment variables removed. It creates a new anonymous project even when your normal CLI is logged in or your source directory is linked to Vercel. A single HTML file becomes `index.html`; other single files retain exact bytes under an `artifact` filename. Directories retain their relative paths. Localhost services are unsupported. Projects with a build are built locally by Vercel CLI; their build commands run on the source machine.

The copy excludes `.env*`, `.npmrc`, `.yarnrc.yml`, `.ssh`, `.aws`, `.git`, `.vercel`, and `node_modules` at every depth; symlinks and special files are rejected. Publish only a narrow directory containing material intended for public access. The source directory and its existing provider links remain untouched; staging files and anonymous CLI credentials are removed after the attempt.

JSON retains the usual `url`, `provider`, `kind`, and `target` fields and adds `temporary: true`, `visibility: "public"`, `previewUrl`, `claimUrl`, and `expiresAt` (Unix milliseconds). The share stays online after the source computer disconnects and expires at the time returned by Vercel. Keep `claimUrl` private: it lets you transfer the project to your Vercel account and keep or manage it. Human output prints only the artifact URL to stdout; expiry and claim instructions go to stderr.

Anonymous deployments have no supported listing or early deletion through giveurl. `status --provider vercel` and `stop <vercel-url>` return `PROVIDER_UNSUPPORTED_ACTION`; automatic status continues to list Tailscale/Gist shares. `stopCommand` is `null`. Claim the project to manage it earlier, or let it expire. No fixed lifetime is assumed.

Vercel may reject anonymous creation based on availability or eligibility. Giveurl reports the failure and stops the CLI's login fallback instead of waiting for authorization or switching to a deployment in your account. The retired claimable-deploy HTTP endpoints are not used.

Local provider tests cover the temporary-deploy JSON contract, credential isolation, upload exclusions, exact bytes, dry runs, cleanup, and CLI routing. Live verification on 2026-10-23 reached Vercel's anonymous-project endpoint with CLI 65.2.0, which returned HTTP 403; a successful public deployment remains unverified from this environment.

## Security and lifetime

`giveurl` does not make Tailscale shares public to the internet. Any tailnet peer permitted by your Tailscale policy may be able to read the shared route, so publish the narrowest useful file or directory. Filesystem shares start a detached loopback server and persist across terminal sessions until `giveurl stop` is run or the source machine restarts.

A secret GitHub Gist is unlisted, not private: anyone who receives its URL can read it. GitHub hosts the file after the source machine goes offline, and the share remains available until `giveurl stop` deletes the Gist or it is deleted through GitHub.

Existing Tailscale Serve handlers are preserved. Cleanup turns off the exact `/giveurl/<id>` route and its matching loopback process rather than resetting the machine's Serve configuration. GitHub cleanup deletes only a Gist that belongs to the authenticated account and carries the `giveurl` marker.

## Agent skill

The small `giveurl` skill in [`skills/giveurl/SKILL.md`](skills/giveurl/SKILL.md) teaches an agent when to publish, verify, consume, and stop a share. Install or link it using the skill mechanism supported by your agent harness.

Install it globally with the [Skills CLI](https://www.skills.sh/docs):

```bash
npx skills add https://github.com/adinvadim/giveurl --skill giveurl -g
```

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
