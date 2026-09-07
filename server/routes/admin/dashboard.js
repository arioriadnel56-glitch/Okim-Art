const express = require("express");
const { db } = require("../../db");
const router = express.Router();

async function getResetAt() {
  const row = await db.prepare("SELECT valeur FROM settings WHERE cle = 'dashboard_reset_at'").get();
  return row && row.valeur ? row.valeur : null;
}

router.get("/", async (req, res) => {
  const resetAt = await getResetAt();
  // Quand une réinitialisation a été demandée, chaque compteur ne prend en
  // compte que ce qui a été créé APRÈS cette date — rien n'est supprimé,
  // les données restent visibles et intactes dans leurs sections respectives
  // (photos, commandes, messages...), seul l'affichage du tableau de bord
  // "repart de zéro" comme un compteur qu'on réinitialise.
  const since = (col) => (resetAt ? ` AND ${col} >= '${resetAt}'` : "");
  const count = async (sql) => (await db.prepare(sql).get()).n;

  res.json({
    stats: {
      photos: await count(`SELECT COUNT(*) n FROM photos WHERE 1=1${since("created_at")}`),
      photos_publiees: await count(`SELECT COUNT(*) n FROM photos WHERE statut='publie'${since("created_at")}`),
      produits: await count(`SELECT COUNT(*) n FROM products WHERE statut='actif'${since("created_at")}`),
      commandes: await count(`SELECT COUNT(*) n FROM orders WHERE 1=1${since("created_at")}`),
      commandes_en_attente: await count(`SELECT COUNT(*) n FROM orders WHERE statut='en_attente'${since("created_at")}`),
      chiffre_affaires: await count(`SELECT COALESCE(SUM(montant),0) n FROM orders WHERE statut IN ('payee','livree')${since("created_at")}`),
      clients: await count(`SELECT COUNT(*) n FROM clients WHERE 1=1${since("created_at")}`),
      formations: await count(`SELECT COUNT(*) n FROM formations WHERE statut='actif'${since("created_at")}`),
      inscriptions: await count(`SELECT COUNT(*) n FROM inscriptions_formation WHERE 1=1${since("created_at")}`),
      messages_non_lus: await count(`SELECT COUNT(*) n FROM messages WHERE statut='non_lu'${since("created_at")}`),
      seances_actives: await count(`SELECT COUNT(*) n FROM sessions_photo WHERE status='active'${since("created_at")}`),
      seances_archivees: await count(`SELECT COUNT(*) n FROM sessions_photo WHERE status='archived'${since("created_at")}`),
      revenus_recuperation: await count(`SELECT COALESCE(SUM(amount),0) n FROM recovery_transactions WHERE status='success'${since("created_at")}`),

      // ---- Module "Outils & Logiciels" ----
      logiciels_publies: await count(`SELECT COUNT(*) n FROM products p JOIN software_products sw ON sw.product_id = p.id WHERE p.statut='actif'${since("p.created_at")}`),
      licences_actives: await count(`SELECT COUNT(*) n FROM licenses WHERE status='active'${since("created_at")}`),
      licences_expirees: await count(`SELECT COUNT(*) n FROM licenses WHERE status='expiree'${since("created_at")}`),
      licences_suspendues: await count(`SELECT COUNT(*) n FROM licenses WHERE status='suspendue'${since("created_at")}`),
      logiciels_vendus: await count(`
        SELECT COUNT(*) n FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.plan_id IS NOT NULL AND o.statut IN ('payee','livree')${since("o.created_at")}
      `),
      chiffre_affaires_logiciels: await count(`
        SELECT COALESCE(SUM(oi.prix_unitaire * oi.quantite),0) n FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.plan_id IS NOT NULL AND o.statut IN ('payee','livree')${since("o.created_at")}
      `),
      telechargements_logiciels: await count(`SELECT COUNT(*) n FROM software_downloads WHERE 1=1${since("downloaded_at")}`),
      temoignages_en_attente: await count(`SELECT COUNT(*) n FROM testimonials WHERE statut='en_attente'${since("created_at")}`)
    },
    logiciel_plus_vendu: (await db.prepare(`
      SELECT p.titre, COUNT(*) n
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE oi.plan_id IS NOT NULL AND o.statut IN ('payee','livree')
      GROUP BY p.id, p.titre
      ORDER BY n DESC
      LIMIT 1
    `).get()) || null,
    revenus_par_logiciel: await db.prepare(`
      SELECT p.titre, COALESCE(SUM(oi.prix_unitaire * oi.quantite),0) n
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      WHERE oi.plan_id IS NOT NULL AND o.statut IN ('payee','livree')
      GROUP BY p.id, p.titre
      ORDER BY n DESC
    `).all(),
    reset_at: resetAt
  });
});

// Remise à zéro des compteurs affichés : n'efface AUCUNE donnée réelle
// (photos, commandes, messages... restent consultables dans leurs sections),
// change seulement le point de départ du comptage du tableau de bord.
router.post("/reset", async (req, res) => {
  // IMPORTANT : on utilise l'horloge du serveur PostgreSQL (now()), pas
  // new Date().toISOString(). Les colonnes created_at sont écrites au
  // format "YYYY-MM-DD HH:MM:SS" (sans "T" ni millisecondes) ; comparer ce
  // format à un ISO JS ("...T...Z") donne une comparaison de chaînes
  // incorrecte (le "T" arrive après l'espace dans l'ordre ASCII) et ferait
  // échouer silencieusement TOUS les filtres "depuis la réinitialisation"
  // — d'où ce choix, pour rester strictement comparable aux valeurs déjà en base.
  const now = (await db.query(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS now`)).rows[0].now;
  await db.prepare("INSERT INTO settings (cle, valeur) VALUES ('dashboard_reset_at', ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur").run(now);
  res.json({ ok: true, reset_at: now });
});

module.exports = router;
