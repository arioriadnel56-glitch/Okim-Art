// scripts/make-webp.js — génère les .webp à partir des .jpg du dépôt (utilise "sharp", déjà installé).
// Usage (depuis la racine du dépôt) : node scripts/make-webp.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const root = path.join(__dirname, "..", "public");
const dirs = [path.join(root, "assets", "portfolio"), path.join(root, "img", "about")];

(async () => {
  let n = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /\.jpe?g$/i.test(x))) {
      const out = path.join(dir, f.replace(/\.jpe?g$/i, ".webp"));
      await sharp(path.join(dir, f)).webp({ quality: 80, effort: 6 }).toFile(out);
      console.log("OK", path.relative(root, out));
      n++;
    }
  }
  console.log(n + " image(s) WebP créée(s).");
})().catch((e) => { console.error(e); process.exit(1); });
