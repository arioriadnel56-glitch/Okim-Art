// ============================================================
// admin/trash.js — corbeille (éléments supprimés, 30 jours avant purge)
// ============================================================
const express = require("express");
const { listTrash, restoreFromTrash, permanentlyDelete, emptyAllTrash, purgeExpiredTrash, RETENTION_DAYS } = require("../../utils/trash");
const router = express.Router();

router.get("/", async (req, res) => {
  // Purge d'abord ce qui a dépassé les 30 jours, pour que la liste reflète toujours l'état réel.
  await purgeExpiredTrash();
  res.json({ items: await listTrash(), retention_days: RETENTION_DAYS });
});

router.post("/:id/restore", async (req, res) => {
  try {
    const item = await restoreFromTrash(req.params.id);
    if (!item) return res.status(404).json({ error: "Élément introuvable dans la corbeille (peut-être déjà purgé)." });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  const item = await permanentlyDelete(req.params.id);
  if (!item) return res.status(404).json({ error: "Élément introuvable dans la corbeille." });
  res.json({ ok: true });
});

router.delete("/", async (req, res) => {
  const count = await emptyAllTrash();
  res.json({ ok: true, count });
});

module.exports = router;
