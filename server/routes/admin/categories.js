const express = require("express");
const { db } = require("../../db");
const { moveToTrash } = require("../../utils/trash");
const router = express.Router();

function slugify(s) {
  return String(s).toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

router.get("/", async (req, res) => {
  res.json({ categories: await db.prepare("SELECT * FROM categories ORDER BY nom").all() });
});

router.post("/", async (req, res) => {
  const { nom, description } = req.body || {};
  if (!nom) return res.status(400).json({ error: "Le nom est requis." });
  const slug = slugify(nom);
  try {
    const info = await db.prepare("INSERT INTO categories (nom, slug, description) VALUES (?,?,?)").run(nom, slug, description || "");
    res.status(201).json({ category: await db.prepare("SELECT * FROM categories WHERE id = ?").get(info.lastInsertRowid) });
  } catch (e) {
    res.status(409).json({ error: "Une catégorie avec un nom similaire existe déjà." });
  }
});

router.put("/:id", async (req, res) => {
  const cat = await db.prepare("SELECT * FROM categories WHERE id = ?").get(req.params.id);
  if (!cat) return res.status(404).json({ error: "Catégorie introuvable." });
  const { nom, description } = req.body || {};
  const newNom = nom ?? cat.nom;
  const slug = nom ? slugify(nom) : cat.slug;
  await db.prepare("UPDATE categories SET nom=?, slug=?, description=? WHERE id=?")
    .run(newNom, slug, description ?? cat.description, req.params.id);
  res.json({ category: await db.prepare("SELECT * FROM categories WHERE id = ?").get(req.params.id) });
});

router.delete("/:id", async (req, res) => {
  const cat = await db.prepare("SELECT * FROM categories WHERE id = ?").get(req.params.id);
  if (!cat) return res.status(404).json({ error: "Catégorie introuvable." });
  const used = (await db.prepare("SELECT COUNT(*) n FROM photos WHERE category_id = ?").get(req.params.id)).n;
  if (used > 0) return res.status(409).json({ error: "Des photos utilisent encore cette catégorie." });
  await moveToTrash("categories", cat, cat.nom);
  res.json({ ok: true, trashed: true });
});

module.exports = router;
