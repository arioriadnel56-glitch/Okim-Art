// ============================================================
// compress.js — compression HTTP des réponses JSON, sans dépendance
// ============================================================
// Utilise uniquement le module natif "zlib". Ne touche QUE les réponses
// envoyées via res.json() (API) : les flux (ZIP, proxy d'images/vidéos
// Cloudinary) ne sont jamais compressés ni mis en mémoire.
const zlib = require("zlib");

const MIN_BYTES = 1024; // en dessous, la compression n'apporte rien

function pickEncoding(header) {
  const h = String(header || "").toLowerCase();
  if (/\bbr\b/.test(h)) return "br";
  if (/\bgzip\b/.test(h)) return "gzip";
  return null;
}

function compressJson() {
  return function (req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      const enc = pickEncoding(req.headers["accept-encoding"]);
      if (!enc || res.headersSent || res.getHeader("Content-Encoding")) return originalJson(body);
      const payload = Buffer.from(JSON.stringify(body === undefined ? null : body), "utf8");
      if (payload.length < MIN_BYTES) return originalJson(body);

      const done = (err, out) => {
        if (err) return originalJson(body); // en cas d'échec : réponse non compressée
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Encoding", enc);
        res.vary("Accept-Encoding");
        res.setHeader("Content-Length", out.length);
        res.end(out);
      };
      if (enc === "br") {
        zlib.brotliCompress(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, done);
      } else {
        zlib.gzip(payload, { level: 6 }, done);
      }
      return res;
    };
    next();
  };
}

module.exports = { compressJson, pickEncoding };
