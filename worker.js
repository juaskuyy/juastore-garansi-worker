export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path === "/") {
        return json({ success: true, message: "Sistem Garansi API aktif." }, 200, cors);
      }
      if (request.method === "POST" && path === "/api/claims") {
        return await createClaim(request, env, cors);
      }
      if (request.method === "GET" && path === "/api/status") {
        return await checkStatus(url, env, cors);
      }
      if (request.method === "POST" && path === "/telegram-webhook") {
        return await telegramWebhook(request, url, env, cors);
      }
      return json({ success: false, message: "Endpoint tidak ditemukan." }, 404, cors);
    } catch (error) {
      return json({ success: false, message: error?.message || "Terjadi kesalahan server." }, 500, cors);
    }
  }
};

async function createClaim(request, env, cors) {
  if (!env.DB) throw new Error("Binding D1 DB belum dipasang.");
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Token bot atau Chat ID Telegram belum dipasang.");
  }

  const form = await request.formData();
  const get = key => String(form.get(key) || "").trim();

  let phone = get("customerContact").replace(/\D/g, "");
  if (phone.startsWith("0")) phone = "62" + phone.slice(1);
  else if (phone.startsWith("8")) phone = "62" + phone;

  if (!/^62\d{8,13}$/.test(phone)) {
    return json({ success: false, message: "Nomor WhatsApp tidak valid." }, 400, cors);
  }

  for (const key of ["customerName", "productName", "orderId", "problem"]) {
    if (!get(key)) return json({ success: false, message: `Field ${key} wajib diisi.` }, 400, cors);
  }

  const claimId = `GRN-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO claims (
      id, customer_name, whatsapp, product_name, price, duration,
      order_date, order_id, payment, claim_type, problem,
      status, admin_note, telegram_chat_id, telegram_message_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    claimId, get("customerName"), phone, get("productName"), get("price"),
    get("duration"), get("orderDate"), get("orderId"), get("payment"),
    get("claimType") || "Garansi", get("problem"), "Menunggu", "", "", 0, now, now
  ).run();

  const text = [
    "🛡️ <b>PENGAJUAN GARANSI BARU — JUASTORE</b>", "",
    `🆔 ID Garansi: <code>${esc(claimId)}</code>`,
    `👤 Nama: ${esc(get("customerName"))}`,
    `📱 WhatsApp: <code>${esc(phone)}</code>`, "",
    `📦 Produk: ${esc(get("productName"))}`,
    `💰 Harga: Rp ${esc(get("price") || "0")}`,
    `⏳ Durasi: ${esc(get("duration") || "-")}`,
    `📅 Tanggal Order: ${esc(get("orderDate") || "-")}`,
    `🧾 ID Order: ${esc(get("orderId"))}`,
    `💳 Pembayaran: ${esc(get("payment") || "-")}`,
    `🛡 Jenis: ${esc(get("claimType") || "Garansi")}`, "",
    "<b>📝 Masalah / Kendala:</b>", esc(get("problem")), "",
    "⏱ <b>Status:</b> Menunggu"
  ].join("\n");

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Terima", callback_data: `claim:${claimId}:Diterima` },
        { text: "🟡 Proses", callback_data: `claim:${claimId}:Diproses` },
        { text: "❌ Tolak", callback_data: `claim:${claimId}:Ditolak` }
      ],
      [{ text: "💬 Balas WhatsApp", url: waLink(phone, claimId) }]
    ]
  };

  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const evidence = form.get("evidence");
  let response;

  if (evidence && typeof evidence !== "string" && evidence.size > 0) {
    if (evidence.size > 5 * 1024 * 1024) {
      return json({ success: false, message: "Screenshot maksimal 5 MB." }, 400, cors);
    }
    const tg = new FormData();
    tg.append("chat_id", env.TELEGRAM_CHAT_ID);
    tg.append("caption", text.slice(0, 1024));
    tg.append("parse_mode", "HTML");
    tg.append("reply_markup", JSON.stringify(keyboard));
    tg.append("photo", evidence, evidence.name || "bukti.jpg");
    response = await fetch(`${base}/sendPhoto`, { method: "POST", body: tg });
  } else {
    response = await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard
      })
    });
  }

  const raw = await response.text();
  let telegram;
  try { telegram = JSON.parse(raw); }
  catch { throw new Error("Respons Telegram bukan JSON: " + raw.slice(0, 200)); }
  if (!telegram.ok) throw new Error(telegram.description || "Telegram API gagal.");

  await env.DB.prepare(`UPDATE claims SET telegram_chat_id=?, telegram_message_id=?, updated_at=? WHERE id=?`)
    .bind(String(telegram.result?.chat?.id || ""), Number(telegram.result?.message_id || 0), new Date().toISOString(), claimId)
    .run();

  return json({ success: true, ok: true, claimId, warrantyId: claimId, message: "Pengajuan berhasil dikirim." }, 200, cors);
}

async function checkStatus(url, env, cors) {
  if (!env.DB) throw new Error("Binding D1 DB belum dipasang.");
  const q = String(url.searchParams.get("q") || "").trim();
  if (!q) return json({ success: false, message: "Masukkan ID garansi atau nomor WhatsApp." }, 400, cors);

  let normalized = q;
  if (!q.toUpperCase().startsWith("GRN-")) {
    normalized = q.replace(/\D/g, "");
    if (normalized.startsWith("0")) normalized = "62" + normalized.slice(1);
    else if (normalized.startsWith("8")) normalized = "62" + normalized;
  } else normalized = q.toUpperCase();

  const result = await env.DB.prepare(`
    SELECT id, whatsapp, product_name, duration, order_id, claim_type,
           status, admin_note, created_at, updated_at
    FROM claims WHERE id=? OR whatsapp=? ORDER BY created_at DESC LIMIT 20
  `).bind(normalized, normalized).all();

  return json({ success: true, data: result.results || [] }, 200, cors);
}

async function telegramWebhook(request, url, env, cors) {
  const key = url.searchParams.get("key") || "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || key !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ success: false, message: "Webhook ditolak." }, 401, cors);
  }

  const update = await request.json();
  const callback = update.callback_query;
  if (!callback) return json({ success: true }, 200, cors);

  const parts = String(callback.data || "").split(":");
  if (parts.length !== 3 || parts[0] !== "claim") return json({ success: true }, 200, cors);

  const claimId = parts[1];
  const status = parts[2];
  if (!["Diterima", "Diproses", "Ditolak"].includes(status)) return json({ success: true }, 200, cors);

  await env.DB.prepare(`UPDATE claims SET status=?, updated_at=? WHERE id=?`)
    .bind(status, new Date().toISOString(), claimId).run();

  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  await fetch(`${base}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callback.id, text: `Status: ${status}` })
  });

  const row = await env.DB.prepare(`SELECT whatsapp FROM claims WHERE id=?`).bind(claimId).first();
  const message = callback.message;
  const oldText = message.caption || message.text || "";
  const statusLine = `⏱ <b>Status:</b> ${esc(status)}`;
  const newText = /⏱\s*<b>Status:<\/b>.*$/m.test(oldText)
    ? oldText.replace(/⏱\s*<b>Status:<\/b>.*$/m, statusLine)
    : `${oldText}\n\n${statusLine}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Terima", callback_data: `claim:${claimId}:Diterima` },
        { text: "🟡 Proses", callback_data: `claim:${claimId}:Diproses` },
        { text: "❌ Tolak", callback_data: `claim:${claimId}:Ditolak` }
      ],
      [{ text: "💬 Balas WhatsApp", url: waLink(row?.whatsapp || "", claimId) }]
    ]
  };

  const method = message.photo ? "editMessageCaption" : "editMessageText";
  const payload = {
    chat_id: message.chat.id,
    message_id: message.message_id,
    parse_mode: "HTML",
    reply_markup: keyboard
  };
  if (message.photo) payload.caption = newText.slice(0, 1024);
  else payload.text = newText;

  await fetch(`${base}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  return json({ success: true }, 200, cors);
}

function waLink(phone, claimId) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(`Halo, pengajuan garansi JuaStore ${claimId} sedang kami tindak lanjuti.`)}`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" }
  });
}
