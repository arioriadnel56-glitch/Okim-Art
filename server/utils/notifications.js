// ============================================================
// notifications.js — notifications IN-APP (admin ET client)
// ============================================================
// Complète (ne remplace pas) le système d'e-mail/webhook existant
// (server/utils/notify.js) : celui-ci envoie des messages EXTERNES,
// celui-ci alimente une cloche de notifications DANS la plateforme
// (tableau de bord admin, espace client), avec état lu/non lu.
// Best-effort comme le reste : une notification qui échoue à s'écrire
// ne doit jamais faire échouer l'action métier qui l'a déclenchée.
const { db } = require("../db");

async function notifyAdminInApp(type, titre, corps = "", lien = "") {
  try {
    await db.prepare("INSERT INTO notifications (audience, client_id, type, titre, corps, lien) VALUES ('admin', NULL, ?,?,?,?)")
      .run(type, titre, corps, lien);
  } catch (e) { console.error("[notifications] échec notifyAdminInApp :", e.message); }
}

async function notifyClientInApp(clientId, type, titre, corps = "", lien = "") {
  if (!clientId) return;
  try {
    await db.prepare("INSERT INTO notifications (audience, client_id, type, titre, corps, lien) VALUES ('client', ?,?,?,?,?)")
      .run(clientId, type, titre, corps, lien);
  } catch (e) { console.error("[notifications] échec notifyClientInApp :", e.message); }
}

module.exports = { notifyAdminInApp, notifyClientInApp };
