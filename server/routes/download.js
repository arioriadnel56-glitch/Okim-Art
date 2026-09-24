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
    // 1. Validation du jeton de téléchargement
    const row = await getValidToken(req.params.token);
    if (!row) {
      return res.status(410).json({ error: "Lien de téléchargement invalide, expiré ou déjà utilisé." });
    }

    // 2. Récupération du produit lié
    const product = await db.prepare("SELECT * FROM products WHERE id = ?").get(row.product_id);
    if (!product) {
      return res.status(404).json({ error: "Produit ou fichier introuvable." });
    }

    // 3. VÉRIFICATION DÉFENSIVE : S'assurer que le fichier original existe et n'est pas vide
    if (!product.fichier_original || product.fichier_original.trim() === "") {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Fichier indisponible - OKIM ART</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 40px 20px; color: #333; line-height: 1.6; }
            .card { max-width: 480px; margin: 0 auto; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); background: #fff; }
            h2 { color: #e53935; margin-top: 0; }
            p { color: #666; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Fichier en cours de préparation</h2>
            <p>Le fichier haute résolution associé à votre commande est en cours de finalisation par l'équipe OKIM ART.</p>
            <p>Veuillez réessayer dans quelques instants ou contacter le support.</p>
          </div>
        </body>
        </html>
      `);
    }

    // Normalisation du nom de fichier
    const safeTitre = (product.titre || "photo-okim-art").replace(/[^a-z0-9]+/gi, "-");
    const isVideo = product.type === "video";
    const ext = isVideo ? ".mp4" : ".jpg";
    const finalFilename = `okim-art-${safeTitre}${ext}`;

    // ------------------------------------------------------------
    // CAS A : Fichier hébergé sur Cloudinary (Migration)
    // ------------------------------------------------------------
    if (isCloudinaryRef(product.fichier_original)) {
      let url;
      try {
        url = await signedPrivateUrl(product.fichier_original, finalFilename, {
          inline: false, // Force le téléchargement (attachment)
          onRepair: (repairedRef) =>
            db.prepare("UPDATE products SET fichier_original = ? WHERE id = ?").run(repairedRef, product.id)
        });
      } catch (e) {
        console.error("[download] Erreur signature Cloudinary :", e.message);
        return res.status(404).json({ error: e.message || "Ce fichier n'est plus disponible sur le stockage." });
      }

      // Consommation du jeton unique UNIQUEMENT après succès de la signature
      await consumeToken(req.params.token);

      // Redirection HTTP vers l'URL signée de livraison Cloudinary
      return res.redirect(url);
    }

    // ------------------------------------------------------------
    // CAS B : Stockage local (Compatibilité ascendante)
    // ------------------------------------------------------------
    const fullPath = path.join(PERSIST_ROOT, product.fichier_original);

    // Vérification d'existence sur le disque local
    if (!fs.existsSync(fullPath)) {
      console.error(`[download] Fichier local introuvable : ${fullPath}`);
      return res.status(404).json({ error: "Ce fichier n'est plus disponible sur le serveur." });
    }

    const stat = fs.statSync(fullPath);
    if (stat.size === 0) {
      return res.status(500).json({ error: "Le fichier source est vide sur le serveur." });
    }

    // Consommation du jeton unique
    await consumeToken(req.params.token);

    // Configuration des en-têtes de livraison
    const contentType = isVideo ? "video/mp4" : "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);

    return res.download(fullPath, finalFilename, (err) => {
      if (err && !res.headersSent) {
        console.error("[download] Erreur lors du res.download local :", err);
        res.status(500).json({ error: "Erreur lors du transfert du fichier." });
      }
    });

  } catch (err) {
    console.error("Erreur serveur /api/download/:token :", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erreur interne lors de la livraison du fichier." });
    }
  }
});

module.exports = router;
