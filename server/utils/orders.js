// ============================================================
// orders.js (utils) — logique partagée de confirmation de commande
// ============================================================
const { db } = require("../db");
const { createDownloadToken } = require("./tokens");
const { sendMail, fireEvent } = require("./notify");
const { issueLicensesForOrder } = require("./licenses");
const { notifyAdminInApp, notifyClientInApp } = require("./notifications");

const PAID_STATUTS = new Set(["payee", "livree"]);

async function getSiteUrl() {
  const row = await db.prepare("SELECT valeur FROM settings WHERE cle = 'site_url'").get();
  return (row && row.valeur) ? row.valeur.replace(/\/$/, "") : "";
}

async function downloadEmailHtml(order, tokens, licenses = []) {
  const siteUrl = await getSiteUrl();
  const links = tokens.map((t) => {
    const url = siteUrl ? `${siteUrl}/api/download/${t.token}` : `/api/download/${t.token}`;
    return `<li style="margin-bottom:8px"><strong>${t.titre}</strong> — <a href="${url}">Télécharger</a></li>`;
  }).join("");
  const licenseLines = licenses.map((l) =>
    `<li style="margin-bottom:8px">Clé de licence : <strong>${l.license_key}</strong>${l.expires_at ? ` (valable jusqu'au ${l.expires_at.slice(0, 10)})` : " (licence permanente)"}</li>`
  ).join("");
  const accountUrl = siteUrl ? `${siteUrl}/compte.html` : "/compte.html";
  return `
    <div style="font-family:sans-serif; color:#1c1a17; max-width:520px">
      <h2 style="margin-bottom:4px">Merci pour votre achat !</h2>
      <p>Votre commande <strong>${order.numero}</strong> (${order.montant} FCFA) est confirmée et payée.</p>
      ${links ? `<p>Vos photographies en haute résolution sont prêtes :</p><ul>${links}</ul>` : ""}
      ${licenseLines ? `<p>Vos licences logicielles :</p><ul>${licenseLines}</ul><p>Téléchargez vos logiciels et retrouvez vos clés à tout moment depuis votre <a href="${accountUrl}">espace client</a> (section « Mes logiciels »).</p>` : ""}
      <p style="color:#6b6558; font-size:.85rem">Chaque lien reste valable un temps limité et un nombre limité de téléchargements. En cas de souci, contactez OKIM ART en répondant à cet e-mail.</p>
    </div>`;
}

/**
 * Marque une commande comme payée (si elle ne l'est pas déjà) et génère
 * automatiquement les jetons de téléchargement sécurisés pour chaque
 * article de la commande. Idempotent : si la commande est déjà payée,
 * ne génère pas de nouveaux jetons et renvoie ceux déjà émis.
 * Déclenche aussi, sans jamais bloquer ni faire échouer l'appelant :
 *  - un e-mail automatique au client avec ses liens de téléchargement ;
 *  - une notification à l'admin (e-mail + webhook générique).
 */
async function markOrderPaid(orderId, moyenPaiement) {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) return null;

  const alreadyPaid = PAID_STATUTS.has(order.statut);
  if (!alreadyPaid) {
    await db.prepare("UPDATE orders SET statut = 'payee', moyen_paiement = ? WHERE id = ?")
      .run(moyenPaiement || order.moyen_paiement || "", order.id);
  }

  let tokens;
  let licenses = [];
  if (!alreadyPaid) {
    const items = await db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(order.id);
    tokens = [];
    for (const it of items) {
      // Un article "logiciel" (product.type = 'logiciel') ne reçoit jamais
      // de jeton de téléchargement générique : son accès passe par une
      // licence + le téléchargement authentifié de l'espace client (voir
      // utils/licenses.js et routes/client.js). Les autres articles
      // (photos) gardent le comportement inchangé.
      const product = await db.prepare("SELECT type FROM products WHERE id = ?").get(it.product_id);
      if (product && product.type === "logiciel") continue;
      tokens.push({
        product_id: it.product_id,
        titre: it.titre,
        token: await createDownloadToken(order.id, it.product_id)
      });
    }
    // Génère les licences pour tous les articles "logiciel" de cette commande.
    licenses = await issueLicensesForOrder(order);
  } else {
    tokens = await db.prepare(`
      SELECT dt.token, oi.product_id, oi.titre
      FROM download_tokens dt JOIN order_items oi ON oi.product_id = dt.product_id AND oi.order_id = dt.order_id
      WHERE dt.order_id = ?
    `).all(order.id);
    licenses = await db.prepare("SELECT * FROM licenses WHERE order_id = ?").all(order.id);
  }

  const finalOrder = await db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);

  // Notifications automatiques — uniquement au moment où la commande passe
  // réellement à "payée" (pas à chaque relecture d'une commande déjà payée).
  if (!alreadyPaid) {
    downloadEmailHtml(finalOrder, tokens, licenses).then((html) => {
      sendMail({ to: finalOrder.client_email, subject: `OKIM ART — Votre commande ${finalOrder.numero} est prête`, html }).catch(() => {});
    }).catch(() => {});
    fireEvent("order.paid", {
      subject: `OKIM ART — Nouvelle commande payée (${finalOrder.numero})`,
      html: `<p>Commande <strong>${finalOrder.numero}</strong> de ${finalOrder.client_nom} (${finalOrder.client_email}) — ${finalOrder.montant} FCFA — payée via ${finalOrder.moyen_paiement || "?"}.</p>`,
      payload: { order_id: finalOrder.id, numero: finalOrder.numero, montant: finalOrder.montant, client_nom: finalOrder.client_nom, client_email: finalOrder.client_email, moyen_paiement: finalOrder.moyen_paiement }
    });
    notifyAdminInApp("order_paid", `Commande payée — ${finalOrder.numero}`,
      `${finalOrder.client_nom} — ${finalOrder.montant} FCFA`, "#orders");
    if (finalOrder.client_id) {
      notifyClientInApp(finalOrder.client_id, "order_ready", `Votre commande ${finalOrder.numero} est prête`,
        licenses.length ? "Vos licences et téléchargements sont disponibles." : "Vos téléchargements sont disponibles.",
        "compte.html");
    }
    for (const l of licenses) {
      if (l.client_id) {
        notifyClientInApp(l.client_id, "license_created", "Votre licence logicielle est prête",
          `Clé : ${l.license_key}`, "compte.html");
      }
    }
  }

  return { order: finalOrder, tokens, licenses };
}

module.exports = { markOrderPaid };
