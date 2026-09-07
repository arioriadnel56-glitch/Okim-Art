// ============================================================
// admin/licenses.js — gestion des licences & journal des téléchargements
// ============================================================
const express = require("express");
const { db } = require("../../db");
const { generateLicenseKey, computeExpiry } = require("../../utils/licenses");
const { redactClientId } = require("../../utils/adminAccess");
const router = express.Router();

const VALID_STATUTS = ["active", "expiree", "suspendue", "annulee"];

router.get("/", async (req, res) => {
  const { q, status } = req.query;
  let sql = `
    SELECT l.*, p.titre AS logiciel_nom, sp.nom AS plan_nom, c.nom AS client_nom, c.email AS client_email
    FROM licenses l
    JOIN software_products sw ON sw.id = l.software_id
    JOIN products p ON p.id = sw.product_id
    LEFT JOIN software_plans sp ON sp.id = l.plan_id
    LEFT JOIN clients c ON c.id = l.client_id
    WHERE 1=1`;
  const params = [];
  if (status && VALID_STATUTS.includes(status)) { sql += " AND l.status = ?"; params.push(status); }
  if (q) {
    sql += " AND (l.license_key ILIKE ? OR c.email ILIKE ? OR c.nom ILIKE ? OR p.titre ILIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += " ORDER BY l.created_at DESC";
  const licenses = await db.prepare(sql).all(...params);
  res.json({ licenses: licenses.map(l => redactClientId(l, req)) });
});

// Génération manuelle (ex. licence offerte, support client, partenariat).
router.post("/", async (req, res) => {
  const { software_id, plan_id, client_id, max_devices, max_users, expires_at, periodicite } = req.body || {};
  const software = await db.prepare("SELECT * FROM software_products WHERE id = ?").get(software_id);
  if (!software) return res.status(400).json({ error: "Logiciel invalide." });

  let plan = null;
  if (plan_id) {
    plan = await db.prepare("SELECT * FROM software_plans WHERE id = ? AND software_id = ?").get(plan_id, software_id);
    if (!plan) return res.status(400).json({ error: "Formule invalide pour ce logiciel." });
  }

  const licenseKey = generateLicenseKey();
  const finalExpires = expires_at || (plan ? computeExpiry(plan.periodicite) : (periodicite ? computeExpiry(periodicite) : null));

  const info = await db.prepare(`
    INSERT INTO licenses (license_key, software_id, plan_id, client_id, status, max_devices, max_users, expires_at)
    VALUES (?,?,?,?, 'active', ?, ?, ?)
  `).run(licenseKey, software_id, plan_id || null, client_id || null,
         Number(max_devices) || (plan ? plan.max_devices : 1),
         Number(max_users) || (plan ? plan.max_users : 1), finalExpires);

  res.status(201).json({ license: redactClientId(await db.prepare("SELECT * FROM licenses WHERE id = ?").get(info.lastInsertRowid), req) });
});

router.patch("/:id/status", async (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUTS.includes(status)) return res.status(400).json({ error: "Statut invalide." });
  const license = await db.prepare("SELECT * FROM licenses WHERE id = ?").get(req.params.id);
  if (!license) return res.status(404).json({ error: "Licence introuvable." });
  await db.prepare("UPDATE licenses SET status = ? WHERE id = ?").run(status, license.id);
  res.json({ ok: true, license: redactClientId(await db.prepare("SELECT * FROM licenses WHERE id = ?").get(license.id), req) });
});

// Prolongation : ajoute N jours à la date d'expiration actuelle (ou à
// aujourd'hui si la licence était permanente / déjà expirée).
router.post("/:id/extend", async (req, res) => {
  const { days } = req.body || {};
  const nbDays = Number(days);
  if (!nbDays || nbDays <= 0) return res.status(400).json({ error: "Nombre de jours invalide." });
  const license = await db.prepare("SELECT * FROM licenses WHERE id = ?").get(req.params.id);
  if (!license) return res.status(404).json({ error: "Licence introuvable." });
  const base = license.expires_at && new Date(license.expires_at) > new Date() ? new Date(license.expires_at) : new Date();
  base.setDate(base.getDate() + nbDays);
  await db.prepare("UPDATE licenses SET expires_at = ?, status = 'active' WHERE id = ?").run(base.toISOString(), license.id);
  res.json({ ok: true, license: redactClientId(await db.prepare("SELECT * FROM licenses WHERE id = ?").get(license.id), req) });
});

module.exports = router;
