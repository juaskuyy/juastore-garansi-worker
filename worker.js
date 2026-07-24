const JSON_HEADERS = { "content-type": "application/json; charset=UTF-8" };
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({ success: true, message: "Sistem Garansi JuaStore aktif." }, 200, request);
      }
      if (request.method === "POST" && url.pathname === "/api/claims") {
        return await createClaim(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return await getStatus(request, env);
      }
      if (request.method === "POST" && url.pathname === "/telegram-webhook") {
        return await telegramWebhook(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/admin/claims") {
        requireAdmin(request, env);
        return await adminListClaims(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/admin/status") {
        requireAdmin(request, env);
        return await adminUpdateStatus(request, env);
      }
      return json({ success: false, message: "Endpoint tidak ditemukan." }, 404, request);
    } catch (error) {
      console.error(error);
      const status = error.status || 500;
      return json({
        success: false,
        message: status === 500 ? "Terjadi kesalahan pada server." : error.message
      }, status, request);
    }
  }
};

async function createClaim(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ success: false, message: "Form harus dikirim sebagai multipart/form-data." }, 400, request);
  }

  const form = await request.formData();
  const body = {
    customerName: clean(form.get("customerName"), 120),
    customerContact: clean(form.get("customerContact"), 40),
    productName: clean(form.get("productName"), 150),
    price: clean(form.get("price"), 40),
    duration: clean(form.get("duration"), 80),
    orderDate: clean(form.get("orderDate"), 40),
    orderId: clean(form.get("orderId"), 100),
    payment: clean(form.get("payment"), 80),
    claimType: clean(form.get("claimType"), 40),
    problem: clean(form.get("problem"), 2500)
  };

  const errorPhoto = form.get("evidence");
  const purchaseProof = form.get("orderProof");
  const required = ["customerName", "customerContact", "productName", "duration", "orderDate", "orderId", "claimType", "problem"];

  for (const key of required) {
    if (!body[key]) {
      return json({ success: false, message: `Kolom ${key} wajib diisi.` }, 400, request);
    }
  }

  const fileError = validateImageFile(errorPhoto, "Foto kendala/error") || validateImageFile(purchaseProof, "Bukti pembelian");
  if (fileError) return json({ success: false, message: fileError }, 400, request);

  const existing = await env.DB.prepare("SELECT id FROM claims WHERE order_id = ? LIMIT 1").bind(body.orderId).first();
  if (existing) {
    return json({ success: false, message: "ID order tersebut sudah pernah digunakan untuk klaim." }, 409, request);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO claims (
      id, customer_name, whatsapp, product_name, price, duration,
      order_date, order_id, payment, claim_type, problem, status,
      admin_note, telegram_chat_id, telegram_message_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, body.customerName, body.customerContact, body.productName, body.price,
    body.duration, body.orderDate, body.orderId, body.payment, body.claimType,
    body.problem, "MENUNGGU", "", "", "", now, now
  ).run();

  let telegramWarning = null;
  try {
    const sent = await sendTelegramClaim(env, { id, ...body, status: "MENUNGGU", errorPhoto, purchaseProof });
    if (sent?.result?.message_id) {
      await env.DB.prepare(`
        UPDATE claims SET telegram_chat_id = ?, telegram_message_id = ?, updated_at = ? WHERE id = ?
      `).bind(String(sent.result.chat.id), String(sent.result.message_id), new Date().toISOString(), id).run();
    }
  } catch (error) {
    console.error("Telegram gagal:", error);
    telegramWarning = "Klaim tersimpan, tetapi notifikasi Telegram gagal dikirim.";
  }

  return json({
    success: true,
    message: telegramWarning || "Klaim berhasil dikirim.",
    data: { id, orderId: body.orderId, status: "MENUNGGU" },
    warning: telegramWarning
  }, 201, request);
}

function validateImageFile(file, label) {
  if (!(file instanceof File) || file.size === 0) return `${label} wajib diunggah.`;
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return `${label} harus berformat JPG, PNG, atau WEBP.`;
  if (file.size > MAX_FILE_SIZE) return `${label} maksimal 5 MB.`;
  return null;
}

async function sendTelegramClaim(env, claim) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Secret Telegram belum diatur.");
  }

  await sendTelegramPhoto(env, env.TELEGRAM_CHAT_ID, claim.errorPhoto, `📷 Foto Kendala / Error\n🆔 ${claim.orderId}`);
  await sendTelegramPhoto(env, env.TELEGRAM_CHAT_ID, claim.purchaseProof, `🧾 Bukti Pembelian\n🆔 ${claim.orderId}`);

  return await telegramApi(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: buildTelegramText({
      id: claim.id,
      customer_name: claim.customerName,
      whatsapp: claim.customerContact,
      product_name: claim.productName,
      price: claim.price,
      duration: claim.duration,
      order_date: claim.orderDate,
      order_id: claim.orderId,
      payment: claim.payment,
      claim_type: claim.claimType,
      problem: claim.problem,
      status: claim.status
    }),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildKeyboard(claim.id)
  });
}

async function sendTelegramPhoto(env, chatId, file, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("caption", caption);
  fd.append("photo", new Blob([await file.arrayBuffer()], { type: file.type }), file.name || "image.jpg");

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: fd
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || "Telegram sendPhoto gagal.");
  return data;
}

async function getStatus(request, env) {
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim();
  if (!q) return json({ success: false, message: "Masukkan ID order atau nomor WhatsApp." }, 400, request);

  const row = await env.DB.prepare(`
    SELECT id, customer_name, whatsapp, product_name, price, duration,
      order_date, order_id, payment, claim_type, problem, status,
      admin_note, created_at, updated_at
    FROM claims
    WHERE order_id = ? OR whatsapp = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(q, q).first();

  if (!row) return json({ success: false, message: "Data klaim tidak ditemukan." }, 404, request);
  return json({ success: true, data: row }, 200, request);
}

async function telegramWebhook(request, env) {
  const url = new URL(request.url);
  if (env.WEBHOOK_SECRET && url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
    return json({ success: false, message: "Webhook secret tidak valid." }, 403, request);
  }

  const update = await request.json();
  if (!update.callback_query) return json({ success: true, ignored: true }, 200, request);

  const callback = update.callback_query;
  const [action, claimId] = String(callback.data || "").split(":");
  const statusMap = { accept: "DITERIMA", process: "DIPROSES", reject: "DITOLAK" };
  const newStatus = statusMap[action];

  if (!newStatus || !claimId) {
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Aksi tidak valid.",
      show_alert: true
    });
    return json({ success: false, message: "Callback tidak valid." }, 400, request);
  }

  const claim = await env.DB.prepare("SELECT * FROM claims WHERE id = ? LIMIT 1").bind(claimId).first();
  if (!claim) {
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Data klaim tidak ditemukan.",
      show_alert: true
    });
    return json({ success: false, message: "Klaim tidak ditemukan." }, 404, request);
  }

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE claims SET status = ?, updated_at = ? WHERE id = ?").bind(newStatus, now, claimId).run();

  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: `Status diubah menjadi ${newStatus}.`
  });

  const updated = { ...claim, status: newStatus, updated_at: now };
  const chatId = callback.message?.chat?.id || claim.telegram_chat_id;
  const messageId = callback.message?.message_id || claim.telegram_message_id;

  if (chatId && messageId) {
    await telegramApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: buildTelegramText(updated),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildKeyboard(claimId)
    });
  }

  return json({ success: true, status: newStatus }, 200, request);
}

async function adminListClaims(request, env) {
  const url = new URL(request.url);
  const status = String(url.searchParams.get("status") || "").trim();
  const q = String(url.searchParams.get("q") || "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 500);

  let sql = `SELECT id, customer_name, whatsapp, product_name, price, duration,
    order_date, order_id, payment, claim_type, problem, status,
    admin_note, created_at, updated_at FROM claims`;
  const where = [];
  const binds = [];

  if (status) { where.push("status = ?"); binds.push(status); }
  if (q) {
    where.push("(order_id LIKE ? OR whatsapp LIKE ? OR customer_name LIKE ? OR product_name LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);

  const result = await env.DB.prepare(sql).bind(...binds).all();
  return json({ success: true, data: result.results || [] }, 200, request);
}

async function adminUpdateStatus(request, env) {
  const body = await request.json();
  const id = String(body.id || "").trim();
  const status = String(body.status || "").trim().toUpperCase();
  const adminNote = clean(body.adminNote, 1000);
  const allowed = ["MENUNGGU", "DIPROSES", "DITERIMA", "DITOLAK"];

  if (!id || !allowed.includes(status)) {
    return json({ success: false, message: "ID atau status tidak valid." }, 400, request);
  }

  const claim = await env.DB.prepare("SELECT * FROM claims WHERE id = ? LIMIT 1").bind(id).first();
  if (!claim) return json({ success: false, message: "Klaim tidak ditemukan." }, 404, request);

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE claims SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?")
    .bind(status, adminNote, now, id).run();

  const updated = { ...claim, status, admin_note: adminNote, updated_at: now };
  if (claim.telegram_chat_id && claim.telegram_message_id) {
    try {
      await telegramApi(env, "editMessageText", {
        chat_id: claim.telegram_chat_id,
        message_id: claim.telegram_message_id,
        text: buildTelegramText(updated),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildKeyboard(id)
      });
    } catch (error) {
      console.error("Gagal mengedit pesan Telegram:", error);
    }
  }

  return json({ success: true, message: "Status berhasil diperbarui.", data: updated }, 200, request);
}

function buildKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: "✅ Terima", callback_data: `accept:${id}` },
      { text: "⏳ Proses", callback_data: `process:${id}` },
      { text: "❌ Tolak", callback_data: `reject:${id}` }
    ]]
  };
}

function buildTelegramText(c) {
  return [
    "🛡️ <b>KLAIM GARANSI JUASTORE</b>", "",
    `🆔 <b>ID Order:</b> ${escapeHtml(c.order_id || "-")}`,
    `👤 <b>Nama:</b> ${escapeHtml(c.customer_name || "-")}`,
    `📱 <b>WhatsApp:</b> ${escapeHtml(c.whatsapp || "-")}`,
    `📦 <b>Produk:</b> ${escapeHtml(c.product_name || "-")}`,
    `💰 <b>Harga:</b> ${escapeHtml(c.price || "-")}`,
    `⏳ <b>Durasi:</b> ${escapeHtml(c.duration || "-")}`,
    `📅 <b>Tanggal Order:</b> ${escapeHtml(c.order_date || "-")}`,
    `💳 <b>Pembayaran:</b> ${escapeHtml(c.payment || "-")}`,
    `📋 <b>Jenis Klaim:</b> ${escapeHtml(c.claim_type || "-")}`,
    "", `⚠️ <b>Kendala:</b>\n${escapeHtml(c.problem || "-")}`, "",
    "📸 <b>Foto kendala:</b> sudah dikirim di atas",
    "🧾 <b>Bukti pembelian:</b> sudah dikirim di atas",
    `📌 <b>Status:</b> ${escapeHtml(c.status || "MENUNGGU")}`,
    c.admin_note ? `📝 <b>Catatan Admin:</b> ${escapeHtml(c.admin_note)}` : ""
  ].filter(Boolean).join("\n");
}

async function telegramApi(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram API ${method} gagal.`);
  return data;
}

function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) {
    const error = new Error("ADMIN_KEY belum diatur.");
    error.status = 500;
    throw error;
  }

  const url = new URL(request.url);
  const supplied = request.headers.get("x-admin-key") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key");

  if (supplied !== env.ADMIN_KEY) {
    const error = new Error("Akses admin ditolak.");
    error.status = 401;
    throw error;
  }
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, X-Admin-Key",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...(request ? corsHeaders(request) : {})
    }
  });
}
