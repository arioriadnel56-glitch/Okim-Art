// ============================================================
// server.js — point d'entrée de la plateforme OKIM ART
// ============================================================
require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const { initDb, ensureFirstAdmin } = require("./db");
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
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// En-têtes de sécurité de base (sans dépendance supplémentaire)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// ---------- SEO : robots.txt + sitemap.xml générés dynamiquement (voir routes/seo.js) ----------
// Placé AVANT express.static pour ne jamais pouvoir être masqué par un
// éventuel fichier statique du même nom.
app.use(seoRoutes);

// ---------- Fichiers statiques (frontend public existant, jamais modifié visuellement) ----------
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

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
  await initDb();

  app.listen(PORT, async () => {
    console.log(`\nOKIM ART — serveur démarré sur http://localhost:${PORT}`);
    console.log(`Site public : http://localhost:${PORT}/`);
    console.log(`Espace admin : http://localhost:${PORT}/admin/`);

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

    // Purge automatique de la corbeille (30 jours) : au démarrage, puis toutes les heures.
    purgeExpiredTrash().catch((e) => console.error("[purgeExpiredTrash]", e));
    setInterval(() => purgeExpiredTrash().catch((e) => console.error("[purgeExpiredTrash]", e)), 60 * 60 * 1000);

    // Bascule les séances photo dont la rétention gratuite est dépassée
    // vers le statut "archived" : au démarrage, puis toutes les heures.
    sweepExpiredSessions().catch((e) => console.error("[sweepExpiredSessions]", e));
    setInterval(() => sweepExpiredSessions().catch((e) => console.error("[sweepExpiredSessions]", e)), 60 * 60 * 1000);

    // Bascule les licences logicielles dont la date d'expiration est
    // dépassée vers le statut "expiree" : au démarrage, puis toutes les heures.
    sweepExpiredLicenses().catch((e) => console.error("[sweepExpiredLicenses]", e));
    setInterval(() => sweepExpiredLicenses().catch((e) => console.error("[sweepExpiredLicenses]", e)), 60 * 60 * 1000);

    // Notifications "licence bientôt expirée" (client + e-mail) : au démarrage, puis toutes les heures.
    sweepExpiringLicenses().catch((e) => console.error("[sweepExpiringLicenses]", e));
    setInterval(() => sweepExpiringLicenses().catch((e) => console.error("[sweepExpiringLicenses]", e)), 60 * 60 * 1000);
  });
}

main().catch((err) => {
  console.error("Échec du démarrage du serveur (connexion à la base de données ?) :", err);
  process.exit(1);
});
