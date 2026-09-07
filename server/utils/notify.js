// ============================================================
// notify.js — notifications automatiques (e-mail + webhook générique)
// ============================================================
// Objectif : tracer et notifier automatiquement chaque événement important
// (paiement confirmé, nouveau message, nouvelle inscription) SANS dépendre
// d'une action manuelle de l'admin. Toute cette logique est volontairement
// "best effort" : un échec d'envoi (SMTP mal configuré, webhook injoignable)
// ne doit JAMAIS faire échouer l'opération métier (paiement, commande...)
// qui l'a déclenchée — on log l'erreur et on continue.
const nodemailer = require("nodemailer");
const { getSecureSetting, db } = require("../db");

// ---------------------------------------------------------------
// E-MAIL (SMTP) — sert à la fois pour les alertes admin et les
// confirmations envoyées automatiquement au client après paiement.
// ---------------------------------------------------------------
async function getSmtpConfig() {
  return {
    host: await getSecureSetting("smtp_host"),
    port: Number((await getSecureSetting("smtp_port")) || 587),
    secure: (await getSecureSetting("smtp_secure")) === "1",
    user: await getSecureSetting("smtp_user"),
    pass: await getSecureSetting("smtp_pass"),
    fromName: (await getSecureSetting("smtp_from_name")) || "OKIM ART",
    fromEmail: (await getSecureSetting("smtp_from_email")) || (await getSecureSetting("smtp_user"))
  };
}

function isSmtpConfigured(cfg) {
  return !!(cfg.host && cfg.user && cfg.pass);
}

let cachedTransporter = null;
let cachedKey = "";
function getTransporter(cfg) {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (cachedTransporter && cachedKey === key) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure, // true = SSL direct (port 465), false = STARTTLS (port 587)
    auth: { user: cfg.user, pass: cfg.pass },
    // Timeouts explicites : un serveur SMTP injoignable (mauvais host,
    // pare-feu, port bloqué) échoue rapidement avec un message clair au
    // lieu de laisser l'admin attendre indéfiniment devant le bouton "test".
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  cachedKey = key;
  return cachedTransporter;
}

/** Envoie un e-mail. Ne lève jamais d'exception : renvoie {ok, error?}. */
async function sendMail({ to, subject, html }) {
  const cfg = await getSmtpConfig();
  if (!isSmtpConfigured(cfg)) {
    console.log(`[notify] SMTP non configuré — e-mail "${subject}" à ${to} non envoyé (voir Paramètres → Notifications).`);
    return { ok: false, error: "SMTP non configuré." };
  }
  try {
    const transporter = getTransporter(cfg);
    await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
      to, subject, html
    });
    return { ok: true };
  } catch (e) {
    console.error("[notify] Échec d'envoi e-mail :", e.message);
    return { ok: false, error: e.message };
  }
}

/** Adresse e-mail de l'admin à notifier (réglages publics du site). */
async function getAdminNotifyEmail() {
  const row = await db.prepare("SELECT valeur FROM settings WHERE cle = 'email'").get();
  return row ? row.valeur : "";
}

async function notifyAdmin(subject, html) {
  const to = await getAdminNotifyEmail();
  if (!to) return { ok: false, error: "Aucun e-mail de contact configuré (Paramètres → Profil & contact)." };
  return sendMail({ to, subject, html });
}

// ---------------------------------------------------------------
// WEBHOOK GÉNÉRIQUE — "par d'autres moyens" (WhatsApp, SMS, Slack...)
// ---------------------------------------------------------------
async function triggerWebhook(event, payload) {
  const url = await getSecureSetting("notify_webhook_url");
  if (!url) return { ok: false, error: "Aucun webhook configuré." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, occurred_at: new Date().toISOString(), ...payload }),
      signal: controller.signal
    });
    return { ok: res.ok };
  } catch (e) {
    console.error("[notify] Échec d'appel webhook :", e.message);
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Déclenche l'e-mail admin ET le webhook générique pour un même événement, sans jamais bloquer l'appelant. */
function fireEvent(event, { subject, html, payload }) {
  notifyAdmin(subject, html).catch(() => {});
  triggerWebhook(event, payload).catch(() => {});
}

module.exports = { sendMail, notifyAdmin, triggerWebhook, fireEvent, getSmtpConfig, isSmtpConfigured };
