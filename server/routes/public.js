// ============================================================
// public.js — API publique lue par le site vitrine (lecture seule)
// ============================================================
const express = require("express");
const { db } = require("../db");
const { fireEvent } = require("../utils/notify");
const { notifyAdminInApp } = require("../utils/notifications");

const router = express.Router();

// Seules ces clés sont exposées au site public. Toute future clé "sensible"
// (secrets, clés privées...) doit vivre dans secure_settings et NE JAMAIS
// être ajoutée ici, quelle que soit la façon dont on lit la table settings.
const PUBLIC_SETTINGS_KEYS = [
  "site_nom", "slogan", "bio", "photographe_nom", "photographe_photo", "ville", "site_url",
  "telephone_1", "telephone_2", "whatsapp", "whatsapp_message", "email",
  "instagram", "facebook", "seo_title", "seo_description", "logo",
  "kkiapay_enabled", "kkiapay_public_key", "kkiapay_sandbox"
];

router.get("/settings", async (req, res) => {
  const placeholders = PUBLIC_SETTINGS_KEYS.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT cle, valeur FROM settings WHERE cle IN (${placeholders})`).all(...PUBLIC_SETTINGS_KEYS);
  const settings = {};
  rows.forEach(r => { settings[r.cle] = r.valeur; });
  res.json({ settings });
});

router.get("/categories", async (req, res) => {
  const categories = await db.prepare("SELECT id, nom, slug, description FROM categories ORDER BY nom").all();
  res.json({ categories });
});

router.get("/photos", async (req, res) => {
  const { category, featured } = req.query;
  let sql = `
    SELECT p.id, p.titre, p.description, p.miniature, p.a_la_une, p.type, c.slug AS categorie, c.nom AS categorie_nom
    FROM photos p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.statut = 'publie'`;
  const params = [];
  if (category) { sql += " AND c.slug = ?"; params.push(category); }
  if (featured === "1") { sql += " AND p.a_la_une = 1"; }
  sql += " ORDER BY p.ordre ASC, p.created_at DESC";
  const photos = await db.prepare(sql).all(...params);
  res.json({ photos });
});

router.get("/services", async (req, res) => {
  const services = await db.prepare("SELECT id, titre, description, image, prix FROM services WHERE statut = 'actif' ORDER BY ordre ASC, created_at ASC").all();
  res.json({ services });
});

router.get("/formations", async (req, res) => {
  const formations = await db.prepare(`
    SELECT id, titre, description, programme, image, prix, duree, date_session, lieu, places
    FROM formations WHERE statut = 'actif' ORDER BY ordre ASC, created_at ASC
  `).all();
  res.json({ formations });
});

router.get("/products", async (req, res) => {
  // Seules les photos (type='photo') sortent ici, comme avant l'ajout du
  // module Logiciels — la boutique "Outils & Logiciels" a ses propres
  // routes ci-dessous (/software, /software/:slug), la tarification d'un
  // logiciel se faisant par formules (plans) et non par un prix unique.
  const products = await db.prepare(`
    SELECT id, titre, description, prix, licence, apercu
    FROM products WHERE statut = 'actif' AND type = 'photo' ORDER BY created_at DESC
  `).all();
  res.json({ products });
});

// ---------- Boutique "Outils & Logiciels" ----------
router.get("/software", async (req, res) => {
  const { category, licence, badge, sort } = req.query;
  let sql = `
    SELECT p.id, p.titre AS nom, p.description, sw.slogan, sw.plateforme, sw.licence_type,
           sw.badge, sw.popularite, sw.captures, p.apercu, c.slug AS categorie, c.nom AS categorie_nom,
           (SELECT MIN(prix) FROM software_plans WHERE software_id = sw.id AND statut = 'actif') AS prix_a_partir_de
    FROM products p
    JOIN software_products sw ON sw.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.statut = 'actif'`;
  const params = [];
  if (category) { sql += " AND c.slug = ?"; params.push(category); }
  if (licence) { sql += " AND sw.licence_type = ?"; params.push(licence); }
  if (badge) { sql += " AND sw.badge = ?"; params.push(badge); }
  sql += sort === "prix_asc" ? " ORDER BY prix_a_partir_de ASC NULLS LAST"
    : sort === "prix_desc" ? " ORDER BY prix_a_partir_de DESC NULLS LAST"
    : sort === "populaire" ? " ORDER BY sw.popularite DESC"
    : " ORDER BY p.created_at DESC";
  const software = await db.prepare(sql).all(...params);
  res.json({ software: software.map((s) => ({ ...s, captures: JSON.parse(s.captures || "[]") })) });
});

router.get("/software/:productId", async (req, res) => {
  const product = await db.prepare("SELECT * FROM products WHERE id = ? AND statut = 'actif' AND type = 'logiciel'").get(req.params.productId);
  if (!product) return res.status(404).json({ error: "Logiciel introuvable." });
  const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(product.id);
  if (!software) return res.status(404).json({ error: "Logiciel introuvable." });
  const plans = await db.prepare("SELECT * FROM software_plans WHERE software_id = ? AND statut = 'actif' ORDER BY ordre ASC, prix ASC").all(software.id);
  const lastVersion = await db.prepare("SELECT version, notes, published_at FROM software_versions WHERE software_id = ? ORDER BY published_at DESC LIMIT 1").get(software.id);
  res.json({
    software: {
      ...software,
      captures: JSON.parse(software.captures || "[]"),
      titre: product.titre,
      description: product.description,
      apercu: product.apercu,
      plans: plans.map((p) => ({ ...p, fonctionnalites: JSON.parse(p.fonctionnalites || "[]") })),
      derniere_version: lastVersion || null
    }
  });
});

router.post("/formations/:id/inscriptions", async (req, res) => {
  const { nom, email, telephone } = req.body || {};
  if (!nom || !email) return res.status(400).json({ error: "Nom et email requis." });
  const formation = await db.prepare("SELECT id, titre FROM formations WHERE id = ? AND statut = 'actif'").get(req.params.id);
  if (!formation) return res.status(404).json({ error: "Formation introuvable." });
  await db.prepare("INSERT INTO inscriptions_formation (formation_id, nom, email, telephone) VALUES (?,?,?,?)")
    .run(formation.id, nom, email, telephone || "");

  fireEvent("formation.inscription.new", {
    subject: `OKIM ART — Nouvelle inscription : ${formation.titre}`,
    html: `<p><strong>${nom}</strong> (${email}${telephone ? ", " + telephone : ""}) vient de s'inscrire à la formation <strong>${formation.titre}</strong>.</p>`,
    payload: { formation_id: formation.id, formation_titre: formation.titre, nom, email, telephone }
  });
  notifyAdminInApp("inscription_new", `Nouvelle inscription — ${formation.titre}`, `${nom} (${email})`, "#formations");

  res.json({ ok: true });
});

router.post("/messages", async (req, res) => {
  const { nom, email, telephone, sujet, message } = req.body || {};
  if (!nom || !email || !message) return res.status(400).json({ error: "Nom, email et message requis." });
  await db.prepare("INSERT INTO messages (nom, email, telephone, sujet, message) VALUES (?,?,?,?,?)")
    .run(nom, email, telephone || "", sujet || "", message);

  fireEvent("message.new", {
    subject: `OKIM ART — Nouveau message de ${nom}${sujet ? " : " + sujet : ""}`,
    html: `<p><strong>${nom}</strong> (${email}${telephone ? ", " + telephone : ""}) :</p><p>${message.replace(/\n/g, "<br>")}</p>`,
    payload: { nom, email, telephone, sujet, message }
  });
  notifyAdminInApp("message_new", `Nouveau message — ${nom}`, sujet || message.slice(0, 80), "#messages");

  res.json({ ok: true });
});

// Témoignages publiés — c'est la SEULE route qui expose des témoignages
// sans authentification, et elle ne renvoie jamais que statut='publie'
// (jamais un témoignage en attente de modération, jamais l'email du client).
router.get("/testimonials", async (req, res) => {
  const testimonials = await db.prepare(`
    SELECT id, nom, texte, note, created_at FROM testimonials
    WHERE statut = 'publie'
    ORDER BY created_at DESC
    LIMIT 30
  `).all();
  res.json({ testimonials });
});

module.exports = router;
