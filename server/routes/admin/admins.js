// ============================================================
// admin/admins.js — gestion des comptes admin (réservé au propriétaire)
// ============================================================
const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("../../db");
const router = express.Router();

router.get("/", async (req, res) => {
  const admins = await db.prepare("SELECT id, nom, email, role, created_at FROM admins ORDER BY created_at ASC").all();
  res.json({ admins });
});

router.post("/", async (req, res) => {
  const { nom, email, password, role } = req.body || {};
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom est requis." });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Email invalide." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Mot de passe (8 caractères min.) requis." });

  const normalizedEmail = String(email).toLowerCase().trim();
  const existing = await db.prepare("SELECT id FROM admins WHERE email = ?").get(normalizedEmail);
  if (existing) return res.status(409).json({ error: "Un compte existe déjà avec cet email." });

  // Un compte créé depuis cette route est toujours "admin" (accès complet,
  // sauf Paramètres/Comptes) ou "secretary" (Contenu + Boutique + Clients,
  // sans suppression) — jamais "owner" : un seul propriétaire, celui qui
  // existe déjà depuis l'installation de la plateforme.
  const finalRole = role === "secretary" ? "secretary" : "admin";
  const hash = bcrypt.hashSync(password, 12);
  const info = await db.prepare("INSERT INTO admins (nom, email, password_hash, role) VALUES (?,?,?,?)")
    .run(nom.trim(), normalizedEmail, hash, finalRole);
  res.status(201).json({ ok: true, admin: { id: info.lastInsertRowid, nom: nom.trim(), email: normalizedEmail, role: finalRole } });
});

router.delete("/:id", async (req, res) => {
  const target = await db.prepare("SELECT * FROM admins WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "Compte introuvable." });
  if (target.role === "owner") return res.status(403).json({ error: "Le compte propriétaire ne peut pas être supprimé." });
  if (String(target.id) === String(req.admin.id)) return res.status(400).json({ error: "Vous ne pouvez pas supprimer votre propre session en cours." });
  await db.prepare("DELETE FROM admins WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
