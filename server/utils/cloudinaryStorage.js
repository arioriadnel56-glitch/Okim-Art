// ============================================================
// cloudinaryStorage.js — primitives bas niveau autour du SDK Cloudinary
// ============================================================
const { nanoid } = require("nanoid");
const https = require("https");
const path = require("path");
const { cloudinary } = require("./cloudinary");

// Agent HTTPS réutilisé avec keep-alive
const keepAliveAgent = new https.Agent({ 
  keepAlive: true, 
  maxSockets: 25, 
  freeSocketTimeout: 30000 
});

const REF_PREFIX = "cloudinary:";

function makeRef(resourceType, publicId, version) {
  return version ? `${REF_PREFIX}${resourceType}:${version}:${publicId}` : `${REF_PREFIX}${resourceType}:${publicId}`;
}

function isCloudinaryRef(value) {
  return typeof value === "string" && value.startsWith(REF_PREFIX);
}

function parseRef(ref) {
  const rest = ref.slice(REF_PREFIX.length);
  const firstColon = rest.indexOf(":");
  const resourceType = rest.slice(0, firstColon);
  const remainder = rest.slice(firstColon + 1);
  const m = remainder.match(/^(\d+):(.+)$/s);
  if (m) return { resourceType, version: m[1], publicId: m[2] };
  return { resourceType, version: null, publicId: remainder };
}

function isCloudinaryUrl(value) {
  return typeof value === "string" && value.includes("res.cloudinary.com");
}

/** Extrait { resourceType, publicId } d'une URL de livraison Cloudinary publique. */
function parsePublicUrl(url) {
  const m = url.match(/res\.cloudinary\.com\/[^/]+\/(image|video|raw)\/upload\/(?:[^/]+\/)*?v\d+\/(.+)$/);
  if (!m) return null;
  const resourceType = m[1];
  const publicId = resourceType === "raw" ? m[2] : m[2].replace(/\.[a-zA-Z0-9]+$/, "");
  return { resourceType, publicId };
}

/** Upload d'un buffer en mémoire. */
function uploadBuffer(buffer, { resourceType, type, folder, publicId = nanoid(24) }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, type, folder, public_id: publicId, overwrite: false },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

/** Supprime un asset PRIVÉ à partir de sa référence encodée. */
async function destroyRef(ref) {
  if (!isCloudinaryRef(ref)) return;
  const { resourceType, publicId } = parseRef(ref);
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: "authenticated", invalidate: true });
  } catch (e) {
    console.error("[cloudinary] échec suppression asset privé :", publicId, e.message);
  }
}

/** Supprime un asset PUBLIC à partir de son URL de livraison. */
async function destroyPublicUrl(url) {
  const parsed = parsePublicUrl(url);
  if (!parsed) return;
  try {
    await cloudinary.uploader.destroy(parsed.publicId, { resource_type: parsed.resourceType, type: "upload", invalidate: true });
  } catch (e) {
    console.error("[cloudinary] échec suppression asset public :", parsed.publicId, e.message);
  }
}

/**
 * Génère une URL signée sécurisée pour livrer un asset PRIVÉ à un client.
 */
async function signedPrivateUrl(ref, filename, { inline = false, onRepair } = {}) {
  const { resourceType, publicId, version } = parseRef(ref);
  let v = version;
  let detectedFormat = null;

  // Extraction de l'extension si le filename est transmis
  if (filename) {
    const ext = path.extname(filename).replace(".", "").toLowerCase();
    if (ext && ext !== "bin") {
      detectedFormat = ext;
    }
  }

  if (!v) {
    try {
      const info = await cloudinary.api.resource(publicId, { resource_type: resourceType, type: "authenticated" });
      v = info.version;
      if (!detectedFormat && info.format) {
        detectedFormat = info.format;
      }
      if (v && onRepair) {
        const repairedRef = makeRef(resourceType, publicId, v);
        Promise.resolve(onRepair(repairedRef)).catch((e) =>
          console.error("[cloudinary] échec de la sauvegarde de la version réparée :", e.message)
        );
      }
    } catch (e) {
      console.error("[cloudinary] impossible de récupérer la version de", publicId, "(resource_type:", resourceType + ") -", e.message);
      throw new Error("Ce fichier n'est plus disponible sur le stockage (référence introuvable ou expirée). Contactez le support.");
    }
  }

  const opts = { 
    resource_type: resourceType, 
    type: "authenticated", 
    sign_url: true, 
    secure: true 
  };

  if (v) opts.version = v;
  if (detectedFormat) opts.format = detectedFormat;

  if (!inline) {
    // Correctif header attachment avec encodage strict des caractères pour éviter les rejets Safari/iOS
    const safeFilename = filename ? encodeURIComponent(filename) : "download";
    opts.flags = `attachment:${safeFilename}`;
  }

  return cloudinary.url(publicId, opts);
}

/**
 * Ouvre un flux HTTPS lisible vers un asset PRIVÉ via un proxy en streaming.
 */
function openPrivateStream(ref, { onRepair } = {}) {
  return signedPrivateUrl(ref, null, { inline: true, onRepair }).then((url) => fetchFollowingRedirects(url));
}

/** Suit la chaîne de redirections HTTP/HTTPS sans bloquer de connexions. */
function fetchFollowingRedirects(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent: keepAliveAgent }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume(); // Indispensable : libère immédiatement le socket
        if (redirectsLeft <= 0) return reject(new Error("Trop de redirections lors de la récupération du fichier."));
        const nextUrl = new URL(headers.location, url).toString();
        return resolve(fetchFollowingRedirects(nextUrl, redirectsLeft - 1));
      }

      if (statusCode >= 200 && statusCode < 300) {
        return resolve(res);
      }

      res.resume();
      reject(new Error(`Cloudinary a répondu ${statusCode}`));
    }).on("error", reject);
  });
}

module.exports = {
  makeRef, 
  isCloudinaryRef, 
  parseRef, 
  isCloudinaryUrl, 
  parsePublicUrl,
  uploadBuffer, 
  destroyRef, 
  destroyPublicUrl, 
  signedPrivateUrl, 
  openPrivateStream
};
