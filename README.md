# Parciv Tmail

Parciv Tmail adalah temporary email web app full Cloudflare.

Fitur utama:

- Full Cloudflare Worker
- Cloudflare Email Routing receiver
- Cloudflare D1 database
- Admin panel di `/admin`
- API public URL dengan API key wajib
- Auto-generated readable email
- Custom email username
- Domain rotation dari domain aktif
- Auto refresh inbox
- OTP auto detect
- Recent inbox history via browser localStorage
- Auto delete email sesuai setting admin
- Emergency cleanup option
- Attachment toggle, default OFF
- Turnstile option
- Appearance Settings dengan tab Branding, Interface, Themes, Localization
- Privacy-first: admin tidak punya menu membaca isi inbox user

Default login admin:

```text
username: admin
password: admin
```

Segera ganti username dan password di menu System setelah login.

---

## 1. Install kebutuhan

Install Node.js versi LTS, lalu install dependencies:

```bash
npm install
```

Login ke Cloudflare:

```bash
npx wrangler login
```

---

## 2. Buat D1 database

```bash
npx wrangler d1 create parciv_tmail_db
```

Cloudflare akan memberi output seperti:

```toml
[[d1_databases]]
binding = "DB"
database_name = "parciv_tmail_db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy `database_id`, lalu paste ke `wrangler.toml` menggantikan:

```text
REPLACE_WITH_YOUR_D1_DATABASE_ID
```

---

## 3. Import schema D1

Untuk production Cloudflare:

```bash
npm run db:prod
```

Untuk local dev:

```bash
npm run db:local
```

---

## 4. Edit domain default

Buka `wrangler.toml`, ubah:

```toml
DEFAULT_WEB_DOMAIN = "domain.com"
DEFAULT_API_DOMAIN = "api.domain.com"
```

Setelah deploy, kamu juga bisa mengatur domain dari admin panel.

---

## 5. Deploy Worker

```bash
npm run deploy
```

Setelah berhasil, Cloudflare akan memberi URL Worker.

---

## 6. Pasang custom domain

Di Cloudflare dashboard:

1. Buka Workers & Pages.
2. Pilih Worker `parciv-tmail`.
3. Masuk ke Settings > Domains & Routes.
4. Tambahkan route untuk web, contoh:

```text
domain.com/*
```

5. Tambahkan route untuk API, contoh:

```text
api.domain.com/*
```

Keduanya boleh diarahkan ke Worker yang sama.

---

## 7. Setup Email Routing

Di Cloudflare dashboard:

1. Buka domain kamu.
2. Pilih Email > Email Routing.
3. Aktifkan Email Routing.
4. Ikuti setup MX record dari Cloudflare.
5. Buat route/catch-all:

```text
*@domain.com
```

6. Action pilih Worker.
7. Pilih Worker `parciv-tmail`.

Ulangi untuk domain email lain kalau kamu menambahkan lebih dari satu domain.

---

## 8. Admin panel

Buka:

```text
https://domain.com/admin
```

Login default:

```text
admin / admin
```

Masuk ke menu System, lalu ganti username dan password.

---

## 9. Setting penting di admin

### Domains

Tambahkan domain email yang aktif, contoh:

```text
domain.com
mail.domain.com
```

Domain aktif akan dipakai untuk domain rotation saat user generate email.

### Storage

Default auto delete:

```text
7 days
```

Admin bisa ubah bebas, misalnya 1, 3, 7, 14, 30 hari.

### Security

Atur:

- Turnstile ON/OFF
- Turnstile Site Key
- Turnstile Secret Key
- Captcha on Generate
- Forbidden usernames
- Custom min/max username length

### Features

Atur:

- OTP detector
- Attachments ON/OFF
- Sound notification
- Cookie notice
- Auto refresh seconds

### Appearance Settings

Tab tersedia:

- Branding
- Interface
- Themes
- Localization

Default logo dan favicon:

```text
https://i.ibb.co.com/1tNtxMjH/image.png
```

Rekomendasi ukuran:

```text
Logo: 800x200 px, PNG/WEBP/SVG
Favicon: 32x32 atau 64x64 px, PNG/ICO/SVG
OG image: 1200x630 px
```

Untuk awal lebih ringan pakai direct image URL dari ImgBB atau Postimages.

---

## 10. API usage

API base URL contoh:

```text
https://api.domain.com/api/v1
```

Semua API wajib pakai API key:

```http
Authorization: Bearer pcv_live_xxxxx
```

Buat API key dari:

```text
Admin > Developer Hub > Generate API Key
```

### Create inbox

```bash
curl -X POST https://api.domain.com/api/v1/inboxes \
  -H "Authorization: Bearer pcv_live_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Custom username:

```bash
curl -X POST https://api.domain.com/api/v1/inboxes \
  -H "Authorization: Bearer pcv_live_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"username":"testing123","domain":"domain.com"}'
```

### Read inbox

```bash
curl https://api.domain.com/api/v1/inboxes/TOKEN \
  -H "Authorization: Bearer pcv_live_xxxxx"
```

### Get OTP

```bash
curl https://api.domain.com/api/v1/inboxes/TOKEN/otp \
  -H "Authorization: Bearer pcv_live_xxxxx"
```

### Delete inbox

```bash
curl -X DELETE https://api.domain.com/api/v1/inboxes/TOKEN \
  -H "Authorization: Bearer pcv_live_xxxxx"
```

---

## 11. Catatan attachment

Attachment default OFF.

Kalau ON, versi awal ini baru menyimpan status toggle. Untuk penyimpanan file attachment penuh, aktifkan R2 binding di `wrangler.toml` dan lanjutkan implementasi parser MIME attachment.

Saran awal: tetap OFF agar aman dan hemat storage.

---

## 12. Catatan privacy

Admin panel versi ini tidak menyediakan menu untuk membaca semua inbox/email user.

Admin hanya melihat statistik dan activity center yang dimasking, supaya lebih privacy-first.

---

## 13. Troubleshooting

### Email tidak masuk

Cek:

- Email Routing sudah aktif
- MX record sudah benar
- catch-all diarahkan ke Worker
- domain sudah aktif di menu Domains
- email yang dipakai sudah dibuat lewat web/API

### API 403

Pastikan header ada:

```http
Authorization: Bearer API_KEY
```

### Admin tidak bisa login

Default login:

```text
admin / admin
```

Pastikan schema D1 sudah diimport dengan `npm run db:prod`.

