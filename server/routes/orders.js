// ============================================================
// orders.js — création de commande (panier -> checkout), public
// ============================================================
const express = require("express");
const { nanoid } = require("nanoid");
const { db, transaction } = require("../db");
const { idempotent } = require("../utils/idempotency");

const router = express.Router();

function generateNumero() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  return `OKA-${stamp}-${nanoid(6).toUpperCase()}`;
}

// Le montant est TOUJOURS recalculé côté serveur à partir des prix réels en
// base — on ne fait jamais confiance à un prix envoyé par le navigateur.
//
// Protection contre les commandes en double : si le navigateur envoie un
// en-tête "Idempotency-Key", la commande n'est créée qu'UNE fois, quel que
// soit le nombre de réémissions (timeout, réveil du serveur, file hors-ligne).
// La commande et ses lignes sont écrites dans UNE transaction (avant : une
// coupure entre les deux pouvait laisser une commande sans articles).
const MAX_ITEMS = 50;

router.post("/", idempotent("order", async (req, res) => {
  const { items, client } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Le panier est vide." });
  if (items.length > MAX_ITEMS) return res.status(400).json({ error: "Panier trop volumineux." });
  const clientNom = String(client?.nom ?? "").trim().slice(0, 120);
  const clientEmail = String(client?.email ?? "").trim().slice(0, 254);
  const clientTel = String(client?.telephone ?? "").trim().slice(0, 40);
  if (!clientNom || !clientEmail) return res.status(400).json({ error: "Nom et email requis." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clientEmail)) return res.status(400).json({ error: "Adresse e-mail invalide." });

  const ids = [];
  for (const it of items) {
    const pid = Number(it?.product_id);
    if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: "Produit invalide dans le panier." });
    if (it.plan_id != null && it.plan_id !== "" && !(Number.isInteger(Number(it.plan_id)) && Number(it.plan_id) > 0)) {
      return res.status(400).json({ error: "Formule invalide dans le panier." });
    }
    ids.push(pid);
  }

  // Requêtes groupées (avant : 1 à 3 requêtes par article = problème N+1).
  const uniqueIds = [...new Set(ids)];
  const products = await db.prepare("SELECT * FROM products WHERE id = ANY(?) AND statut = 'actif'").all(uniqueIds);
  const productById = new Map(products.map((p) => [p.id, p]));
  const softwareRows = await db.prepare("SELECT product_id FROM software_products WHERE product_id = ANY(?)").all(uniqueIds);
  const softwareIds = new Set(softwareRows.map((r) => r.product_id));
  const planIds = [...new Set(items.filter((it) => it.plan_id).map((it) => Number(it.plan_id)))];
  const plans = planIds.length ? await db.prepare(`
    SELECT sp.*, sw.product_id AS owner_product_id FROM software_plans sp
    JOIN software_products sw ON sw.id = sp.software_id
    WHERE sp.id = ANY(?) AND sp.statut = 'actif'
  `).all(planIds) : [];
  const planById = new Map(plans.map((p) => [p.id, p]));

  let montant = 0;
  const resolved = [];
  for (const it of items) {
    const pid = Number(it.product_id);
    const p = productById.get(pid);
    if (!p) return res.status(400).json({ error: `Produit introuvable ou indisponible (id ${pid}).` });
    const qte = Math.min(99, Math.max(1, Number(it.quantite) || 1));

    // Prix TOUJOURS recalculé côté serveur. Pour un logiciel acheté avec une
    // formule (plan_id), c'est le prix de LA FORMULE qui fait foi, et on
    // vérifie que la formule appartient bien à CE logiciel.
    let unitPrice = p.prix;
    let planId = null;
    if (it.plan_id) {
      const plan = planById.get(Number(it.plan_id));
      if (!plan || plan.owner_product_id !== pid) return res.status(400).json({ error: `Formule introuvable ou indisponible pour le produit ${pid}.` });
      unitPrice = plan.prix;
      planId = plan.id;
    } else if (softwareIds.has(pid)) {
      return res.status(400).json({ error: "Veuillez sélectionner une formule pour ce logiciel." });
    }

    montant += unitPrice * qte;
    resolved.push({ product: p, quantite: qte, unitPrice, planId });
  }

  // Rattachement automatique à un compte client existant si connecté (facultatif).
  let clientId = null;
  try {
    const cookieToken = req.cookies?.okimart_client_token;
    if (cookieToken) {
      const { SECRET } = require("../middleware/auth");
      const jwt = require("jsonwebtoken");
      const decoded = jwt.verify(cookieToken, SECRET);
      if (decoded.type === "client") clientId = decoded.id;
    }
  } catch (_) { /* pas connecté, on continue en invité */ }

  const numero = generateNumero();
  const orderId = await transaction(async (tx) => {
    const info = await tx.prepare(`
      INSERT INTO orders (numero, client_id, client_nom, client_email, client_telephone, montant, statut)
      VALUES (?,?,?,?,?,?, 'en_attente')
    `).run(numero, clientId, clientNom, clientEmail, clientTel, montant);
    for (const r of resolved) {
      await tx.prepare("INSERT INTO order_items (order_id, product_id, titre, prix_unitaire, quantite, plan_id) VALUES (?,?,?,?,?,?)")
        .run(info.lastInsertRowid, r.product.id, r.product.titre, r.unitPrice, r.quantite, r.planId);
    }
    return info.lastInsertRowid;
  });

  res.status(201).json({
    ok: true,
    order: { id: orderId, numero, montant, statut: "en_attente" },
    note: "Commande enregistrée. Le paiement (mobile money / espèces / virement) est confirmé manuellement par OKIM ART, qui valide ensuite la commande depuis le tableau de bord pour débloquer le téléchargement."
  });
}));

module.exports = router;
