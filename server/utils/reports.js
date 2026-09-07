// ============================================================
// reports.js — rapport PDF du flux journalier (commandes du jour)
// ============================================================
const PDFDocument = require("pdfkit");
const { db } = require("../db");

const STATUT_LABEL = { en_attente: "En attente", payee: "Payée", echouee: "Échouée", annulee: "Annulée", livree: "Livrée" };

function fmtMontant(n) {
  // On évite Intl.NumberFormat("fr-FR") ici : son séparateur de milliers est
  // une espace insécable étroite (U+202F) que la police standard du PDF
  // n'a pas dans sa table de caractères — elle s'affichait comme un
  // caractère erroné ("/"). On regroupe donc les milliers manuellement
  // avec une espace normale, sans dépendance à l'encodage de la police.
  const s = String(Math.round(n || 0));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " FCFA";
}

/**
 * Génère le rapport PDF du flux d'une journée (toutes les commandes créées
 * ce jour-là, sous forme de tableau) et l'écrit dans le flux de réponse HTTP.
 * @param {string} dateStr date au format YYYY-MM-DD (jour local du serveur)
 * @param {import('http').ServerResponse} res
 */
async function streamDailyOrdersPdf(dateStr, res) {
  const orders = await db.prepare(`
    SELECT * FROM orders
    WHERE left(created_at, 10) = ?
    ORDER BY created_at ASC
  `).all(dateStr);

  const totalPaye = orders.filter(o => o.statut === "payee" || o.statut === "livree").reduce((s, o) => s + o.montant, 0);
  const totalCommandes = orders.reduce((s, o) => s + o.montant, 0);

  const doc = new PDFDocument({ size: "A4", margin: 40, layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="okim-art-flux-${dateStr}.pdf"`);
  doc.pipe(res);

  // ---- En-tête ----
  doc.fontSize(18).font("Helvetica-Bold").text("OKIM ART — Flux journalier", { align: "left" });
  doc.fontSize(11).font("Helvetica").fillColor("#555").text(`Journée du ${dateStr}`, { align: "left" });
  doc.moveDown(1);

  // ---- Résumé ----
  doc.fontSize(10).fillColor("#000");
  doc.text(`Commandes du jour : ${orders.length}`, { continued: true }).text(`      Montant total : ${fmtMontant(totalCommandes)}`, { continued: true }).text(`      Encaissé (payé/livré) : ${fmtMontant(totalPaye)}`);
  doc.moveDown(1);

  if (!orders.length) {
    doc.fontSize(12).fillColor("#555").text("Aucune commande enregistrée ce jour-là.");
    doc.end();
    return;
  }

  // ---- Tableau ----
  const startX = doc.page.margins.left;
  let y = doc.y;
  const colWidths = { heure: 55, numero: 130, client: 150, email: 160, montant: 80, paiement: 90, statut: 80 };
  const cols = [
    ["heure", "Heure"], ["numero", "N° commande"], ["client", "Client"], ["email", "E-mail"],
    ["montant", "Montant"], ["paiement", "Paiement"], ["statut", "Statut"]
  ];
  const rowHeight = 22;

  function drawHeaderRow(yPos) {
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#fff");
    doc.rect(startX, yPos, cols.reduce((s, [k]) => s + colWidths[k], 0), rowHeight).fill("#232f52");
    let x = startX;
    cols.forEach(([key, label]) => {
      doc.fillColor("#fff").text(label, x + 6, yPos + 6, { width: colWidths[key] - 8 });
      x += colWidths[key];
    });
    return yPos + rowHeight;
  }

  y = drawHeaderRow(y);
  doc.font("Helvetica").fontSize(9).fillColor("#000");

  orders.forEach((o, i) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage({ size: "A4", margin: 40, layout: "landscape" });
      y = doc.page.margins.top;
      y = drawHeaderRow(y);
      doc.font("Helvetica").fontSize(9).fillColor("#000");
    }
    if (i % 2 === 0) {
      doc.rect(startX, y, cols.reduce((s, [k]) => s + colWidths[k], 0), rowHeight).fill("#f5f1e6");
      doc.fillColor("#000");
    }
    const heure = (o.created_at || "").split(" ")[1] || "";
    const row = {
      heure, numero: o.numero, client: o.client_nom || "", email: o.client_email || "",
      montant: fmtMontant(o.montant), paiement: o.moyen_paiement || "—", statut: STATUT_LABEL[o.statut] || o.statut
    };
    let x = startX;
    cols.forEach(([key]) => {
      doc.text(String(row[key]), x + 6, y + 6, { width: colWidths[key] - 8, ellipsis: true });
      x += colWidths[key];
    });
    y += rowHeight;
  });

  doc.moveDown(2);
  doc.fontSize(8).fillColor("#888").text(`Généré automatiquement le ${new Date().toLocaleString("fr-FR")} — OKIM ART`, startX, doc.page.height - doc.page.margins.bottom - 10);

  doc.end();
}

/**
 * Génère le rapport PDF de la liste des inscrits à une formation (tableau).
 * @param {object} formation ligne formations (au moins id, titre)
 * @param {object[]} inscriptions lignes inscriptions_formation
 * @param {import('http').ServerResponse} res
 */
function streamFormationInscriptionsPdf(formation, inscriptions, res) {
  const INSCRIT_STATUT_LABEL = { en_attente: "En attente", confirme: "Confirmé", annule: "Annulé" };
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const safeName = (formation.titre || "formation").replace(/[^a-zA-Z0-9-_ ]/g, "").trim().replace(/\s+/g, "-") || "formation";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="okim-art-inscrits-${safeName}.pdf"`);
  doc.pipe(res);

  doc.fontSize(18).font("Helvetica-Bold").text("OKIM ART — Liste des inscrits");
  doc.fontSize(12).font("Helvetica").fillColor("#555").text(formation.titre || "");
  doc.fontSize(10).fillColor("#000").text(`${inscriptions.length} inscription(s)`);
  doc.moveDown(1);

  if (!inscriptions.length) {
    doc.fontSize(12).fillColor("#555").text("Aucune inscription pour cette formation.");
    doc.end();
    return;
  }

  const startX = doc.page.margins.left;
  let y = doc.y;
  const colWidths = { date: 75, nom: 130, email: 170, telephone: 100, statut: 90 };
  const cols = [["date", "Date"], ["nom", "Nom"], ["email", "E-mail"], ["telephone", "Téléphone"], ["statut", "Statut"]];
  const rowHeight = 22;

  function drawHeaderRow(yPos) {
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#fff");
    doc.rect(startX, yPos, cols.reduce((s, [k]) => s + colWidths[k], 0), rowHeight).fill("#232f52");
    let x = startX;
    cols.forEach(([key, label]) => {
      doc.fillColor("#fff").text(label, x + 6, yPos + 6, { width: colWidths[key] - 8 });
      x += colWidths[key];
    });
    return yPos + rowHeight;
  }

  y = drawHeaderRow(y);
  doc.font("Helvetica").fontSize(9).fillColor("#000");

  inscriptions.forEach((insc, i) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage({ size: "A4", margin: 40 });
      y = doc.page.margins.top;
      y = drawHeaderRow(y);
      doc.font("Helvetica").fontSize(9).fillColor("#000");
    }
    if (i % 2 === 0) {
      doc.rect(startX, y, cols.reduce((s, [k]) => s + colWidths[k], 0), rowHeight).fill("#f5f1e6");
      doc.fillColor("#000");
    }
    const row = {
      date: (insc.created_at || "").split(" ")[0] || "",
      nom: insc.nom || "", email: insc.email || "", telephone: insc.telephone || "—",
      statut: INSCRIT_STATUT_LABEL[insc.statut] || insc.statut
    };
    let x = startX;
    cols.forEach(([key]) => {
      doc.text(String(row[key]), x + 6, y + 6, { width: colWidths[key] - 8, ellipsis: true });
      x += colWidths[key];
    });
    y += rowHeight;
  });

  doc.moveDown(2);
  doc.fontSize(8).fillColor("#888").text(`Généré automatiquement le ${new Date().toLocaleString("fr-FR")} — OKIM ART`, startX, doc.page.height - doc.page.margins.bottom - 10);

  doc.end();
}

module.exports = { streamDailyOrdersPdf, streamFormationInscriptionsPdf };
