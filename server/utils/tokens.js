// ============================================================
// tokens.js — jetons de téléchargement sécurisés (achats)
// ============================================================
const { nanoid } = require("nanoid");
const { db } = require("../db");

const DEFAULT_MAX_DOWNLOADS = 5;
const DEFAULT_EXPIRY_HOURS = 72;

async function createDownloadToken(orderId, productId, opts = {}) {
  const token = nanoid(40); // opaque, imprévisible — ne révèle jamais l'emplacement du fichier
  const expiresAt = new Date(Date.now() + (opts.expiryHours || DEFAULT_EXPIRY_HOURS) * 3600 * 1000).toISOString();
  await db.prepare(`
    INSERT INTO download_tokens (token, order_id, product_id, max_downloads, downloads_used, expires_at)
    VALUES (?,?,?,?,0,?)
  `).run(token, orderId, productId, opts.maxDownloads || DEFAULT_MAX_DOWNLOADS, expiresAt);
  return token;
}

async function getValidToken(token) {
  const row = await db.prepare("SELECT * FROM download_tokens WHERE token = ?").get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (row.downloads_used >= row.max_downloads) return null;
  return row;
}

async function consumeToken(token) {
  await db.prepare("UPDATE download_tokens SET downloads_used = downloads_used + 1 WHERE token = ?").run(token);
}

async function tokensForOrder(orderId) {
  return db.prepare("SELECT * FROM download_tokens WHERE order_id = ?").all(orderId);
}

module.exports = { createDownloadToken, getValidToken, consumeToken, tokensForOrder };
