# Synapse Grid 34 — Panduan tools

[English](TOOLS.md) · [Indonesia](TOOLS.id.md)

Login, buka /tools, pilih alat lalu buka Cara pakai & keamanan. Gunakan browser modern dan HTTPS. Pemrosesan lokal bukan berarti offline: font eksternal dapat dimuat. Contoh bukan kredensial asli. Uji hanya sistem berizin.

## Kalkulator CIDR

`/tools/cidr`

IPv4/IPv6: jaringan, netmask, host, pecah subnet, cek keanggotaan. Murni di browser.

Isi 192.168.1.10/24 lalu Hitung: jaringan 192.168.1.0/24. Pecah prefix 26 menjadi empat subnet. Cek anggota 192.168.1.20. Ini hitungan alamat, bukan uji koneksi.

## Konverter Epoch

`/tools/epoch`

Epoch detik/ms/mikro/nano ke tanggal dan sebaliknya, zona waktu, waktu relatif. Murni di browser.

Konversi 0 detik: 1970-01-01 UTC. Pilih satuan dan zona waktu; milidetik bukan detik.

## Formatter JSON

`/tools/json`

Rapikan, padatkan, validasi (dengan baris/kolom error), urutkan kunci; angka besar tidak dibulatkan. Murni di browser.

Tempel {"b":2,"a":1}, rapikan/padatkan/urutkan lalu salin. Perbaiki posisi error. Angka besar dipertahankan; bukan validasi skema.

## Parser Cron

`/tools/cron`

Validasi cron 5 field gaya Cloudflare (L, W, #, 1=Minggu) dan hitung jadwal berikutnya dalam UTC. Murni di browser.

Isi */5 * * * * lalu lihat jadwal UTC. Sintaks lima field Cloudflare: 1=Minggu. Ini tidak memasang Cron Trigger.

## Penguji Regex

`/tools/regex`

Uji regex JavaScript: kecocokan, grup (termasuk bernama), flag, dan penggantian. Murni di browser; ada batas ukuran input.

Pola (hello), flag g, teks hello world hello: jalankan dan periksa grup; bisa ganti teks. Sintaks JavaScript; pola kompleks dapat membebani browser.

## Pembuat Perintah curl

`/tools/curl`

Susun perintah curl (atau kode fetch) dari formulir, atau muat perintah curl yang sudah ada ke formulir. Murni di browser; kutip gaya POSIX.

Pilih GET, https://example.com dan header opsional. Buat curl/fetch, periksa dan salin. Generator tidak mengirim request. Kutip POSIX bukan PowerShell. Jangan bagikan Authorization.

## Pembuat SSH Config

`/tools/ssh-config`

Susun blok Host untuk ~/.ssh/config: HostName, User, Port, kunci, ProxyJump, forward port, keepalive. Murni di browser; tanpa kolom teks bebas.

Isi alias demo, HostName example.com, User deploy, Port 22 dan lokasi kunci. Buat, periksa lalu tambah ke ~/.ssh/config. ProxyJump/forward opsional. Tidak membuat koneksi.

## Pembuat Tunnel

`/tools/tunnel`

Susun perintah ssh -N dengan forward port (-L/-R/-D) atau config.yml ingress Cloudflare Tunnel. Hanya menghasilkan teks; murni di browser; kutip gaya POSIX.

Pilih SSH atau Cloudflare, isi host/forward atau tunnel/ingress, buat lalu periksa. Instal/otorisasi SSH atau cloudflared terpisah. Teks hasil tidak mengaktifkan tunnel.

## Export MD/TXT

`/tools/export`

Konversi JSON ekspor menjadi dokumen MD/TXT di browser; tanpa membaca KV.

Ekspor JSON dashboard, tempel, pilih MD/TXT lalu konversi. Periksa field privat sebelum berbagi. Tidak membaca KV langsung; teks hasil bukan backup restore.

## Konverter Teks & Data

`/tools/converter`

Base64, URL, MD5, SHA-256, JWT inspector. Lokal di browser.

Encode hello ke Base64: aGVsbG8=. Decode untuk membalik. Pilih mode URL/hash/JWT terpisah. JWT tidak memverifikasi tanda tangan; MD5 bukan keamanan sandi; Base64 bukan enkripsi.

## Generator Kunci & UUID

`/tools/keygen`

UUID v4, secret acak, pasangan kunci X25519 native. Lokal di browser.

Pilih UUID, secret acak atau X25519 lalu buat. Simpan aman; bagikan hanya public key. X25519 perlu dukungan browser. Web Crypto perlu HTTPS/localhost tepercaya.

## Formatter Protokol Modern

`/tools/modern`

Profil TCP/WS/gRPC + TLS atau TCP/REALITY ke fragmen Sing-box, Clash/Meta, V2Ray/Xray, AWG legacy, link/subscription dan QR.

Muat contoh TLS/AWG bawaan, ganti placeholder, pilih tujuan lalu buat. Validasi di klien: hasil fragmen, bukan konfigurasi lengkap. REALITY untuk VLESS TCP/Xray; Clash VLESS perlu Meta/Mihomo. AWG legacy bukan 2.x. QR bisa berisi kredensial.

## Diagnostik Jaringan

`/tools/netdiag`

DNS lewat DoH 1.1.1.1 (A/AAAA/CNAME/TXT/MX/NS), info IP/ASN koneksi, audit header keamanan HTTPS. Tanpa socket mentah.

Query example.com tipe A, muat info koneksi atau audit https://example.com. Layanan eksternal menerima request. IP dapat berupa IP server, bukan perangkat. Audit header tidak memberi penerbit/kedaluwarsa sertifikat.

## Secret Share Terenkripsi

`/tools/paste`

AES-GCM di browser, kunci di #fragment, TTL 1 jam-7 hari, opsi sekali-baca (best-effort di KV). 1 tulis KV per secret dibuat.

Isi secret uji, pilih TTL 1 jam, opsi sekali-baca lalu buat. Simpan tautan lengkap termasuk #fragment yang membawa kunci. Maks 32 KB. Sekali-baca KV best-effort jika pembaca bersamaan; pemegang tautan dapat mendekripsi.

## Webhook Gateway

`/tools/gateway`

GitHub, Alertmanager, Kuma → Discord, Telegram, Ntfy, GitHub dispatch

Muat JSON konfigurasi dan pertahankan skema; isi secret masuk dan maksimal empat tujuan sesuai contoh halaman. Simpan lalu kirim event uji ke POST /api/v1/webhook/ingest. GitHub: X-Hub-Signature-256; generic/Kuma/Alertmanager: Bearer. Cek penerimaan. GitHub keluar repository_dispatch/Contents:write. Tanpa retry/deduplikasi otomatis; hindari loop. Secret server tidak dienkripsi aplikasi.

## Provisioning Host

`/tools/provision`

Public SSH keys dan setup.sh; nonaktif secara default

Tempel SSH public key dan setup.sh yang sudah diperiksa, aktifkan Publish lalu simpan. Periksa endpoint publik. Jangan publikasikan private key/token. Unduh dan periksa skrip sebelum menjalankan di VPS. Server hanya menyajikan teks.

## Code Vault

`/tools/vault`

Template publik dan AES-GCM privat

Isi judul, bahasa dan kode; pilih publik atau privat terenkripsi. Mode privat perlu sandi utama kuat. Simpan versi baru dan ID/sandi; muat berdasarkan ID. Bersihkan data sensitif. Judul/bahasa tidak dienkripsi. Versi tanpa kedaluwarsa otomatis; sandi hilang tidak bisa dipulihkan.

## Kontrol Akses

`/tools/access`

Token read-only dan whitelist IP admin

Isi umur token, buat dan simpan token serta ID pencabutan. Token hanya membaca /api/v1/public/data, bukan admin; data publik bisa anonim. Cabut berdasarkan ID; KV bisa terlambat. Allowlist admin berupa array JSON IP/CIDR termasuk IP saat ini; [] menonaktifkan. Siapkan pemulihan: IP dinamis bisa mengunci akses.

## Uptime Bulanan

`/tools/uptime`

Persentase sampel ping bulanan, opt-in; bukan SLA berbasis waktu.

Aktifkan pencatatan maksimal sepuluh host HTTPS. Worker perlu Cron Trigger */5 * * * * terpisah; timer Node otomatis. Pilih bulan UTC lalu baca. Batch lima menit diperkirakan 288 tulis/hari sebelum penggunaan lain. Sampel hilang tidak diketahui; persentase bukan SLA. Update KV bersamaan tidak atomik.

## TCP Probe

`/tools/tcp`

Admin, Node/VPS; TCP connect saja, bukan UDP.

Di Node/VPS isi host publik berizin dan port, misalnya example.com:443 lalu uji. Sukses hanya koneksi TCP, bukan kesehatan aplikasi. Tanpa UDP/WireGuard/payload; target privat/cadangan diblokir. Tidak didukung Worker.
