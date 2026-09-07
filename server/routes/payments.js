// ============================================================
// payments.js — alias explicite /api/payments/kkiapay-webhook
// ============================================================
// Route dédiée demandée pour le module "Galerie client & récupération
// sécurisée", qui délègue au MÊME handler que /api/kkiapay/webhook (déjà
// utilisé par la boutique). Les deux chemins acceptent les notifications
// KKiaPay de façon strictement identique — inutile de configurer deux
// webhooks différents côté KKiaPay, un seul suffit, quelle que soit
// l'URL choisie par l'admin.
const express = require("express");
const { handleKkiapayWebhook } = require("./kkiapay");

const router = express.Router();

router.post("/kkiapay-webhook", (req, res) => { handleKkiapayWebhook(req, res).catch((e) => { console.error("[payments webhook]", e); res.status(200).json({ ok: false }); }); });

module.exports = router;
