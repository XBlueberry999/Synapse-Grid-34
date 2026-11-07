# Synapse Grid 34 — Tools guide

[English](TOOLS.md) · [Indonesia](TOOLS.id.md)

Log in, open /tools, select a tool and expand How to use & safety. Use modern browsers and HTTPS. Browser-local processing does not mean offline: fonts can load externally. Examples are not real credentials. Test only authorized systems.

## CIDR Calculator

`/tools/cidr`

IPv4/IPv6: network, netmask, hosts, subnet split, membership check. Browser-only.

Enter 192.168.1.10/24 and Calculate: network 192.168.1.0/24. Split with prefix 26 for four subnets. Check membership of 192.168.1.20. This calculates addresses, not reachability.

## Epoch Converter

`/tools/epoch`

Epoch seconds/ms/micro/nano to date and back, time zones, relative time. Browser-only.

Convert 0 seconds: 1970-01-01 UTC. Select units and timezone before conversion; milliseconds are not seconds.

## JSON Formatter

`/tools/json`

Format, minify, validate (with line/column errors), sort keys; big numbers are not rounded. Browser-only.

Paste {"b":2,"a":1}, format/minify/sort, then copy. Fix reported error positions. Large numeric literals are preserved; this is not schema validation.

## Cron Parser

`/tools/cron`

Validate Cloudflare-style 5-field cron (L, W, #, 1=Sunday) and compute upcoming runs in UTC. Browser-only.

Enter */5 * * * * and preview upcoming UTC runs. Five-field Cloudflare syntax: 1=Sunday. This does not install a Cron Trigger.

## Regex Tester

`/tools/regex`

Test JavaScript regex: matches, groups (including named), flags and replacement. Browser-only; input size is capped.

Pattern (hello), flag g, text hello world hello: run and inspect matches/groups; optionally replace. JavaScript syntax; complex patterns may freeze a browser.

## curl Command Builder

`/tools/curl`

Build a curl command (or fetch code) from a form, or load an existing curl command into the form. Browser-only; POSIX quoting.

Choose GET, https://example.com, and optional headers. Generate curl/fetch, inspect and copy. Generation sends no request. POSIX quoting is not PowerShell. Never share Authorization values.

## SSH Config Builder

`/tools/ssh-config`

Build a Host block for ~/.ssh/config: HostName, User, Port, key, ProxyJump, port forwards, keepalive. Browser-only; no free-text field.

Set alias demo, HostName example.com, User deploy, Port 22 and key path. Generate, review and add to ~/.ssh/config. ProxyJump/forwarding are optional. No connection is made.

## Tunnel Builder

`/tools/tunnel`

Build an ssh -N command with port forwards (-L/-R/-D) or a Cloudflare Tunnel ingress config.yml. Text output only; browser-only; POSIX quoting.

Select SSH or Cloudflare mode, fill host/forward or tunnel/ingress fields, generate and inspect. Install/authorize the actual SSH or cloudflared client separately. Text generation does not activate a tunnel.

## Export MD/TXT

`/tools/export`

Convert export JSON to MD/TXT in browser; no KV reads.

Export dashboard JSON first, paste it, select MD/TXT and convert. Inspect private fields before sharing. No direct KV reads; formatted text is not a restore backup.

## String & Data Converter

`/tools/converter`

Base64, URL, MD5, SHA-256, JWT inspector. Browser-local.

Encode hello as Base64: aGVsbG8=. Decode to reverse. Select URL/hash/JWT modes separately. JWT inspection does not verify signatures; MD5 is not password security; Base64 is not encryption.

## Key & UUID Generator

`/tools/keygen`

UUID v4, random secrets, native X25519 keypairs. Browser-local.

Select UUID, random secret or X25519 and generate. Save privately; share public keys only. X25519 requires browser support. Web Crypto needs HTTPS/trusted localhost.

## Modern Protocol Formatter

`/tools/modern`

TCP/WS/gRPC + TLS or TCP/REALITY profiles to Sing-box, Clash/Meta, V2Ray/Xray fragments, legacy AWG, links/subscription and QR.

Load the built-in TLS/AWG example, replace placeholders, choose target and generate. Validate in the target client: output is a fragment, not full configuration. REALITY is VLESS TCP/Xray; Clash VLESS needs Meta/Mihomo. AWG is legacy, not 2.x. QR can contain credentials.

## Network Diagnostics

`/tools/netdiag`

DNS via 1.1.1.1 DoH (A/AAAA/CNAME/TXT/MX/NS), IP/ASN connection info, HTTPS security header audit. No raw sockets.

Query example.com type A, load connection info or audit https://example.com. External services receive requests. IP may be server egress, not your device. Header audit does not expose certificate issuer/expiry.

## Encrypted Secret Share

`/tools/paste`

Browser AES-GCM, key in #fragment, TTL 1h-7d, optional read-once (best-effort on KV). 1 KV write per secret created.

Enter a test secret, choose 1-hour TTL, optionally read-once, then create. Retain the full link including #fragment: it carries the decryption key. Max 32 KB. KV read-once is best-effort under concurrent reads; anyone with the link can decrypt.

## Webhook Gateway

`/tools/gateway`

Signed inbound and authenticated outbound webhook gateway

Load configuration JSON and preserve its schema; set inbound secret and up to four destination objects using page examples. Save and send a test event to POST /api/v1/webhook/ingest. GitHub: X-Hub-Signature-256; generic/Kuma/Alertmanager: Bearer. Verify destination delivery. GitHub outbound uses repository_dispatch/Contents:write. No automatic retry/dedup; avoid loops. Server secrets are not encrypted by this app.

## Provisioning Host

`/tools/provision`

Public SSH keys and setup.sh; disabled by default

Paste SSH public keys and an optional reviewed setup.sh, enable Publish and save. Verify displayed public endpoints. Never publish private keys/tokens. Download and inspect scripts before running on your VPS. Server serves text only.

## Code Vault

`/tools/vault`

Public templates and private AES-GCM

Enter title, language and code; choose public template or private encrypted mode. For private mode choose a strong master password. Save a new version and retain ID/password; load by ID. Clear sensitive data afterward. Title/language are plaintext. Versions have no automatic expiry; lost passwords cannot be recovered.

## Access Control

`/tools/access`

Read-only tokens and admin IP allowlist

Set token lifetime, create and save token plus revocation ID. Token reads /api/v1/public/data only, not admin; public data can already be anonymous. Revoke by ID; KV propagation may lag. Admin allowlist is a JSON IP/CIDR array including your current IP; [] disables. Prepare recovery before saving: dynamic IP changes may lock you out.

## Monthly Uptime

`/tools/uptime`

Monthly observed ping sample percentage, opt-in; not time-weighted SLA.

Enable recording for up to ten HTTPS hosts. Worker needs separate */5 * * * * Cron Trigger; Node timer is automatic. Select UTC month and read. Five-minute batches estimate 288 writes/day before other use. Missing samples are unknown; percentage is sampled uptime, not SLA. Concurrent KV updates are not atomic.

## TCP Probe

`/tools/tcp`

Admin, Node/VPS; TCP connect only, not UDP.

On Node/VPS enter an authorized public host and port, e.g. example.com:443, then test. Success proves TCP connection, not application health. No UDP/WireGuard or payload; private/reserved targets blocked. Not supported on Worker.
