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
    // navigateur dessus — Cloudinary sert alors le fichier directement.
    //
    // BUG CORRIGÉ : signedPrivateUrl attend (ref, nomDeFichier, options) —
    // un appel précédent lui passait un OBJET en 2e argument à la place
    // d'un nom de fichier texte. Le paramètre "filename" de la fonction
    // recevait donc cet objet entier, qui devenait littéralement la chaîne
    // "[object Object]" une fois inséré dans l'URL Cloudinary (attachment
    // flag), cassant le lien de téléchargement généré — exactement ce qui
    // empêchait un client de récupérer sa photo/vidéo après paiement, alors
    // même que le bouton "Télécharger" s'affichait normalement (le statut
    // de commande, lui, était correct).
    //
    // Type de fichier déterminé via product.type (colonne fiable, définie à
    // la création du produit — voir db.js) plutôt qu'en devinant depuis la
    // référence Cloudinary elle-même, qui ne contient pas d'extension.
    const isVideo = product.type === "video";
    const ext = isVideo ? ".mp4" : ".jpg";
    const finalFilename = `${safeTitre}${ext}`;

    const url = await signedPrivateUrl(product.fichier_original, finalFilename, {
      onRepair: (repairedRef) => db.prepare("UPDATE products SET fichier_original = ? WHERE id = ?").run(repairedRef, product.id)
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
