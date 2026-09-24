// ============================================================
// routes/admin/signature.js — Direct Upload signé vers Cloudinary
// ============================================================
const express = require("express");
const { cloudinary } = require("../../utils/cloudinary");

const router = express.Router();

const VIDEO_FOLDER = process.env.CLOUDINARY_VIDEO_FOLDER || "okimart/videos";
const SESSION_VIDEO_FOLDER = "okimart/private/videos";
const SESSION_PHOTO_FOLDER = "okimart/private/photos";

// ---------- Signature pour vidéo PORTFOLIO (public) ----------
router.get("/video", async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);

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
    console.error("Erreur de signature Cloudinary (vidéo) :", e);
    res.status(500).json({ error: "Impossible de générer la signature d'upload." });
  }
});

// ---------- Signature pour vidéo de SÉANCE CLIENT (privée) ----------
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

// ---------- Signature pour PHOTO de SÉANCE CLIENT (privée + filigrane) ----------
router.get("/session-photo", async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const { client_name, access_token } = req.query;

    // Construction du texte du filigrane dynamique
    const shortName = (client_name || "Client").trim().slice(0, 22);
    const shortToken = (access_token || "").replace(/-/g, "").slice(0, 6).toUpperCase();
    const watermarkText = `OKIM ART • ${shortName}${shortToken ? " • " + shortToken : ""}`;

    const paramsToSign = {
      timestamp,
      folder: SESSION_PHOTO_FOLDER,
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
      folder: SESSION_PHOTO_FOLDER,
      type: "authenticated",
      watermarkText
    });
  } catch (e) {
    console.error("Erreur de signature Cloudinary (photo de séance) :", e);
    res.status(500).json({ error: "Impossible de générer l'autorisation d'upload photo." });
  }
});

module.exports = router;
