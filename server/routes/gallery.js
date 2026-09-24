// ============================================================
// gallery.js (routes) — accès public à la galerie client
// ============================================================
const express = require("express");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { db } = require("../db");
const { signToken, requireGalleryAccess } = require("../middleware/auth");
const { getSetting, addHours, hasHdAccess, getSessionByToken } = require("../utils/gallery");
const { streamSessionZip } = require("../utils/zip");
const { PERSIST_ROOT } = require("../utils/upload");
const { isCloudinaryRef, signedPrivateUrl, openPrivateStream, parseRef } = require("../utils/cloudinaryStorage");

const router = express.Router();

// Max 5 tentatives de PIN / 15 min, par IP ET par séance
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

/** Réécrit une fois la référence Cloudinary réparée sur la photo/vidéo concernée. */
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
  try {
    const { pin } = req.body || {};
    const session = await getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: "Galerie introuvable." });
    
    if (!pin || !bcrypt.compareSync(String(pin), session.pin_code_hash)) {
      return res.status(401).json({ error: "Code PIN incorrect." });
    }
    
    const galleryToken = signToken({ type: "gallery", session_id: session.id, access_token: session.access_token }, "2h");
    res.json({ ok: true, token: galleryToken, session: publicSessionInfo(session), photos: await photoList(session.id) });
  } catch (err) {
    console.error("Erreur POST verify-pin :", err);
    res.status(500).json({ error: "Erreur serveur lors de la vérification du code PIN." });
  }
});

// ---------- Détail de séance ----------
router.get("/:token", requireGalleryAccess, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: "Galerie introuvable." });
    res.json({ session: publicSessionInfo(session), photos: await photoList(session.id) });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la récupération de la galerie." });
  }
});

// ---------- Téléchargement ZIP des originaux HD ----------
router.get("/:token/download", requireGalleryAccess, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: "Galerie introuvable." });
    
    if (!hasHdAccess(session)) {
      return res.status(403).json({ error: "Accès HD expiré ou non débloqué. Utilisez « Récupérer mes photos » pour y accéder à nouveau." });
    }

    const photos = await db.prepare("SELECT id, titre, file_path, type FROM session_photos WHERE session_id = ?").all(session.id);
    if (!photos.length) return res.status(404).json({ error: "Aucune photo dans cette séance." });

    const safeName = (session.client_name || "seance").replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "seance";
    
    await streamSessionZip(photos, `okim-art-${safeName}.zip`, res);
  } catch (e) {
    console.error("[gallery] échec de génération du ZIP :", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Échec de la génération de l'archive ZIP." });
  }
});

// ---------- Proxy streaming pour bouton "Enregistrer" (CORS-safe) ----------
router.get("/:token/photos/:photoId/blob", requireGalleryAccess, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: "Galerie introuvable." });
    if (!hasHdAccess(session)) {
      return res.status(403).json({ error: "Accès HD expiré ou non débloqué." });
    }

    const photo = await db.prepare("SELECT * FROM session_photos WHERE id = ? AND session_id = ?")
      .get(req.params.photoId, session.id);
    if (!photo) return res.status(404).json({ error: "Fichier introuvable dans cette séance." });

    if (isCloudinaryRef(photo.file_path)) {
      const stream = await openPrivateStream(photo.file_path, { onRepair: repairSessionPhotoRef(photo.id) });

      // Transposer les en-têtes clés pour le support streaming mobile / iOS Range requests
      if (stream.statusCode) res.status(stream.statusCode);

      const headersToRelay = ["content-type", "content-length", "accept-ranges", "content-range"];
      headersToRelay.forEach((h) => {
        if (stream.headers[h]) res.setHeader(h, stream.headers[h]);
      });

      if (!stream.headers["content-type"]) {
        res.setHeader("Content-Type", photo.type === "video" ? "video/mp4" : "image/jpeg");
      }

      // Destruction du flux amont en cas de fermeture anticipée de la connexion client
      req.on("close", () => {
        if (stream && typeof stream.destroy === "function") stream.destroy();
      });

      return stream.pipe(res);
    } else {
      // Stockage local fallback
      const fullPath = path.join(PERSIST_ROOT, photo.file_path);
      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: "Le fichier local n'existe plus sur le serveur." });
      }
      return res.sendFile(fullPath);
    }
  } catch (e) {
    console.error("[gallery] Erreur /blob :", e.message);
    if (!res.headersSent) {
      res.status(404).json({ error: e.message || "Ce fichier n'est plus disponible." });
    }
  }
});

// ---------- Affichage visionneuse plein écran ----------
router.get("/:token/photos/:photoId/view", requireGalleryAccess, async (req, res) => {
  try {
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

    const fullPath = path.join(PERSIST_ROOT, photo.file_path);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "Ce fichier local n'existe plus." });
    }

    res.sendFile(fullPath, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: "Ce fichier n'est plus disponible." });
      }
    });
  } catch (e) {
    console.error("[gallery] Erreur /view :", e.message);
    if (!res.headersSent) res.status(404).json({ error: "Impossible de charger l'aperçu." });
  }
});

// ---------- Téléchargement individuel ----------
router.get("/:token/photos/:photoId/download", requireGalleryAccess, async (req, res) => {
  try {
    const session = await getSessionByToken(req.params.token);
    if (!session) return res.status(404).json({ error: "Galerie introuvable." });
    if (!hasHdAccess(session)) {
      return res.status(403).json({ error: "Accès HD expiré ou non débloqué. Utilisez « Récupérer mes photos » pour y accéder à nouveau." });
    }

    const photo = await db.prepare("SELECT * FROM session_photos WHERE id = ? AND session_id = ?")
      .get(req.params.photoId, session.id);
    if (!photo) return res.status(404).json({ error: "Fichier introuvable dans cette séance." });

    const safeTitre = (photo.titre || (photo.type === "video" ? "video" : "photo")).replace(/[^a-z0-9]+/gi, "-");
    
    // Extraction sécurisée du format réel
    let ext = ".jpg";
    if (isCloudinaryRef(photo.file_path)) {
      const parsed = parseRef(photo.file_path);
      ext = parsed.resourceType === "video" ? ".mp4" : ".jpg";
    } else {
      ext = photo.type === "video" ? ".mp4" : ".jpg";
    }

    const filename = `okim-art-${safeTitre}${ext}`;

    if (isCloudinaryRef(photo.file_path)) {
      const url = await signedPrivateUrl(photo.file_path, filename, { onRepair: repairSessionPhotoRef(photo.id) });
      return res.redirect(url);
    }

    const fullPath = path.join(PERSIST_ROOT, photo.file_path);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "Ce fichier local n'est plus disponible." });
    }

    res.download(fullPath, filename, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: "Ce fichier n'est plus disponible." });
      }
    });
  } catch (e) {
    console.error("[gallery] Erreur /download :", e.message);
    if (!res.headersSent) res.status(404).json({ error: "Erreur lors du téléchargement." });
  }
});

// ---------- Récupération payante d'une séance (init KKiaPay) ----------
router.post("/:token/recover", requireGalleryAccess, async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de l'initialisation de la récupération." });
  }
});

// ---------- Confirmation du paiement KKiaPay ----------
router.post("/:token/kkiapay-confirm", requireGalleryAccess, async (req, res) => {
  try {
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

    try {
      await db.prepare(`
        INSERT INTO recovery_transactions (session_id, transaction_reference, amount, status)
        VALUES (?,?,?, 'success')
      `).run(session.id, transactionId, event.amount ?? session.recovery_price);
    } catch (e) {
      if (e.code === "23505" || (e.message && e.message.includes("UNIQUE constraint failed"))) {
        const existing = await db.prepare("SELECT session_id FROM recovery_transactions WHERE transaction_reference = ?").get(transactionId);
        if (!existing || existing.session_id !== session.id) {
          return res.status(409).json({ error: "Cette transaction a déjà été utilisée pour une autre galerie. Contactez OKIM ART." });
        }
        await db.prepare("UPDATE recovery_transactions SET status = 'success' WHERE transaction_reference = ? AND session_id = ?").run(transactionId, session.id);
      } else {
        throw e;
      }
    }

    await db.prepare("UPDATE sessions_photo SET hd_unlocked_until = ? WHERE id = ?").run(unlockedUntil, session.id);

    res.json({ ok: true, hd_unlocked_until: unlockedUntil });
  } catch (err) {
    console.error("Erreur kkiapay-confirm :", err);
    res.status(500).json({ error: "Erreur serveur lors de la confirmation du paiement." });
  }
});

module.exports = router;
