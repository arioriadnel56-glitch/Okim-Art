#!/usr/bin/env node
// ============================================================
// backup-sqlite.js — sauvegarde intacte de data/okimart.db avant migration
// ============================================================
// RÈGLE ABSOLUE : ce script ne modifie JAMAIS le fichier original. Il en
// lit les octets, calcule une empreinte SHA-256, et écrit une COPIE
// horodatée dans data/backups/. Le fichier original reste intouché.
//
// Usage :
//   node scripts/backup-sqlite.js [chemin-vers-okimart.db]
// Par défaut : data/okimart.db (à la racine du projet).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const srcPath = process.argv[2] || path.join(ROOT, "data", "okimart.db");
const backupDir = path.join(ROOT, "data", "backups");

if (!fs.existsSync(srcPath)) {
  console.error(`✗ Fichier introuvable : ${srcPath}`);
  console.error("  Rien à sauvegarder — vérifiez le chemin (aucune action effectuée).");
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destPath = path.join(backupDir, `okimart-${stamp}.db`);

// Copie en lecture seule du fichier source : fs.copyFileSync ne modifie
// jamais le fichier source, uniquement la destination.
fs.copyFileSync(srcPath, destPath);

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

const srcHash = sha256(srcPath);
const destHash = sha256(destPath);

console.log("================================================================");
console.log(" SAUVEGARDE DE data/okimart.db — AVANT MIGRATION POSTGRESQL");
console.log("================================================================");
console.log(` Original     : ${srcPath}`);
console.log(` Copie créée  : ${destPath}`);
console.log(` SHA-256 (original) : ${srcHash}`);
console.log(` SHA-256 (copie)    : ${destHash}`);
console.log(destHash === srcHash
  ? " ✓ Empreintes identiques — copie fidèle confirmée."
  : " ✗ ALERTE : empreintes différentes — la copie est corrompue, relancez.");
console.log("================================================================");
console.log(" Le fichier original n'a PAS été modifié ni supprimé.");
console.log(" Conservez cette empreinte pour vérifier plus tard qu'il n'a pas changé :");
console.log(`   sha256sum "${srcPath}"`);
console.log("================================================================\n");

if (destHash !== srcHash) process.exit(1);

// Écrit aussi l'empreinte dans un fichier .sha256 à côté de la copie, pour
// vérification ultérieure sans avoir à relire ce script.
fs.writeFileSync(destPath + ".sha256", srcHash + "  " + path.basename(srcPath) + "\n");
