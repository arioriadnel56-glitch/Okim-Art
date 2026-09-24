// ============================================================
// download.js — téléchargement sécurisé par jeton opaque
// ============================================================
const express = require("express");
const path = require("path");
const fs = require("fs");
const { db } = require("../db");
const { getValidToken, consumeToken } = require("../utils/tokens");
const { PERSIST_ROOT } = require("../utils/upload");
const { isCloudinaryRef, signedPrivateUrl } = require("../utils/cloudinaryStorage");

const router = express.Router();

router.get("/:token", async (req, res) => {
  try {
    // 1. Vérification de la validité du jeton
    const row = await getValidToken(req.params.token);
    if (!row) {
      return res.status(410).json({ error: "Lien de téléchargement invalide, expiré ou déjà utilisé." });
    }

    // 2. Récupération du produit en BDD
    const product = await db.prepare("SELECT * FROM products WHERE id = ?").get(row.product_id);
    if (!product || !product.fichier_original) {
      return res.status(404).json({ error: "Fichier associé introuvable." });
    }

    // Nettoyage et sécurisation du nom de fichier
    const safeTitre = (product.titre || "photo-okim-art").replace(/[^a-z0-9]+/gi, "-");
    const isVideo = product.type === "video";
    const ext = isVideo ? ".mp4" : ".jpg";
    const finalFilename = `${safeTitre}${ext}`;

    // ------------------------------------------------------------
    // CAS A : Fichier hébergé sur Cloudinary
    // ------------------------------------------------------------
    if (isCloudinaryRef(product.fichier_original)) {
      let url;
      try {
        // Génération de l'URL signée avec le nom de fichier explicite
        url = await signedPrivateUrl(product.fichier_original, finalFilename, {
          flags: "attachment", // Force le téléchargement (Content-Disposition: attachment)
          onRepair: (repairedRef) =>
            db.prepare("UPDATE products SET fichier_original = ? WHERE id = ?").run(repairedRef, product.id)
        });
      } catch (e) {
        console.error("Erreur génération URL Cloudinary:", e);
        return res.status(404).json({ error: e.message || "Ce fichier n'est plus disponible sur Cloudinary." });
      }

      // Le jeton est consommé uniquement si la signature a réussi
      await consumeToken(req.params.token);

      // Redirection HTTP vers l'URL Cloudinary avec flag attachment
      return res.redirect(url);
    }

    // ------------------------------------------------------------
    // CAS B : Compatibilité ascendante (Fichier local)
    // ------------------------------------------------------------
    const fullPath = path.join(PERSIST_ROOT, product.fichier_original);

    // Vérification existence et taille sur le disque local
    if (!fs.existsSync(fullPath)) {
      console.error(`Fichier local introuvable : ${fullPath}`);
      return res.status(404).json({ error: "Le fichier n'existe plus sur le serveur." });
    }

    const stat = fs.statSync(fullPath);
    if (stat.size === 0) {
      return res.status(500).json({ error: "Le fichier image est vide sur le serveur." });
    }

    // Le jeton est consommé avant le transfert local
    await consumeToken(req.params.token);

    // Configuration des en-têtes stricts pour forcer l'affichage/téléchargement correct
    const contentType = isVideo ? "video/mp4" : "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);

    return res.download(fullPath, `okim-art-${finalFilename}`, (err) => {
      if (err && !res.headersSent) {
        console.error("Erreur res.download :", err);
        res.status(500).json({ error: "Erreur lors du transfert du fichier." });
      }
    });

  } catch (err) {
    console.error("Erreur serveur dans /download/:token :", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erreur interne lors du téléchargement." });
    }
  }
});

module.exports = router;
