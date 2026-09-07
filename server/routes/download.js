// ============================================================
// download.js — téléchargement sécurisé par jeton opaque
// ============================================================
const express = require("express");
const path = require("path");
const { db } = require("../db");
const { getValidToken, consumeToken } = require("../utils/tokens");
const { PERSIST_ROOT } = require("../utils/upload");
const { isCloudinaryRef, signedPrivateUrl } = require("../utils/cloudinaryStorage");

const router = express.Router();

router.get("/:token", async (req, res) => {
  const row = await getValidToken(req.params.token);
  if (!row) return res.status(410).json({ error: "Lien de téléchargement invalide, expiré ou déjà entièrement utilisé." });

  const product = await db.prepare("SELECT * FROM products WHERE id = ?").get(row.product_id);
  if (!product) return res.status(404).json({ error: "Fichier introuvable." });

  // Le jeton est consommé AVANT la livraison, comme avant la migration :
  // un jeton à usage unique déjà validé ne doit pas pouvoir être rejoué même
  // si la livraison Cloudinary qui suit échoue pour une autre raison.
  await consumeToken(req.params.token);

  const safeTitre = product.titre.replace(/[^a-z0-9]+/gi, "-");

  if (isCloudinaryRef(product.fichier_original)) {
    // MIGRATION CLOUDINARY : le fichier n'est plus sur notre disque. On
    // génère une URL signée valable pour cet aller-retour et on redirige le
    // navigateur dessus — Cloudinary sert alors le fichier directement,
   // Détection du fichier d'origine
const originalFile = product.fichier_original || "";
let ext = path.extname(originalFile).toLowerCase();

// 1. Déterminer si le fichier est une vidéo ou une photo
const isVideo = originalFile.includes('/video/') ||
originalFile.endsWith('.mp4') ||
(product.type && product.type.includes('video'));

// 2. Assigner la bonne extension sans écraser les photos
if (isVideo) {
ext = ".mp4";
} else if (!ext) {
ext = ".jpg";
}

// 3. Nom final propre pour l'utilisateur
const finalFilename = `${safeTitre}${ext}`;

// 4. Génération de l'URL Cloudinary avec le bon nom de fichier et la bonne extension
const url = await signedPrivateUrl(product.fichier_original, {
attachment: true,
filename: finalFilename
});

return res.redirect(url);


  }

  // Compatibilité ascendante : ancien chemin local (donnée antérieure à la
  // migration). Sur Render, ce fichier n'existe probablement plus après un
  // redéploiement — géré proprement plutôt que de planter sur un ENOENT.
  const fullPath = path.join(PERSIST_ROOT, product.fichier_original);
  const ext = path.extname(fullPath) || ".jpg";
  res.download(fullPath, `okim-art-${safeTitre}${ext}`, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "Ce fichier n'est plus disponible. Contactez le support." });
    }
  });
});

module.exports = router;
