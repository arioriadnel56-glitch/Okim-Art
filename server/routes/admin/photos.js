// ============================================================
// admin/photos.js — gestion du portfolio (CRUD + upload)
// Une entrée peut être une PHOTO (traitement image + filigrane, comme
// avant) ou une courte VIDÉO (stockée telle quelle, publique, sans
// filigrane — voir server/utils/upload.js).
// ============================================================
const express = require("express");
const { db } = require("../../db");
const {
  uploadMedia, saveOriginal, savePublicVersion,
  saveVideoPublic, isVideoFile, assertMediaSize,
  deletePublicFile, deletePrivateFile
} = require("../../utils/upload");
const { moveToTrash } = require("../../utils/trash");

const router = express.Router();

router.get("/", async (req, res) => {
  const photos = await db.prepare(`
    SELECT p.*, c.nom AS categorie_nom, c.slug AS categorie_slug
    FROM photos p LEFT JOIN categories c ON c.id = p.category_id
    ORDER BY p.ordre ASC, p.created_at DESC
  `).all();
  res.json({ photos });
});

/**
 * Traite le fichier envoyé (photo ou vidéo) et renvoie { fichier, miniature, watermark, type }.
 * Le type effectif est déterminé par le CONTENU réel du fichier (mimetype/extension
 * détectés par multer), jamais par le seul champ "type" envoyé par le formulaire —
 * qui ne sert qu'à donner l'intention pour un message d'erreur plus clair.
 */
async function processMediaFile(file, requestedType, watermarkFlag) {
  assertMediaSize(file);
  const actualIsVideo = isVideoFile(file);
  if (requestedType === "video" && !actualIsVideo) {
    throw new Error("Le fichier envoyé n'est pas une vidéo valide (MP4, WEBM, MOV attendus).");
  }
  if (requestedType === "photo" && actualIsVideo) {
    throw new Error("Le fichier envoyé est une vidéo — choisissez le type « Vidéo » pour l'ajouter au portfolio.");
  }

  if (actualIsVideo) {
    // Vidéo de portfolio : publique par nature (vitrine), pas de filigrane
    // possible côté serveur (pas de traitement vidéo disponible ici).
    const url = await saveVideoPublic(file.buffer, file.originalname);
    return { fichier: url, miniature: url, watermark: 0, type: "video" };
  }

  const wm = watermarkFlag !== "0"; // filigrane activé par défaut
  const fichier = await saveOriginal(file.buffer);
  const miniature = await savePublicVersion(file.buffer, { watermarkText: wm ? "OKIM ART" : null });
  return { fichier, miniature, watermark: wm ? 1 : 0, type: "photo" };
}

router.post("/", uploadMedia.single("file"), async (req, res) => {
  try {
    const { titre, description, category_id, statut, a_la_une, prix, watermark, type, video_url } = req.body;

    // Deux façons d'ajouter une vidéo au portfolio :
    //  1) video_url renseigné → upload déjà fait par le NAVIGATEUR directement
    //     vers Cloudinary (voir GET /api/signature/video) ; aucun fichier ne
    //     transite ici, donc pas de risque de RAM/timeout sur Render Free.
    //  2) req.file présent → ancien circuit (photo, ou petite vidéo passée
    //     par Multer/Express) — inchangé.
    let media;
    if (video_url) {
      if (!titre) return res.status(400).json({ error: "Titre requis." });
      media = { fichier: video_url, miniature: video_url, watermark: 0, type: "video" };
    } else {
      if (!titre || !req.file) return res.status(400).json({ error: "Titre et fichier (photo ou vidéo) requis." });
      media = await processMediaFile(req.file, type === "video" ? "video" : "photo", watermark);
    }

    const info = await db.prepare(`
      INSERT INTO photos (titre, description, fichier, miniature, video_url, category_id, statut, a_la_une, prix, watermark, type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      titre, description || "", media.fichier, media.miniature,
      video_url || null,
      category_id || null, statut === "publie" ? "publie" : "brouillon",
      a_la_une === "1" ? 1 : 0,
      media.type === "video" ? null : (prix ? Number(prix) : null), // une vidéo de portfolio n'est pas mise en vente
      media.watermark, media.type
    );
    const photo = await db.prepare("SELECT * FROM photos WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({ photo });
  } catch (e) {
    res.status(400).json({ error: e.message || "Échec de l'envoi." });
  }
});

router.put("/:id", uploadMedia.single("file"), async (req, res) => {
  try {
    const photo = await db.prepare("SELECT * FROM photos WHERE id = ?").get(req.params.id);
    if (!photo) return res.status(404).json({ error: "Photo introuvable." });

    const { titre, description, category_id, statut, a_la_une, prix, watermark, type, video_url } = req.body;
    let { fichier, miniature, watermark: wmVal, type: mediaType } = photo;
    let newVideoUrl = photo.video_url;

    if (video_url) {
      // Remplacement par une vidéo uploadée directement vers Cloudinary
      // (voir POST / ci-dessus) : on nettoie l'ancien fichier local éventuel.
      if (photo.type === "video") { if (photo.miniature && !photo.video_url) deletePublicFile(photo.miniature); }
      else { deletePrivateFile(fichier); deletePublicFile(miniature); }
      fichier = video_url; miniature = video_url; wmVal = 0; mediaType = "video"; newVideoUrl = video_url;
    } else if (req.file) {
      const media = await processMediaFile(req.file, type === "video" ? "video" : (type === "photo" ? "photo" : (photo.type || "photo")), watermark);
      // Nettoyage de l'ancien fichier, adapté à son type d'origine.
      if (photo.type === "video") { if (photo.miniature && !photo.video_url) deletePublicFile(photo.miniature); }
      else { deletePrivateFile(fichier); deletePublicFile(miniature); }
      fichier = media.fichier; miniature = media.miniature; wmVal = media.watermark; mediaType = media.type;
      newVideoUrl = null; // retour à un fichier hébergé localement
    }

    await db.prepare(`
      UPDATE photos SET titre=?, description=?, fichier=?, miniature=?, video_url=?, category_id=?, statut=?, a_la_une=?, prix=?, watermark=?, type=?
      WHERE id=?
    `).run(
      titre ?? photo.titre, description ?? photo.description, fichier, miniature, newVideoUrl,
      category_id !== undefined ? (category_id || null) : photo.category_id,
      statut === "publie" || statut === "brouillon" ? statut : photo.statut,
      a_la_une !== undefined ? (a_la_une === "1" ? 1 : 0) : photo.a_la_une,
      mediaType === "video" ? null : (prix !== undefined ? (prix ? Number(prix) : null) : photo.prix),
      wmVal, mediaType,
      req.params.id
    );
    const updated = await db.prepare("SELECT * FROM photos WHERE id = ?").get(req.params.id);
    res.json({ photo: updated });
  } catch (e) {
    res.status(400).json({ error: e.message || "Échec de la mise à jour." });
  }
});

router.delete("/:id", async (req, res) => {
  const photo = await db.prepare("SELECT * FROM photos WHERE id = ?").get(req.params.id);
  if (!photo) return res.status(404).json({ error: "Photo introuvable." });
  const used = (await db.prepare("SELECT COUNT(*) n FROM products WHERE photo_id = ?").get(req.params.id)).n;
  if (used > 0) return res.status(409).json({ error: "Cette photo est liée à un produit de la boutique. Supprimez d'abord le produit." });
  // Mise à la corbeille (récupérable 30 jours) : les fichiers ne sont
  // supprimés qu'à la purge définitive, jamais ici.
  await moveToTrash("photos", photo, photo.titre);
  res.json({ ok: true, trashed: true });
});

module.exports = router;
