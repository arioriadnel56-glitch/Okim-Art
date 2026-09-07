// ============================================================
// utils/cloudinary.js — configuration centralisée du SDK Cloudinary
// (Direct Upload signé pour les vidéos lourdes — voir routes/admin/signature.js)
// ============================================================
const cloudinary = require("cloudinary").v2;

const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

// Comme pour JWT_SECRET/DATABASE_URL ailleurs dans le projet : on préfère un
// plantage explicite au démarrage plutôt qu'une route de signature qui
// échouerait silencieusement (ou pire, signerait avec "undefined") une fois
// en production.
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  throw new Error(
    "Variables Cloudinary manquantes (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, " +
    "CLOUDINARY_API_SECRET). Définissez-les dans .env — voir .env.example."
  );
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true
});

module.exports = { cloudinary };
