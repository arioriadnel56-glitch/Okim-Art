const express = require("express");
const { db, transaction, getSecureSetting, setSecureSetting } = require("../../db");
const { nanoid } = require("nanoid");
const { uploadMemory, savePublicVersion, deletePublicFile } = require("../../utils/upload");
const router = express.Router();

router.get("/", async (req, res) => {
  const rows = await db.prepare("SELECT cle, valeur FROM settings").all();
  const settings = {};
  rows.forEach(r => { settings[r.cle] = r.valeur; });
  res.json({ settings });
});

router.put("/", async (req, res) => {
  const updates = req.body || {};
  await transaction(async (tx) => {
    for (const [cle, valeur] of Object.entries(updates)) {
      await tx.prepare("INSERT INTO settings (cle, valeur) VALUES (?,?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur")
        .run(cle, String(valeur ?? ""));
    }
  });
  const rows = await db.prepare("SELECT cle, valeur FROM settings").all();
  const settings = {};
  rows.forEach(r => { settings[r.cle] = r.valeur; });
  res.json({ settings });
});

router.post("/logo", uploadMemory.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fichier requis." });
    const current = await db.prepare("SELECT valeur FROM settings WHERE cle = 'logo'").get();
    if (current?.valeur) deletePublicFile(current.valeur);
    const url = await savePublicVersion(req.file.buffer, { urlPrefix: "/uploads/images", maxWidth: 600, quality: 90 });
    await db.prepare("INSERT INTO settings (cle, valeur) VALUES ('logo', ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur").run(url);
    res.json({ logo: url });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Photo de profil (affichée en mode portrait sur le site public) ----------
router.post("/photo-profil", uploadMemory.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Fichier requis." });
    const current = await db.prepare("SELECT valeur FROM settings WHERE cle = 'photographe_photo'").get();
    if (current?.valeur) deletePublicFile(current.valeur);
    // On conserve les proportions d'origine (pas de recadrage forcé côté
    // serveur) : c'est le CSS du site (ratio portrait fixe + object-fit)
    // qui garantit un cadrage cohérent sur tous les appareils, quelle que
    // soit la photo fournie par le photographe.
    const url = await savePublicVersion(req.file.buffer, { urlPrefix: "/uploads/images", maxWidth: 1000, quality: 88 });
    await db.prepare("INSERT INTO settings (cle, valeur) VALUES ('photographe_photo', ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur").run(url);
    res.json({ photographe_photo: url });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Paiement KKiaPay (Mobile Money / carte) ----------
router.get("/kkiapay", async (req, res) => {
  const rows = await db.prepare("SELECT cle, valeur FROM settings WHERE cle IN ('kkiapay_enabled','kkiapay_public_key','kkiapay_sandbox')").all();
  const cfg = {};
  rows.forEach(r => { cfg[r.cle] = r.valeur; });
  res.json({
    enabled: cfg.kkiapay_enabled === "1",
    public_key: cfg.kkiapay_public_key || "",
    sandbox: cfg.kkiapay_sandbox !== "0",
    webhook_secret: await getSecureSetting("kkiapay_webhook_secret"),
    webhook_url: `${req.protocol}://${req.get("host")}/api/kkiapay/webhook`
  });
});

router.put("/kkiapay", async (req, res) => {
  const { enabled, public_key, sandbox } = req.body || {};
  const upsert = db.prepare("INSERT INTO settings (cle, valeur) VALUES (?,?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur");
  await upsert.run("kkiapay_enabled", enabled ? "1" : "0");
  await upsert.run("kkiapay_public_key", public_key || "");
  await upsert.run("kkiapay_sandbox", sandbox === false ? "0" : "1");
  res.json({ ok: true });
});

router.post("/kkiapay/regenerate-secret", async (req, res) => {
  const secret = nanoid(32);
  await setSecureSetting("kkiapay_webhook_secret", secret);
  res.json({ webhook_secret: secret });
});

// Vide le journal des paiements KKiaPay déjà validés (kkiapay_events) —
// une fois qu'une commande est "payée", ces entrées ne servent plus qu'à
// la traçabilité technique ; les rappeler n'affecte ni les commandes ni
// les liens de téléchargement déjà générés.
router.post("/kkiapay/clear-cache", async (req, res) => {
  const info = await db.prepare("DELETE FROM kkiapay_events WHERE success = 1").run();
  res.json({ ok: true, count: info.changes });
});

// ---------- Notifications automatiques (e-mail + webhook générique) ----------
const NOTIFY_KEYS = ["smtp_host", "smtp_port", "smtp_secure", "smtp_user", "smtp_pass", "smtp_from_name", "smtp_from_email", "notify_webhook_url"];

router.get("/notifications", async (req, res) => {
  const cfg = {};
  for (const k of NOTIFY_KEYS) cfg[k] = await getSecureSetting(k);
  cfg.smtp_secure = cfg.smtp_secure === "1";
  cfg.smtp_configured = !!(cfg.smtp_host && cfg.smtp_user && cfg.smtp_pass);
  delete cfg.smtp_pass; // ne jamais renvoyer un secret déjà stocké, même à l'admin
  res.json(cfg);
});

router.put("/notifications", async (req, res) => {
  const body = req.body || {};
  for (const k of NOTIFY_KEYS) {
    if (k === "smtp_secure") { await setSecureSetting(k, body.smtp_secure ? "1" : "0"); continue; }
    if (body[k] !== undefined) await setSecureSetting(k, String(body[k]));
  }
  res.json({ ok: true });
});

router.post("/notifications/test-email", async (req, res) => {
  const { sendMail } = require("../../utils/notify");
  const row = await db.prepare("SELECT valeur FROM settings WHERE cle = 'email'").get();
  const to = row?.valeur;
  if (!to) return res.status(400).json({ error: "Renseignez d'abord un e-mail de contact dans Profil & contact." });
  const result = await sendMail({ to, subject: "OKIM ART — Test de notification", html: "<p>Ceci est un e-mail de test envoyé depuis votre tableau de bord OKIM ART. Si vous le recevez, vos réglages SMTP fonctionnent.</p>" });
  if (!result.ok) return res.status(400).json({ error: result.error || "Échec de l'envoi." });
  res.json({ ok: true });
});

// ---------- Assistant IA "okim.box" ----------
router.get("/assistant", async (req, res) => {
  const rows = await db.prepare("SELECT cle, valeur FROM settings WHERE cle IN ('assistant_enabled','assistant_name','assistant_intro','assistant_model')").all();
  const cfg = {};
  rows.forEach((r) => { cfg[r.cle] = r.valeur; });
  const { DEFAULT_MODEL } = require("../../utils/assistant");
  res.json({
    enabled: cfg.assistant_enabled === "1",
    name: cfg.assistant_name || "okim.box",
    intro: cfg.assistant_intro || "",
    model: cfg.assistant_model || DEFAULT_MODEL,
    api_key_configured: !!(await getSecureSetting("anthropic_api_key"))
  });
});

router.put("/assistant", async (req, res) => {
  const { enabled, name, intro, model, api_key } = req.body || {};
  const upsert = db.prepare("INSERT INTO settings (cle, valeur) VALUES (?,?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur");
  await upsert.run("assistant_enabled", enabled ? "1" : "0");
  if (name !== undefined) await upsert.run("assistant_name", String(name || "okim.box"));
  if (intro !== undefined) await upsert.run("assistant_intro", String(intro || ""));
  if (model !== undefined && String(model).trim()) await upsert.run("assistant_model", String(model).trim());
  // La clé API n'est écrite QUE si l'admin en saisit une nouvelle — un champ
  // laissé vide ne l'efface jamais (même comportement que le mot de passe SMTP).
  if (api_key) await setSecureSetting("anthropic_api_key", String(api_key).trim());
  res.json({ ok: true });
});

// Envoie un message de test réel à l'API pour confirmer que la clé
// fonctionne, sans passer par le widget public ni consommer un tour de
// conversation client.
router.post("/assistant/test", async (req, res) => {
  try {
    const { askAssistant } = require("../../utils/assistant");
    const reply = await askAssistant([{ role: "user", contenu: "Bonjour, peux-tu te présenter en une phrase ?" }]);
    res.json({ ok: true, reply: reply.text });
  } catch (e) {
    if (e.code === "MISSING_KEY") return res.status(400).json({ error: "Aucune clé API Anthropic enregistrée." });
    res.status(400).json({ error: e.message || "Échec du test." });
  }
});

module.exports = router;
