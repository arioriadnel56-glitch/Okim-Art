// ============================================================
// cloudinaryStorage.js — primitives bas niveau autour du SDK Cloudinary
// ============================================================
// Toute la logique "métier" (redimensionnement, filigrane...) reste dans
// upload.js. Ce fichier ne fait que : envoyer un buffer à Cloudinary,
// encoder/décoder une référence d'asset PRIVÉ, et générer une URL signée
// ou une suppression à partir de cette référence.
//
// Format d'une référence d'asset PRIVÉ (stocké tel quel en base, jamais
// exposé au navigateur) : "cloudinary:<resource_type>:<public_id>"
//   ex: cloudinary:image:okimart/private/photos/aBcD1234EfGh
//
// Les assets PUBLICS, eux, sont stockés en base comme une simple URL
// https://res.cloudinary.com/... — utilisable directement dans un <img src>
// ou un <video src>, sans passer par ce module à la lecture.
const { nanoid } = require("nanoid");
const https = require("https");
const { cloudinary } = require("./cloudinary");

const REF_PREFIX = "cloudinary:";

function makeRef(resourceType, publicId, version) {
  // La version est INDISPENSABLE pour les assets "authenticated" (voir
  // signedPrivateUrl ci-dessous) — on l'encode dans la référence dès
  // l'upload pour ne jamais avoir à la redemander à Cloudinary ensuite.
  return version ? `${REF_PREFIX}${resourceType}:${version}:${publicId}` : `${REF_PREFIX}${resourceType}:${publicId}`;
}

function isCloudinaryRef(value) {
  return typeof value === "string" && value.startsWith(REF_PREFIX);
}

function parseRef(ref) {
  // Deux formats possibles :
  //   cloudinary:<resource_type>:<version>:<public_id>   (nouveau, avec version)
  //   cloudinary:<resource_type>:<public_id>              (ancien, sans version)
  // On distingue les deux au deuxième segment : une version Cloudinary est
  // TOUJOURS purement numérique, alors qu'un public_id commence toujours par
  // un nom de dossier (donc contient forcément au moins un "/" ou une lettre).
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
  // Pour image/video, Cloudinary sépare le format de l'extension dans le
  // public_id ; pour raw, le public_id contient déjà son extension telle
  // quelle (voir saveSoftwareFile). On ne retire donc l'extension finale
  // que pour image/video.
  const publicId = resourceType === "raw" ? m[2] : m[2].replace(/\.[a-zA-Z0-9]+$/, "");
  return { resourceType, publicId };
}

/** Upload d'un buffer en mémoire (jamais de fichier temporaire sur disque). */
function uploadBuffer(buffer, { resourceType, type, folder, publicId = nanoid(24) }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, type, folder, public_id: publicId, overwrite: false },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

/** Supprime un asset PRIVÉ à partir de sa référence encodée. Best-effort. */
async function destroyRef(ref) {
  if (!isCloudinaryRef(ref)) return;
  const { resourceType, publicId } = parseRef(ref);
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: "authenticated", invalidate: true });
  } catch (e) {
    console.error("[cloudinary] échec suppression asset privé :", publicId, e.message);
  }
}

/** Supprime un asset PUBLIC à partir de son URL de livraison. Best-effort. */
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
 * URL signée temporaire pour livrer un asset PRIVÉ.
 * NOTE IMPORTANTE : ce n'est pas une URL à expiration automatique (ça
 * demanderait l'option payante "Token-based authentication" de Cloudinary).
 * La protection réelle vient de notre propre application, EN AMONT : cette
 * fonction n'est appelée qu'après qu'un jeton de téléchargement à usage
 * unique (voir utils/tokens.js), une licence active, ou un accès galerie HD
 * ait déjà été vérifié côté serveur. Considérez cette URL comme un lien
 * "porte-clé" valable le temps d'un aller-retour HTTP, pas comme un lien
 * public partageable.
 *
 * @param {boolean} inline - false (défaut) = en-tête Content-Disposition
 *   "attachment" (téléchargement forcé, bouton "Télécharger"). true = pas de
 *   Content-Disposition forcé : le fichier s'affiche normalement dans la
 *   page (visionneuse plein écran) — INDISPENSABLE sur iPhone/Safari, où un
 *   appui long sur une image/vidéo affichée "à l'écran" propose "Enregistrer
 *   l'image/la vidéo" (écrit directement dans Photos), alors qu'un fichier
 *   forcé en téléchargement atterrit dans l'appli Fichiers, jamais Photos.
 * @param {function(string):Promise} onRepair - appelé UNE FOIS avec la
 *   référence corrigée (version incluse) si celle-ci manquait et a dû être
 *   redemandée à Cloudinary. Laisser l'appelant réécrire cette référence en
 *   base transforme l'auto-réparation "à chaque téléchargement" en
 *   auto-réparation "une seule fois, pour toujours" — le fichier redevient
 *   aussi rapide qu'un fichier jamais touché par le bug dès le 2e accès.
 *   Best-effort : un échec d'écriture ici n'empêche jamais le téléchargement
 *   en cours de réussir, on retentera simplement la prochaine fois.
 */
async function signedPrivateUrl(ref, filename, { inline = false, onRepair } = {}) {
  const { resourceType, publicId, version } = parseRef(ref);
  let v = version;

  if (!v) {
    // BUG CORRIGÉ : cette référence a été créée avant l'ajout de la version
    // dans le format de ref (voir makeRef). Sans version explicite, le SDK
    // Cloudinary insère "v1" par défaut dans l'URL signée — qui ne
    // correspond QUASIMENT JAMAIS à la vraie version (un horodatage) du
    // fichier réel, ce qui fait échouer la livraison avec un 404 Cloudinary,
    // même si le fichier existe bel et bien. On la récupère une fois via
    // l'API Cloudinary pour les anciennes références (auto-réparation).
    try {
      const info = await cloudinary.api.resource(publicId, { resource_type: resourceType, type: "authenticated" });
      v = info.version;
      if (v && onRepair) {
        const repairedRef = makeRef(resourceType, publicId, v);
        // Ne bloque jamais le téléchargement en cours : "fire and forget".
        Promise.resolve(onRepair(repairedRef)).catch((e) =>
          console.error("[cloudinary] échec de la sauvegarde de la version réparée :", e.message)
        );
      }
    } catch (e) {
      console.error("[cloudinary] impossible de récupérer la version de", publicId, "-", e.message);
    }
  }

  const opts = { resource_type: resourceType, type: "authenticated", sign_url: true, secure: true };
  if (v) opts.version = v;
  if (!inline) opts.flags = filename ? `attachment:${encodeURIComponent(filename)}` : "attachment";
  return cloudinary.url(publicId, opts);
}

/**
 * Ouvre un flux HTTPS lisible vers un asset PRIVÉ, en passant par notre
 * propre serveur (proxy en streaming, jamais bufferisé en RAM).
 * BUG CORRIGÉ (CORS) : la visionneuse (<img>/<video>) affiche très bien un
 * fichier chargé via une redirection vers Cloudinary — un simple affichage
 * ne demande aucune autorisation CORS. Mais dès qu'on veut RÉCUPÉRER ce
 * fichier en JavaScript (fetch + blob, nécessaire pour le partage natif iOS
 * "Save Image/Video"), le navigateur applique les règles CORS sur la
 * redirection cross-origin vers res.cloudinary.com. En proxyfiant nous-mêmes
 * le flux d'octets, le fetch() du navigateur reste sur notre propre
 * domaine : plus aucun souci CORS.
 * BUG CORRIGÉ (redirections) : `https.get()` de Node NE SUIT JAMAIS
 * automatiquement les redirections HTTP (3xx) — contrairement à un
 * navigateur ou à fetch(). Or Cloudinary sert souvent les vidéos (plus
 * volumineuses) via une redirection vers son stockage sous-jacent, alors
 * que les petites images sont plus souvent servies directement en 200. Sans
 * ce correctif, toute vidéo dont la livraison passe par une redirection
 * échouait silencieusement ("Cloudinary a répondu 302"), alors que les
 * photos fonctionnaient normalement — exactement le symptôme observé.
 */
function openPrivateStream(ref, { onRepair } = {}) {
  return signedPrivateUrl(ref, null, { inline: true, onRepair }).then((url) => fetchFollowingRedirects(url));
}

/** Suit une vraie chaîne de redirections (pas un seul saut) — https.get() de Node n'en suit aucune nativement. */
function fetchFollowingRedirects(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume(); // vide la réponse en cours pour libérer la connexion
        if (redirectsLeft <= 0) return reject(new Error("Trop de redirections lors de la récupération du fichier."));
        // new URL(location, url) gère aussi bien une redirection en URL
        // absolue (cas Cloudinary habituel) qu'en URL relative (rare, mais
        // techniquement valide en HTTP).
        const nextUrl = new URL(headers.location, url).toString();
        return resolve(fetchFollowingRedirects(nextUrl, redirectsLeft - 1));
      }
      if (statusCode >= 200 && statusCode < 300) return resolve(res);
      reject(new Error(`Cloudinary a répondu ${statusCode}`));
    }).on("error", reject);
  });
}

module.exports = {
  makeRef, isCloudinaryRef, parseRef, isCloudinaryUrl, parsePublicUrl,
  uploadBuffer, destroyRef, destroyPublicUrl, signedPrivateUrl, openPrivateStream
};