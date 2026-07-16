# GAJAH MAS 2026 - Backend API

Backend Express + PostgreSQL untuk dashboard GAJAH MAS 2026
(dashboard-kerja.html, dashboard-laporan.html, dashboard-data.html).

## Cara deploy ke Railway (project `GMdashboardv01` yang sudah ada)

1. **Push isi folder ini ke repo GitHub `GMdashboardv01`** (menggantikan
   file HTML yang sebelumnya ter-upload). Struktur file di root repo:
   ```
   server.js
   package.json
   .gitignore
   README.md
   (.env TIDAK usah di-push, itu cuma contoh untuk lokal)
   ```

2. **Tambah PostgreSQL di Railway:**
   - Di project Railway kamu (`courageous-trust` / `production`), klik **+ New**.
   - Pilih **Database -> Add PostgreSQL**.
   - Railway otomatis bikin service Postgres baru.

3. **Hubungkan `DATABASE_URL` ke service `GMdashboardv01`:**
   - Buka service `GMdashboardv01` -> tab **Variables**.
   - Klik **New Variable -> Add Reference**.
   - Pilih service Postgres yang baru dibuat, pilih variable `DATABASE_URL`.
   - Railway akan otomatis mengisi env `DATABASE_URL` di service backend ini.

4. **Isi variable lain di tab Variables (service `GMdashboardv01`):**
   ```
   SESSION_SECRET=<string acak panjang, bebas, jangan ditebak orang>
   ALLOWED_ORIGINS=https://graito1618-spec.github.io
   NODE_ENV=production
   ```
   (Kalau frontend-nya juga dibuka dari beberapa domain/lokal, pisahkan
   dengan koma di `ALLOWED_ORIGINS`.)

5. **Redeploy** (Railway biasanya otomatis redeploy begitu ada push baru
   ke GitHub / variable berubah). Tunggu sampai status **ACTIVE / Online**.

6. **Cek domain publiknya** di tab **Settings -> Networking**:
   - Kalau sudah pernah generate domain sebelumnya
     (`gmdashboardv01-production.up.railway.app`), itu akan tetap dipakai.
   - Railway otomatis mendeteksi PORT dari `process.env.PORT`, jadi tidak
     perlu di-set manual (kode di `server.js` sudah pakai `process.env.PORT`).

7. **Test endpoint:**
   - Buka `https://<domain-railway-kamu>/` -> harus muncul JSON
     `{"ok":true,"app":"GAJAH MAS 2026 API", ...}`.
   - Buka `https://<domain-railway-kamu>/api/auth/status` -> harus muncul
     `{"loggedIn":false}` (bukan 404 lagi).

8. **Isi `API_BASE` di 5 file dashboard frontend** (index.html /
   dshboard_utama.html, dashboard-kerja.html, dashboard-laporan.html,
   dashboard-data.html):
   ```js
   const API_BASE = 'https://<domain-railway-kamu>';
   ```
   Commit & push ke repo GitHub Pages-nya, lalu tunggu 1-2 menit.

9. **Aktifkan lagi pengecekan login** di `index.html` /
   `dshboard_utama.html` (saat ini sengaja dinonaktifkan untuk preview):
   cari fungsi `bootstrap()` dan hapus baris `return;` di dalamnya supaya
   overlay login benar-benar jalan.

## Struktur data

Semua tabel (`sales`, `cashIncome`, `printHistory`, `trash`,
`piutangNotes`, `cashNotes`, `cetakTagihanMap`, `inputHarian`,
`pengeluaran`) disimpan generik di 1 tabel Postgres `records`
(`table_name`, `data jsonb`) supaya fleksibel mengikuti bentuk data yang
dikirim frontend, tanpa perlu migrasi skema setiap kali ada field baru.

## Catatan keamanan

- Password di-hash pakai bcrypt, tidak disimpan plain text.
- Session pakai cookie `httpOnly` + `secure` + `SameSite=None` (wajib untuk
  akses cross-domain GitHub Pages -> Railway), disimpan di tabel Postgres
  `session` (dibuat otomatis oleh `connect-pg-simple`).
- Endpoint tabel data (`/api/:table/...`) wajib login (401 kalau belum).
- `ALLOWED_ORIGINS` membatasi domain mana saja yang boleh manggil API ini.
