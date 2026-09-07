// ============================================================
// seo.js — robots.txt et sitemap.xml générés dynamiquement
// ============================================================
// Générés à la volée (plutôt que des fichiers statiques dans public/) pour
// pouvoir construire des URLs ABSOLUES correctes — Google exige une URL
// absolue pour la directive Sitemap et pour chaque <loc> du sitemap, et
// l'adresse réelle du site (site_url, réglages du studio, ou nom de
// domaine personnalisé) n'est connue qu'au moment de la requête.
const express = require("express");
const { db } = require("../db");

const router = express.Router();

async function getSiteUrl(req) {
  const row = await db.prepare("SELECT valeur FROM settings WHERE cle = 'site_url'").get();
  if (row && row.valeur) return row.valeur.replace(/\/$/, "");
  // Repli : déduit du nom d'hôte de la requête si site_url n'est pas
  // encore renseigné dans Paramètres → Profil & contact.
  return `${req.protocol}://${req.get("host")}`;
}

router.get("/robots.txt", async (req, res) => {
  const siteUrl = await getSiteUrl(req);
  res.type("text/plain").send(
`User-agent: *
Allow: /
Disallow: /admin/
Disallow: /compte.html
Disallow: /panier.html
Disallow: /reset-password.html
Disallow: /gallery/
Disallow: /api/

Sitemap: ${siteUrl}/sitemap.xml
`);
});

// Pages statiques du site public, avec une priorité indicative (Google
// ignore largement <priority>/<changefreq> aujourd'hui, mais ça reste une
// bonne pratique documentaire et certains autres moteurs les utilisent encore).
const STATIC_PAGES = [
  { path: "/", priority: "1.0", changefreq: "weekly" },
  { path: "/boutique.html", priority: "0.8", changefreq: "weekly" },
  { path: "/logiciels.html", priority: "0.8", changefreq: "weekly" }
];

router.get("/sitemap.xml", async (req, res) => {
  const siteUrl = await getSiteUrl(req);
  const now = new Date().toISOString().slice(0, 10);

  const urls = STATIC_PAGES.map((p) => ({ loc: siteUrl + p.path, lastmod: now, priority: p.priority, changefreq: p.changefreq }));

  // Fiches logiciel individuelles (contenu public indexable) : /logiciel.html?id=N
  const software = await db.prepare(`
    SELECT p.id, p.created_at FROM products p
    JOIN software_products sw ON sw.product_id = p.id
    WHERE p.statut = 'actif'
  `).all();
  software.forEach((s) => urls.push({
    loc: `${siteUrl}/logiciel.html?id=${s.id}`,
    lastmod: (s.created_at || now).slice(0, 10),
    priority: "0.6",
    changefreq: "monthly"
  }));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join("\n")}
</urlset>`;

  res.type("application/xml").send(xml);
});

module.exports = router;
