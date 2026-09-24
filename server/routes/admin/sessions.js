// ============================================================
// admin/sessions.js — gestion des séances clients (galerie sécurisée)
// ============================================================
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db } = require("../../db");
const {
  uploadMedia, saveOriginal, savePublicVersion, saveVideoPrivate, 
  registerPrivateVideoRef, registerPrivatePhotoRef, isVideoFile, 
  assertMediaSize, deletePublicFile, deletePrivateFile
} = require("../../utils/upload");
const { getSetting, addDays, hasHdAccess } = require("../../utils/gallery");

const router = express.Router();

/** Génère un code PIN à 6 chiffres cryptographiquement aléatoire. */
function generatePin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

async function sessionSummary(req, s) {
  const nbPhotos = (await db.prepare("SELECT COUNT(*) n FROM session_photos WHERE session_id = ? AND type != 'video'").get(s.id)).n;
  const nbVideos = (await db.prepare("SELECT COUNT(*) n FROM session_photos WHERE session_id = ? AND type = 'video'").get(s.id)).n;
  return {
    id: s.id,
    client_name: s.client_name,
    client_phone: s.client_phone,
    access_token: s.access_token,
    status: s.status,
    hd_unlocked_until: s.hd_unlocked_until,
    recovery_price: s.recovery_price,
    created_at: s.created_at,
    expires_at: s.expires_at,
    has_hd_access: hasHdAccess(s),
    nb_photos: nbPhotos,
    nb_videos: nbVideos,
    link: `${req.protocol}://${req.get("host")}/gallery/${s.access_token}`
  };
}

function buildWatermarkLabel(clientName, accessToken) {
  const shortName = (clientName || "Client").trim().slice(0, 22);
  const shortToken = (accessToken || "").replace(/-/g, "").slice(0, 6).toUpperCase();
  return `OKIM ART • ${shortName}${shortToken ? " • " + shortToken : ""}`;
}

// ---------- Fallback : Traitement des fichiers par lots via serveur Node ----------
async function insertSessionFiles(sessionId, files, watermarkLabel) {
  const CONCURRENCY = 2;
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= files.length) return;
      const file = files[i];

      assertMediaSize(file);

      const cleanTitre = (file.originalname || "").replace(/\.[a-zA-Z0-9]+$/, "");
      if (isVideoFile(file)) {
        const filePath = await saveVideoPrivate(file.buffer, file.originalname);
        await db.prepare("INSERT INTO session_photos (session_id, titre, file_path, watermark_path, type) VALUES (?,?,?,NULL,'video')")
          .run(sessionId, cleanTitre, filePath);
      } else {
        const filePath = await saveOriginal(file.buffer);
        const watermarkPath = await savePublicVersion(file.buffer, {
          urlPrefix: "/uploads/previews",
          maxWidth: 1000, 
          quality: 78, 
          watermarkText: watermarkLabel || "OKIM ART — APERÇU"
        });
        await db.prepare("INSERT INTO session_photos (session_id, titre, file_path, watermark_path, type) VALUES (?,?,?,?,'photo')")
          .run(sessionId, cleanTitre, filePath, watermarkPath);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
}

const MAX_FILES_PER_BATCH = 40;

// ---------- Créer une séance ----------
router.post("/", uploadMedia.array("files", MAX_FILES_PER_BATCH), async (req, res) => {
  try {
    const { client_name, client_phone } = req.body || {};
    if (!client_name || !client_name.trim()) return res.status(400).json({ error: "Le nom du client est requis." });

    const retentionDays = Number(req.body.retention_days) || Number(await getSetting("gallery_retention_days", "30"));
    const recoveryPrice = req.body.recovery_price !== undefined && req.body.recovery_price !== ""
      ? Number(req.body.recovery_price)
      : Number(await getSetting("gallery_recovery_price", "2000"));

    const accessToken = crypto.randomUUID();
    const rawPin = generatePin();
    const pinHash = bcrypt.hashSync(rawPin, 12);
    const expiresAt = addDays(new Date(), retentionDays).toISOString();

    const session = await db.prepare(`
      INSERT INTO sessions_photo (client_name, client_phone, access_token, pin_code_hash, status, recovery_price, expires_at)
      VALUES (?,?,?,?, 'active', ?, ?)
    `).run(client_name.trim(), (client_phone || "").trim(), accessToken, pinHash, recoveryPrice, expiresAt);
    const sessionId = session.lastInsertRowid;

    if (req.files && req.files.length) {
      await insertSessionFiles(sessionId, req.files, buildWatermarkLabel(client_name.trim(), accessToken));
    }

    const created = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(sessionId);
    res.status(201).json({
      ok: true,
      session: await sessionSummary(req, created),
      pin: rawPin
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Ajouter un lot de photos/vidéos (Upload classique Express) ----------
router.post("/:id/photos", uploadMedia.array("files", MAX_FILES_PER_BATCH), async (req, res) => {
  try {
    const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
    if (!s) return res.status(404).json({ error: "Séance introuvable." });
    if (!req.files || !req.files.length) return res.status(400).json({ error: "Aucun fichier reçu pour ce lot." });

    await insertSessionFiles(s.id, req.files, buildWatermarkLabel(s.client_name, s.access_token));

    const updated = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(s.id);
    res.status(201).json({ ok: true, session: await sessionSummary(req, updated) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- NOUVEAU : Enregistrer une photo envoyée DIRECTEMENT à Cloudinary ----------
router.post("/:id/photos-direct", async (req, res) => {
  try {
    const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
    if (!s) return res.status(404).json({ error: "Séance introuvable." });

    const { titre, public_id, version, watermark_url } = req.body || {};
    if (!public_id) {
      return res.status(400).json({ error: "Référence Cloudinary (public_id) manquante." });
    }

    // Référence privée formatée pour le stockage sécurisé
    const filePath = typeof registerPrivatePhotoRef === "function" 
      ? registerPrivatePhotoRef(public_id, version)
      : public_id;

    const cleanTitre = (titre || "Photo").toString().slice(0, 200);
    const watermarkPath = watermark_url || null;

    await db.prepare(`
      INSERT INTO session_photos (session_id, titre, file_path, watermark_path, type) 
      VALUES (?, ?, ?, ?, 'photo')
    `).run(s.id, cleanTitre, filePath, watermarkPath);

    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Enregistrer une vidéo envoyée DIRECTEMENT à Cloudinary ----------
router.post("/:id/videos", async (req, res) => {
  try {
    const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
    if (!s) return res.status(404).json({ error: "Séance introuvable." });

    const { titre, public_id, version } = req.body || {};
    if (!public_id) return res.status(400).json({ error: "Référence Cloudinary manquante — l'upload direct a-t-il bien abouti ?" });

    const filePath = registerPrivateVideoRef(public_id, version);
    const cleanTitre = (titre || "Vidéo").toString().slice(0, 200);
    await db.prepare("INSERT INTO session_photos (session_id, titre, file_path, watermark_path, type) VALUES (?,?,?,NULL,'video')")
      .run(s.id, cleanTitre, filePath);

    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/", async (req, res) => {
  const rows = await db.prepare("SELECT * FROM sessions_photo ORDER BY created_at DESC").all();
  const sessions = [];
  for (const s of rows) sessions.push(await sessionSummary(req, s));
  res.json({ sessions });
});

router.get("/:id", async (req, res) => {
  const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Séance introuvable." });
  const photos = await db.prepare("SELECT id, titre, watermark_path, type, created_at FROM session_photos WHERE session_id = ?").all(s.id);
  res.json({ session: await sessionSummary(req, s), photos });
});

// ---------- Modifier une séance ----------
router.patch("/:id", async (req, res) => {
  try {
    const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
    if (!s) return res.status(404).json({ error: "Séance introuvable." });

    const { client_name, client_phone, recovery_price, expires_at } = req.body || {};
    const newName = client_name !== undefined ? client_name.trim() : s.client_name;
    if (!newName) return res.status(400).json({ error: "Le nom du client est requis." });
    const newPhone = client_phone !== undefined ? client_phone.trim() : s.client_phone;
    const newPrice = (recovery_price !== undefined && recovery_price !== "") ? Number(recovery_price) : s.recovery_price;
    if (Number.isNaN(newPrice)) return res.status(400).json({ error: "Prix de récupération invalide." });

    let newExpires = s.expires_at;
    if (expires_at !== undefined && expires_at !== "") {
      const parsed = new Date(expires_at);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: "Date d'expiration invalide." });
      newExpires = parsed.toISOString();
    }

    await db.prepare("UPDATE sessions_photo SET client_name = ?, client_phone = ?, recovery_price = ?, expires_at = ? WHERE id = ?")
      .run(newName, newPhone, newPrice, newExpires, s.id);

    const updated = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(s.id);
    res.json({ ok: true, session: await sessionSummary(req, updated) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Supprimer un média d'une séance ----------
router.delete("/:id/photos/:photoId", async (req, res) => {
  try {
    const photo = await db.prepare("SELECT * FROM session_photos WHERE id = ? AND session_id = ?").get(req.params.photoId, req.params.id);
    if (!photo) return res.status(404).json({ error: "Fichier introuvable dans cette séance." });
    deletePrivateFile(photo.file_path);
    if (photo.watermark_path) deletePublicFile(photo.watermark_path);
    await db.prepare("DELETE FROM session_photos WHERE id = ?").run(photo.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Régénérer un code PIN ----------
router.post("/:id/regenerate-pin", async (req, res) => {
  const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Séance introuvable." });
  const rawPin = generatePin();
  const pinHash = bcrypt.hashSync(rawPin, 12);
  await db.prepare("UPDATE sessions_photo SET pin_code_hash = ? WHERE id = ?").run(pinHash, s.id);
  res.json({ ok: true, pin: rawPin });
});

// ---------- Supprimer une séance complète ----------
router.delete("/:id", async (req, res) => {
  const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Séance introuvable." });
  const photos = await db.prepare("SELECT * FROM session_photos WHERE session_id = ?").all(s.id);
  photos.forEach((p) => { deletePrivateFile(p.file_path); deletePublicFile(p.watermark_path); });
  await db.prepare("DELETE FROM sessions_photo WHERE id = ?").run(s.id);
  res.json({ ok: true });
});

module.exports = router;
