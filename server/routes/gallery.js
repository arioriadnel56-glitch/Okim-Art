// ============================================================
// gallery.js (routes) — accès public à la galerie client
// ============================================================
// Toute la confiance repose sur le code PIN (hashé, jamais stocké en
// clair) et sur le jeton court délivré après validation — jamais sur le
// numéro de téléphone du client, à la demande explicite du studio.
const express = require("express");
const bcrypt = require("bcryptjs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { db } = require("../db");
const { signToken, requireGalleryAccess } = require("../middleware/auth");
const { getSetting, addHours, hasHdAccess, getSessionByToken } = require("../utils/gallery");
const { streamSessionZip } = require("../utils/zip");
const { PERSIST_ROOT } = require("../utils/upload");
const { isCloudinaryRef, signedPrivateUrl, openPrivateStream } = require("../utils/cloudinaryStorage");

const router = express.Router();

// Max 5 tentatives de PIN / 15 min, par IP ET par séance (deux clients
// différents sur la même IP ne se bloquent pas mutuellement).
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip) + ":" + req.params.token,
  message: { error: "Trop de tentatives. Réessayez dans quelques minutes, ou contactez OKIM ART." }
});

async function photoList(sessionId) {
  return db.prepare("SELECT id, titre, watermark_path, type FROM session_photos WHERE session_id = ?").all(sessionId);
}

/** Réécrit une fois la référence Cloudinary réparée (version retrouvée) sur la photo/vidéo de séance concernée. */
function repairSessionPhotoRef(photoId) {
  return (repairedRef) => db.prepare("UPDATE session_photos SET file_path = ? WHERE id = ?").run(repairedRef, photoId);
}

function publicSessionInfo(session) {
  return {
    client_name: session.client_name,
    status: session.status,
    created_at: session.created_at,
    expires_at: session.expires_at,
    has_hd_access: hasHdAccess(session),
    hd_unlocked_until: session.hd_unlocked_until,
    recovery_price: session.recovery_price
  };
}

// ---------- Validation du code PIN ----------
router.post("/:token/verify-pin", pinLimiter, async (req, res) => {
  const { pin } = req.body || {};
  const session = await getSessionByToken(req.params.token);
  if (!session) return res.status(404).json({ error: "Galerie introuvable." });
  if (!pin || !bcrypt.compareSync(String(pin), session.pin_code_hash)) {
    return res.status(401).json({ error: "Code PIN incorrect." });
  }
  const galleryToken = signToken({ type: "gallery", session_id: session.id, access_token: session.access_token }, "2h");
  res.json({ ok: true, token: galleryToken, session: publicSessionInfo(session), photos: await photoList(session.id) });
});

// ---------- Détail (revalidation, ex. après retour de paiement) ----------
router.get("/:token", requireGalleryAccess, async (req, res) => {
  const session = await getSessionByToken(req.params.token);
  if (!session) return res.status(404).json({ error: "Galerie introuvable." });
  res.json({ session: publicSessionInfo(session), photos: await photoList(session.id) });
});

// ---------- Téléchargement ZIP des originaux HD ----------
router.get("/:token/download", requireGalleryAccess, async (req, res) => {
  const session = await getSessionByToken(req.params.token);
  if (!session) return res.status(404).json({ error: "Galerie introuvable." });
  if (!hasHdAccess(session)) {
    return res.status(403).json({ error: "Accès HD expiré ou non débloqué. Utilisez « Récupérer mes photos » pour y accéder à nouveau." });
  }
  const photos = await db.prepare("SELECT id, titre, file_path FROM session_photos WHERE session_id = ?").all(session.id);
  if (!photos.length) return res.status(404).json({ error: "Aucune photo dans cette séance." });
  const safeName = (session.client_name || "seance").replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "seance";
  streamSessionZip(photos, `okim-art-${safeName}.zip`, res).catch((e) => {
    console.error("[gallery] échec de génération du ZIP :", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Échec de la génération du ZIP." });
  });
});

// ---------- Récupération en flux (proxy) pour le bouton "Enregistrer" (saveMedia côté client) ----------
// Contrairement à /view (redirection directe vers Cloudinary — parfaite pour
// un simple <img>/<video src>), cette route fait transiter les octets par
// notre propre serveur. Nécessaire car le bouton "Enregistrer" utilise
// fetch()+blob() pour proposer le partage natif iOS ("Enregistrer l'image/
// vidéo") — et un fetch() vers une redirection cross-origin (res.cloudinary.com)
// se heurte aux règles CORS, contrairement à un simple affichage. En restant
// sur notre propre domaine, plus aucun souci CORS. Le flux est piped
// directement (jamais bufferisé entièrement en RAM).
router.get("/:token/photos/:photoId/blob", requireGalleryAccess, async (req, res) => {
  const session = await getSessionByToken(req.params.token);
  if (!session) return res.status(404).json({ error: "Galerie introuvable." });
  if (!hasHdAccess(session)) {
    return res.status(403).json({ error: "Accès HD expiré ou non débloqué." });
  }

  const photo = await db.prepare("SELECT * FROM session_photos WHERE id = ? AND session_id = ?")
    .get(req.params.photoId, session.id);
  if (!photo) return res.status(404).json({ error: "Fichier introuvable dans cette séance." });

  try {
    if (isCloudinaryRef(photo.file_path)) {
      const stream = await openPrivateStream(photo.file_path, { onRepair: repairSessionPhotoRef(photo.id) });
      res.setHeader("Content-Type", stream.headers["content-type"] || (photo.type === "video" ? "video/mp4" : "image/jpeg"));
      stream.pipe(res);
    } else {
      // Compatibilité ascendante : ancien chemin local.
      const fullPath = path.join(PERSIST_ROOT, photo.file_path);
      res.sendFile(fullPath);
    }
  } catch (e) {
    res.status(404).json({ error: "Ce fichier n'est plus disponible. Contactez le support." });
  }
});

// ---------- Affichage plein écran d'UN SEUL fichier (photo ou vidéo) ----------
// Contrairement à /download ci-dessus, ce lien n'est PAS envoyé en pièce
// jointe forcée : le fichier s'affiche normalement, pour être ouvert dans la
// visionneuse plein écran de la page (voir gallery.html). C'est ce qui
// permet l'appui long "Enregistrer l'image/la vidéo" sur iPhone — un
// téléchargement forcé atterrit dans l'appli Fichiers, jamais dans Photos.
router.get("/:token/photos/:photoId/view", requireGalleryAccess, async (req, res) => {
  const session = await getSessionByToken(req.params.token);
  if (!session) return res.status(404).json({ error: "Galerie introuvable." });
  if (!hasHdAccess(session)) {
    return res.status(403).json({ error: "Accès HD expiré ou non débloqué." });
  }

  const photo = await db.prepare("SELECT * FROM session_photos WHERE id = ? AND session_id = ?")
    .get(req.params.photoId, session.id);
  if (!photo) return res.status(404).json({ error: "Fichier introuvable dans cette séance." });

  if (isCloudinaryRef(photo.file_path)) {
    const url = await signedPrivateUrl(photo.file_path, null, { inline: true, onRepair: repairSessionPhotoRef(photo.id) });
    return res.redirect(url);
  }

  // Compatibilité ascendante : ancien chemin local — affichage direct du fichier.
  const fullPath = path.join(PERSIST_ROOT, photo.file_path);
  res.sendFile(fullPath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "Ce fichier n'est plus disponible. Contactez le support." });
    }
  });
});

// ---------- Téléchargement d'UN SEUL fichier (photo ou vidéo) ----------
// Contrairement au ZIP ci-dessus, ce lien est fait pour être ouvert
// directement par le navigateur (pas un fetch+blob) : sur mobile, un
// fichier image/vidéo téléchargé individuellement de cette façon est
// généralement repris automatiquement par l'appli Galerie/Photos du
// téléphone (Android en particulier) — contrairement à un .zip, que le
// téléphone range dans "Fichiers", inutilisable tel quel pour un client.
router.get("/:token/photos/:photoId/download", requireGalleryAccess, async (req, res) => {
  const session = await getSessionByToken(req.params.token);
  if (!session) return res.status(404).json({ error: "Galerie introuvable." });
  if (!hasHdAccess(session)) {
    return res.status(403).json({ error: "Accès HD expiré ou non débloqué. Utilisez « Récupérer mes photos » pour y accéder à nouveau." });
  }

  // Le filtre "AND session_id = ?" est essentiel : sans lui, un client pourrait
  // deviner l'id d'une photo appartenant à une AUTRE séance et la télécharger
  // avec son propre jeton (faille de type IDOR).
  const photo = await db.prepare("SELECT * FROM session_photos WHERE id = ? AND session_id = ?")
    .get(req.params.photoId, session.id);
  if (!photo) return res.status(404).json({ error: "Fichier introuvable dans cette séance." });

  const safeTitre = (photo.titre || (photo.type === "video" ? "video" : "photo")).replace(/[^a-z0-9]+/gi, "-");
  const defaultExt = photo.type === "video" ? ".mp4" : ".jpg";

  if (isCloudinaryRef(photo.file_path)) {
    const ext = path.extname(photo.file_path) || defaultExt;
    const url = await signedPrivateUrl(photo.file_path, `okim-art-${safeTitre}${ext}`, { onRepair: repairSessionPhotoRef(photo.id) });
    return res.redirect(url);
  }

  // Compatibilité ascendante : ancien chemin local (donnée antérieure à la migration Cloudinary).
  const fullPath = path.join(PERSIST_ROOT, photo.file_path);
  const ext = path.extname(fullPath) || defaultExt;
  res.download(fullPath, `okim-art-${safeTitre}${ext}`, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "Ce fichier n'est plus disponible. Contactez le support." });
    }
  });
});

// ---------- Récupération payante d'une séance archivée (init KKiaPay) ----------
router.post("/:token/recover", requireGalleryAccess, async (req, res) => {
  const session = await getSessionByToken(req.params.token);
  if (!session) return res.status(404).json({ error: "Galerie introuvable." });
  if (hasHdAccess(session)) return res.json({ ok: true, already_unlocked: true });

  const enabled = (await getSetting("kkiapay_enabled", "0")) === "1";
  const publicKey = await getSetting("kkiapay_public_key", "");
  if (!enabled || !publicKey) {
    return res.status(400).json({ error: "Le paiement en ligne n'est pas encore activé sur cette plateforme. Contactez OKIM ART directement." });
  }
  res.json({
    ok: true,
    amount: session.recovery_price,
    kkiapay: { public_key: publicKey, sandbox: (await getSetting("kkiapay_sandbox", "1")) !== "0" },
    reference: session.access_token
  });
});

// ---------- Confirmation du paiement (déclenchée par le navigateur du client) ----------
router.post("/:token/kkiapay-confirm", requireGalleryAccess, async (req, res) => {
  const { transactionId } = req.body || {};
  if (!transactionId) return res.status(400).json({ error: "Identifiant de transaction manquant." });

  const session = await getSessionByToken(req.params.token);
  if (!session) return res.status(404).json({ error: "Galerie introuvable." });
  if (hasHdAccess(session)) return res.json({ ok: true, hd_unlocked_until: session.hd_unlocked_until });

  const event = await db.prepare("SELECT * FROM kkiapay_events WHERE transaction_id = ?").get(transactionId);
  if (!event || !event.success) {
    return res.status(202).json({ ok: false, pending: true, message: "Vérification du paiement en cours…" });
  }
  if (event.amount !== null && Number(event.amount) !== Number(session.recovery_price)) {
    return res.status(400).json({ error: "Le montant de la transaction ne correspond pas au tarif de récupération." });
  }

  const hdHours = Number(await getSetting("gallery_hd_access_hours", "48"));
  const unlockedUntil = addHours(new Date(), hdHours).toISOString();

  await db.prepare(`
    INSERT INTO recovery_transactions (session_id, transaction_reference, amount, status)
    VALUES (?,?,?, 'success')
    ON CONFLICT(transaction_reference) DO UPDATE SET status = 'success'
  `).run(session.id, transactionId, event.amount ?? session.recovery_price);

  await db.prepare("UPDATE sessions_photo SET hd_unlocked_until = ? WHERE id = ?").run(unlockedUntil, session.id);

  res.json({ ok: true, hd_unlocked_until: unlockedUntil });
});

module.exports = router;
