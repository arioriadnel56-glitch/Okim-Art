// ============================================================
// assistant.js (routes) — chat public avec l'assistant IA "okim.box"
// ============================================================
const express = require("express");
const rateLimit = require("express-rate-limit");
const { nanoid } = require("nanoid");
const { db } = require("../db");
const { askAssistant } = require("../utils/assistant");
const { notifyAdminInApp } = require("../utils/notifications");
const { fireEvent } = require("../utils/notify");

const router = express.Router();

// Coût réel par appel API : limite volontairement stricte pour éviter tout
// abus (bot, spam) qui ferait exploser la facture Anthropic du studio.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de messages envoyés à l'assistant. Réessayez dans quelques minutes, ou contactez OKIM ART directement." }
});

const MAX_HISTORY = 16; // messages gardés en contexte (évite un prompt qui grossit indéfiniment)
const MAX_MESSAGE_LEN = 2000;

router.get("/config", async (req, res) => {
  const rows = await db.prepare("SELECT cle, valeur FROM settings WHERE cle IN ('assistant_enabled','assistant_name','assistant_intro')").all();
  const cfg = {};
  rows.forEach((r) => { cfg[r.cle] = r.valeur; });
  res.json({ enabled: cfg.assistant_enabled === "1", name: cfg.assistant_name || "okim.box", intro: cfg.assistant_intro || "" });
});

router.post("/chat", chatLimiter, async (req, res) => {
  try {
    const enabledRow = await db.prepare("SELECT valeur FROM settings WHERE cle = 'assistant_enabled'").get();
    if (!enabledRow || enabledRow.valeur !== "1") {
      return res.status(503).json({ error: "L'assistant n'est pas activé pour le moment." });
    }

    let { session_id, message } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: "Message vide." });
    message = String(message).trim().slice(0, MAX_MESSAGE_LEN);

    // Un visiteur anonyme obtient un session_id à sa première question ;
    // il est réutilisé pour tout l'échange (stocké côté navigateur par le
    // widget, voir public/js/assistant-widget.js). Jamais lié à un compte
    // sauf si la personne est connectée (req.cookies), pour garder le chat
    // utilisable sans inscription.
    if (!session_id || typeof session_id !== "string" || session_id.length > 80) session_id = nanoid(24);

    let conversation = await db.prepare("SELECT * FROM assistant_conversations WHERE session_id = ?").get(session_id);
    let clientId = null;
    try {
      const cookieToken = req.cookies?.okimart_client_token;
      if (cookieToken) {
        const jwt = require("jsonwebtoken");
        const { SECRET } = require("../middleware/auth");
        const decoded = jwt.verify(cookieToken, SECRET);
        if (decoded.type === "client") clientId = decoded.id;
      }
    } catch (_) { /* pas connecté, conversation anonyme */ }

    if (!conversation) {
      const info = await db.prepare("INSERT INTO assistant_conversations (session_id, client_id) VALUES (?,?)").run(session_id, clientId);
      conversation = await db.prepare("SELECT * FROM assistant_conversations WHERE id = ?").get(info.lastInsertRowid);
    }

    await db.prepare("INSERT INTO assistant_messages (conversation_id, role, contenu) VALUES (?,'user',?)").run(conversation.id, message);

    const history = await db.prepare("SELECT role, contenu FROM assistant_messages WHERE conversation_id = ? ORDER BY created_at ASC").all(conversation.id);
    const trimmedHistory = history.slice(-MAX_HISTORY);

    let reply;
    try {
      reply = await askAssistant(trimmedHistory);
    } catch (e) {
      if (e.code === "MISSING_KEY") {
        return res.status(503).json({ error: "L'assistant n'est pas encore configuré. Contactez OKIM ART directement." });
      }
      console.error("[assistant] échec appel Anthropic :", e.message);
      return res.status(502).json({ error: "L'assistant est momentanément indisponible. Contactez OKIM ART directement, ou réessayez dans un instant." });
    }

    await db.prepare("INSERT INTO assistant_messages (conversation_id, role, contenu) VALUES (?,'assistant',?)").run(conversation.id, reply.text);
    await db.prepare("UPDATE assistant_conversations SET updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?").run(conversation.id);

    if (reply.needsHuman && !conversation.needs_human) {
      await db.prepare("UPDATE assistant_conversations SET needs_human = 1 WHERE id = ?").run(conversation.id);
      // Transforme la demande en message de contact classique, pour que
      // l'admin la retrouve exactement au même endroit qu'un message envoyé
      // depuis le formulaire de contact — un seul flux à surveiller.
      const recap = history.filter((h) => h.role === "user").map((h) => h.contenu).join(" / ").slice(0, 500);
      await db.prepare("INSERT INTO messages (nom, email, telephone, sujet, message) VALUES (?,?,?,?,?)")
        .run("Visiteur (via okim.box)", "non-fourni@okimart.studio", "", "Conversation transférée par l'assistant IA", recap);
      notifyAdminInApp("assistant_handoff", "Une conversation okim.box nécessite un humain", recap.slice(0, 100), "#messages");
      fireEvent("assistant.handoff", { subject: "OKIM ART — okim.box a transféré une conversation", html: `<p>${recap.replace(/\n/g, "<br>")}</p>`, payload: { session_id, recap } });
    }

    res.json({ session_id, reply: reply.text, needs_human: reply.needsHuman });
  } catch (e) {
    console.error("[assistant] erreur inattendue :", e);
    res.status(500).json({ error: "Une erreur est survenue. Réessayez, ou contactez OKIM ART directement." });
  }
});

module.exports = router;
