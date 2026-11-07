# Synapse Grid 34

[Bahasa Indonesia](README.id.md) · [Tools guide](TOOLS.md) · [License audit](LICENSE_AUDIT.md)

A lightweight, portable, single-file monitoring dashboard and administrator toolbox. No AI features and no npm runtime dependencies. Cloudflare Workers + KV is the primary deployment; Node.js with local storage is the alternative.

## Features
- Dashboard inventory, categories, visibility controls, HTTPS probes and optional sampled monthly uptime.
- Notes, Markdown pages and optional media storage.
- 20 categorized tools: CIDR, epoch, JSON, cron, regex, curl, SSH, tunnels, MD/TXT export, encoding/hashes/JWT, key generation, protocol formatting, network diagnostics, encrypted sharing, webhook gateway, provisioning, vault, access and Node TCP probes.
- Indonesian/English interface and per-tool usage/safety instructions.
- Manual backup/restore; optional storage/runtime paths without splitting the application.

## Start with Cloudflare Worker + KV
1. Create a Worker and a KV namespace in your Cloudflare account.
2. This file uses **Service Worker syntax** (`addEventListener`), not an ES-module default export. Deploy `Synapse Grid 34.js` with a compatible Worker editor or Wrangler; do not wrap it in `export default`.
3. Bind the namespace as **SERVER_KV** (exact case).
4. Before exposing the site, set **ADMIN_PASSWORD** as a secret with a strong unique value (at least 8 characters). Optionally set **ADMIN_USER** (default `admin`). Without a suitable Worker bootstrap password, the source falls back to `admin123`: never leave this publicly accessible.
5. Deploy, open the HTTPS URL, log in and review settings/public visibility. Bootstrap credentials initialize a fresh store; changing environment variables is not a guaranteed reset of an existing stored password.
6. Keep the Worker/light profile for small deployments. Add features deliberately; monitor the provider's current quotas and billing. Free-plan limits can change and warnings are advisory, not spending enforcement.
7. For optional monthly uptime, enable recording in `/tools/uptime` and configure a **separate** Cron Trigger `*/5 * * * *` (UTC). Up to ten hosts; approximately 288 batch writes/day plus other writes. Use a distinct cron for optional backup, not the same five-minute expression.

### Optional bindings
| Name | Purpose |
|---|---|
| `DB` | D1 adapter; takes priority over SERVER_KV when both exist. Do not bind casually: this does not migrate data. |
| `MEDIA_BUCKET` | R2 media uploads. |
| `BACKUP_BUCKET` | Backup integration; also a fallback media bucket in the code. |

KV alone is sufficient for the basic deployment. R2/D1 are optional, not prerequisites. Media upload needs blob storage; verify current account pricing before enabling extras.

### Example Wrangler configuration
Create your own `wrangler.toml` (replace the namespace ID; do not commit secrets):
```toml
name = "synapse-grid-34"
main = "Synapse Grid 34.js"
compatibility_date = "2026-11-07"
[[kv_namespaces]]
binding = "SERVER_KV"
id = "REPLACE_WITH_YOUR_NAMESPACE_ID"
```
Then use `npx wrangler secret put ADMIN_PASSWORD` and `npx wrangler deploy` with your configured account. Wrangler is deployment tooling, not an app runtime dependency. This exact cloud deployment was not exercised during release preparation.

## Node.js / local / VPS
Use a currently supported Node LTS with Fetch/Web Crypto APIs (Node 22+ recommended). In a dedicated folder outside an ES-module `type: module` package:
```sh
export ADMIN_USER=admin
read -s -p 'Admin password: ' ADMIN_PASSWORD; echo
export ADMIN_PASSWORD
export DATA_DIR="$PWD/.data"
export PORT=8787
node "Synapse Grid 34.js"
```
The password prompt uses Bash. Open `http://localhost:8787`; use HTTPS at a trusted reverse proxy for production. The server listens without a loopback-only host argument: firewall the port; localhost in the log is not a security boundary. `UPLOAD_DIR` optionally overrides upload storage. Without a configured bootstrap password Node generates one in logs: protect those logs. `TRUST_PROXY=1` is only appropriate behind a trusted, access-restricted proxy that overwrites forwarding headers. Node supplies five-minute uptime and daily backup timers while the process runs; use a process supervisor for persistence.

## First use and backup
1. Log in; change/review credentials and site settings.
2. Add a test dashboard item with an authorized HTTPS host; verify its public/private fields in a logged-out window.
3. Open `/tools`, select a category/tool and expand **How to use & safety**. Full guide: [TOOLS.md](TOOLS.md).
4. Export a backup before changing storage/profile or upgrading. Keep it encrypted/offline; never commit backups to GitHub.
5. Restore manually into the intended instance and verify item counts/settings/access before deleting the original. Do not assume JSON exports include R2/disk media; back up blobs separately. Node: preserve DATA_DIR and UPLOAD_DIR with a consistent snapshot.

## Security, privacy and limits
- Only probe systems you own or have permission to test. TCP is Node/VPS-only and is not UDP or application-health verification.
- Google Fonts and configured network services receive network requests. Browser-local tools do not make the entire site offline.
- Secret-share link fragments carry keys. KV read-once is best-effort, not atomic globally. Vault titles/languages are not encrypted.
- Webhook secrets are stored server-side without app-level encryption at rest. No automatic delivery retry/deduplication.
- Provisioned keys/scripts and public templates are public. Never publish private keys, passwords or tokens there.
- JWT decoding is not verification; Base64 is not encryption; MD5 is not safe password hashing.
- Uptime is sampled, not a time-weighted SLA. Header audit does not provide certificate details. Generated client configs are fragments; validate with the target client/version.
- This is not an audited security product. See [SECURITY.md](SECURITY.md).

## Troubleshooting
- Missing storage: verify exact SERVER_KV binding and deployment environment.
- Login fails after changing environment: existing stored credentials can override bootstrap values; use the established account/settings or a verified recovery backup.
- Crypto/clipboard fails: use HTTPS or trusted localhost and a modern browser.
- Uptime empty: enable recording, eligible hosts and separate UTC cron; absent samples are unknown.
- Upload unavailable: configure blob storage or use supported image URLs.
- Configuration rejected by a client: confirm target version, supported transport and full-config vs fragment requirements.

## License and contribution
No project-wide license has been designated. This repository provides source code for review, without claiming that the uploader authored or owns the entire codebase. This is not a general grant of permission to use, modify, or redistribute the code. [Third-party credits and licenses](THIRD_PARTY_NOTICES.md) remain applicable to their respective components. Some provenance remains unverified; see the [limited review notes](LICENSE_AUDIT.md). Absence of a project license does not remove third-party permission requirements.

## Release status
Based on BATCH44. Distribution name: Synapse Grid 34; the internal app version remains V40.1 and existing stored titles are unchanged. See [release notes](RELEASE_NOTES.md) and `PREVIOUS_TEST_RESULTS.json`. Local checks are not proof of live Cloudflare deployment. Upload is performed by the maintainer, not by this package.


Packaging note: renamed to Synapse Grid 34. PREVIOUS_TEST_RESULTS.json records prior-package checks; the full runtime suite was not rerun for this documentation/header-only revision.

## In-web guide
Open /guide through the footer or Guide menu. Covers 20 tools, dashboard/CMS/backup basics and third-party credits. The guide is public; tools still require login. See TEST_RESULTS.json for revision checks.
