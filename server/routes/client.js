// ============================================================
// client.js — espace client (commandes + téléchargements)
// ============================================================
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { requireClient } = require("../middleware/auth");
const { getValidToken, tokensForOrder, createDownloadToken } = require("../utils/tokens");
const { isLicenseValid } = require("../utils/licenses");
const { PERSIST_ROOT } = require("../utils/upload");
const { isCloudinaryRef, signedPrivateUrl } = require("../utils/cloudinaryStorage");
const { notifyAdminInApp } = require("../utils/notifications");

const router = express.Router();

router.get("/orders", requireClient, async (req, res) => {
  const orders = await db.prepare("SELECT * FROM orders WHERE client_id = ? ORDER BY created_at DESC").all(req.client.id);
  const withDetails = [];
  for (const o of orders) {
    const items = await db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(o.id);
    const itemsWithLinks = [];
    for (const it of items) {
      const candidates = await tokensForOrder(o.id);
      let token = null;
      for (const t of candidates) {
        if (t.product_id === it.product_id && (await getValidToken(t.token))) { token = t; break; }
      }
      let downloadUrl = null;
      if ((o.statut === "payee" || o.statut === "livree")) {
        if (!token) {
          // Génère un nouveau lien si aucun n'est encore valide (ex. ancien expiré).
          const newToken = await createDownloadToken(o.id, it.product_id);
          downloadUrl = `/api/download/${newToken}`;
        } else {
          downloadUrl = `/api/download/${token.token}`;
        }
      }
      itemsWithLinks.push({ ...it, downloadUrl });
    }
    withDetails.push({ ...o, items: itemsWithLinks });
  }
  res.json({ orders: withDetails });
});

// ---------- « Mes logiciels » : licences, mises à jour, téléchargements ----------
// Authentification obligatoire (requireClient) : jamais d'accès anonyme à
// cette liste, ni aux clés de licence, ni aux fichiers.
router.get("/software", requireClient, async (req, res) => {
  const licenses = await db.prepare(`
    SELECT l.*, p.titre AS logiciel_nom, p.apercu, sw.id AS software_pid, sw.slogan, sw.version_actuelle
    FROM licenses l
    JOIN software_products sw ON sw.id = l.software_id
    JOIN products p ON p.id = sw.product_id
    WHERE l.client_id = ?
    ORDER BY l.created_at DESC
  `).all(req.client.id);

  const result = [];
  for (const l of licenses) {
    const plan = l.plan_id ? await db.prepare("SELECT nom FROM software_plans WHERE id = ?").get(l.plan_id) : null;
    const lastVersion = await db.prepare("SELECT id, version, notes, published_at FROM software_versions WHERE software_id = ? ORDER BY published_at DESC LIMIT 1").get(l.software_id);
    const nouvelleMajDisponible = !!(lastVersion && lastVersion.version && lastVersion.version !== l.version_actuelle);
    result.push({
      id: l.id,
      logiciel: l.logiciel_nom,
      apercu: l.apercu,
      slogan: l.slogan,
      plan: plan ? plan.nom : null,
      license_key: l.license_key,
      status: isLicenseValid(l) ? l.status : (l.status === "active" ? "expiree" : l.status),
      activated_at: l.activated_at,
      expires_at: l.expires_at,
      max_devices: l.max_devices,
      max_users: l.max_users,
      derniere_version: lastVersion ? lastVersion.version : null,
      nouvelle_maj_disponible: nouvelleMajDisponible,
      can_download: isLicenseValid(l) && !!lastVersion,
      download_url: isLicenseValid(l) && lastVersion ? `/api/client/software/${l.id}/download` : null
    });
  }
  res.json({ licenses: result });
});

// Téléchargement du fichier logiciel : jamais d'URL publique permanente.
// Vérifie ICI, côté serveur : authentification, propriété de la licence,
// validité (statut + expiration) — jamais sur la seule foi du frontend.
router.get("/software/:licenseId/download", requireClient, async (req, res) => {
  const license = await db.prepare("SELECT * FROM licenses WHERE id = ? AND client_id = ?").get(req.params.licenseId, req.client.id);
  if (!license) return res.status(404).json({ error: "Licence introuvable." });
  if (!isLicenseValid(license)) {
    return res.status(403).json({ error: "Cette licence n'est plus active (expirée, suspendue ou annulée). Contactez le support." });
  }
  const version = await db.prepare("SELECT * FROM software_versions WHERE software_id = ? ORDER BY published_at DESC LIMIT 1").get(license.software_id);
  if (!version) return res.status(404).json({ error: "Aucun fichier disponible pour ce logiciel pour le moment." });

  // Journalisation de l'activation/téléchargement (exigée par le cahier des charges).
  await db.prepare("INSERT INTO software_downloads (license_id, version_id, client_id) VALUES (?,?,?)")
    .run(license.id, version.id, req.client.id);

  const product = await db.prepare(`
    SELECT p.titre FROM products p JOIN software_products sw ON sw.product_id = p.id WHERE sw.id = ?
  `).get(license.software_id);
  const safeTitre = (product?.titre || "logiciel").replace(/[^a-z0-9]+/gi, "-");

  if (isCloudinaryRef(version.fichier)) {
    // MIGRATION CLOUDINARY : voir download.js pour le même principe —
    // redirection vers une URL signée générée après vérification complète
    // de la licence ci-dessus (jamais avant).
    const ext = path.extname(version.fichier) || ".zip";
    const url = await signedPrivateUrl(version.fichier, `okim-art-${safeTitre}-v${version.version}${ext}`, {
      onRepair: (repairedRef) => db.prepare("UPDATE software_versions SET fichier = ? WHERE id = ?").run(repairedRef, version.id)
    });
    return res.redirect(url);
  }

  // Compatibilité ascendante : ancien chemin local (voir download.js).
  const fullPath = path.join(PERSIST_ROOT, version.fichier);
  const ext = path.extname(fullPath) || ".zip";
  res.download(fullPath, `okim-art-${safeTitre}-v${version.version}${ext}`, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "Ce fichier n'est plus disponible. Contactez le support." });
    }
  });
});

router.put("/profile", requireClient, async (req, res) => {
  const { nom, telephone, nouveau_mot_de_passe } = req.body || {};
  const client = await db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);
  if (!client) return res.status(404).json({ error: "Client introuvable." });
  let hash = client.password_hash;
  if (nouveau_mot_de_passe) {
    if (nouveau_mot_de_passe.length < 8) return res.status(400).json({ error: "Mot de passe trop court (8 caractères min.)." });
    hash = bcrypt.hashSync(nouveau_mot_de_passe, 12);
  }
  await db.prepare("UPDATE clients SET nom=?, telephone=?, password_hash=? WHERE id=?")
    .run(nom ?? client.nom, telephone ?? client.telephone, hash, client.id);
  res.json({ ok: true });
});

// ---------- « Mon témoignage » : un client ne peut avoir qu'un seul
// témoignage actif ; le renvoyer avec un texte différent le met à jour et
// le repasse en modération (jamais republié automatiquement sans relecture). ----------
router.get("/testimonials/mine", requireClient, async (req, res) => {
  const t = await db.prepare("SELECT id, nom, texte, note, statut, created_at, updated_at FROM testimonials WHERE client_id = ?").get(req.client.id);
  res.json({ testimonial: t || null });
});

router.put("/testimonials/mine", requireClient, async (req, res) => {
  const { nom, texte, note } = req.body || {};
  if (!texte || !texte.trim()) return res.status(400).json({ error: "Le texte du témoignage est requis." });
  const noteNum = Math.min(5, Math.max(1, Number(note) || 5));
  const client = await db.prepare("SELECT nom FROM clients WHERE id = ?").get(req.client.id);
  const displayName = (nom && nom.trim()) || client.nom;

  const existing = await db.prepare("SELECT id FROM testimonials WHERE client_id = ?").get(req.client.id);
  if (existing) {
    await db.prepare(`
      UPDATE testimonials SET nom = ?, texte = ?, note = ?, statut = 'en_attente',
        updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
    `).run(displayName, texte.trim(), noteNum, existing.id);
  } else {
    await db.prepare("INSERT INTO testimonials (client_id, nom, texte, note, statut) VALUES (?,?,?,?, 'en_attente')")
      .run(req.client.id, displayName, texte.trim(), noteNum);
  }
  const saved = await db.prepare("SELECT id, nom, texte, note, statut, created_at, updated_at FROM testimonials WHERE client_id = ?").get(req.client.id);
  notifyAdminInApp("testimonial_new", `Témoignage à modérer — ${displayName}`, texte.trim().slice(0, 100), "#testimonials");
  res.json({ ok: true, testimonial: saved });
});

router.delete("/testimonials/mine", requireClient, async (req, res) => {
  await db.prepare("DELETE FROM testimonials WHERE client_id = ?").run(req.client.id);
  res.json({ ok: true });
});

// ---------- Notifications (cloche de l'espace client) ----------
router.get("/notifications", requireClient, async (req, res) => {
  const notifications = await db.prepare("SELECT * FROM notifications WHERE audience = 'client' AND client_id = ? ORDER BY created_at DESC LIMIT 50").all(req.client.id);
  const unread = (await db.prepare("SELECT COUNT(*) n FROM notifications WHERE audience = 'client' AND client_id = ? AND lu = 0").get(req.client.id)).n;
  res.json({ notifications, unread });
});

router.patch("/notifications/:id/read", requireClient, async (req, res) => {
  await db.prepare("UPDATE notifications SET lu = 1 WHERE id = ? AND audience = 'client' AND client_id = ?").run(req.params.id, req.client.id);
  res.json({ ok: true });
});

router.post("/notifications/read-all", requireClient, async (req, res) => {
  await db.prepare("UPDATE notifications SET lu = 1 WHERE audience = 'client' AND client_id = ? AND lu = 0").run(req.client.id);
  res.json({ ok: true });
});

// ---------- Suppression DÉFINITIVE du compte ----------
// Suppression réelle (pas une désactivation) : le mot de passe actuel est
// exigé en confirmation, car c'est une action irréversible. Les commandes,
// licences et témoignages du client NE SONT PAS supprimés (nécessaires à la
// comptabilité et au support du studio) — voir le schéma dans db.js, ces
// tables utilisent ON DELETE SET NULL : elles restent, juste déliées de ce
// client. Seules les données strictement personnelles/de session (jetons de
// réinitialisation de mot de passe, notifications) disparaissent en cascade.
router.delete("/account", requireClient, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Veuillez saisir votre mot de passe pour confirmer." });

  const client = await db.prepare("SELECT * FROM clients WHERE id = ?").get(req.client.id);
  if (!client || !bcrypt.compareSync(password, client.password_hash)) {
    return res.status(401).json({ error: "Mot de passe incorrect." });
  }

  await db.prepare("DELETE FROM clients WHERE id = ?").run(req.client.id);
  res.clearCookie("okimart_client_token", { path: "/" });
  res.json({ ok: true });
});

module.exports = router;
