# Synapse Grid 34

[English](README.md) · [Panduan tools](TOOLS.id.md) · [Audit lisensi](LICENSE_AUDIT.md)

Dashboard monitoring ringan dan toolbox admin yang portable dalam satu file. Tanpa fitur AI dan tanpa dependensi npm runtime. Prioritas Cloudflare Worker + KV; Node.js/file sebagai alternatif.

## Fitur
Dashboard inventaris, kategori dan visibilitas; probe HTTPS dan uptime bulanan opsional; notes/halaman Markdown/media; backup/restore manual; 20 tools yang dikelompokkan menurut fungsi. Tools mencakup CIDR, epoch, JSON, cron, regex, curl, SSH/tunnel, ekspor, konverter, generator kunci, formatter protokol, diagnostik, secret share, gateway webhook, provisioning, vault, akses dan TCP Node. Panduan ID/EN tersedia langsung pada tiap halaman tool.

## Deploy utama: Cloudflare Worker + KV
1. Buat Worker dan namespace KV.
2. Deploy `Synapse Grid 34.js` sebagai **Service Worker syntax** (`addEventListener`), bukan ES-module `export default`. Gunakan editor/alat deploy yang mendukung format tersebut.
3. Binding KV wajib bernama **SERVER_KV**, huruf besar-kecil persis.
4. **Sebelum publik**, isi secret **ADMIN_PASSWORD** yang kuat (minimal 8 karakter), opsional **ADMIN_USER** (default `admin`). Tanpa sandi bootstrap yang sesuai, Worker fallback ke `admin123`; jangan biarkan ini terbuka publik.
5. Deploy, buka HTTPS, login dan periksa pengaturan serta data publik. Variabel bootstrap berlaku untuk penyimpanan baru; menggantinya bukan jaminan reset sandi yang sudah tersimpan.
6. Pertahankan profil Worker/light untuk pemakaian kecil. Pantau kuota/harga terbaru Cloudflare; peringatan aplikasi hanya saran, bukan pembatas tagihan.
7. Uptime opsional: aktifkan di `/tools/uptime`, siapkan maksimal sepuluh host dan Cron Trigger UTC **terpisah** `*/5 * * * *`. Perkiraan 288 tulis batch/hari, belum termasuk operasi lain. Cron backup harus berbeda dari ekspresi lima menit itu.

Binding opsional: **DB** untuk D1 (diprioritaskan dibanding KV jika keduanya ada; tidak memigrasikan data otomatis), **MEDIA_BUCKET** untuk R2 media, **BACKUP_BUCKET** untuk integrasi backup sekaligus fallback bucket media. KV saja cukup untuk penggunaan dasar; D1/R2 bukan wajib. Periksa harga layanan sebelum mengaktifkan.

Contoh `wrangler.toml` (ganti ID namespace):
```toml
name = "synapse-grid-34"
main = "Synapse Grid 34.js"
compatibility_date = "2026-11-07"
[[kv_namespaces]]
binding = "SERVER_KV"
id = "GANTI_ID_NAMESPACE"
```
Gunakan `npx wrangler secret put ADMIN_PASSWORD`, kemudian `npx wrangler deploy` pada akun yang sudah dikonfigurasi. Jangan masukkan sandi ke config/repository. Wrangler hanya alat deployment. Deploy cloud ini belum diuji langsung pada tahap persiapan rilis.

## Node/local/VPS
Gunakan Node LTS yang masih didukung, disarankan Node 22+, dengan API Fetch/Web Crypto. Jalankan di folder khusus tanpa package `type: module`:
```sh
export ADMIN_USER=admin
read -s -p 'Sandi admin: ' ADMIN_PASSWORD; echo
export ADMIN_PASSWORD
export DATA_DIR="$PWD/.data"
export PORT=8787
node "Synapse Grid 34.js"
```
Prompt memakai Bash. Buka `http://localhost:8787`. Server tidak dibatasi listen loopback: lindungi port dengan firewall. Produksi perlu HTTPS/reverse proxy tepercaya. `UPLOAD_DIR` mengubah lokasi media. Tanpa sandi bootstrap, Node membuat sandi di log; lindungi log. Aktifkan `TRUST_PROXY=1` hanya di belakang proxy tepercaya yang aksesnya dibatasi dan menimpa forwarding header. Timer uptime lima menit dan backup harian aktif selama proses hidup; gunakan supervisor bila diperlukan.

## Pemakaian awal dan backup
1. Login dan periksa/ganti kredensial serta pengaturan situs.
2. Tambah item uji dengan host HTTPS berizin. Periksa visibilitas dari jendela logout.
3. Buka `/tools`, pilih kategori/alat, buka **Cara pakai & keamanan**. Lihat [panduan lengkap](TOOLS.id.md).
4. Ekspor backup sebelum upgrade/pindah storage. Simpan aman; jangan commit backup ke GitHub.
5. Restore manual ke instance tujuan lalu periksa jumlah item/pengaturan/akses sebelum menghapus sumber. Jangan menganggap ekspor JSON memuat media R2/disk; backup blob terpisah. Untuk Node, snapshot konsisten DATA_DIR dan UPLOAD_DIR.

## Keamanan dan keterbatasan
- Uji hanya sistem berizin. TCP hanya Node/VPS, bukan UDP atau bukti kesehatan aplikasi.
- Font Google dan layanan diagnostik menerima request; tool browser-local bukan berarti seluruh halaman offline.
- Fragment tautan secret membawa kunci. Sekali-baca KV best-effort; judul/bahasa vault tidak dienkripsi.
- Secret webhook disimpan server tanpa enkripsi tingkat aplikasi; tanpa retry/deduplikasi otomatis.
- Provisioning/template publik memang publik. Jangan unggah private key/token/sandi.
- JWT decode bukan verifikasi; Base64 bukan enkripsi; MD5 bukan hash sandi aman.
- Uptime berbasis sampel, bukan SLA. Audit header belum memberikan detail sertifikat. Output konfigurasi berupa fragmen dan perlu validasi di klien.
- Bukan produk yang sudah diaudit keamanan menyeluruh. Baca [SECURITY.md](SECURITY.md).

## Pemecahan masalah
Storage hilang: periksa SERVER_KV dan environment. Login gagal setelah ubah secret: kredensial tersimpan dapat mengalahkan bootstrap. Crypto/clipboard gagal: gunakan HTTPS/localhost dan browser modern. Uptime kosong: aktifkan pencatatan, host dan cron. Upload tidak tersedia: perlu blob storage. Config klien ditolak: periksa versi/transport dan fragmen vs konfigurasi penuh.

## Lisensi dan kontribusi
Belum ada lisensi proyek yang ditetapkan. Repository ini menyediakan kode sumber untuk ditinjau, tanpa klaim bahwa seluruh kode merupakan karya atau milik pengunggah. Ini bukan pemberian izin umum untuk menggunakan, mengubah, atau mendistribusikan kode. [Credit dan lisensi pihak ketiga](THIRD_PARTY_NOTICES.md) tetap berlaku untuk komponen masing-masing. Sebagian asal-usul kode belum terverifikasi; lihat [catatan pemeriksaan terbatas](LICENSE_AUDIT.md). Tidak adanya lisensi proyek tidak menghapus kewajiban memperoleh izin pihak ketiga.

## Status
Berbasis BATCH44. Nama distribusi Synapse Grid 34; versi internal tetap V40.1 dan judul tersimpan tidak diubah. Lihat [catatan rilis](RELEASE_NOTES.md) serta PREVIOUS_TEST_RESULTS.json. Tes lokal bukan pengganti deploy Cloudflare langsung. Upload GitHub dilakukan sendiri oleh pengunggah.


Catatan pengemasan: nama paket diperbarui menjadi Synapse Grid 34. Hasil di PREVIOUS_TEST_RESULTS.json berasal dari paket sebelumnya; pengujian runtime lengkap tidak diulang untuk perubahan dokumentasi/header ini.

## Panduan di web
Buka /guide melalui footer atau menu Panduan. Tersedia panduan 20 tools, dasar dashboard/CMS/backup serta credit pihak ketiga. Panduan dapat dibaca tanpa login; tools tetap memerlukan login. Lihat TEST_RESULTS.json untuk pemeriksaan revisi ini.
