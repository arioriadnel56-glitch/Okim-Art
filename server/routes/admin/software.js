// ============================================================
// admin/software.js — gestion des logiciels, formules (plans) et versions
// ============================================================
const express = require("express");
const { db } = require("../../db");
const {
  uploadMemory, uploadSoftwareFile, savePublicVersion, saveSoftwareFile,
  deletePublicFile, deletePrivateFile
} = require("../../utils/upload");

const router = express.Router();

function parseJsonArray(v, fallback = []) {
  if (Array.isArray(v)) return v;
  if (!v) return fallback;
  try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : fallback; } catch (e) { return fallback; }
}

async function fullSoftware(productId) {
  const product = await db.prepare("SELECT * FROM products WHERE id = ? AND type = 'logiciel'").get(productId);
  if (!product) return null;
  const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(productId);
  if (!software) return null;
  const plans = await db.prepare("SELECT * FROM software_plans WHERE software_id = ? ORDER BY ordre ASC, id ASC").all(software.id);
  const versions = await db.prepare("SELECT * FROM software_versions WHERE software_id = ? ORDER BY published_at DESC").all(software.id);
  const nbLicenses = (await db.prepare("SELECT COUNT(*) n FROM licenses WHERE software_id = ?").get(software.id)).n;
  return {
    ...product,
    software: { ...software, captures: parseJsonArray(software.captures) },
    plans: plans.map((p) => ({ ...p, fonctionnalites: parseJsonArray(p.fonctionnalites) })),
    versions,
    nb_licenses: nbLicenses
  };
}

// ---------- Logiciels (liste + CRUD) ----------
router.get("/", async (req, res) => {
  const rows = await db.prepare(`
    SELECT p.*, sw.id AS software_id, sw.slogan, sw.badge, sw.popularite, sw.version_actuelle,
      (SELECT COUNT(*) FROM software_plans WHERE software_id = sw.id) AS nb_plans,
      (SELECT COUNT(*) FROM licenses WHERE software_id = sw.id) AS nb_licenses
    FROM products p JOIN software_products sw ON sw.product_id = p.id
    ORDER BY p.created_at DESC
  `).all();
  res.json({ software: rows });
});

router.get("/:id", async (req, res) => {
  const full = await fullSoftware(req.params.id);
  if (!full) return res.status(404).json({ error: "Logiciel introuvable." });
  res.json({ software: full });
});

router.post("/", uploadMemory.single("apercu"), async (req, res) => {
  try {
    const {
      titre, description, category_id, statut,
      slogan, description_longue, probleme_resolu, public_cible,
      plateforme, systeme_compatible, version_actuelle, taille, configuration_min,
      licence_type, demo_url, video_url, badge
    } = req.body;
    if (!titre) return res.status(400).json({ error: "Le nom du logiciel est requis." });

    let apercu = "img/brand/logo.png"; // valeur neutre par défaut, remplaçable ensuite
    if (req.file) apercu = await savePublicVersion(req.file.buffer, { maxWidth: 1200, quality: 88 });

    const productInfo = await db.prepare(`
      INSERT INTO products (titre, description, prix, licence, fichier_original, apercu, statut, type)
      VALUES (?,?,0,?,'', ?, ?, 'logiciel')
    `).run(titre, description || "", licence_type || "Logiciel", apercu, statut === "inactif" ? "inactif" : "actif");
    const productId = productInfo.lastInsertRowid;

    if (category_id) await db.prepare("UPDATE products SET category_id = ? WHERE id = ?").run(category_id, productId);

    const swInfo = await db.prepare(`
      INSERT INTO software_products (product_id, slogan, description_longue, probleme_resolu, public_cible,
        plateforme, systeme_compatible, version_actuelle, taille, configuration_min, licence_type, demo_url, video_url, badge)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(productId, slogan || "", description_longue || "", probleme_resolu || "", public_cible || "",
           plateforme || "", systeme_compatible || "", version_actuelle || "", taille || "", configuration_min || "",
           licence_type || "", demo_url || "", video_url || "", ["nouveau", "populaire", "promotion"].includes(badge) ? badge : "");

    res.status(201).json({ software: await fullSoftware(productId) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put("/:id", uploadMemory.single("apercu"), async (req, res) => {
  try {
    const product = await db.prepare("SELECT * FROM products WHERE id = ? AND type = 'logiciel'").get(req.params.id);
    if (!product) return res.status(404).json({ error: "Logiciel introuvable." });
    const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(product.id);

    const {
      titre, description, category_id, statut,
      slogan, description_longue, probleme_resolu, public_cible,
      plateforme, systeme_compatible, version_actuelle, taille, configuration_min,
      licence_type, demo_url, video_url, badge
    } = req.body;

    let apercu = product.apercu;
    if (req.file) {
      // CORRIGÉ : ce garde-fou (`.startsWith("/uploads/")`) datait du stockage
      // disque local et empêchait la suppression des aperçus Cloudinary (URL
      // "https://res.cloudinary.com/...") lors d'un remplacement — l'ancien
      // fichier restait orphelin sur Cloudinary indéfiniment. deletePublicFile()
      // sait déjà distinguer les deux formats en interne (voir upload.js),
      // donc on l'appelle sans condition, comme dans photos.js/products.js.
      if (product.apercu) deletePublicFile(product.apercu);
      apercu = await savePublicVersion(req.file.buffer, { maxWidth: 1200, quality: 88 });
    }

    await db.prepare(`
      UPDATE products SET titre=?, description=?, category_id=?, statut=?, apercu=?, licence=? WHERE id=?
    `).run(
      titre ?? product.titre, description ?? product.description,
      category_id !== undefined ? (category_id || null) : product.category_id,
      statut === "inactif" || statut === "actif" ? statut : product.statut,
      apercu, licence_type ?? product.licence, product.id
    );

    await db.prepare(`
      UPDATE software_products SET slogan=?, description_longue=?, probleme_resolu=?, public_cible=?,
        plateforme=?, systeme_compatible=?, version_actuelle=?, taille=?, configuration_min=?,
        licence_type=?, demo_url=?, video_url=?, badge=?
      WHERE product_id=?
    `).run(
      slogan ?? software.slogan, description_longue ?? software.description_longue,
      probleme_resolu ?? software.probleme_resolu, public_cible ?? software.public_cible,
      plateforme ?? software.plateforme, systeme_compatible ?? software.systeme_compatible,
      version_actuelle ?? software.version_actuelle, taille ?? software.taille,
      configuration_min ?? software.configuration_min, licence_type ?? software.licence_type,
      demo_url ?? software.demo_url, video_url ?? software.video_url,
      badge !== undefined ? (["nouveau", "populaire", "promotion", ""].includes(badge) ? badge : software.badge) : software.badge,
      product.id
    );

    res.json({ software: await fullSoftware(product.id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Suppression définitive — refusée si des licences existent déjà (ventes
// réelles) pour éviter de casser l'accès de clients payants. Utilisez le
// statut "inactif" pour simplement retirer un logiciel de la vente.
router.delete("/:id", async (req, res) => {
  const product = await db.prepare("SELECT * FROM products WHERE id = ? AND type = 'logiciel'").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Logiciel introuvable." });
  const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(product.id);
  const nbLicenses = software ? (await db.prepare("SELECT COUNT(*) n FROM licenses WHERE software_id = ?").get(software.id)).n : 0;
  if (nbLicenses > 0) {
    return res.status(409).json({ error: `Ce logiciel a ${nbLicenses} licence(s) émise(s) et ne peut pas être supprimé définitivement. Passez-le en statut "inactif" pour le retirer de la vente.` });
  }
  await db.prepare("DELETE FROM products WHERE id = ?").run(product.id); // cascade : software_products, plans, versions
  res.json({ ok: true });
});

// ---------- Captures d'écran ----------
router.post("/:id/captures", uploadMemory.array("captures", 10), async (req, res) => {
  try {
    const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(req.params.id);
    if (!software) return res.status(404).json({ error: "Logiciel introuvable." });
    if (!req.files || !req.files.length) return res.status(400).json({ error: "Aucune image envoyée." });
    const current = parseJsonArray(software.captures);
    for (const file of req.files) {
      const url = await savePublicVersion(file.buffer, { urlPrefix: "/uploads/images", maxWidth: 1600, quality: 85 });
      current.push(url);
    }
    await db.prepare("UPDATE software_products SET captures = ? WHERE id = ?").run(JSON.stringify(current), software.id);
    res.json({ captures: current });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/:id/captures", async (req, res) => {
  const { url } = req.body || {};
  const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(req.params.id);
  if (!software) return res.status(404).json({ error: "Logiciel introuvable." });
  const current = parseJsonArray(software.captures).filter((u) => u !== url);
  await db.prepare("UPDATE software_products SET captures = ? WHERE id = ?").run(JSON.stringify(current), software.id);
  if (url) deletePublicFile(url);
  res.json({ captures: current });
});

// ---------- Formules (plans) ----------
router.post("/:id/plans", async (req, res) => {
  const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(req.params.id);
  if (!software) return res.status(404).json({ error: "Logiciel introuvable." });
  const { nom, description, prix, periodicite, fonctionnalites, max_devices, max_users, statut, ordre } = req.body || {};
  if (!nom || prix === undefined) return res.status(400).json({ error: "Nom et prix de la formule requis." });
  const info = await db.prepare(`
    INSERT INTO software_plans (software_id, nom, description, prix, periodicite, fonctionnalites, max_devices, max_users, statut, ordre)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(software.id, nom, description || "", Number(prix),
         ["unique", "mensuel", "annuel"].includes(periodicite) ? periodicite : "unique",
         JSON.stringify(parseJsonArray(fonctionnalites)), Number(max_devices) || 1, Number(max_users) || 1,
         statut === "inactif" ? "inactif" : "actif", Number(ordre) || 0);
  res.status(201).json({ plan: await db.prepare("SELECT * FROM software_plans WHERE id = ?").get(info.lastInsertRowid) });
});

router.put("/plans/:planId", async (req, res) => {
  const plan = await db.prepare("SELECT * FROM software_plans WHERE id = ?").get(req.params.planId);
  if (!plan) return res.status(404).json({ error: "Formule introuvable." });
  const { nom, description, prix, periodicite, fonctionnalites, max_devices, max_users, statut, ordre } = req.body || {};
  await db.prepare(`
    UPDATE software_plans SET nom=?, description=?, prix=?, periodicite=?, fonctionnalites=?, max_devices=?, max_users=?, statut=?, ordre=?
    WHERE id=?
  `).run(
    nom ?? plan.nom, description ?? plan.description, prix !== undefined ? Number(prix) : plan.prix,
    ["unique", "mensuel", "annuel"].includes(periodicite) ? periodicite : plan.periodicite,
    fonctionnalites !== undefined ? JSON.stringify(parseJsonArray(fonctionnalites)) : plan.fonctionnalites,
    max_devices !== undefined ? Number(max_devices) : plan.max_devices,
    max_users !== undefined ? Number(max_users) : plan.max_users,
    statut === "inactif" || statut === "actif" ? statut : plan.statut,
    ordre !== undefined ? Number(ordre) : plan.ordre,
    plan.id
  );
  res.json({ plan: await db.prepare("SELECT * FROM software_plans WHERE id = ?").get(plan.id) });
});

router.delete("/plans/:planId", async (req, res) => {
  try {
    const plan = await db.prepare("SELECT * FROM software_plans WHERE id = ?").get(req.params.planId);
    if (!plan) return res.status(404).json({ error: "Formule introuvable." });
    await db.prepare("DELETE FROM software_plans WHERE id = ?").run(plan.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: "Cette formule est référencée par des commandes ou licences existantes et ne peut pas être supprimée. Désactivez-la plutôt (statut inactif)." });
  }
});

// ---------- Versions ----------
router.post("/:id/versions", uploadSoftwareFile.single("file"), async (req, res) => {
  try {
    const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(req.params.id);
    if (!software) return res.status(404).json({ error: "Logiciel introuvable." });
    const { version, notes, compatibilite, type_maj } = req.body || {};
    if (!version || !req.file) return res.status(400).json({ error: "Numéro de version et fichier requis." });

    const saved = await saveSoftwareFile(req.file.buffer, req.file.originalname);
    const info = await db.prepare(`
      INSERT INTO software_versions (software_id, version, notes, fichier, taille_octets, compatibilite, type_maj)
      VALUES (?,?,?,?,?,?,?)
    `).run(software.id, version, notes || "", saved.relPath, saved.size, compatibilite || "",
           ["majeure", "mineure", "correctif"].includes(type_maj) ? type_maj : "mineure");

    // Reflète la nouvelle version comme "version actuelle" affichée sur la fiche produit.
    await db.prepare("UPDATE software_products SET version_actuelle = ? WHERE id = ?").run(version, software.id);

    res.status(201).json({ version: await db.prepare("SELECT * FROM software_versions WHERE id = ?").get(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/versions/:versionId", async (req, res) => {
  const version = await db.prepare("SELECT * FROM software_versions WHERE id = ?").get(req.params.versionId);
  if (!version) return res.status(404).json({ error: "Version introuvable." });
  await db.prepare("DELETE FROM software_versions WHERE id = ?").run(version.id);
  deletePrivateFile(version.fichier);
  res.json({ ok: true });
});

module.exports = router;
