# JuaStore Garansi Worker — GitHub Deploy

1. Buat repository GitHub baru, misalnya `juastore-garansi-worker`.
2. Upload semua file dari ZIP ini ke repository.
3. Buka `wrangler.jsonc`, lalu ganti `GANTI_DENGAN_DATABASE_ID_D1` dengan Database ID D1 `juastore-garansi-db`.
4. Di Cloudflare buka Workers & Pages → Create → Continue with GitHub.
5. Pilih repository tadi.
6. Build command: `npm install`
7. Deploy command: `npx wrangler deploy`
8. Tambahkan secrets di Worker:
   - TELEGRAM_BOT_TOKEN
   - TELEGRAM_CHAT_ID
   - TELEGRAM_WEBHOOK_SECRET
9. Jalankan isi `schema.sql` di D1 Console.
10. Ganti API endpoint di website ke URL Worker baru + `/api/claims`.
11. Pasang ulang webhook Telegram ke URL Worker baru:
   `https://api.telegram.org/botTOKEN/setWebhook?url=https%3A%2F%2FGARANSI-API-V2.SUBDOMAIN.workers.dev%2Ftelegram-webhook%3Fkey%3DSECRET`

Jangan simpan token bot di GitHub.
