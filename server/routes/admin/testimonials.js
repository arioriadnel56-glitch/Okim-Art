// ============================================================
// admin/testimonials.js — modération des témoignages clients
// ============================================================
// Un témoignage soumis par un client n'est JAMAIS visible publiquement
// avant validation explicite par un admin (statut 'publie'). Voir
// server/routes/public.js pour la seule route publique, qui ne renvoie
// que statut = 'publie'.
const express = require("express");
const { db } = require("../../db");
const { notifyClientInApp } = require("../../utils/notifications");
const { redactClientId } = require("../../utils/adminAccess");
const router = express.Router();

router.get("/", async (req, res) => {
  const { statut } = req.query;
  const testimonials = statut
    ? await db.prepare("SELECT * FROM testimonials WHERE statut = ? ORDER BY created_at DESC").all(statut)
    : await db.prepare("SELECT * FROM testimonials ORDER BY created_at DESC").all();
  res.json({ testimonials: testimonials.map(t => redactClientId(t, req)) });
});

router.patch("/:id/statut", async (req, res) => {
  const { statut } = req.body || {};
  if (!["en_attente", "publie", "rejete"].includes(statut)) return res.status(400).json({ error: "Statut invalide." });
  const t = await db.prepare("SELECT * FROM testimonials WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Témoignage introuvable." });
  await db.prepare("UPDATE testimonials SET statut = ? WHERE id = ?").run(statut, req.params.id);
  if (statut === "publie" && t.client_id) {
    notifyClientInApp(t.client_id, "testimonial_published", "Votre témoignage a été publié",
      "Merci de l'avoir partagé — il est désormais visible sur le site.", "index.html#about");
  }
  res.json({ ok: true });
});

// Suppression directe (pas de corbeille ici : un témoignage rejeté ou
// obsolète n'a pas la valeur "récupérable" d'une photo ou d'un produit).
router.delete("/:id", async (req, res) => {
  const t = await db.prepare("SELECT * FROM testimonials WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Témoignage introuvable." });
  await db.prepare("DELETE FROM testimonials WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
