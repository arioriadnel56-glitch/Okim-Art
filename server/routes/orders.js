// ============================================================
// orders.js — création de commande (panier -> checkout), public
// ============================================================
const express = require("express");
const { nanoid } = require("nanoid");
const { db } = require("../db");
const { requireClient } = require("../middleware/auth");

const router = express.Router();

function generateNumero() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  return `OKA-${stamp}-${nanoid(6).toUpperCase()}`;
}

// Le montant est TOUJOURS recalculé côté serveur à partir des prix réels en
// base — on ne fait jamais confiance à un prix envoyé par le navigateur.
router.post("/", async (req, res) => {
  const { items, client } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Le panier est vide." });
  if (!client?.nom || !client?.email) return res.status(400).json({ error: "Nom et email requis." });

  let montant = 0;
  const resolved = [];
  for (const it of items) {
    const p = await db.prepare("SELECT * FROM products WHERE id = ? AND statut = 'actif'").get(it.product_id);
    if (!p) return res.status(400).json({ error: `Produit introuvable ou indisponible (id ${it.product_id}).` });
    const qte = Math.max(1, Number(it.quantite) || 1);

    // Prix TOUJOURS recalculé côté serveur. Pour un logiciel acheté avec une
    // formule (plan_id), c'est le prix de LA FORMULE qui fait foi — jamais
    // p.prix (les logiciels n'ont pas de prix propre, seulement leurs plans)
    // — et on vérifie que la formule appartient bien à CE logiciel.
    let unitPrice = p.prix;
    let planId = null;
    if (it.plan_id) {
      const plan = await db.prepare(`
        SELECT sp.* FROM software_plans sp
        JOIN software_products sw ON sw.id = sp.software_id
        WHERE sp.id = ? AND sw.product_id = ? AND sp.statut = 'actif'
      `).get(it.plan_id, it.product_id);
      if (!plan) return res.status(400).json({ error: `Formule introuvable ou indisponible pour le produit ${it.product_id}.` });
      unitPrice = plan.prix;
      planId = plan.id;
    } else {
      const isSoftware = await db.prepare("SELECT 1 FROM software_products WHERE product_id = ?").get(it.product_id);
      if (isSoftware) return res.status(400).json({ error: "Veuillez sélectionner une formule pour ce logiciel." });
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
  const info = await db.prepare(`
    INSERT INTO orders (numero, client_id, client_nom, client_email, client_telephone, montant, statut)
    VALUES (?,?,?,?,?,?, 'en_attente')
  `).run(numero, clientId, client.nom, client.email, client.telephone || "", montant);

  for (const r of resolved) {
    await db.prepare("INSERT INTO order_items (order_id, product_id, titre, prix_unitaire, quantite, plan_id) VALUES (?,?,?,?,?,?)")
      .run(info.lastInsertRowid, r.product.id, r.product.titre, r.unitPrice, r.quantite, r.planId);
  }

  res.status(201).json({
    ok: true,
    order: { id: info.lastInsertRowid, numero, montant, statut: "en_attente" },
    note: "Commande enregistrée. Le paiement (mobile money / espèces / virement) est confirmé manuellement par OKIM ART, qui valide ensuite la commande depuis le tableau de bord pour débloquer le téléchargement."
  });
});

module.exports = router;
