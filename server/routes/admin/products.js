const express = require("express");
const { db } = require("../../db");
const { uploadMemory, saveOriginal, savePublicVersion, deletePublicFile, deletePrivateFile } = require("../../utils/upload");
const { moveToTrash } = require("../../utils/trash");
const router = express.Router();

router.get("/", async (req, res) => {
  res.json({ products: await db.prepare("SELECT * FROM products ORDER BY created_at DESC").all() });
});

// Le fichier original haute résolution n'est JAMAIS renvoyé dans les réponses JSON —
// seuls son statut d'existence et le chemin privé interne sont gérés côté serveur.
router.post("/", uploadMemory.single("file"), async (req, res) => {
  try {
    const { photo_id, titre, description, prix, licence, statut } = req.body;
    if (!titre || !prix || !req.file) return res.status(400).json({ error: "Titre, prix et fichier original requis." });

    const fichier_original = await saveOriginal(req.file.buffer);
    const apercu = await savePublicVersion(req.file.buffer, {
      urlPrefix: "/uploads/previews",
      maxWidth: 900, quality: 68, watermarkText: "OKIM ART — APERÇU"
    });

    const info = await db.prepare(`
      INSERT INTO products (photo_id, titre, description, prix, licence, fichier_original, apercu, statut)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(photo_id || null, titre, description || "", Number(prix), licence || "Usage personnel",
           fichier_original, apercu, statut === "inactif" ? "inactif" : "actif");
    res.status(201).json({ product: await db.prepare("SELECT * FROM products WHERE id = ?").get(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put("/:id", uploadMemory.single("file"), async (req, res) => {
  try {
    const p = await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
    if (!p) return res.status(404).json({ error: "Produit introuvable." });
    const { photo_id, titre, description, prix, licence, statut } = req.body;
    let { fichier_original, apercu } = p;
    if (req.file) {
      deletePrivateFile(fichier_original);
      deletePublicFile(apercu);
      fichier_original = await saveOriginal(req.file.buffer);
      apercu = await savePublicVersion(req.file.buffer, {
        urlPrefix: "/uploads/previews",
        maxWidth: 900, quality: 68, watermarkText: "OKIM ART — APERÇU"
      });
    }
    await db.prepare(`
      UPDATE products SET photo_id=?, titre=?, description=?, prix=?, licence=?, fichier_original=?, apercu=?, statut=?
      WHERE id=?
    `).run(photo_id !== undefined ? (photo_id || null) : p.photo_id, titre ?? p.titre, description ?? p.description,
           prix !== undefined ? Number(prix) : p.prix, licence ?? p.licence, fichier_original, apercu,
           statut === "inactif" || statut === "actif" ? statut : p.statut, req.params.id);
    res.json({ product: await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  const p = await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Produit introuvable." });
  const used = (await db.prepare("SELECT COUNT(*) n FROM order_items WHERE product_id = ?").get(req.params.id)).n;
  if (used > 0) return res.status(409).json({ error: "Ce produit apparaît dans une commande existante et ne peut pas être supprimé." });
  await moveToTrash("products", p, p.titre);
  res.json({ ok: true, trashed: true });
});

module.exports = router;
