// ============================================================
// kkiapay.js — intégration du paiement Mobile Money / carte via KKiaPay
// ============================================================
// Fonctionnement (conforme à la documentation officielle KKiaPay) :
//  1. Le client paie via le widget KKiaPay affiché sur la page panier.
//  2. KKiaPay notifie NOTRE SERVEUR en arrière-plan via un webhook signé
//     (en-tête x-kkiapay-secret comparé au secret généré automatiquement,
//     configurable dans Paramètres → Paiement). C'est la seule source de
//     vérité : un identifiant de transaction n'est considéré payé QUE s'il
//     apparaît ici avec success = 1.
//  3. Le navigateur du client, de son côté, reçoit aussi la confirmation
//     (addSuccessListener du widget) et appelle /kkiapay-confirm avec cet
//     identifiant — on ne débloque le téléchargement que si l'événement
//     webhook correspondant a déjà été reçu ET que le montant correspond
//     exactement à celui de la commande.
const express = require("express");
const crypto = require("crypto");
const { db, getSecureSetting } = require("../db");
const { markOrderPaid } = require("../utils/orders");

const router = express.Router();

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Logique centrale du webhook, appelée par les deux chemins exposés
// ci-dessous (/kkiapay/webhook et /payments/kkiapay-webhook) : un seul
// secret à configurer côté KKiaPay, quelle que soit l'URL choisie —
// utile car ce même webhook sert à la fois la boutique et le module
// "Galerie client & récupération sécurisée".
async function handleKkiapayWebhook(req, res) {
  const configuredSecret = await getSecureSetting("kkiapay_webhook_secret");
  const receivedSecret = req.get("x-kkiapay-secret");

  if (!configuredSecret || !receivedSecret || !safeEqual(receivedSecret, configuredSecret)) {
    // On répond 200 malgré tout pour ne pas révéler d'information à un
    // tiers qui tenterait de deviner le secret par tâtonnement, mais on
    // n'enregistre rien.
    return res.status(200).json({ ok: false });
  }

  const payload = req.body || {};
  const transactionId = payload.transactionId;
  if (!transactionId) return res.status(200).json({ ok: false });

  const success = payload.isPaymentSucces === true || payload.event === "transaction.success";

  await db.prepare(`
    INSERT INTO kkiapay_events (transaction_id, success, amount, method, account, raw_json)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(transaction_id) DO UPDATE SET
      success = excluded.success, amount = excluded.amount,
      method = excluded.method, account = excluded.account, raw_json = excluded.raw_json
  `).run(
    transactionId,
    success ? 1 : 0,
    payload.amount ?? null,
    payload.method || "",
    payload.account || "",
    JSON.stringify(payload)
  );

  res.status(200).json({ ok: true });
}

// ---------- Webhook (appelé par KKiaPay, pas par le navigateur) ----------
router.post("/kkiapay/webhook", (req, res) => { handleKkiapayWebhook(req, res).catch((e) => { console.error("[kkiapay webhook]", e); res.status(200).json({ ok: false }); }); });

// ---------- Confirmation déclenchée par le navigateur du client ----------
router.post("/orders/:id/kkiapay-confirm", async (req, res) => {
  const { transactionId } = req.body || {};
  if (!transactionId) return res.status(400).json({ error: "Identifiant de transaction manquant." });

  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Commande introuvable." });

  if (order.statut === "payee" || order.statut === "livree") {
    const tokens = await db.prepare(`
      SELECT dt.token, oi.product_id, oi.titre
      FROM download_tokens dt JOIN order_items oi ON oi.product_id = dt.product_id AND oi.order_id = dt.order_id
      WHERE dt.order_id = ?
    `).all(order.id);
    const licenses = await db.prepare("SELECT * FROM licenses WHERE order_id = ?").all(order.id);
    return res.json({ ok: true, order, download_tokens: tokens, licenses });
  }

  const event = await db.prepare("SELECT * FROM kkiapay_events WHERE transaction_id = ?").get(transactionId);
  if (!event || !event.success) {
    // Le webhook n'est peut-être pas encore arrivé (léger délai réseau) —
    // le client réessaiera automatiquement quelques secondes plus tard.
    return res.status(202).json({ ok: false, pending: true, message: "Vérification du paiement en cours…" });
  }

  if (event.amount !== null && Number(event.amount) !== Number(order.montant)) {
    return res.status(400).json({ error: "Le montant de la transaction ne correspond pas à celui de la commande." });
  }

  // FAILLE CORRIGÉE : sans cette étape, un transactionId "success" pour UNE
  // commande pouvait être rejoué tel quel sur n'importe quelle AUTRE commande
  // de même montant pour la débloquer sans payer une seconde fois. On
  // réserve maintenant explicitement ce transactionId à CETTE commande —
  // l'index UNIQUE (voir db.js) empêche toute réutilisation concurrente
  // même en cas de deux requêtes simultanées (condition de course).
  try {
    await db.prepare("UPDATE orders SET kkiapay_transaction_id = ? WHERE id = ?").run(transactionId, order.id);
  } catch (e) {
    if (e.code === "23505") {
      // Violation de la contrainte UNIQUE (code Postgres standard) : ce
      // transactionId est déjà rattaché à une autre commande — on refuse,
      // sans jamais indiquer laquelle.
      return res.status(409).json({ error: "Cette transaction a déjà été utilisée pour une autre commande. Contactez OKIM ART si vous pensez qu'il s'agit d'une erreur." });
    }
    throw e; // toute autre erreur (panne DB...) doit remonter normalement, pas être masquée en "409".
  }

  const result = await markOrderPaid(order.id, "kkiapay");
  res.json({ ok: true, order: result.order, download_tokens: result.tokens, licenses: result.licenses });
});

module.exports = router;
module.exports.handleKkiapayWebhook = handleKkiapayWebhook;
