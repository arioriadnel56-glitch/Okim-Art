// ============================================================
// public.js — API publique lue par le site vitrine (lecture seule)
// ============================================================
const express = require("express");
const { db } = require("../db");
const { fireEvent } = require("../utils/notify");
const { notifyAdminInApp } = require("../utils/notifications");
const data = require("../utils/publicData");
const { idempotent } = require("../utils/idempotency");
const { buildSnapshot } = require("../utils/snapshot");

const router = express.Router();

// Lecture publique : cache court côté navigateur/CDN (les données changent
// rarement). Le frontend lit surtout l'instantané CDN (utils/snapshot.js) ;
// ces routes servent de repli et de source "live" quand le backend est réveillé.
// Validation / nettoyage des champs saisis par des visiteurs anonymes.
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const isEmail = (v) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(v);
const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function publicCache(res) { res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300"); }

router.get("/settings", async (req, res) => { publicCache(res); res.json({ settings: await data.getSettings() }); });
router.get("/categories", async (req, res) => { publicCache(res); res.json({ categories: await data.getCategories() }); });
// ?limit= (défaut 200, max 500) et ?offset= : pagination optionnelle.
router.get("/photos", async (req, res) => { publicCache(res); res.json({ photos: await data.getPhotos(req.query) }); });
router.get("/services", async (req, res) => { publicCache(res); res.json({ services: await data.getServices() }); });
router.get("/formations", async (req, res) => { publicCache(res); res.json({ formations: await data.getFormations() }); });
router.get("/products", async (req, res) => { publicCache(res); res.json({ products: await data.getProducts() }); });

// ---------- Boutique "Outils & Logiciels" ----------
router.get("/software", async (req, res) => { publicCache(res); res.json({ software: await data.getSoftwareList(req.query) }); });
router.get("/software/:productId", async (req, res) => {
  const software = await data.getSoftwareDetail(req.params.productId);
  if (!software) return res.status(404).json({ error: "Logiciel introuvable." });
  publicCache(res);
  res.json({ software });
});

// Instantané complet des données publiques (même contenu que le fichier CDN).
router.get("/snapshot", async (req, res) => { publicCache(res); res.json(await buildSnapshot()); });

router.post("/formations/:id/inscriptions", idempotent("inscription", async (req, res) => {
  const b = req.body || {};
  const nom = str(b.nom, 120), email = str(b.email, 254).toLowerCase(), telephone = str(b.telephone, 40);
  if (!nom || !email) return res.status(400).json({ error: "Nom et email requis." });
  if (!isEmail(email)) return res.status(400).json({ error: "Adresse e-mail invalide." });
  const formation = await db.prepare("SELECT id, titre FROM formations WHERE id = ? AND statut = 'actif'").get(req.params.id);
  if (!formation) return res.status(404).json({ error: "Formation introuvable." });
  await db.prepare("INSERT INTO inscriptions_formation (formation_id, nom, email, telephone) VALUES (?,?,?,?)")
    .run(formation.id, nom, email, telephone);

  fireEvent("formation.inscription.new", {
    subject: `OKIM ART — Nouvelle inscription : ${formation.titre}`,
    html: `<p><strong>${escHtml(nom)}</strong> (${escHtml(email)}${telephone ? ", " + escHtml(telephone) : ""}) vient de s'inscrire à la formation <strong>${escHtml(formation.titre)}</strong>.</p>`,
    payload: { formation_id: formation.id, formation_titre: formation.titre, nom, email, telephone }
  });
  notifyAdminInApp("inscription_new", `Nouvelle inscription — ${formation.titre}`, `${nom} (${email})`, "#formations");

  res.json({ ok: true });
}));

router.post("/messages", idempotent("message", async (req, res) => {
  const b = req.body || {};
  const nom = str(b.nom, 120), email = str(b.email, 254).toLowerCase(), telephone = str(b.telephone, 40);
  const sujet = str(b.sujet, 200), message = str(b.message, 5000);
  if (!nom || !email || !message) return res.status(400).json({ error: "Nom, email et message requis." });
  if (!isEmail(email)) return res.status(400).json({ error: "Adresse e-mail invalide." });
  await db.prepare("INSERT INTO messages (nom, email, telephone, sujet, message) VALUES (?,?,?,?,?)")
    .run(nom, email, telephone, sujet, message);

  fireEvent("message.new", {
    subject: `OKIM ART — Nouveau message de ${nom}${sujet ? " : " + sujet : ""}`.replace(/[\r\n]+/g, " "),
    html: `<p><strong>${escHtml(nom)}</strong> (${escHtml(email)}${telephone ? ", " + escHtml(telephone) : ""}) :</p><p>${escHtml(message).replace(/\n/g, "<br>")}</p>`,
    payload: { nom, email, telephone, sujet, message }
  });
  notifyAdminInApp("message_new", `Nouveau message — ${nom}`, sujet || message.slice(0, 80), "#messages");

  res.json({ ok: true });
}));

// Témoignages publiés — SEULE route sans authentification exposant des témoignages ;
// jamais que statut='publie', jamais l'email du client (voir publicData.js).
router.get("/testimonials", async (req, res) => { publicCache(res); res.json({ testimonials: await data.getTestimonials() }); });

module.exports = router;
