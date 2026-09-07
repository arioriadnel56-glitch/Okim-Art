const express = require("express");
const { db } = require("../../db");
const { moveToTrash } = require("../../utils/trash");
const router = express.Router();

router.get("/", async (req, res) => {
  res.json({ messages: await db.prepare("SELECT * FROM messages ORDER BY created_at DESC").all() });
});

router.patch("/:id/statut", async (req, res) => {
  const { statut } = req.body || {};
  if (!["non_lu", "lu", "traite"].includes(statut)) return res.status(400).json({ error: "Statut invalide." });
  await db.prepare("UPDATE messages SET statut = ? WHERE id = ?").run(statut, req.params.id);
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  const msg = await db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id);
  if (!msg) return res.status(404).json({ error: "Message introuvable." });
  const label = msg.nom + (msg.sujet ? " — " + msg.sujet : "");
  await moveToTrash("messages", msg, label);
  res.json({ ok: true, trashed: true });
});

module.exports = router;
