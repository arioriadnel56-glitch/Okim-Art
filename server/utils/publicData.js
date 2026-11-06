// ============================================================
// publicData.js — lecture des données PUBLIQUES de la vitrine
// ============================================================
// Source unique utilisée par :
//  - les routes /api/* publiques (routes/public.js) ;
//  - le "snapshot" statique publié sur le CDN (utils/snapshot.js), que le
//    frontend lit sans réveiller le backend Render.
// Ne renvoie QUE ce que les routes publiques exposaient déjà (colonnes
// explicitement listées, jamais SELECT * sur des tables sensibles).
const { db } = require("../db");
const { optimizeImageUrl } = require("./images");

// Clés de réglages autorisées publiquement. Toute clé sensible doit vivre
// dans secure_settings et NE JAMAIS être ajoutée ici.
const PUBLIC_SETTINGS_KEYS = [
  "site_nom", "slogan", "bio", "photographe_nom", "photographe_photo", "ville", "site_url",
  "telephone_1", "telephone_2", "whatsapp", "whatsapp_message", "email",
  "instagram", "facebook", "seo_title", "seo_description", "logo",
  "kkiapay_enabled", "kkiapay_public_key", "kkiapay_sandbox"
];

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

async function getSettings() {
  const placeholders = PUBLIC_SETTINGS_KEYS.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT cle, valeur FROM settings WHERE cle IN (${placeholders})`).all(...PUBLIC_SETTINGS_KEYS);
  const settings = {};
  rows.forEach((r) => { settings[r.cle] = r.valeur; });
  if (settings.logo) settings.logo = optimizeImageUrl(settings.logo, 400);
  if (settings.photographe_photo) settings.photographe_photo = optimizeImageUrl(settings.photographe_photo, 900);
  return settings;
}

async function getCategories() {
  return db.prepare("SELECT id, nom, slug, description FROM categories ORDER BY nom").all();
}

async function getPhotos({ category, featured, limit, offset } = {}) {
  let sql = `
    SELECT p.id, p.titre, p.description, p.miniature, p.a_la_une, p.type, c.slug AS categorie, c.nom AS categorie_nom
    FROM photos p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.statut = 'publie'`;
  const params = [];
  if (category) { sql += " AND c.slug = ?"; params.push(category); }
  if (featured === "1" || featured === 1) sql += " AND p.a_la_une = 1";
  sql += " ORDER BY p.ordre ASC, p.created_at DESC LIMIT ? OFFSET ?";
  params.push(clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT), clampInt(offset, 0, 0, 1e9));
  const rows = await db.prepare(sql).all(...params);
  return rows.map((p) => ({ ...p, miniature: p.type === "video" ? p.miniature : optimizeImageUrl(p.miniature, 900) }));
}

async function getServices() {
  const rows = await db.prepare("SELECT id, titre, description, image, prix FROM services WHERE statut = 'actif' ORDER BY ordre ASC, created_at ASC").all();
  return rows.map((s) => ({ ...s, image: optimizeImageUrl(s.image, 800) }));
}

async function getFormations() {
  const rows = await db.prepare(`
    SELECT id, titre, description, programme, image, prix, duree, date_session, lieu, places
    FROM formations WHERE statut = 'actif' ORDER BY ordre ASC, created_at ASC
  `).all();
  return rows.map((f) => ({ ...f, image: optimizeImageUrl(f.image, 800) }));
}

async function getProducts() {
  // Seules les photos (type='photo') : la boutique logiciels a ses routes propres.
  const rows = await db.prepare(`
    SELECT id, titre, description, prix, licence, apercu
    FROM products WHERE statut = 'actif' AND type = 'photo' ORDER BY created_at DESC LIMIT ?
  `).all(MAX_LIMIT);
  return rows.map((p) => ({ ...p, apercu: optimizeImageUrl(p.apercu, 800) }));
}

async function getSoftwareList({ category, licence, badge, sort } = {}) {
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
  sql += " LIMIT " + MAX_LIMIT;
  const rows = await db.prepare(sql).all(...params);
  return rows.map((s) => ({
    ...s,
    apercu: optimizeImageUrl(s.apercu, 800),
    captures: JSON.parse(s.captures || "[]").map((c) => optimizeImageUrl(c, 1200))
  }));
}

/** Retourne null si le logiciel n'existe pas / n'est pas actif. */
async function getSoftwareDetail(productId) {
  const product = await db.prepare("SELECT * FROM products WHERE id = ? AND statut = 'actif' AND type = 'logiciel'").get(productId);
  if (!product) return null;
  const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(product.id);
  if (!software) return null;
  const plans = await db.prepare("SELECT * FROM software_plans WHERE software_id = ? AND statut = 'actif' ORDER BY ordre ASC, prix ASC").all(software.id);
  const lastVersion = await db.prepare("SELECT version, notes, published_at FROM software_versions WHERE software_id = ? ORDER BY published_at DESC LIMIT 1").get(software.id);
  return {
    ...software,
    captures: JSON.parse(software.captures || "[]").map((c) => optimizeImageUrl(c, 1200)),
    titre: product.titre,
    description: product.description,
    apercu: optimizeImageUrl(product.apercu, 1200),
    plans: plans.map((p) => ({ ...p, fonctionnalites: JSON.parse(p.fonctionnalites || "[]") })),
    derniere_version: lastVersion || null
  };
}

async function getTestimonials() {
  // Uniquement statut='publie' — jamais un témoignage en attente, jamais l'email.
  return db.prepare(`
    SELECT id, nom, texte, note, created_at FROM testimonials
    WHERE statut = 'publie' ORDER BY created_at DESC LIMIT 30
  `).all();
}

/** Même contenu que GET /api/assistant/config (routes/assistant.js). */
async function getAssistantConfig() {
  const rows = await db.prepare("SELECT cle, valeur FROM settings WHERE cle IN ('assistant_enabled','assistant_name','assistant_intro')").all();
  const cfg = {};
  rows.forEach((r) => { cfg[r.cle] = r.valeur; });
  return { enabled: cfg.assistant_enabled === "1", name: cfg.assistant_name || "okim.box", intro: cfg.assistant_intro || "" };
}

module.exports = {
  getAssistantConfig,
  PUBLIC_SETTINGS_KEYS, getSettings, getCategories, getPhotos, getServices, getFormations,
  getProducts, getSoftwareList, getSoftwareDetail, getTestimonials
};
