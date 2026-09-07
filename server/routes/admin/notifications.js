// ============================================================
// admin/notifications.js — cloche de notifications admin
// ============================================================
const express = require("express");
const { db } = require("../../db");
const router = express.Router();

router.get("/", async (req, res) => {
  const notifications = await db.prepare("SELECT * FROM notifications WHERE audience = 'admin' ORDER BY created_at DESC LIMIT 50").all();
  const unread = (await db.prepare("SELECT COUNT(*) n FROM notifications WHERE audience = 'admin' AND lu = 0").get()).n;
  res.json({ notifications, unread });
});

router.patch("/:id/read", async (req, res) => {
  await db.prepare("UPDATE notifications SET lu = 1 WHERE id = ? AND audience = 'admin'").run(req.params.id);
  res.json({ ok: true });
});

router.post("/read-all", async (req, res) => {
  await db.prepare("UPDATE notifications SET lu = 1 WHERE audience = 'admin' AND lu = 0").run();
  res.json({ ok: true });
});

module.exports = router;
