// ============================================================
// gallery.js (utils) — logique métier partagée du module Galerie Client
// ============================================================
const { db } = require("../db");

async function getSetting(cle, fallback) {
  const row = await db.prepare("SELECT valeur FROM settings WHERE cle = ?").get(cle);
  return row ? row.valeur : fallback;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days));
  return d;
}
function addHours(date, hours) {
  const d = new Date(date);
  d.setHours(d.getHours() + Number(hours));
  return d;
}

/**
 * Un accès "HD" (téléchargement des originaux) est autorisé si :
 *  - la séance est encore dans sa période de rétention gratuite (active
 *    ET expires_at pas encore dépassé), OU
 *  - un accès payant a été débloqué et n'a pas encore expiré (48h).
 * Ne se fie JAMAIS au champ `status` seul : `expires_at` et
 * `hd_unlocked_until` sont revérifiés à chaque appel (source de vérité).
 */
function hasHdAccess(session) {
  const now = new Date();
  const withinFreeRetention = new Date(session.expires_at) > now;
  const hdUnlocked = session.hd_unlocked_until && new Date(session.hd_unlocked_until) > now;
  return withinFreeRetention || !!hdUnlocked;
}

function isArchived(session) {
  return new Date(session.expires_at) <= new Date() && !hasHdAccess(session);
}

/** Marque en base les séances dont la rétention gratuite est dépassée. À appeler périodiquement. */
async function sweepExpiredSessions() {
  const now = new Date().toISOString();
  const info = await db.prepare("UPDATE sessions_photo SET status = 'archived' WHERE status = 'active' AND expires_at <= ?").run(now);
  return info.changes;
}

async function getSessionByToken(token) {
  return db.prepare("SELECT * FROM sessions_photo WHERE access_token = ?").get(token);
}

module.exports = { getSetting, addDays, addHours, hasHdAccess, isArchived, sweepExpiredSessions, getSessionByToken };
