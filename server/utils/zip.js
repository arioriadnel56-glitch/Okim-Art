// ============================================================
// zip.js — génération de ZIP en flux (aucun fichier temporaire écrit)
// ============================================================
const archiver = require("archiver");
const path = require("path");
const { db } = require("../db");
const { PERSIST_ROOT } = require("./upload");
const { isCloudinaryRef, openPrivateStream } = require("./cloudinaryStorage");

/** Ouvre un flux de lecture pour un fichier privé, qu'il soit sur Cloudinary (nouveau) ou sur disque local (ancien, compatibilité). */
async function openReadStream(filePath, onRepair) {
  if (isCloudinaryRef(filePath)) return openPrivateStream(filePath, { onRepair });
  // Ancien chemin local (compatibilité ascendante — voir upload.js PERSIST_ROOT).
  return new Promise((resolve, reject) => {
    const fs = require("fs");
    const fullPath = path.join(PERSIST_ROOT, path.basename(filePath));
    const stream = fs.createReadStream(fullPath);
    stream.on("open", () => resolve(stream));
    stream.on("error", reject);
  });
}

/**
 * Diffuse un ZIP contenant les fichiers HD originaux d'une séance
 * directement dans la réponse HTTP, sans jamais écrire de fichier
 * temporaire sur le disque.
 * @param {{id:number, titre:string, file_path:string}[]} photos
 * @param {string} zipFilename
 * @param {import('http').ServerResponse} res
 */
async function streamSessionZip(photos, zipFilename, res) {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("[zip] erreur d'archivage :", err.message);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const ext = path.extname(p.file_path) || ".jpg";
    const safeTitre = (p.titre || `photo-${i + 1}`).replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || `photo-${i + 1}`;
    try {
      // onRepair réécrit la référence Cloudinary réparée (version retrouvée)
      // sur cette photo précise — une seule fois, jamais plus ensuite. `p.id`
      // doit donc obligatoirement faire partie de la requête SQL appelante.
      const onRepair = p.id
        ? (repairedRef) => db.prepare("UPDATE session_photos SET file_path = ? WHERE id = ?").run(repairedRef, p.id)
        : undefined;
      const stream = await openReadStream(p.file_path, onRepair);
      archive.append(stream, { name: `${String(i + 1).padStart(2, "0")}-${safeTitre}${ext}` });
    } catch (e) {
      console.error(`[zip] fichier ignoré (${p.file_path}) :`, e.message);
      // On continue avec les autres photos plutôt que de faire échouer tout le ZIP.
    }
  }

  archive.finalize();
}

module.exports = { streamSessionZip };
