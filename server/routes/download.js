// ============================================================
// download.js — livraison et affichage direct des médias boutique
// ============================================================
const express = require("express");
const path = require("path");
const fs = require("fs");
const { db } = require("../db");
const { getValidToken, consumeToken } = require("../utils/tokens");
const { PERSIST_ROOT } = require("../utils/upload");
const { isCloudinaryRef, openPrivateStream } = require("../utils/cloudinaryStorage");

const router = express.Router();

router.get("/:token", async (req, res) => {
  try {
    // 1. Validation du jeton de téléchargement
    const row = await getValidToken(req.params.token);
    if (!row) {
      return res.status(410).json({ error: "Lien invalide, expiré ou déjà utilisé." });
    }

    // 2. Récupération du produit en base de données
    const product = await db.prepare("SELECT * FROM products WHERE id = ?").get(row.product_id);
    if (!product || !product.fichier_original || product.fichier_original.trim() === "") {
      return res.status(404).json({ error: "Le fichier HD associé n'est pas encore disponible." });
    }

    // Normalisation du nom de fichier et déduction de l'extension
    const safeTitre = (product.titre || "photo-okim-art").replace(/[^a-z0-9]+/gi, "-");
    const isVideo = product.type === "video";
    const ext = isVideo ? ".mp4" : ".jpg";
    const finalFilename = `okim-art-${safeTitre}${ext}`;

    // Consommation du jeton unique
    await consumeToken(req.params.token);

    // ------------------------------------------------------------
    // CAS A : Livré depuis Cloudinary (Proxy Streaming CORS-safe)
    // ------------------------------------------------------------
    if (isCloudinaryRef(product.fichier_original)) {
      let stream;
      try {
        stream = await openPrivateStream(product.fichier_original, {
          onRepair: (repairedRef) =>
            db.prepare("UPDATE products SET fichier_original = ? WHERE id = ?").run(repairedRef, product.id)
        });
      } catch (e) {
        console.error("[download] Erreur ouverture flux Cloudinary :", e.message);
        return res.status(404).json({ error: "Fichier indisponible sur le stockage distant." });
      }

      if (stream.statusCode) res.status(stream.statusCode);

      // EN-TÊTE INLINE : Permet l'ouverture directe du média dans Safari/Chrome mobile
      res.setHeader("Content-Type", isVideo ? "video/mp4" : "image/jpeg");
      res.setHeader("Content-Disposition", `inline; filename="${finalFilename}"`);

      // Relais de la taille et des en-têtes de streaming
      const headersToRelay = ["content-length", "accept-ranges", "content-range"];
      headersToRelay.forEach((h) => {
        if (stream.headers[h]) res.setHeader(h, stream.headers[h]);
      });

      // Destruction du flux en cas de déconnexion prématurée du client
      req.on("close", () => {
        if (stream && typeof stream.destroy === "function") stream.destroy();
      });

      return stream.pipe(res);
    }

    // ------------------------------------------------------------
    // CAS B : Stockage local (Compatibilité ascendante)
    // ------------------------------------------------------------
    const fullPath = path.join(PERSIST_ROOT, product.fichier_original);

    if (!fs.existsSync(fullPath)) {
      console.error(`[download] Fichier local introuvable : ${fullPath}`);
      return res.status(404).json({ error: "Fichier local introuvable sur le serveur." });
    }

    const stat = fs.statSync(fullPath);
    if (stat.size === 0) {
      return res.status(500).json({ error: "Le fichier source est vide sur le serveur." });
    }

    res.setHeader("Content-Type", isVideo ? "video/mp4" : "image/jpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `inline; filename="${finalFilename}"`);

    const fileStream = fs.createReadStream(fullPath);
    return fileStream.pipe(res);

  } catch (err) {
    console.error("Erreur serveur /api/download/:token :", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erreur lors du traitement du fichier." });
    }
  }
});

module.exports = router;
