#!/usr/bin/env node
// ============================================================
// migrate-sqlite-to-postgres.js — transfert des données réelles
// SQLite (data/okimart.db) → PostgreSQL, sans perte ni altération.
// ============================================================
// GARANTIES :
//  - Le fichier SQLite est ouvert en LECTURE SEULE (readOnly: true) :
//    ce script ne peut mécaniquement pas le modifier, quel que soit
//    le résultat de la migration.
//  - Idempotent par table : si une table PostgreSQL contient déjà des
//    lignes, elle est ignorée par défaut (jamais vidée ni dupliquée).
//    Utilisez --force pour la réimporter quand même (voir plus bas).
//  - Les identifiants (id) sont préservés tels quels — indispensable
//    pour conserver les relations (order_items.order_id, etc.) et les
//    liens déjà envoyés par e-mail/SMS aux clients (jetons, PIN...).
//  - Toute la migration s'exécute dans UNE SEULE transaction PostgreSQL :
//    en cas d'erreur, ROLLBACK complet — jamais d'état à moitié migré.
//  - Un rapport de vérification (comptage ligne à ligne, SQLite vs
//    PostgreSQL) est imprimé à la fin. La migration n'est PAS considérée
//    réussie si un seul total ne correspond pas.
//
// Usage :
//   DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-postgres.js [chemin-sqlite] [--force]
//
// Recommandé : lancez d'abord scripts/backup-sqlite.js et passez-lui la
// COPIE de sauvegarde en argument (plutôt que le fichier original), pour
// qu'une double-protection (lecture seule + copie de travail) soit en place.
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
require("dotenv").config();
const { Pool, types } = require("pg");

types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const sqlitePath = args.find((a) => !a.startsWith("--")) || path.join(ROOT, "data", "okimart.db");

if (!fs.existsSync(sqlitePath)) {
  console.error(`✗ Fichier SQLite introuvable : ${sqlitePath}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("✗ DATABASE_URL manquant (voir .env / variables d'environnement Render).");
  process.exit(1);
}

// Lecture seule : toute tentative d'écriture sur cette connexion lèvera une
// erreur — protection mécanique du fichier original, pas seulement une
// convention de code.
const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
});

// Ordre de migration : les tables référencées (par clé étrangère) sont
// toujours migrées avant celles qui les référencent.
const TABLES = [
  { name: "admins", cols: ["id", "nom", "email", "password_hash", "role", "created_at"] },
  { name: "categories", cols: ["id", "nom", "slug", "description", "created_at"] },
  { name: "photos", cols: ["id", "titre", "description", "fichier", "miniature", "category_id", "statut", "a_la_une", "prix", "watermark", "ordre", "created_at"] },
  { name: "services", cols: ["id", "titre", "description", "image", "prix", "statut", "ordre", "created_at"] },
  { name: "formations", cols: ["id", "titre", "description", "programme", "image", "prix", "duree", "date_session", "lieu", "places", "statut", "ordre", "created_at"] },
  { name: "inscriptions_formation", cols: ["id", "formation_id", "nom", "email", "telephone", "statut", "created_at"] },
  { name: "products", cols: ["id", "photo_id", "titre", "description", "prix", "licence", "fichier_original", "apercu", "statut", "created_at"] },
  { name: "clients", cols: ["id", "nom", "email", "telephone", "password_hash", "created_at"] },
  { name: "orders", cols: ["id", "numero", "client_id", "client_nom", "client_email", "client_telephone", "montant", "statut", "moyen_paiement", "note_admin", "created_at"] },
  { name: "order_items", cols: ["id", "order_id", "product_id", "titre", "prix_unitaire", "quantite"] },
  { name: "download_tokens", cols: ["id", "token", "order_id", "product_id", "max_downloads", "downloads_used", "expires_at", "created_at"] },
  { name: "messages", cols: ["id", "nom", "email", "telephone", "sujet", "message", "statut", "created_at"] },
  { name: "settings", cols: ["cle", "valeur"], noId: true },
  { name: "secure_settings", cols: ["cle", "valeur"], noId: true },
  { name: "kkiapay_events", cols: ["id", "transaction_id", "success", "amount", "method", "account", "raw_json", "created_at"] },
  { name: "trash", cols: ["id", "entity_type", "entity_id", "label", "data", "deleted_at", "purge_at"] },
  { name: "sessions_photo", cols: ["id", "client_name", "client_phone", "access_token", "pin_code_hash", "status", "hd_unlocked_until", "recovery_price", "created_at", "expires_at"] },
  { name: "session_photos", cols: ["id", "session_id", "titre", "file_path", "watermark_path", "created_at"] },
  { name: "recovery_transactions", cols: ["id", "session_id", "transaction_reference", "amount", "status", "created_at"] }
];

function tableExistsInSqlite(name) {
  const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  return !!row;
}

async function migrateTable(client, table) {
  if (!tableExistsInSqlite(table.name)) {
    console.log(`  ⏭  ${table.name} : absente de la base SQLite source, ignorée.`);
    return { skipped: true };
  }

  const { rows: existingRows } = await client.query(`SELECT COUNT(*) n FROM ${table.name}`);
  const alreadyHasData = Number(existingRows[0].n) > 0;
  if (alreadyHasData && !FORCE) {
    console.log(`  ⏭  ${table.name} : déjà des données dans PostgreSQL, ignorée (--force pour réimporter).`);
    return { skipped: true };
  }

  const srcRows = sqlite.prepare(`SELECT * FROM ${table.name}`).all();
  if (srcRows.length === 0) {
    console.log(`  —  ${table.name} : vide côté SQLite, rien à transférer.`);
    return { migrated: 0 };
  }

  const colList = table.cols.filter((c) => Object.prototype.hasOwnProperty.call(srcRows[0], c));
  const placeholders = colList.map((_, i) => `$${i + 1}`).join(",");
  const insertSql = table.noId
    ? `INSERT INTO ${table.name} (${colList.join(",")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
    : `INSERT INTO ${table.name} (${colList.join(",")}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;

  for (const row of srcRows) {
    const values = colList.map((c) => (row[c] === undefined ? null : row[c]));
    await client.query(insertSql, values);
  }

  if (!table.noId) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${table.name}', 'id'), COALESCE((SELECT MAX(id) FROM ${table.name}), 1))`
    );
  }

  console.log(`  ✓  ${table.name} : ${srcRows.length} ligne(s) transférée(s).`);
  return { migrated: srcRows.length };
}

async function verifyCounts() {
  console.log("\n================================================================");
  console.log(" VÉRIFICATION — SQLite vs PostgreSQL (nombre de lignes par table)");
  console.log("================================================================");
  let allOk = true;
  for (const table of TABLES) {
    if (!tableExistsInSqlite(table.name)) continue;
    const sqliteCount = sqlite.prepare(`SELECT COUNT(*) n FROM ${table.name}`).get().n;
    const { rows } = await pool.query(`SELECT COUNT(*) n FROM ${table.name}`);
    const pgCount = Number(rows[0].n);
    const ok = sqliteCount === pgCount;
    if (!ok) allOk = false;
    console.log(
      `  ${table.name.padEnd(24)} SQLite: ${String(sqliteCount).padStart(6)}   PostgreSQL: ${String(pgCount).padStart(6)}   ${ok ? "OK" : "✗ ÉCART"}`
    );
  }
  console.log("================================================================");
  console.log(allOk ? " STATUT GLOBAL : OK — tous les comptages correspondent.\n" : " STATUT GLOBAL : ÉCHEC — au moins un comptage ne correspond pas.\n");
  return allOk;
}

async function run() {
  console.log("================================================================");
  console.log(" MIGRATION SQLite → PostgreSQL");
  console.log("================================================================");
  console.log(` Source (lecture seule) : ${sqlitePath}`);
  console.log(` Destination            : ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ":****@")}`);
  console.log(` Mode                   : ${FORCE ? "FORCÉ (réimporte même si des données existent déjà)" : "normal (ignore les tables déjà peuplées)"}`);
  console.log("================================================================\n");

  // Le schéma PostgreSQL doit déjà exister (créé par server/db.js au premier
  // démarrage de l'application, ou en lançant `node -e "require('./server/db').initDb()"`).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const table of TABLES) {
      await migrateTable(client, table);
    }
    await client.query("COMMIT");
    console.log("\n✓ Transaction PostgreSQL validée (COMMIT).");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\n✗ ERREUR CRITIQUE — migration annulée (ROLLBACK). Aucune donnée partielle n'a été conservée côté PostgreSQL.");
    console.error(e);
    process.exitCode = 1;
    return;
  } finally {
    client.release();
  }

  const ok = await verifyCounts();
  process.exitCode = ok ? 0 : 1;
}

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    sqlite.close();
    await pool.end();
  });
