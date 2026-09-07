// ============================================================
// routes/admin/signature.js — Direct Upload signé vers Cloudinary
// ============================================================
// Le navigateur de l'admin envoie la vidéo DIRECTEMENT à Cloudinary
// (jamais à notre serveur Express) : sur le plan Free de Render, un
// fichier vidéo lourd transitant par notre process Node ferait exploser
// la RAM (buffer en mémoire) et/ou dépasserait le timeout de requête.
//
// Cette route ne fait que délivrer une AUTORISATION SIGNÉE, valable
// quelques minutes, que le front-end joint à son upload Cloudinary.
// Le secret Cloudinary (CLOUDINARY_API_SECRET) ne quitte jamais le
// serveur : seule la signature qui en résulte est renvoyée.
const express = require("express");
const { cloudinary } = require("../../utils/cloudinary");

const router = express.Router();

const VIDEO_FOLDER = process.env.CLOUDINARY_VIDEO_FOLDER || "okimart/videos";

router.get("/video", async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);

    // Tous les paramètres qui seront envoyés à Cloudinary lors de l'upload
    // DOIVENT être inclus ici pour la signature — Cloudinary recalcule la
    // signature côté serveur à réception et rejette l'upload si un seul
    // paramètre diffère de ce qui a été signé (ex: un folder différent).
    const paramsToSign = {
      timestamp,
      folder: VIDEO_FOLDER
    };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      signature,
      timestamp,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder: VIDEO_FOLDER
    });
  } catch (e) {
    console.error("Erreur de signature Cloudinary :", e);
    res.status(500).json({ error: "Impossible de générer la signature d'upload." });
  }
});

module.exports = router;
