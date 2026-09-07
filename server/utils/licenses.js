// ============================================================
// licenses.js (utils) — génération et cycle de vie des licences logiciel
// ============================================================
const crypto = require("crypto");
const { db } = require("../db");

/** Clé de licence lisible et difficile à deviner : OKIM-XXXX-XXXX-XXXX-XXXX */
function generateLicenseKey() {
  const block = () => crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 hex chars
  return `OKIM-${block()}-${block()}-${block()}-${block()}`;
}

function computeExpiry(periodicite, from = new Date()) {
  if (periodicite === "mensuel") {
    const d = new Date(from); d.setMonth(d.getMonth() + 1); return d.toISOString();
  }
  if (periodicite === "annuel") {
    const d = new Date(from); d.setFullYear(d.getFullYear() + 1); return d.toISOString();
  }
  return null; // "unique" = licence permanente
}

/**
 * Génère une licence pour un article de commande payé correspondant à un
 * logiciel (product.type = 'logiciel'). Idempotent au niveau appelant :
 * markOrderPaid() n'appelle ceci que la première fois qu'une commande passe
 * à "payée" (jamais en relecture d'une commande déjà payée), donc jamais de
 * doublon de licence pour un même article.
 */
async function issueLicenseForOrderItem({ orderItem, order }) {
  const software = await db.prepare("SELECT * FROM software_products WHERE product_id = ?").get(orderItem.product_id);
  if (!software) return null; // ce n'est pas un article "logiciel" — rien à faire

  let plan = null;
  if (orderItem.plan_id) {
    plan = await db.prepare("SELECT * FROM software_plans WHERE id = ?").get(orderItem.plan_id);
  }

  const licenseKey = generateLicenseKey();
  const expiresAt = plan ? computeExpiry(plan.periodicite) : null;
  const maxDevices = plan ? plan.max_devices : 1;
  const maxUsers = plan ? plan.max_users : 1;

  const info = await db.prepare(`
    INSERT INTO licenses (license_key, software_id, plan_id, client_id, order_id, order_item_id, status, max_devices, max_users, expires_at)
    VALUES (?,?,?,?,?,?, 'active', ?, ?, ?)
  `).run(licenseKey, software.id, plan ? plan.id : null, order.client_id, order.id, orderItem.id, maxDevices, maxUsers, expiresAt);

  await db.prepare("UPDATE software_products SET popularite = popularite + 1 WHERE id = ?").run(software.id);

  return db.prepare("SELECT * FROM licenses WHERE id = ?").get(info.lastInsertRowid);
}

/** Génère les licences pour tous les articles "logiciel" d'une commande qui vient de passer à "payée". */
async function issueLicensesForOrder(order) {
  const items = await db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
  const licenses = [];
  for (const item of items) {
    const license = await issueLicenseForOrderItem({ orderItem: item, order });
    if (license) licenses.push(license);
  }
  return licenses;
}

/** Une licence est valide (accès autorisé) si active ET (pas d'expiration OU pas encore expirée). */
function isLicenseValid(license) {
  if (license.status !== "active") return false;
  if (!license.expires_at) return true;
  return new Date(license.expires_at) > new Date();
}

/** Bascule automatiquement en "expiree" les licences dont la date est dépassée. À appeler périodiquement, comme purgeExpiredTrash. */
async function sweepExpiredLicenses() {
  const now = new Date().toISOString();
  const info = await db.prepare("UPDATE licenses SET status = 'expiree' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").run(now);
  return info.changes;
}

/**
 * Notifie (in-app + e-mail) le client dont la licence expire dans les 7
 * prochains jours — une seule fois par licence (marquée via
 * expiry_notified pour ne jamais spammer à chaque exécution horaire).
 * À appeler périodiquement, comme sweepExpiredLicenses.
 */
async function sweepExpiringLicenses(daysBefore = 7) {
  const { notifyClientInApp } = require("./notifications");
  const { sendMail } = require("./notify");
  const now = new Date();
  const limit = new Date(now.getTime() + daysBefore * 24 * 3600 * 1000).toISOString();
  const soon = await db.prepare(`
    SELECT l.*, sw.product_id, p.titre AS logiciel_titre, c.email AS client_email, c.nom AS client_nom
    FROM licenses l
    JOIN software_products sw ON sw.id = l.software_id
    JOIN products p ON p.id = sw.product_id
    LEFT JOIN clients c ON c.id = l.client_id
    WHERE l.status = 'active' AND l.expires_at IS NOT NULL
      AND l.expires_at <= ? AND l.expires_at > ? AND l.expiry_notified = 0
  `).all(limit, now.toISOString());

  for (const l of soon) {
    const jours = Math.max(1, Math.round((new Date(l.expires_at) - now) / (24 * 3600 * 1000)));
    if (l.client_id) {
      notifyClientInApp(l.client_id, "license_expiring", `Votre licence « ${l.logiciel_titre} » expire bientôt`,
        `Expire dans ${jours} jour(s) — pensez à la renouveler pour garder l'accès.`, "compte.html");
    }
    if (l.client_email) {
      sendMail({
        to: l.client_email,
        subject: `OKIM ART — Votre licence « ${l.logiciel_titre} » expire bientôt`,
        html: `<div style="font-family:sans-serif; color:#1c1a17"><p>Bonjour ${l.client_nom || ""},</p><p>Votre licence pour <strong>${l.logiciel_titre}</strong> expire dans <strong>${jours} jour(s)</strong> (le ${l.expires_at.slice(0,10)}).</p><p>Renouvelez-la depuis votre espace client pour conserver l'accès aux téléchargements et mises à jour.</p></div>`
      }).catch(() => {});
    }
    await db.prepare("UPDATE licenses SET expiry_notified = 1 WHERE id = ?").run(l.id);
  }
  return soon.length;
}

module.exports = { generateLicenseKey, computeExpiry, issueLicensesForOrder, isLicenseValid, sweepExpiredLicenses, sweepExpiringLicenses };
