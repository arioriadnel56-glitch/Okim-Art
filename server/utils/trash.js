// ============================================================
// trash.js — corbeille générique (30 jours avant suppression définitive)
// ============================================================
const { db } = require("../db");

const RETENTION_DAYS = 30;

// Table SQL réelle correspondant à chaque type d'élément trashable.
const ENTITY_TABLES = {
  photos: "photos",
  categories: "categories",
  services: "services",
  formations: "formations",
  products: "products",
  messages: "messages",
  inscriptions: "inscriptions_formation"
};

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Déplace une ligne déjà chargée (SELECT * ...) vers la corbeille, puis la retire de sa table d'origine. */
async function moveToTrash(entityType, row, label) {
  const table = ENTITY_TABLES[entityType];
  if (!table) throw new Error("Type d'élément inconnu pour la corbeille : " + entityType);
  const now = new Date();
  const purgeAt = addDays(now, RETENTION_DAYS);
  await db.prepare(`INSERT INTO trash (entity_type, entity_id, label, data, deleted_at, purge_at) VALUES (?,?,?,?,?,?)`)
    .run(entityType, row.id, label || "", JSON.stringify(row), now.toISOString(), purgeAt.toISOString());
  await db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
}

async function listTrash() {
  const rows = await db.prepare("SELECT * FROM trash ORDER BY deleted_at DESC").all();
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

async function getTrashItem(id) {
  const r = await db.prepare("SELECT * FROM trash WHERE id = ?").get(id);
  if (!r) return null;
  return { ...r, data: JSON.parse(r.data) };
}

/** Supprime les fichiers physiques associés à un élément (uniquement à la purge définitive, jamais à la mise en corbeille). */
function deleteEntityFiles(entityType, data) {
  const { deletePublicFile, deletePrivateFile } = require("./upload");
  if (entityType === "photos") {
    if (data.type === "video") {
      // Vidéo de portfolio : pas de fichier privé séparé, "fichier" et
      // "miniature" pointent tous deux vers le même fichier public.
      if (data.miniature) deletePublicFile(data.miniature);
    } else {
      if (data.fichier) deletePrivateFile(data.fichier);
      if (data.miniature) deletePublicFile(data.miniature);
    }
  } else if (entityType === "products") {
    if (data.fichier_original) deletePrivateFile(data.fichier_original);
    if (data.apercu) deletePublicFile(data.apercu);
  } else if ((entityType === "services" || entityType === "formations") && data.image) {
    deletePublicFile(data.image);
  }
}

/** Remet l'élément dans sa table d'origine tel qu'il était au moment de la suppression. */
async function restoreFromTrash(id) {
  const item = await getTrashItem(id);
  if (!item) return null;
  const table = ENTITY_TABLES[item.entity_type];
  if (!table) throw new Error("Type d'élément inconnu pour la corbeille : " + item.entity_type);

  const cols = Object.keys(item.data);
  const placeholders = cols.map(() => "?").join(",");
  try {
    await db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`)
      .run(...cols.map((c) => item.data[c]));
    // La ligne restaurée réutilise son ancien "id" explicite : on resynchronise
    // la séquence PostgreSQL de la colonne id pour que les PROCHAINES
    // insertions "normales" (auto-incrémentées) ne rentrent jamais en
    // collision avec un id restauré.
    if (cols.includes("id")) {
      await db.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
      );
    }
  } catch (e) {
    throw new Error("Restauration impossible : un élément lié (catégorie, photo...) a peut-être été supprimé depuis. " + e.message);
  }
  await db.prepare("DELETE FROM trash WHERE id = ?").run(id);
  return item;
}

/** Suppression définitive et immédiate d'un élément de la corbeille (fichiers compris). */
async function permanentlyDelete(id) {
  const item = await getTrashItem(id);
  if (!item) return null;
  deleteEntityFiles(item.entity_type, item.data);
  await db.prepare("DELETE FROM trash WHERE id = ?").run(id);
  return item;
}

/** Purge automatique : tout élément dont le délai de 30 jours est dépassé. À appeler périodiquement. */
async function purgeExpiredTrash() {
  const now = new Date().toISOString();
  const expired = await db.prepare("SELECT id FROM trash WHERE purge_at <= ?").all(now);
  for (const r of expired) await permanentlyDelete(r.id);
  return expired.length;
}

/** Vide toute la corbeille immédiatement, sans attendre les 30 jours (action manuelle explicite). */
async function emptyAllTrash() {
  const all = await db.prepare("SELECT id FROM trash").all();
  for (const r of all) await permanentlyDelete(r.id);
  return all.length;
}

module.exports = { moveToTrash, listTrash, getTrashItem, restoreFromTrash, permanentlyDelete, purgeExpiredTrash, emptyAllTrash, RETENTION_DAYS };
