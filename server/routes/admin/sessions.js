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

// ---------- Sauvegarde d'un lot de fichiers pour une séance existante ----------
// Extrait dans une fonction partagée car appelé à la fois par la création
// de séance (POST /, avec un premier lot optionnel) et par l'ajout de lots
// suivants (POST /:id/photos) — voir plus bas pourquoi tout n'est PLUS
// envoyé en une seule requête géante.
async function insertSessionFiles(sessionId, files) {
  // Chaque photo : original HD en stockage privé + aperçu filigrané public
  // (le client voit toujours un aperçu, jamais le fichier HD tant qu'il
  // n'a pas d'accès valide — même logique que la boutique).
  // Chaque vidéo : original HD en stockage privé UNIQUEMENT — pas
  // d'aperçu public possible (pas de filigrane vidéo côté serveur) ; le
  // client voit une carte "verrouillée" tant qu'il n'a pas d'accès HD
  // (voir routes/gallery.js et public/gallery.html).
  for (const file of files) {
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
}

// Nombre max de fichiers acceptés PAR REQUÊTE (pas par séance). Une séance
// de 300 photos passe désormais par ~20 requêtes de 15 fichiers plutôt
// qu'une seule requête géante — voir public/admin/app.js. Ce plafond reste
// une garde-fou côté serveur, pas la limite réelle d'une séance.
const MAX_FILES_PER_BATCH = 40;

// ---------- Créer une séance (métadonnées + premier lot optionnel de fichiers) ----------
// IMPORTANT : les fichiers ne sont plus obligatoires ici. Pour une séance
// avec beaucoup de photos/vidéos (ex. 300), le front-end crée la séance
// SANS fichier, puis les envoie par lots successifs via POST /:id/photos
// ci-dessous — une seule requête contenant des centaines de fichiers finit
// par timeout ou saturer la mémoire du serveur (RAM limitée sur Render),
// ce qui se traduisait par une erreur 502 pour l'admin.
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
      await insertSessionFiles(sessionId, req.files);
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

// ---------- Ajouter un lot de photos/vidéos à une séance existante ----------
// Appelé plusieurs fois de suite par le front-end (voir app.js) pour
// envoyer une grosse séance (ex. 300 fichiers) sans jamais dépasser
// MAX_FILES_PER_BATCH dans une seule requête. Chaque appel est indépendant :
// si l'un d'eux échoue (coupure réseau...), les lots déjà envoyés restent
// enregistrés et l'admin peut relancer l'envoi sans tout recommencer.
router.post("/:id/photos", uploadMedia.array("files", MAX_FILES_PER_BATCH), async (req, res) => {
  try {
    const s = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(req.params.id);
    if (!s) return res.status(404).json({ error: "Séance introuvable." });
    if (!req.files || !req.files.length) return res.status(400).json({ error: "Aucun fichier reçu pour ce lot." });

    await insertSessionFiles(s.id, req.files);

    const updated = await db.prepare("SELECT * FROM sessions_photo WHERE id = ?").get(s.id);
    res.status(201).json({ ok: true, session: await sessionSummary(req, updated) });
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
