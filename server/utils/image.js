// ============================================================
// images.js — optimisation à la livraison des images Cloudinary publiques
// ============================================================
// Insère "f_auto,q_auto[,w_N]" dans l'URL de livraison : Cloudinary sert
// alors WebP/AVIF selon le navigateur, sans modifier le fichier stocké
// (aucune donnée touchée). Les URL non-Cloudinary et les vidéos sont
// renvoyées telles quelles.
function optimizeImageUrl(url, width) {
  if (typeof url !== "string") return url;
  const m = url.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/);
  if (!m) return url;
  if (/^(?:[a-z]{1,3}_[^/,]+,?)+\//.test(m[2]) && /(^|,)f_auto/.test(m[2].split("/")[0])) return url; // déjà transformée
  const t = "f_auto,q_auto" + (width ? `,w_${width}` : "");
  return m[1] + t + "/" + m[2];
}

module.exports = { optimizeImageUrl };
