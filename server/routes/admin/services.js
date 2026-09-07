const express = require("express");
const { db } = require("../../db");
const { uploadMemory, savePublicVersion, deletePublicFile } = require("../../utils/upload");
const { moveToTrash } = require("../../utils/trash");
const router = express.Router();

router.get("/", async (req, res) => {
  res.json({ services: await db.prepare("SELECT * FROM services ORDER BY ordre ASC, created_at ASC").all() });
});

router.post("/", uploadMemory.single("file"), async (req, res) => {
  try {
    const { titre, description, prix, statut, ordre } = req.body;
    if (!titre) return res.status(400).json({ error: "Le titre est requis." });
    let image = null;
    if (req.file) image = await savePublicVersion(req.file.buffer, { urlPrefix: "/uploads/images", maxWidth: 1200 });
    const info = await db.prepare("INSERT INTO services (titre, description, image, prix, statut, ordre) VALUES (?,?,?,?,?,?)")
      .run(titre, description || "", image, prix || "", statut === "inactif" ? "inactif" : "actif", ordre ? Number(ordre) : 0);
    res.status(201).json({ service: await db.prepare("SELECT * FROM services WHERE id = ?").get(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put("/:id", uploadMemory.single("file"), async (req, res) => {
  try {
    const svc = await db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id);
    if (!svc) return res.status(404).json({ error: "Service introuvable." });
    const { titre, description, prix, statut, ordre } = req.body;
    let image = svc.image;
    if (req.file) {
      deletePublicFile(image);
      image = await savePublicVersion(req.file.buffer, { urlPrefix: "/uploads/images", maxWidth: 1200 });
    }
    await db.prepare("UPDATE services SET titre=?, description=?, image=?, prix=?, statut=?, ordre=? WHERE id=?")
      .run(titre ?? svc.titre, description ?? svc.description, image, prix ?? svc.prix,
           statut === "inactif" || statut === "actif" ? statut : svc.statut,
           ordre !== undefined ? Number(ordre) : svc.ordre, req.params.id);
    res.json({ service: await db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  const svc = await db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id);
  if (!svc) return res.status(404).json({ error: "Service introuvable." });
  await moveToTrash("services", svc, svc.titre);
  res.json({ ok: true, trashed: true });
});

module.exports = router;
