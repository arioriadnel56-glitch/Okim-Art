// ============================================================
// idempotency.js — clés d'idempotence pour les écritures sensibles
// ============================================================
// Principe : le navigateur génère une clé unique par intention de l'utilisateur
// (en-tête "Idempotency-Key") et la renvoie à l'identique si l'envoi est
// répété (réseau coupé, réveil du serveur, file hors-ligne...). Le serveur
// exécute l'opération UNE seule fois et rejoue la même réponse ensuite.
//
// Table dédiée "idempotency_keys" (créée par db.js, purement additive).
const { db } = require("../db");

const KEY_RE = /^[A-Za-z0-9_-]{16,80}$/;
const IN_PROGRESS_STALE_MS = 2 * 60 * 1000; // un traitement "en cours" plus vieux est considéré abandonné

function readKey(req) {
  const k = req.get("idempotency-key");
  return k && KEY_RE.test(k) ? k : null;
}

/**
 * Enveloppe un handler Express (req, res) => Promise.
 * Sans en-tête Idempotency-Key valide : comportement strictement inchangé.
 * Avec clé : exécution unique, réponse rejouée pour toute répétition.
 */
function idempotent(scope, handler) {
  return async function (req, res, next) {
    try {
      const key = readKey(req);
      if (!key) return await handler(req, res, next);

      const fullKey = scope + ":" + key;
      const claim = await db.prepare(
        "INSERT INTO idempotency_keys (key, scope, state) VALUES (?,?, 'in_progress') ON CONFLICT (key) DO NOTHING"
      ).run(fullKey, scope);

      if (claim.changes === 0) {
        const row = await db.prepare("SELECT state, status_code, response_json, created_at FROM idempotency_keys WHERE key = ?").get(fullKey);
        if (row && row.state === "done") {
          res.setHeader("Idempotent-Replay", "true");
          return res.status(row.status_code || 200).json(JSON.parse(row.response_json || "null"));
        }
        const age = row ? Date.now() - new Date(row.created_at.replace(" ", "T") + "Z").getTime() : Infinity;
        if (age < IN_PROGRESS_STALE_MS) {
          res.setHeader("Retry-After", "2");
          return res.status(409).json({ error: "Opération déjà en cours de traitement.", in_progress: true });
        }
        // Traitement précédent abandonné (crash) : on reprend la main.
        await db.prepare("UPDATE idempotency_keys SET state = 'in_progress', created_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE key = ?").run(fullKey);
      }

      // Capture la réponse pour la rejouer.
      const originalJson = res.json.bind(res);
      let captured = false;
      res.json = function (body) {
        if (!captured) {
          captured = true;
          const code = res.statusCode || 200;
          const p = code >= 500
            ? db.prepare("DELETE FROM idempotency_keys WHERE key = ?").run(fullKey) // échec serveur : on autorise un nouvel essai
            : db.prepare("UPDATE idempotency_keys SET state = 'done', status_code = ?, response_json = ? WHERE key = ?")
                .run(code, JSON.stringify(body === undefined ? null : body), fullKey);
          p.catch((e) => console.error("[idempotency] enregistrement impossible :", e.message));
        }
        return originalJson(body);
      };
      try {
        await handler(req, res, next);
      } catch (e) {
        await db.prepare("DELETE FROM idempotency_keys WHERE key = ?").run(fullKey).catch(() => {});
        throw e;
      }
    } catch (e) {
      next(e);
    }
  };
}

async function purgeOldIdempotencyKeys() {
  await db.prepare("DELETE FROM idempotency_keys WHERE created_at < to_char((now() AT TIME ZONE 'UTC') - interval '7 days', 'YYYY-MM-DD HH24:MI:SS')").run();
}

module.exports = { idempotent, purgeOldIdempotencyKeys };
