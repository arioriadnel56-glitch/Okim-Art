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

// ---------- Signature pour une vidéo de SÉANCE CLIENT (privée) ----------
// Différence essentielle avec /video ci-dessus (portfolio, public) : le
// paramètre "type: authenticated" est inclus dans ce qui est signé, ce qui
// rend le fichier PRIVÉ sur Cloudinary dès l'upload (jamais d'URL publique
// directe) — indispensable puisqu'une vidéo de séance ne doit être
// accessible qu'au client concerné, après vérification de son accès HD
// (voir routes/gallery.js). Le dossier est le MÊME que celui utilisé par
// saveVideoPrivate (upload classique via notre serveur, voir utils/upload.js)
// pour que les deux chemins d'upload produisent des fichiers équivalents.
const SESSION_VIDEO_FOLDER = "okimart/private/videos";

router.get("/session-video", async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const paramsToSign = {
      timestamp,
      folder: SESSION_VIDEO_FOLDER,
      type: "authenticated"
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
      folder: SESSION_VIDEO_FOLDER,
      type: "authenticated"
    });
  } catch (e) {
    console.error("Erreur de signature Cloudinary (vidéo de séance) :", e);
    res.status(500).json({ error: "Impossible de générer l'autorisation d'upload." });
  }
});

module.exports = const express = require("express");
const cloudinary = require("cloudinary").v2;
const router = express.Router();

// Route pour obtenir une signature d'upload direct pour une PHOTO
router.get("/session-photo", (req, res) => {
  try {
    const timestamp = Math.round(new Date().getTime() / 1000);
    const { client_name, access_token } = req.query;

    // Construction du texte du filigrane
    const shortName = (client_name || "Client").trim().slice(0, 22);
    const shortToken = (access_token || "").replace(/-/g, "").slice(0, 6).toUpperCase();
    const watermarkText = `OKIM ART • ${shortName}${shortToken ? " • " + shortToken : ""}`;

    // Paramètres de transformation transmis à Cloudinary pour la version publique/filigranée
    // Note : On génère la version filigranée à la volée ou lors de l'upload via un preset
    const paramsToSign = {
      timestamp: timestamp,
      folder: "okim_art/originals" // Dossier privé Cloudinary
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
      folder: "okim_art/originals",
      watermarkText
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;





