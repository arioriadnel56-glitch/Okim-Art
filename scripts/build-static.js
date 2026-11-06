// ============================================================
// build-static.js — prépare le site statique (Render Static Site / CDN)
// ============================================================
// Usage : node scripts/build-static.js   (aucune dépendance)
// Variables d'environnement :
//   OKIM_SNAPSHOT_URL  URL CDN de l'instantané public (affichée dans les logs du backend au démarrage)
//   SITE_URL           URL publique du site statique (pour robots.txt / sitemap.xml)
// Sortie : ./dist  (à publier tel quel)
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "public");
const OUT = path.join(ROOT, "dist");
const snapshotUrl = process.env.OKIM_SNAPSHOT_URL || "";
const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });

// Précache : pages + CSS + JS + manifest + logo/icônes (les photos sont mises en cache à l'usage).
const list = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== "admin" && f.name !== "assets") walk(full); continue; }
    const rel = "/" + path.relative(OUT, full).split(path.sep).join("/");
    if (/^\/(sw\.js|sitemap\.xml)$/.test(rel)) continue;
    if (/\.(html|css|js|json)$/.test(rel) || /^\/img\/brand\//.test(rel)) list.push(rel);
  }
})(OUT);
list.unshift("/");

// Version = empreinte du contenu : toute modification change la version, donc purge les anciens caches.
const hash = crypto.createHash("sha1");
for (const rel of list.slice(1).sort()) hash.update(rel).update(fs.readFileSync(path.join(OUT, rel)));
const version = hash.digest("hex").slice(0, 10);

const swPath = path.join(OUT, "sw.js");
let sw = fs.readFileSync(swPath, "utf8");
sw = sw.replace('const VERSION = "dev"; // @OKIM_VERSION', `const VERSION = "${version}";`);
sw = sw.replace(/\/\*@OKIM_PRECACHE_START\*\/[\s\S]*?\/\*@OKIM_PRECACHE_END\*\//, JSON.stringify(list));
fs.writeFileSync(swPath, sw);

const corePath = path.join(OUT, "js", "okim-core.js");
let core = fs.readFileSync(corePath, "utf8");
core = core.replace("/*@OKIM_CONFIG_START*/{}/*@OKIM_CONFIG_END*/", JSON.stringify({ snapshotUrl }));
fs.writeFileSync(corePath, core);

// robots.txt / sitemap.xml statiques (plus de réveil du backend pour les robots).
fs.writeFileSync(path.join(OUT, "robots.txt"),
`User-agent: *
Allow: /
Disallow: /admin/
Disallow: /compte.html
Disallow: /panier.html
Disallow: /reset-password.html
Disallow: /gallery/
Disallow: /api/
${siteUrl ? `\nSitemap: ${siteUrl}/sitemap.xml\n` : ""}`);
if (siteUrl) {
  const pages = ["/", "/boutique.html", "/logiciels.html"];
  fs.writeFileSync(path.join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    pages.map((p) => `  <url><loc>${siteUrl}${p}</loc></url>`).join("\n") + `\n</urlset>\n`);
}
console.log(`[build] dist/ prêt — version ${version}, ${list.length} fichiers précachés, snapshotUrl=${snapshotUrl || "(non défini)"}`);
