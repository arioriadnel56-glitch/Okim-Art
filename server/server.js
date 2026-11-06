// ============================================================
// server.js — point d'entrée de la plateforme OKIM ART
// ============================================================
require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const { initDb, ensureFirstAdmin } = require("./db");
const { compressJson } = require("./utils/compress");
const { scheduleSnapshot, ensureSnapshotOnce, snapshotUrl } = require("./utils/snapshot");
const { purgeOldIdempotencyKeys } = require("./utils/idempotency");
const { requireAdmin, requireOwner, requireSection } = require("./middleware/auth");
const { purgeExpiredTrash } = require("./utils/trash");
const { sweepExpiredSessions } = require("./utils/gallery");
const { sweepExpiredLicenses, sweepExpiringLicenses } = require("./utils/licenses");

const authRoutes = require("./routes/auth");
const publicRoutes = require("./routes/public");
const ordersRoutes = require("./routes/orders");
const downloadRoutes = require("./routes/download");
const clientRoutes = require("./routes/client");
const kkiapayRoutes = require("./routes/kkiapay");
const assistantRoutes = require("./routes/assistant");
const paymentsRoutes = require("./routes/payments");
const galleryRoutes = require("./routes/gallery");

const adminPhotos = require("./routes/admin/photos");
const adminCategories = require("./routes/admin/categories");
const adminServices = require("./routes/admin/services");
const adminFormations = require("./routes/admin/formations");
const adminProducts = require("./routes/admin/products");
const adminOrders = require("./routes/admin/orders");
const adminMessages = require("./routes/admin/messages");
const adminSettings = require("./routes/admin/settings");
const adminDashboard = require("./routes/admin/dashboard");
const adminTrash = require("./routes/admin/trash");
const adminSessions = require("./routes/admin/sessions");
const adminAdmins = require("./routes/admin/admins");
const adminSoftware = require("./routes/admin/software");
const adminLicenses = require("./routes/admin/licenses");
const adminTestimonials = require("./routes/admin/testimonials");
const adminNotifications = require("./routes/admin/notifications");
const adminSignature = require("./routes/admin/signature");
const seoRoutes = require("./routes/seo");

const app = express();

// 👉 Configuration indispensable pour Render (proxy inverse et rate limit)
// Nombre de proxys de confiance devant l'application. 1 = répartiteur Render seul.
// Si le site statique Render relaie /api/* (voir render.yaml), il y a un proxy de plus :
// vérifiez sur /api/health que "client_ip" est bien VOTRE adresse, sinon réglez
// TRUST_PROXY_HOPS=2 — les limiteurs de tentatives (connexion, PIN) en dépendent.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 1);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

app.disable("x-powered-by");

// ---------- Santé : répond IMMÉDIATEMENT, sans toucher à la base ----------
// Utilisé UNIQUEMENT à la demande par le frontend (réveil de Render quand une
// fonctionnalité serveur est sollicitée) — jamais par un ping périodique.
// Déclaré avant tout le reste pour que le réveil soit le plus court possible.
let dbReady = false;
let dbFailed = null;
app.get("/api/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, service: "okim-art", ready: dbReady, uptime: Math.round(process.uptime()), client_ip: req.ip });
});

app.use(compressJson());
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// En-têtes de sécurité de base (sans dépendance supplémentaire)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Interdit l'accès caméra/micro/géolocalisation par défaut — le site n'en
  // a besoin nulle part ; réduit la surface d'attaque si un script tiers
  // (widget KKiaPay, etc.) était un jour compromis.
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // HSTS : force le navigateur à toujours utiliser HTTPS pour ce domaine,
  // même si quelqu'un tape/partage un lien en http:// par erreur. Seulement
  // en production (Render sert bien du HTTPS) — inutile et gênant en local.
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// ---------- API : jamais mise en cache par défaut (sessions, données privées) ----------
// Les routes publiques en lecture seule (routes/public.js) redéfinissent
// explicitement un cache court. Évite toute fuite de données entre
// utilisateurs via un cache partagé (CDN, proxy).
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ---------- Attend la base avant toute route /api (sauf /api/health, déjà répondue) ----------
// Le serveur écoute tout de suite (donc Render considère le service "up" et
// /api/health répond), pendant que la base s'initialise en arrière-plan.
let readyResolve;
const readyPromise = new Promise((r) => { readyResolve = r; });
app.use("/api", async (req, res, next) => {
  if (!dbReady) {
    await Promise.race([readyPromise, new Promise((r) => setTimeout(r, 20000))]);
  }
  if (dbFailed) return res.status(503).set("Retry-After", "5").json({ error: "Service en cours de démarrage, réessayez dans un instant." });
  if (!dbReady) return res.status(503).set("Retry-After", "3").json({ error: "Service en cours de démarrage, réessayez dans un instant." });
  next();
});

// ---------- Instantané public : republié après toute modification admin réussie ----------
app.use("/api/admin", (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    res.on("finish", () => { if (res.statusCode < 400) scheduleSnapshot(); });
  }
  next();
});

// ---------- SEO : robots.txt + sitemap.xml générés dynamiquement (voir routes/seo.js) ----------
// Placé AVANT express.static pour ne jamais pouvoir être masqué par un
// éventuel fichier statique du même nom.
app.use(seoRoutes);

// ---------- Fichiers statiques (frontend public existant, jamais modifié visuellement) ----------
// Cache : HTML/CSS/JS revalidés (ETag) pour que les mises à jour soient immédiates,
// images et polices conservées longtemps. (En production, ces fichiers sont servis
// par le site statique Render + CDN — voir render.yaml ; ceci sert le dev local
// et le mode "un seul service".)
app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  setHeaders(res, filePath) {
    if (/\.(?:jpe?g|png|webp|avif|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=604800");
    } else if (/sw\.js$/.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Service-Worker-Allowed", "/");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

// ---------- Fichiers uploadés publics (photos, aperçus, logo...) ----------
// Servis depuis PERSIST_ROOT/public (voir server/utils/upload.js), racine
// unique et distincte du code applicatif — c'est CE dossier qu'il faut
// faire pointer vers un disque persistant en production (Render Disk...),
// jamais "public/" lui-même (qui contient le site statique versionné).
const { PERSIST_ROOT } = require("./utils/upload");
app.use("/uploads", express.static(path.join(PERSIST_ROOT, "public")));

// ---------- API publique ----------
app.use("/api/auth", authRoutes);
app.use("/api", publicRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/download", downloadRoutes);
app.use("/api/client", clientRoutes);
app.use("/api", kkiapayRoutes); // /api/kkiapay/webhook + /api/orders/:id/kkiapay-confirm
app.use("/api/assistant", assistantRoutes);
app.use("/api/payments", paymentsRoutes); // /api/payments/kkiapay-webhook (alias)
app.use("/api/gallery", galleryRoutes);

// Page publique de la galerie client (le jeton est géré côté client en JS)
app.get("/gallery/:token", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "gallery.html")));

// ---------- API admin (protégée) ----------
// Groupes Contenu / Boutique / Clients : mêmes regroupements que la barre
// latérale de l'admin (public/admin/dashboard.html) — c'est ce qui définit
// le périmètre exact d'un compte "secretary" (voir requireSection).
// "Système" (trash, settings, admins) et le tableau de bord/notifications
// restent hors périmètre secrétaire — settings/admins déjà verrouillés par
// requireOwner ci-dessous.
app.use("/api/admin/photos", requireAdmin, requireSection("contenu"), adminPhotos);
app.use("/api/admin/categories", requireAdmin, requireSection("contenu"), adminCategories);
app.use("/api/admin/services", requireAdmin, requireSection("contenu"), adminServices);
app.use("/api/admin/formations", requireAdmin, requireSection("contenu"), adminFormations);
app.use("/api/admin/products", requireAdmin, requireSection("boutique"), adminProducts);
app.use("/api/admin/orders", requireAdmin, requireSection("clients"), adminOrders);
app.use("/api/admin/messages", requireAdmin, requireSection("clients"), adminMessages);
app.use("/api/admin/settings", requireAdmin, requireOwner, adminSettings);
app.use("/api/admin/dashboard", requireAdmin, adminDashboard);
app.use("/api/admin/trash", requireAdmin, requireSection("systeme"), adminTrash);
app.use("/api/admin/sessions", requireAdmin, requireSection("clients"), adminSessions);
app.use("/api/admin/admins", requireAdmin, requireOwner, adminAdmins);
app.use("/api/admin/software", requireAdmin, requireSection("boutique"), adminSoftware);
app.use("/api/admin/licenses", requireAdmin, requireSection("boutique"), adminLicenses);
app.use("/api/admin/testimonials", requireAdmin, requireSection("clients"), adminTestimonials);
app.use("/api/admin/notifications", requireAdmin, adminNotifications);
// Expose GET /api/signature/video — hors du préfixe /api/admin pour respecter
// l'URL demandée par le front-end, mais protégée par requireAdmin comme
// toutes les autres routes d'administration.
app.use("/api/signature", requireAdmin, requireSection("contenu"), adminSignature);

// ---------- Page 404 pour les routes API inconnues ----------
app.use("/api", (req, res) => res.status(404).json({ error: "Route API inconnue." }));

// ---------- Gestionnaire d'erreurs (ne jamais renvoyer la pile d'erreurs au client) ----------
app.use((err, req, res, next) => {
  console.error("[Erreur]", err);
  if (err?.message?.includes("Type de fichier")) return res.status(400).json({ error: err.message });
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Fichier trop volumineux (20 Mo max)." });
  res.status(500).json({ error: "Erreur interne du serveur." });
});

// ---------- Démarrage ----------
// La connexion PostgreSQL et la création du schéma sont asynchrones (contrairement
// à l'ancienne base SQLite en fichier local) : on attend que tout soit prêt
// avant d'accepter des requêtes HTTP.
async function main() {
  // On écoute d'abord : /api/health répond tout de suite, la base s'initialise
  // en parallèle (voir portier "dbReady" ci-dessus). Avant : app.listen n'était
  // appelé qu'après initDb() => tout le schéma/amorçage retardait le réveil.
  const server = app.listen(PORT, () => {
    console.log(`\nOKIM ART — serveur démarré sur http://localhost:${PORT}`);
    console.log(`Site public : http://localhost:${PORT}/`);
    console.log(`Espace admin : http://localhost:${PORT}/admin/`);
  });
  // Doit dépasser le délai d'inactivité du répartiteur de charge Render (≈ 60 s),
  // sinon des 502 sporadiques apparaissent sur des connexions réutilisées.
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;
  server.requestTimeout = 0; // les uploads/téléchargements lourds (ZIP, vidéos) ne doivent pas être coupés

  // Arrêt propre (Render envoie SIGTERM à chaque mise en veille / déploiement).
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[arrêt] ${sig} reçu — fermeture propre…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    const t0 = Date.now();
    const info = await initDb();
    console.log(`[db] prête en ${Date.now() - t0} ms${info && info.skipped ? " (schéma déjà à jour)" : " (schéma initialisé)"}`);
    dbReady = true;
    readyResolve();
  } catch (err) {
    dbFailed = err;
    readyResolve();
    console.error("[Erreur critique au démarrage]", err);
    process.exit(1);
  }

  try {
    const created = await ensureFirstAdmin();
    if (created) {
      const fs = require("fs");
      const msg = `
================================================================
 COMPTE ADMINISTRATEUR CRÉÉ (à noter puis à SUPPRIMER ce fichier)
================================================================
 URL de connexion : /admin/
 Email            : ${created.email}
 Mot de passe     : ${created.rawPassword}

 Changez ce mot de passe dès la première connexion
 (Paramètres → Sécurité), puis supprimez ce fichier.
================================================================
`;
      console.log(msg);
      fs.writeFileSync(path.join(__dirname, "..", "ADMIN-IDENTIFIANTS.txt"), msg.trim() + "\n");
    }
  } catch (e) {
    console.error("[démarrage] Échec de la création/vérification du premier admin :", e);
  }

  // Tâches d'entretien : décalées de 30 s après le démarrage pour ne pas
  // concurrencer la première requête d'un visiteur qui vient de réveiller le
  // serveur ; puis toutes les heures TANT QUE le serveur est éveillé. Ce n'est
  // pas un ping : rien ne réveille Render, ces tâches ne tournent que si le
  // service est déjà actif.
  const HOUR = 60 * 60 * 1000;
  const guarded = (name, fn) => () => fn().catch((e) => console.error(`[${name}]`, e));
  const jobs = [
    guarded("purgeExpiredTrash", purgeExpiredTrash),
    guarded("sweepExpiredSessions", sweepExpiredSessions),
    guarded("sweepExpiredLicenses", sweepExpiredLicenses),
    guarded("sweepExpiringLicenses", sweepExpiringLicenses),
    guarded("purgeOldIdempotencyKeys", purgeOldIdempotencyKeys)
  ];
  setTimeout(() => {
    jobs.forEach((j) => j());
    setInterval(() => jobs.forEach((j) => j()), HOUR);
  }, 30 * 1000).unref();

  // Instantané public pour le CDN : publié une seule fois s'il n'existe pas encore,
  // ensuite après chaque modification faite dans l'administration.
  setTimeout(() => { ensureSnapshotOnce(); }, 45 * 1000).unref();
  const url = snapshotUrl();
  if (url) console.log(`[snapshot] URL publique de l'instantané : ${url}`);
}

main().catch((err) => {
  console.error("[Erreur critique au démarrage]", err);
  process.exit(1);
});
