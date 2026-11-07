# Third-party notices

No project-wide license is designated. No ownership of the entire codebase is claimed. The licenses below apply to the respective third-party components, not to the project as a whole.

## QR encoder: Project Nayuki — MIT
Embedded makeQrSvg has strong structural correspondence with Nayuki: raw-module formula, Reed–Solomon divisor/remainder, short-block interleaving and tables. Historical derivation is unverified. Full upstream notice is conservatively retained inside the standalone JS and [NAYUKI_LICENSE.txt](NAYUKI_LICENSE.txt).
https://github.com/nayuki/QR-Code-generator/blob/master/typescript-javascript/qrcodegen.ts

## Google Fonts: SIL OFL 1.1
- Orbitron: Copyright 2018 The Orbitron Project Authors; reserved name Orbitron. [License](Orbitron-OFL.txt). https://github.com/google/fonts/tree/main/ofl/orbitron
- Rajdhani: Copyright (c) 2014 Indian Type Foundry. [License](Rajdhani-OFL.txt). https://github.com/google/fonts/tree/main/ofl/rajdhani
- JetBrains Mono: Copyright 2020 The JetBrains Mono Project Authors. [License](JetBrainsMono-OFL.txt). https://github.com/google/fonts/tree/main/ofl/jetbrainsmono
Font binaries load through Google Fonts, not bundled. Upstream license texts retrieved 2026-11-07. Google receives font requests.

## Services, not bundled source
Cloudflare Workers/KV/D1/R2/Turnstile/DoH, ipify, ipwho.is, GitHub, Telegram, Discord and ntfy have separate service terms. Node imports are built-ins, not vendored source. Sing-box, Xray, V2Ray, Mihomo and AmneziaWG are output targets, not bundled binaries. No endorsement implied. User-uploaded media/scripts/templates require their own permissions. Test tooling is not bundled.

See [audit limitations](LICENSE_AUDIT.md).
