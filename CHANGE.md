# CHANGE.md — Perubahan dari StreamFlow Asli

Dokumen ini merangkum semua perubahan fork ini dibanding [streamflow asli (bangtutorial/streamflow)](https://github.com/bangtutorial/streamflow), baseline commit `9dc36f0`.

**Total: 23 file — 19 diedit, 4 file baru (+1405 / −1126 baris).**

| File | Status | Ringkasan |
|---|---|---|
| `app.js` | diedit | CSRF, cascade delete stream/history/thumbnail, thumbnail original 2MB, parsing schedule, `sameSite`, hapus route donators, route hapus semua history |
| `db/database.js` | diedit | Tambah index `idx_stream_history_stream_id` |
| `middleware/uploadMiddleware.js` | diedit | Tambah `uploadStreamThumbnail` (limit 2MB) + `defParamCharset: 'utf8'` di semua instance multer |
| `models/Stream.js` | diedit | Stream yang sudah selesai di-hide dari list dashboard |
| `package.json` | diedit | multer 1.x → 2.4.0, blok `allowScripts` npm |
| `public/js/csrf.js` | **baru** | Injector header CSRF global (fetch + XMLHttpRequest) |
| `public/js/custom-dialog.js` | **baru** | Dialog konfirmasi/prompt in-app shared (pengganti dialog bawaan browser) |
| `public/js/schedule-picker.js` | **baru** | Komponen schedule picker kustom (kalender + slot waktu) |
| `public/js/stream-modal.js` | diedit | Revive tombol submit saat modal dibuka ulang |
| `public/sw.js` | diedit | Static resources jadi network-first, precache + csrf.js + custom-dialog.js, versi cache 1.2.0 |
| `scripts/cleanup-orphan-thumbnails.js` | **baru** | Sweep file thumbnail yatim (dry-run default) |
| `services/youtubeService.js` | diedit | MIME type thumbnail mengikuti ekstensi file |
| `utils/storage.js` | diedit | Tambah helper `deleteLocalUpload` |
| `utils/videoProcessor.js` | diedit | `generateImageThumbnail` → `generateRotationThumbnail` |
| `views/dashboard.ejs` | diedit | Schedule picker, char counter, delete utk scheduled, cek 2MB, submit ISO, dialog shared |
| `views/gallery.ejs` | diedit | Definisi dialog duplikat diganti file shared |
| `views/history.ejs` | diedit | Dialog custom + tombol Delete All |
| `views/layout.ejs` | diedit | Meta CSRF + csrf.js + custom-dialog.js, pembersihan UI (notifikasi/donate/footer), avatar pindah ke header |
| `views/playlist.ejs` | diedit | Dialog hapus playlist pakai dialog custom |
| `views/rotations.ejs` | diedit | Dialog hapus rotation pakai dialog custom |
| `views/settings.ejs` | diedit | 4 dialog konfirmasi (reCAPTCHA, logs, disconnect channel) pakai dialog custom |
| `views/users.ejs` | diedit | Modal konfirmasi statis lama diganti dialog shared |
| `views/welcome.ejs` | diedit | Halaman welcome disederhanakan |

---

## Ringkasan Perilaku Baru

1. **Stream yang sudah selesai (offline + ada entri di History) tidak muncul lagi di halaman Streams** — pengelolaannya penuh di halaman History. Live dan scheduled tetap tampil.
2. **Hapus stream dan hapus history sekarang saling terhubung, bersih dua arah:**
   - Hapus stream (dari dashboard) → row stream + SEMUA entri history-nya + file thumbnail terhapus.
   - Hapus entri history → entri + stream-nya (kalau statusnya offline/selesai) + thumbnail terhapus. Stream yang live/scheduled tidak bisa terpurge lewat jalur ini.
3. **Semua request mutasi ke `/api` wajib bawa CSRF token** (header `X-CSRF-Token`, disuntik otomatis oleh `public/js/csrf.js`).
4. **Thumbnail stream disimpan sebagai file original tanpa resize** (YouTube butuh ≥1280×720), dibatasi 2MB, dan file lamanya ikut terhapus saat diganti/dihapus.
5. **Form YouTube (create & edit) pakai schedule picker baru** — submit dalam format ISO absolut sehingga timezone-safe, dan tombol delete/edit aktif untuk stream scheduled (dulu disabled).
6. **Semua dialog konfirmasi memakai dialog custom in-app** (`createModalDialog`) — tidak ada lagi dialog bawaan browser (`confirm()`) yang bisa diblokir/langsung tertutup sendiri.
7. **Halaman History punya tombol Delete All** — hapus semua entri sekaligus dalam satu klik (dengan konfirmasi); stream finished yang terikat ikut terhapus beserta thumbnail-nya.

---

## 1. Keamanan

### `app.js` — CSRF protection
- Middleware `csrfProtection` di-mount khusus di scope `/api` (`app.use('/api', csrfProtection)`): semua method selain GET/HEAD/OPTIONS wajib bawa token yang valid (dari header `X-CSRF-Token`, `req.body._csrf`, atau query). Respons ditolak dengan **403 JSON** (dulu: middleware global dengan halaman error HTML, dan malah mengecualikan `/login`).
- Secret CSRF per-session (`req.session.csrfSecret = uuidv4()`), token diekspos ke semua view lewat `res.locals.csrfToken`.
- Halaman form pre-auth (`/login`, `/signup`, `/setup-account`) post di luar scope `/api`, jadi tidak terkena middleware ini.

### `public/js/csrf.js` — **BARU**
- IIFE yang mem-patch `window.fetch` dan `XMLHttpRequest` secara global: semua request same-origin non-GET otomatis dikirim dengan header `X-CSRF-Token` yang dibaca dari `<meta name="csrf-token">`. Tanpa ini, upload video/audio via XHR raw (`/api/videos/upload`, `/api/audio/upload`) tidak akan lolos CSRF.

### `views/layout.ejs`
- Tambah `<meta name="csrf-token">` + `<script src="/js/csrf.js">` di `<head>` (semua halaman yang pakai layout ini otomatis kecover).

### `app.js` — session cookie
- Tambah `sameSite: 'lax'` di config cookie session (eksplisit; dulu mengandalkan default browser).

### `package.json`
- `multer` ^1.4.5-lts.1 → **^2.4.0** (versi 1.x punya beberapa CVE). API kompatibel — `diskStorage`, `.single()`, `.any()`, `limits`, `fileFilter`, dan kode error `LIMIT_FILE_SIZE` tidak berubah perilaku.

---

## 2. Stream Selesai & Penghapusan (Stream Lifecycle)

### `models/Stream.js`
- `findAll()` dan `findAllPaginated()` sekarang mengecualikan **stream yang sudah selesai** = status `offline` DAN punya entri di `stream_history` (subquery `EXISTS`). Efeknya:
  - Tanpa filter → hanya live, scheduled, dan offline yang belum pernah jalan.
  - Filter `offline` → hanya yang belum pernah jalan.
  - Filter `live` / `scheduled` → perilaku sama seperti dulu.
- Catatan: di versi asli, `if (filter)` membuat pemanggilan tanpa filter mengembalikan semua stream mentah — logika filter sekarang selalu dievaluasi.

### `app.js` — `DELETE /api/streams/:id`
- Setelah `Stream.delete()` sukses, route ini sekarang juga:
  - Menghapus file thumbnail lewat `deleteLocalUpload(stream.youtube_thumbnail)` (URL YouTube remote otomatis diabaikan).
  - Menghapus **semua entri** `stream_history` milik stream itu (`DELETE FROM stream_history WHERE stream_id = ?`). Kalau hapus history gagal, request tetap sukses — row stream sudah hilang, sisa history hanya dicatat di log, tidak bikin error di UI.

### `app.js` — `DELETE /api/history/:id`
- Setelah entri history terhapus, jika entri itu punya `stream_id` dan stream-nya berstatus `offline` (selesai), stream-nya ikut dihapus (`Stream.delete`) beserta thumbnail-nya. Stream **live/scheduled tidak pernah terpurge** lewat jalur ini.

### `utils/storage.js`
- Helper baru `deleteLocalUpload(publicUrl)`: menghapus file upload lokal berdasarkan URL publiknya (mis. `/uploads/thumbnails/xxx.jpg`). Guard: hanya path yang diawali `/uploads/` dan tanpa `..` yang diproses — URL remote dan nilai DB basi tidak bisa memicu penghapusan file sembarangan. Gagal hapus hanya di-log, tidak melempar error.

### `db/database.js`
- Tambah index `idx_stream_history_stream_id` pada `stream_history(stream_id)` — subquery `EXISTS` di daftar streams jadi indexed (dipakai tiap load dashboard).

---

## 3. Thumbnail Stream

### `middleware/uploadMiddleware.js`
- Instance multer baru `uploadStreamThumbnail`: storage & filter sama seperti `uploadThumbnail`, plus `limits: { fileSize: 2MB }` — mengikuti batas custom thumbnail YouTube.

### `app.js`
- Route `POST /api/streams/youtube` dan `PUT /api/streams/:id` pindah dari `uploadThumbnail` ke wrapper `streamThumbnailUpload`: error multer (termasuk `LIMIT_FILE_SIZE`) dikembalikan sebagai **JSON 400** dengan pesan jelas, bukan halaman error HTML default Express.
- Upload thumbnail **tidak lagi di-resize**: dulu file dikecilkan jadi copy 320×180 via ffmpeg (`generateImageThumbnail`), yang membuat thumbnail tidak memenuhi syarat YouTube (≥1280×720). Sekarang file original yang disimpan & dipakai.
- `PUT /api/streams/:id`: saat thumbnail diganti, **file lama dihapus** via `deleteLocalUpload` (setelah update DB sukses).
- Upload ke YouTube (`thumbnails.set`): MIME type ditentukan dari ekstensi file (`.png`/`.gif`/`.jpg`), dulu hard-coded `image/jpeg`.

### `services/youtubeService.js`
- `createYouTubeBroadcast`: MIME type thumbnail sama — mengikuti ekstensi file, bukan hard-coded `image/jpeg`.

### `utils/videoProcessor.js`
- `generateImageThumbnail` di-rename jadi `generateRotationThumbnail` karena sekarang hanya dipakai fitur Rotations (stream thumbnail tidak diproses lagi). Logika internal tidak berubah.

### `views/dashboard.ejs`
- Input file thumbnail (create & edit): validasi client-side ukuran maksimal 2MB, file kelebihan langsung ditolak dengan toast sebelum preview.

---

## 4. Penjadwalan (Schedule)

### `public/js/schedule-picker.js` — **BARU**
- Class `SchedulePicker` menggantikan dua input `datetime-local` di form YouTube: kartu **Start Time** dan **End Time** masing-masing dengan kalender bulanan + daftar slot waktu, preset durasi cepat, tombol clear, validasi End ≥ Start, dan ringkasan (start/end/durasi) di dekat toggle.
- Nilai dipertahankan di hidden input (`ytScheduleStart`/`ytScheduleEnd`) dalam format `datetime-local` browser; `syncFromInputs()` menyinkronkan picker saat edit modal diisi; slot list auto-scroll ke waktu prefill.

### `views/dashboard.ejs`
- Dua input `datetime-local` YouTube (create + edit) diganti mount point picker (`pickerCreateYt` / `pickerEditYt`) + hidden input + ringkasan `ytScheduleSummary`.
- Urutan toggle diubah: **Monetization sekarang di atas Schedule**.
- Submit schedule (create & edit): wajib ada start time (kalau tidak → toast error + kartu Start di-highlight merah & di-scroll); nilai dikirim sebagai **ISO absolut** (`new Date(v).toISOString()`) supaya jam yang tersimpan benar apa pun timezone server.
- Prefill edit form YouTube pakai `toBrowserLocalInput()` (wall time browser, tanpa konversi timezone server seperti `formatDateTimeLocal` yang lama) — round-trip edit tidak lagi menggeser jam.

### `app.js`
- Parsing jadwal di-create dan edit dirombak ke fungsi `parseScheduleDateTime()`: menerima string ISO penuh (dari picker baru, timezone-safe) maupun `datetime-local` polos (form manual legacy, dibaca sebagai waktu lokal server), dan nilai invalid mengembalikan `null` dengan aman. Dulu parsing manual `split('T')` yang crash/berperilaku aneh pada format tak terduga.
- `PUT /api/streams/:id`: saat schedule di-clear (`scheduleStartTime` dikirim kosong) dan stream berstatus `scheduled` → status otomatis jadi `offline` (menyamai endpoint cancel-schedule), mencegah zombie "scheduled tanpa jadwal".

### `public/sw.js`
- Strategi static resources berubah dari **cache-first → network-first** (cache hanya fallback saat server unreachable): update UI langsung kelihatan setelah refresh biasa, tidak perlu tunggu bump versi cache.
- `CACHE_VERSION` 1.0.2 → 1.1.1, `/js/schedule-picker.js` dan `/js/csrf.js` masuk daftar precache.

---

## 5. Bug Fix & UX Form

### `views/dashboard.ejs`
- **Char counter** di Stream Title (maks 100) dan Description (maks 5000) untuk form create + edit YouTube — counter live, merah saat lewat batas, dan submit diblokir dengan toast (`validateStreamMetaLength`, termasuk tags maks 500 karakter).
- Tombol **edit & delete** (mobile + desktop) hanya disabled saat status `live` — stream **scheduled sekarang bisa langsung diedit/dihapus** (dulu ikut ter-disable).
- Stub `editStream()` duplikat yang cuma `console.log` dihapus (fungsi asli yang membuka edit modal tetap dipakai).
- Sinkronisasi picker + counter saat modal edit dibuka/di-reset; submit button modal edit di-revive saat dibuka ulang.

### `public/js/stream-modal.js`
- Saat modal New Stream dibuka ulang, tombol submit di-reset dari kondisi mati "Creating..." (disabled) hasil submit sukses sebelumnya.

---

## 6. Pembersihan UI / Debranding

### `views/layout.ejs`
- Semua elemen notifikasi dihapus: bel desktop + dropdown, bel mobile + popup, beserta seluruh JS pengecekan commit GitHub (`api.github.com/repos/bangtutorial/streamflow`), badge, dan `getTimeAgo`.
- Elemen branding/donasi dihapus: ikon gift donate (mobile), link GitHub header, link **Help & Support** di profile dropdown, footer versi + "by Bang Tutorial" + tombol donate Saweria (beserta CSS-nya).
- Modal "Update StreamFlow v2" beserta handler-nya dihapus.
- **Avatar profile pindah** dari bawah sidebar ke header desktop (pojok kanan atas); dropdown profile mengikuti posisi baru (muncul dari atas, di bawah avatar).

### `views/welcome.ejs`
- Halaman welcome disederhanakan total: tombol Donate, marquee daftar donator (CSS/JS + fetch `/api/donators`), dan library confetti dihapus. Countdown redirect 15 detik → **3 detik** (tanpa pause saat hover), copy diganti netral.
- Tambah preconnect jsdelivr + preload font Tabler icons.

### `app.js`
- Route `GET /api/donators` (fetch ke `donate.youtube101.id`) dihapus — tidak ada lagi yang memanggilnya.

---

## 7. Maintenance

### `scripts/cleanup-orphan-thumbnails.js` — **BARU**
- Sweep file di `public/uploads/thumbnails` yang tidak direferensikan DB mana pun (`streams.youtube_thumbnail`, `videos.thumbnail_path`, `rotation_items.thumbnail_path`).
- Default **dry-run** (hanya laporan); tambahkan `--apply` untuk benar-benar menghapus. Dibuat karena sistem lama meninggalkan file resize saat thumbnail diganti.

### `package.json`
- Blok `"allowScripts"` berisi persetujuan build script native untuk `bcrypt@6.0.0` dan `sqlite3@5.1.7` — npm versi baru memblokir install script native secara default; blok ini menyimpan approval agar `npm install` berjalan mulus.

---

## 8. Dialog Custom & Hapus Semua History

### `public/js/custom-dialog.js` — **BARU**
- Dialog konfirmasi/prompt in-app pengganti `confirm()` bawaan browser (yang di beberapa browser/ekstensi bisa diblokir atau langsung tertutup sendiri). Promise-based: `const { confirmed, value } = await createModalDialog({ ... })`.
- 4 tema (info/danger/warning/success), dukungan text input (`hasInput`, untuk dialog rename/create folder), tombol Escape = batal, klik backdrop = batal, animasi open/close, scroll body di-lock selama dialog terbuka.
- `title`, `message`, dan `inputValue` di-set via `textContent`/`.value` — konten user (judul stream/video/channel) tidak bisa menyuntik HTML. (Versi lama di dashboard/gallery meng-inject `message` langsung ke `innerHTML`.)
- Dimuat di `views/layout.ejs` untuk semua halaman, masuk precache service worker (`CACHE_VERSION` → 1.2.0).

### Semua dialog bawaan browser diganti
- `views/history.ejs`, `views/rotations.ejs`, `views/playlist.ejs` — `confirm()` untuk hapus history/rotation/playlist diganti dialog custom.
- `views/settings.ejs` — 4 titik: hapus reCAPTCHA keys, clear all logs, disconnect semua channel YouTube, disconnect satu channel.
- `views/users.ejs` — modal konfirmasi statis lama (`#confirmModal` + `showConfirmModal`/`confirmAction`/`currentAction`) dihapus seluruhnya, `deleteUser` pakai dialog shared.
- `views/dashboard.ejs` & `views/gallery.ejs` — definisi `createModalDialog` yang tadinya duplikat di masing-masing halaman dihapus; keduanya sekarang pakai file shared. Bentuk return diseragamkan jadi `{ confirmed, value }` (dashboard sebelumnya menerima boolean langsung).

### Hapus Semua History
- `app.js` — route baru `DELETE /api/history`: menghapus semua entri `stream_history` milik user dalam satu call. Stream finished (offline) yang terikat entri-entri itu ikut terhapus beserta file thumbnail-nya — cascade sama persis dengan hapus satu entri. Dilindungi auth + CSRF seperti endpoint mutasi lain.
- `views/history.ejs` — tombol **Delete All** di header (hanya muncul kalau ada history), dialog konfirmasinya menyebut jumlah entri; setelah sukses toast menampilkan jumlah terhapus lalu halaman reload.
- Bonus fix: judul entri untuk dialog hapus-satu kini dibaca dari atribut `data-title` row (dulu di-inject ke atribut `onclick` — judul yang mengandung tanda kutip/apostrof merusak handler-nya).

### Fix nama file UTF-8 saat upload (mojibake)
- **Masalah (ada juga di streamflow asli):** nama file non-ASCII pada upload gallery jadi rusak — `A1 — Garden Café….mp4` tersimpan jadi `A1 â Garden CafÃ©….mp4`. Penyebab: browser mengirim nama file multipart sebagai byte UTF-8 mentah, tapi busboy (parser di belakang multer) mendecodenya sebagai latin1 secara default.
- `middleware/uploadMiddleware.js` — semua 5 instance multer kini memakai `defParamCharset: 'utf8'` (didukung multer 2.x): nama file tersimpan utuh sebagai judul video/audio. Nama file fisik di disk tetap di-sanitize jadi ASCII oleh `getUniqueFilename` (perilaku lama, aman untuk URL/filesystem). Jalur upload chunked tidak terdampak (namanya lewat JSON).
- File yang terlanjur rusak namanya sebelum fix ini tidak berubah — bisa dibereskan lewat fitur Rename di gallery.

---

## Yang Sengaja TIDAK Diubah

- **Form stream manual (RTMP)** — create/edit manual tetap pakai input `datetime-local` + format lama; semua perubahan schedule picker/ISO hanya untuk form YouTube.
- **Autentikasi** — `/login`, `/signup`, `/setup-account`, logout, session store (SQLiteStore) tidak disentuh.
- **Fitur streaming inti** — `streamingService`, rotasi, playlist, upload chunk, konverter audio tidak berubah logikanya.

---

## Cara Update dari StreamFlow Asli

Untuk instance yang sudah jalan pakai streamflow asli (data `db/streamflow.db` + `public/uploads/` dipertahankan, bukan install baru):

### 1. Backup dulu
Stop aplikasi, lalu salin aman-aman:
```bash
cp db/streamflow.db db/streamflow.db.bak
cp db/sessions.db db/sessions.db.bak   # kalau ada
cp -r public/uploads public/uploads.bak
```

### 2. Ambil kode fork ini
Karena baseline fork ini identik dengan repo asli (`9dc36f0`), update bisa fast-forward biasa:

**VPS yang dulu clone dari repo asli:**
```bash
git remote set-url origin git@github.com:kumixio/streamflow.git   # arahkan ke fork
git pull origin main
```

**Atau clone baru lalu pindahkan data dari instalasi lama** (salin `.env`, `db/streamflow.db`, dan folder `public/uploads/`).

### 3. Install dependency
```bash
npm install
```
- Perubahan dependency hanya `multer` 1.x → 2.x (kompatibel API, tidak perlu ubah kode).
- npm versi baru memblokir build script native secara default — blok `allowScripts` di `package.json` sudah menyimpan approval untuk `bcrypt` dan `sqlite3`, jadi biasanya langsung jalan. Kalau modul native tetap gagal compile:
```bash
npm install-scripts approve bcrypt
npm install-scripts approve sqlite3
npm rebuild bcrypt sqlite3
```

### 4. Migrasi database: TIDAK ADA
Tidak ada skema yang berubah. Satu-satunya perubahan DB adalah index `idx_stream_history_stream_id`, dan itu dibuat **otomatis saat aplikasi start** (`CREATE INDEX IF NOT EXISTS`) — tidak perlu jalankan SQL manual.

### 5. Bersihkan thumbnail yatim (opsional, disarankan)
Sistem lama menyimpan file hasil resize (`thumb-*.jpg`) yang tidak pernah tercatat di DB:
```bash
node scripts/cleanup-orphan-thumbnails.js           # dry-run, lihat laporan dulu
node scripts/cleanup-orphan-thumbnails.js --apply   # benar-benar hapus
```

### 6. Restart & refresh browser
```bash
pm2 restart streamflow   # atau restart service/docker sesuai setup
```
- Service worker lama (cache-first) akan otomatis update ke versi baru saat user membuka aplikasi — tidak perlu apa-apa.
- Tetap disarankan **hard refresh (Ctrl+Shift+R) sekali** di tiap browser/tab yang sedang terbuka: tab lama belum memuat `csrf.js` + meta token, sehingga tombol yang mengirim data (create/edit/delete stream, upload, dll) akan ditolak 403 sampai di-refresh.

### Catatan perilaku setelah update
- **Stream yang sudah selesai (punya entri History) hilang dari halaman Streams** — bukan data hilang; pengelolaannya pindah ke halaman History (hapus entri history = hapus stream + thumbnail-nya sekalian).
- Thumbnail lama (termasuk yang >2MB hasil sistem lama) tetap dipakai apa adanya — batas 2MB hanya berlaku untuk upload baru.
- Session login semua user tetap valid (secret dan session store tidak berubah); CSRF secret dibuat otomatis per session saat halaman dibuka.
- Tidak ada variabel `.env` baru.
