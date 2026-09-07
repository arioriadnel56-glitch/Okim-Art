// ============================================================
// upload.js — validation, traitement (sharp) et stockage Cloudinary
// des images/vidéos/fichiers logiciels de la plateforme.
// ============================================================
// MIGRATION CLOUDINARY : ce fichier ne stocke plus rien sur le disque
// local du serveur. Sur Render (plan Free en particulier), le système de
// fichiers n'est PAS persistant : tout ce qui y est écrit disparaît au
// prochain redémarrage/redéploiement. Les fonctions ci-dessous gardent
// exactement les mêmes noms et signatures qu'avant la migration — aucun
// fichier appelant (routes/admin/*, trash.js, sessions.js...) n'a besoin
// d'être modifié.
//
// Deux façons de représenter un fichier stocké, selon sa visibilité :
//  - PUBLIC  (miniatures, aperçus, images de services...) → une simple URL
//    https://res.cloudinary.com/... stockée telle quelle en base, utilisable
//    directement dans un <img src="...">.
//  - PRIVÉ   (photo HD originale, fichier produit, installeur logiciel) →
//    une référence encodée "cloudinary:<resource_type>:<public_id>" qui
//    n'est JAMAIS envoyée au navigateur — voir cloudinaryStorage.js.
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const multer = require("multer");
const {
  makeRef, isCloudinaryRef, isCloudinaryUrl,
  uploadBuffer, destroyRef, destroyPublicUrl, signedPrivateUrl
} = require("./cloudinaryStorage");

// Conservé UNIQUEMENT pour compatibilité ascendante : server.js sert encore
// "/uploads" en statique depuis ce dossier pour des données antérieures à la
// migration Cloudinary (chemins locaux déjà stockés en base). Plus AUCUN
// nouvel upload n'y est écrit à partir de maintenant — voir saveOriginal,
// savePublicVersion, etc. ci-dessous, qui envoient tout vers Cloudinary.
// Sur Render, ce dossier reste de toute façon vide après chaque redéploiement
// (disque non persistant sur le plan Free).
const PERSIST_ROOT = process.env.UPLOADS_DIR || path.join(__dirname, "..", "..", "uploads");
if (!fs.existsSync(PERSIST_ROOT)) fs.mkdirSync(PERSIST_ROOT, { recursive: true });

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_SIZE = 20 * 1024 * 1024; // 20 Mo

const ALLOWED_VIDEO_MIME = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const ALLOWED_VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
const MAX_VIDEO_SIZE = 200 * 1024 * 1024; // 200 Mo — "courte vidéo", pas un film
// Rappel : le plan gratuit Cloudinary plafonne à 100 Mo par fichier
// vidéo/raw quel que soit MAX_VIDEO_SIZE ci-dessus — Cloudinary renverra
// une erreur explicite (propagée à l'admin) si ce plafond est dépassé.

// Stockage en mémoire : on ne fait JAMAIS confiance au nom de fichier envoyé
// par le client. On revalide le contenu (mimetype détecté) avant l'envoi à
// Cloudinary, et on ne réutilise jamais le nom d'origine (public_id aléatoire).
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
      return cb(new Error("Type de fichier non autorisé. Formats acceptés : JPG, PNG, WEBP."));
    }
    cb(null, true);
  }
});

// Accepte une image OU une courte vidéo dans le MÊME champ de formulaire
// (portfolio, séances client) : la décision image/vidéo se fait ensuite
// dans la route, à partir du mimetype réellement détecté — jamais sur la
// seule foi d'un paramètre envoyé par le client.
const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_SIZE }, // la limite la plus haute des deux ; la taille réelle par type est revalidée ci-dessous
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const isImage = ALLOWED_MIME.has(file.mimetype) && ALLOWED_EXT.has(ext);
    const isVideo = ALLOWED_VIDEO_MIME.has(file.mimetype) && ALLOWED_VIDEO_EXT.has(ext);
    if (!isImage && !isVideo) {
      return cb(new Error("Type de fichier non autorisé. Formats acceptés : JPG, PNG, WEBP (photo) ou MP4, WEBM, MOV (vidéo)."));
    }
    cb(null, true);
  }
});

function isVideoFile(file) {
  return !!file && ALLOWED_VIDEO_MIME.has(file.mimetype) && ALLOWED_VIDEO_EXT.has(path.extname(file.originalname || "").toLowerCase());
}

/**
 * uploadMedia autorise jusqu'à MAX_VIDEO_SIZE (200 Mo) au niveau multer,
 * pour laisser passer les vidéos — mais une IMAGE ne doit pas profiter de
 * cette limite haute. À appeler juste après le middleware, avec req.file.
 */
function assertMediaSize(file) {
  if (!isVideoFile(file) && file.size > MAX_SIZE) {
    throw new Error(`Image trop volumineuse (${Math.round(file.size / 1024 / 1024)} Mo, maximum 20 Mo).`);
  }
}

async function validateImageBuffer(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!["jpeg", "png", "webp"].includes(meta.format)) throw new Error();
  } catch (e) {
    throw new Error("Format d'image non reconnu ou fichier illisible.");
  }
}

/** Convertit un urlPrefix historique ("/uploads/photos") en dossier Cloudinary ("okimart/photos"). */
function toFolder(urlPrefix) {
  const rest = (urlPrefix || "/uploads/misc").replace(/^\/uploads\/?/, "");
  return `okimart/${rest || "misc"}`;
}

/** Enregistre le fichier ORIGINAL en stockage privé Cloudinary (jamais d'URL publique). */
async function saveOriginal(buffer) {
  await validateImageBuffer(buffer); // valide réellement le contenu, pas juste l'extension déclarée
  // NOTE : contrairement à saveSoftwareFile (type "raw"), on n'intègre pas
  // l'extension dans le public_id ici — pour le resource_type "image",
  // Cloudinary gère l'extension séparément (paramètre "format"), et forcer
  // un point dans le public_id est un comportement moins bien documenté
  // pour ce type de ressource. Conséquence mineure assumée : le fichier
  // téléchargé porte toujours l'extension ".jpg" par défaut dans
  // download.js, même si l'original était un PNG — cosmétique uniquement,
  // le contenu réel du fichier (et son Content-Type) reste correct.
  const result = await uploadBuffer(buffer, { resourceType: "image", type: "authenticated", folder: "okimart/private/photos" });
  return makeRef("image", result.public_id, result.version);
}

/**
 * Génère une version publique (miniature / aperçu) redimensionnée,
 * avec filigrane texte optionnel, et l'envoie sur Cloudinary (public).
 * Signature et options identiques à la version "disque local" d'origine —
 * destDir n'est plus utilisé (conservé pour compatibilité d'appel) : c'est
 * urlPrefix qui détermine désormais le dossier Cloudinary de destination.
 */
async function savePublicVersion(buffer, {
  destDir = null, // conservé pour compat d'appel, plus utilisé
  urlPrefix = "/uploads/photos",
  maxWidth = 1600,
  quality = 82,
  watermarkText = null
} = {}) {
  try {
    await sharp(buffer).metadata();
  } catch (e) {
    throw new Error("Ce fichier image est illisible ou dans un format non supporté.");
  }

  let img = sharp(buffer).rotate().resize({ width: maxWidth, withoutEnlargement: true });

  if (watermarkText) {
    const resizedBuffer = await img.toBuffer();
    const meta = await sharp(resizedBuffer).metadata();
    const w = meta.width;
    const h = meta.height;

    const fontSize = Math.max(14, Math.round(w * 0.028));

    const svg = `
<svg width="${w}" height="${h}">
<style>
.wm { font-family: Arial, sans-serif; font-size: ${fontSize}px; font-weight: 600; fill: rgba(255,255,255,0.82); letter-spacing: 2px; }
.wm-shadow { fill: rgba(0,0,0,0.35); }
</style>
<text x="${w - 18}" y="${h - 18}" text-anchor="end" class="wm wm-shadow" dx="1" dy="1">${watermarkText}</text>
<text x="${w - 18}" y="${h - 18}" text-anchor="end" class="wm">${watermarkText}</text>
</svg>`;

    img = sharp(resizedBuffer).composite([{ input: Buffer.from(svg) }]);
  }

  const outBuffer = await img.jpeg({ quality, mozjpeg: true }).toBuffer();
  const result = await uploadBuffer(outBuffer, { resourceType: "image", type: "upload", folder: toFolder(urlPrefix) });
  return result.secure_url;
}

/** Vidéo PUBLIQUE de portfolio (vitrine, sans filigrane) — envoyée telle quelle à Cloudinary. */
async function saveVideoPublic(buffer, {
  destDir = null, // conservé pour compat d'appel, plus utilisé
  urlPrefix = "/uploads/photos"
} = {}) {
  const result = await uploadBuffer(buffer, { resourceType: "video", type: "upload", folder: toFolder(urlPrefix) });
  return result.secure_url;
}

// ---------------------------------------------------------------
// Vidéos (portfolio public + séances client)
// ---------------------------------------------------------------

/** Séance client : vidéo PRIVÉE (jamais d'URL publique), comme une photo originale HD. */
async function saveVideoPrivate(buffer, originalname) {
  const result = await uploadBuffer(buffer, { resourceType: "video", type: "authenticated", folder: "okimart/private/videos" });
  return makeRef("video", result.public_id, result.version);
}

// ---------------------------------------------------------------
// Fichiers logiciels (installeurs, archives...) — stockage privé,
// jamais servi par une URL publique directe (voir routes de
// téléchargement dédiées, protégées par licence + compte client).
// ---------------------------------------------------------------
const MAX_SOFTWARE_SIZE = 500 * 1024 * 1024; // 500 Mo — voir note plafond Cloudinary Free plus haut
const ALLOWED_SOFTWARE_EXT = new Set([".zip", ".exe", ".dmg", ".pkg", ".apk", ".msi", ".7z", ".rar", ".tar", ".gz", ".appimage"]);

const uploadSoftwareFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SOFTWARE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_SOFTWARE_EXT.has(ext)) {
      return cb(new Error("Type de fichier non autorisé pour un logiciel. Formats acceptés : " + [...ALLOWED_SOFTWARE_EXT].join(", ")));
    }
    cb(null, true);
  }
});

/**
 * Enregistre un fichier logiciel en stockage privé Cloudinary (resource_type
 * "raw" : fichier binaire arbitraire, servi tel quel). Ne valide pas le
 * contenu binaire (contrairement aux images) : seule l'extension déclarée
 * est vérifiée (déjà fait par fileFilter ci-dessus).
 */
async function saveSoftwareFile(buffer, originalname) {
  const ext = path.extname(originalname || "").toLowerCase() || ".zip";
  // Contrairement à image/video, Cloudinary sert un asset "raw" à l'identique
  // du public_id fourni (pas de gestion automatique d'extension) : on
  // l'inclut donc nous-mêmes dans le public_id.
  const { nanoid } = require("nanoid");
  const publicId = `${nanoid(24)}${ext}`;
  const result = await uploadBuffer(buffer, { resourceType: "raw", type: "authenticated", folder: "okimart/private/software", publicId });
  return { relPath: makeRef("raw", result.public_id, result.version), size: buffer.length };
}

/**
 * Supprime un fichier PUBLIC (miniature, aperçu, image de service...).
 * Best-effort et non bloquant, comme avant la migration.
 * Gère les deux formats en base : URL Cloudinary (nouveau) et ancien
 * chemin local "/uploads/..." (jamais supprimé physiquement puisque le
 * disque n'est plus notre stockage — laissé sans effet, la ligne DB sera
 * de toute façon écrasée/supprimée par l'appelant).
 */
function deletePublicFile(publicUrl) {
  if (!publicUrl) return;
  if (isCloudinaryUrl(publicUrl)) { destroyPublicUrl(publicUrl).catch(() => {}); return; }
  // Ancien format local ("/uploads/xxx") : rien à faire côté stockage,
  // ce chemin ne pointe plus vers un disque persistant.
}

/**
 * Supprime un fichier PRIVÉ (original HD, fichier produit, installeur).
 * Même logique de compatibilité double-format que deletePublicFile.
 */
function deletePrivateFile(ref) {
  if (!ref) return;
  if (isCloudinaryRef(ref)) { destroyRef(ref).catch(() => {}); return; }
  // Ancien chemin local relatif : idem, sans effet (plus de disque persistant).
}

module.exports = {
  uploadMemory,
  uploadMedia,
  uploadSoftwareFile,
  saveOriginal,
  saveSoftwareFile,
  savePublicVersion,
  saveVideoPublic,
  saveVideoPrivate,
  isVideoFile,
  assertMediaSize,
  deletePublicFile,
  deletePrivateFile,
  signedPrivateUrl,
  isCloudinaryRef,
  PERSIST_ROOT
};
