const express = require("express");
const { db } = require("../../db");
const { markOrderPaid } = require("../../utils/orders");
const { streamDailyOrdersPdf } = require("../../utils/reports");
const { redactClientId } = require("../../utils/adminAccess");
const router = express.Router();

// ---------- Rapport PDF du flux journalier (tableau des commandes du jour) ----------
router.get("/report.pdf", async (req, res) => {
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "")
    ? req.query.date
    : new Date().toISOString().slice(0, 10);
  try {
    await streamDailyOrdersPdf(dateStr, res);
  } catch (e) {
    console.error("[report.pdf]", e);
    if (!res.headersSent) res.status(500).json({ error: "Échec de la génération du rapport." });
  }
});

// Filtres : ?statut=payee|en_attente|annulee|... et ?type=logiciel|photo
// (un article "logiciel" a toujours un plan_id ; une commande "logiciel"
// est une commande dont au moins un article a un plan_id).
router.get("/", async (req, res) => {
  const { statut, type } = req.query;
  let sql = "SELECT DISTINCT o.* FROM orders o";
  const params = [];
  const where = [];
  if (type === "logiciel") { sql += " JOIN order_items oi ON oi.order_id = o.id"; where.push("oi.plan_id IS NOT NULL"); }
  else if (type === "photo") { sql += " JOIN order_items oi ON oi.order_id = o.id"; where.push("oi.plan_id IS NULL"); }
  if (statut) { where.push("o.statut = ?"); params.push(statut); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY o.created_at DESC";

  const orders = await db.prepare(sql).all(...params);
  const withItems = [];
  for (const o of orders) {
    const items = await db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(o.id);
    const licenses = await db.prepare("SELECT id, license_key, status FROM licenses WHERE order_id = ?").all(o.id);
    withItems.push({ ...redactClientId(o, req), items, licenses });
  }
  res.json({ orders: withItems });
});

router.get("/:id", async (req, res) => {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Commande introuvable." });
  const items = await db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
  res.json({ order: { ...redactClientId(order, req), items } });
});

const VALID_STATUTS = ["en_attente", "payee", "echouee", "annulee", "livree"];

router.patch("/:id/statut", async (req, res) => {
  const { statut, note_admin, moyen_paiement } = req.body || {};
  if (!VALID_STATUTS.includes(statut)) return res.status(400).json({ error: "Statut invalide." });
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Commande introuvable." });

  // Passage à "payee" (ou "livree") : on délègue au helper partagé qui génère
  // automatiquement les liens de téléchargement sécurisés (même logique que
  // la confirmation automatique KKiaPay, pour ne jamais diverger).
  let generatedTokens = [];
  let generatedLicenses = [];
  if (statut === "payee" || statut === "livree") {
    const result = await markOrderPaid(order.id, moyen_paiement || "manuel");
    generatedTokens = result.tokens;
    generatedLicenses = result.licenses;
    if (note_admin !== undefined) await db.prepare("UPDATE orders SET note_admin = ? WHERE id = ?").run(note_admin, order.id);
    if (statut === "livree") await db.prepare("UPDATE orders SET statut = 'livree' WHERE id = ?").run(order.id);
  } else {
    await db.prepare("UPDATE orders SET statut=?, note_admin=?, moyen_paiement=? WHERE id=?")
      .run(statut, note_admin ?? order.note_admin, moyen_paiement ?? order.moyen_paiement, order.id);
  }

  res.json({
    ok: true,
    order: redactClientId(await db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id), req),
    download_tokens: generatedTokens,
    licenses: generatedLicenses
  });
});

// Suppression définitive d'une commande (ex. doublon, commande de test,
// erreur de saisie). Contrairement aux autres suppressions de la
// plateforme, ceci ne passe PAS par la Corbeille : une commande est un
// enregistrement financier/comptable, pas un contenu éditorial, et sa
// structure (articles + jetons de téléchargement liés) ne s'y prête pas
// simplement. Suppression immédiate et irréversible, articles et jetons
// de téléchargement liés supprimés automatiquement (contrainte de la base).
router.delete("/:id", async (req, res) => {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Commande introuvable." });
  await db.prepare("DELETE FROM orders WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
