// ============================================================
// admin/sessions.js — gestion des séances clients (galerie sécurisée)
// ============================================================
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db } = require("../../db");
const {
  uploadMedia, saveOriginal, savePublicVersion, saveVideoPrivate, registerPrivateVideoRef,
  isVideoFile, assertMediaSize, deletePublicFile, deletePrivateFile
} = require("../../utils/upload");
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

// Construit le texte du filigrane à partir du nom du client et d'un
// identifiant court de séance. Rendre le filigrane spécifique à CHAQUE
// séance (plutôt qu'un générique "OKIM ART — APERÇU" identique pour tout
// le monde) permet de retracer l'origine d'un aperçu capturé et partagé
// sans autorisation — c'est la vraie protection, une capture d'écran en
// tant que telle ne pouvant techniquement pas être empêchée par un site
// web (voir public/css/shop.css et public/gallery.html pour les mesures
// dissuasives complémentaires, qui ne bloquent que le clic droit/glisser).
function buildWatermarkLabel(clientName, accessToken) {
  const shortName = (clientName || "Client").trim().slice(0, 22);
  const shortToken = (accessToken || "").replace(/-/g, "").slice(0, 6).toUpperCase();
  return `OKIM ART • ${shortName}${shortToken ? " • " + shortToken : ""}`;
}

// ---------- Sauvegarde d'un lot de fichiers pour une séance existante ----------
// Extrait dans une fonction partagée car appelé à la fois par la création
// de séance (POST /, avec un premier lot optionnel) et par l'ajout de lots
// suivants (POST /:id/photos) — voir plus bas pourquoi tout n'est PLUS
// envoyé en une seule requête géante.
async function insertSessionFiles(sessionId, files, watermarkLabel) {
  // Chaque photo : original HD en stockage privé + aperçu filigrané public
  // (le client voit toujours un aperçu, jamais le fichier HD tant qu'il
  // n'a pas d'accès valide — même logique que la boutique). Le filigrane
  // identifie la séance/le client (voir buildWatermarkLabel ci-dessus).
  // Chaque vidéo : original HD en stockage privé UNIQUEMENT — pas
  // d'aperçu public possible (pas de filigrane vidéo côté serveur) ; le
  // client voit une carte "verrouillée" tant qu'il n'a pas d'accès HD
  // (voir routes/gallery.js et public/gallery.html). En pratique, les
  // vidéos passent désormais presque toujours par l'upload direct (voir
  // POST /:id/videos) — ce chemin vidéo n'est conservé ici que par sécurité
  // (compatibilité, anciens appels).
  //
  // Traitement en PARALLÈLE (jusqu'à CONCURRENCY fichiers à la fois) plutôt
  // qu'un par un : chaque photo demande 2 allers-retours Cloudinary
  // (original + filigrane), donc les traiter en séquence pour un lot de 15
  // photos pouvait prendre un temps considérable. La base de données
  // (pool PostgreSQL) supporte nativement des écritures concurrentes — pas
  // de risque de corruption. CONCURRENCY reste modéré (pas 15 à la fois)
  // pour ne pas saturer la RAM du plan Render Free avec trop de buffers
  // photo (jusqu'à 20 Mo chacun) traités simultanément.
  const CONCURRENCY = 4;
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
          maxWidth: 1000, quality: 78, watermarkText: watermarkLabel || "OKIM ART — APERÇU"
        });
        await db.prepare("INSERT INTO session_photos (session_id, titre, file_path, watermark_path, type) VALUES (?,?,?,?,'photo')")
          .run(sessionId, cleanTitre, filePath, watermarkPath);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
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
      await insertSessionFiles(sessionId, req.files, buildWatermarkLabel(client_name.trim(), accessToken));
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

    await insertSessionFiles(s.id, req.files, buildWatermarkLabel(s.client_name, s.access_token));

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

// ---------- Enregistrer une vidéo de séance déjà envoyée DIRECTEMENT à Cloudinary ----------
// Le navigateur de l'admin a uploadé le fichier lui-même vers Cloudinary
// (voir GET /api/signature/session-video), sans jamais passer par notre
// serveur. Cette route ne reçoit QUE le résultat de cet upload (identifiant
// Cloudinary), jamais l'octet vidéo — c'est ce qui règle à la fois la
// lenteur et les échecs silencieux observés sur les grosses vidéos : avant,
// chaque vidéo transitait par le process Node de Render (buffer complet en
// RAM + traitement séquentiel), lent et sujet à timeout sur le plan Free.
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

// ---------- Modifier les informations d'une séance existante ----------
// Utilisé par le bouton "Modifier" côté admin pour corriger une coquille
// dans le nom/téléphone du client, ajuster le prix de récupération, ou
// prolonger la date d'expiration — sans jamais toucher aux photos/vidéos
// déjà envoyées (gérées séparément, voir POST/DELETE /:id/photos ci-dessous).
// Chaque champ est optionnel : n'envoyer que ce qui change.
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

    // BUG CORRIGÉ : valider la date AVANT d'appeler .toISOString() dessus,
    // pas après. new Date("texte invalide").toISOString() lève elle-même
    // une exception ("Invalid time value") — le contrôle placé après ce
    // calcul ne s'exécutait donc jamais, et l'admin recevait ce message
    // technique brut au lieu de "Date d'expiration invalide."
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

// ---------- Retirer une photo/vidéo précise d'une séance ----------
// Utilisé depuis le panneau "Modifier" pour corriger une séance sans devoir
// tout supprimer et recommencer (ex. photo floue envoyée par erreur).
// Supprime le fichier HD privé ET l'aperçu public filigrané associés sur
// Cloudinary, pas seulement la ligne en base — sinon le fichier resterait
// stocké (et facturé) indéfiniment côté Cloudinary sans plus jamais être
// visible nulle part.
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
