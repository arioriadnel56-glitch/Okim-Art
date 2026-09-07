const express = require("express");
const { db } = require("../../db");
const { uploadMemory, savePublicVersion, deletePublicFile } = require("../../utils/upload");
const { moveToTrash } = require("../../utils/trash");
const { streamFormationInscriptionsPdf } = require("../../utils/reports");
const router = express.Router();

router.get("/", async (req, res) => {
  res.json({ formations: await db.prepare("SELECT * FROM formations ORDER BY ordre ASC, created_at ASC").all() });
});

router.get("/:id/inscriptions", async (req, res) => {
  res.json({ inscriptions: await db.prepare("SELECT * FROM inscriptions_formation WHERE formation_id = ? ORDER BY created_at DESC").all(req.params.id) });
});

// Liste des inscrits en PDF (tableau), téléchargeable en un clic.
router.get("/:id/inscriptions/report.pdf", async (req, res) => {
  const formation = await db.prepare("SELECT * FROM formations WHERE id = ?").get(req.params.id);
  if (!formation) return res.status(404).json({ error: "Formation introuvable." });
  const inscriptions = await db.prepare("SELECT * FROM inscriptions_formation WHERE formation_id = ? ORDER BY created_at ASC").all(req.params.id);
  try {
    streamFormationInscriptionsPdf(formation, inscriptions, res);
  } catch (e) {
    console.error("[formations report.pdf]", e);
    if (!res.headersSent) res.status(500).json({ error: "Échec de la génération du PDF." });
  }
});

// Remet le compteur d'inscrits à zéro pour cette formation : chaque
// inscription est déplacée vers la Corbeille (récupérable 30 jours), rien
// n'est perdu définitivement — seul le compteur affiché repart de zéro.
router.post("/:id/inscriptions/reset", async (req, res) => {
  const formation = await db.prepare("SELECT * FROM formations WHERE id = ?").get(req.params.id);
  if (!formation) return res.status(404).json({ error: "Formation introuvable." });
  const inscriptions = await db.prepare("SELECT * FROM inscriptions_formation WHERE formation_id = ?").all(req.params.id);
  for (const insc of inscriptions) await moveToTrash("inscriptions", insc, `${insc.nom} — ${formation.titre}`);
  res.json({ ok: true, count: inscriptions.length });
});

router.patch("/inscriptions/:id", async (req, res) => {
  const { statut } = req.body || {};
  if (!["en_attente", "confirme", "annule"].includes(statut)) return res.status(400).json({ error: "Statut invalide." });
  await db.prepare("UPDATE inscriptions_formation SET statut = ? WHERE id = ?").run(statut, req.params.id);
  res.json({ ok: true });
});

router.post("/", uploadMemory.single("file"), async (req, res) => {
  try {
    const { titre, description, programme, prix, duree, date_session, lieu, places, statut, ordre } = req.body;
    if (!titre) return res.status(400).json({ error: "Le titre est requis." });
    let image = null;
    if (req.file) image = await savePublicVersion(req.file.buffer, { urlPrefix: "/uploads/images", maxWidth: 1200 });
    const info = await db.prepare(`
      INSERT INTO formations (titre, description, programme, image, prix, duree, date_session, lieu, places, statut, ordre)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(titre, description || "", programme || "", image, prix || "", duree || "", date_session || "", lieu || "",
           places ? Number(places) : 0, statut === "inactif" ? "inactif" : "actif", ordre ? Number(ordre) : 0);
    res.status(201).json({ formation: await db.prepare("SELECT * FROM formations WHERE id = ?").get(info.lastInsertRowid) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put("/:id", uploadMemory.single("file"), async (req, res) => {
  try {
    const f = await db.prepare("SELECT * FROM formations WHERE id = ?").get(req.params.id);
    if (!f) return res.status(404).json({ error: "Formation introuvable." });
    const { titre, description, programme, prix, duree, date_session, lieu, places, statut, ordre } = req.body;
    let image = f.image;
    if (req.file) {
      deletePublicFile(image);
      image = await savePublicVersion(req.file.buffer, { urlPrefix: "/uploads/images", maxWidth: 1200 });
    }
    await db.prepare(`
      UPDATE formations SET titre=?, description=?, programme=?, image=?, prix=?, duree=?, date_session=?, lieu=?, places=?, statut=?, ordre=?
      WHERE id=?
    `).run(titre ?? f.titre, description ?? f.description, programme ?? f.programme, image,
           prix ?? f.prix, duree ?? f.duree, date_session ?? f.date_session, lieu ?? f.lieu,
           places !== undefined ? Number(places) : f.places,
           statut === "inactif" || statut === "actif" ? statut : f.statut,
           ordre !== undefined ? Number(ordre) : f.ordre, req.params.id);
    res.json({ formation: await db.prepare("SELECT * FROM formations WHERE id = ?").get(req.params.id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete("/:id", async (req, res) => {
  const f = await db.prepare("SELECT * FROM formations WHERE id = ?").get(req.params.id);
  if (!f) return res.status(404).json({ error: "Formation introuvable." });
  const nbInscrits = (await db.prepare("SELECT COUNT(*) n FROM inscriptions_formation WHERE formation_id = ?").get(req.params.id)).n;
  if (nbInscrits > 0) {
    return res.status(409).json({ error: `Cette formation a ${nbInscrits} inscription(s) enregistrée(s). Passez-les à "annulé" avant de supprimer la formation, pour ne pas perdre ces informations.` });
  }
  await moveToTrash("formations", f, f.titre);
  res.json({ ok: true, trashed: true });
});

module.exports = router;
