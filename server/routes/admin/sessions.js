// ============================================================
// admin/sessions.js — gestion des séances clients (galerie sécurisée)
// ============================================================
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db } = require("../../db");
const { uploadMedia, saveOriginal, savePublicVersion, saveVideoPrivate, isVideoFile, assertMediaSize, deletePublicFile, deletePrivateFile } = require("../../utils/upload");
const { getSetting, addDays, hasHdAccess } = require("../../utils/gallery");

const router = express.Router();

/** Génère un code PIN à 6 chiffres cryptographiquement aléatoire (jamais 0-padding faible). */
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

// ---------- Créer une séance (upload des photos/vidéos + génération du lien + PIN) ----------
router.post("/", uploadMedia.array("files", 200), async (req, res) => {
  try {
    const { client_name, client_phone } = req.body || {};
    if (!client_name || !client_name.trim()) return res.status(400).json({ error: "Le nom du client est requis." });
    if (!req.files || !req.files.length) return res.status(400).json({ error: "Sélectionnez au moins une photo ou vidéo." });

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

    // Chaque photo : original HD en stockage privé + aperçu filigrané public
    // (le client voit toujours un aperçu, jamais le fichier HD tant qu'il
    // n'a pas d'accès valide — même logique que la boutique).
    // Chaque vidéo : original HD en stockage privé UNIQUEMENT — pas
    // d'aperçu public possible (pas de filigrane vidéo côté serveur) ; le
    // client voit une carte "verrouillée" tant qu'il n'a pas d'accès HD
    // (voir routes/gallery.js et public/gallery.html).
    for (const file of req.files) {
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
          maxWidth: 1000, quality: 78, watermarkText: "OKIM ART — APERÇU"
        });
        await db.prepare("INSERT INTO session_photos (session_id, titre, file_path, watermark_path, type) VALUES (?,?,?,?,'photo')")
          .run(sessionId, cleanTitre, filePath, watermarkPath);
      }
    }

    const created = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(sessionId);
    res.status(201).json({
      ok: true,
      session: await sessionSummary(req, created),
      pin: rawPin // affiché UNE SEULE FOIS ici — jamais récupérable ensuite (seul le hash est stocké)
    });
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

// Le PIN n'est jamais récupérable (seul le hash est stocké) — en cas de
// perte, on en génère un nouveau, retourné une seule fois comme à la création.
router.post("/:id/regenerate-pin", async (req, res) => {
  const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Séance introuvable." });
  const rawPin = generatePin();
  const pinHash = bcrypt.hashSync(rawPin, 12);
  await db.prepare("UPDATE sessions_photo SET pin_code_hash = ? WHERE id = ?").run(pinHash, s.id);
  res.json({ ok: true, pin: rawPin });
});

router.delete("/:id", async (req, res) => {
  const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
  if (!s) return res.status(404).json({ error: "Séance introuvable." });
  const photos = await db.prepare("SELECT * FROM session_photos WHERE session_id = ?").all(s.id);
  photos.forEach((p) => { deletePrivateFile(p.file_path); deletePublicFile(p.watermark_path); });
  await db.prepare("DELETE FROM sessions_photo WHERE id = ?").run(s.id); // cascade : session_photos + recovery_transactions
  res.json({ ok: true });
});

module.exports = router;
