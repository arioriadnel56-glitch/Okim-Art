// ============================================================
// auth.js — connexion / déconnexion admin & client
// ============================================================
const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { db } = require("../db");
const { signToken, requireAdmin, requireOwner, requireClient } = require("../middleware/auth");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessayez dans quelques minutes." }
});

const COOKIE_OPTS_ADMIN = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 7 * 24 * 3600 * 1000,
  path: "/"
};
const COOKIE_OPTS_CLIENT = { ...COOKIE_OPTS_ADMIN };

// ---------- ADMIN ----------
router.post("/admin/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis." });

  const admin = await db.prepare("SELECT * FROM admins WHERE email = ?").get(String(email).toLowerCase().trim());
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: "Identifiants incorrects." });
  }
  const token = signToken({ id: admin.id, email: admin.email, role: admin.role, type: "admin" });
  res.cookie("okimart_admin_token", token, COOKIE_OPTS_ADMIN);
  res.json({ ok: true, admin: { id: admin.id, nom: admin.nom, email: admin.email, role: admin.role } });
});

router.post("/admin/logout", (req, res) => {
  res.clearCookie("okimart_admin_token", { path: "/" });
  res.json({ ok: true });
});

router.get("/admin/me", requireAdmin, async (req, res) => {
  const admin = await db.prepare("SELECT id, nom, email, role, created_at FROM admins WHERE id = ?").get(req.admin.id);
  if (!admin) return res.status(401).json({ error: "Non authentifié." });
  res.json({ admin });
});

router.put("/admin/password", requireAdmin, async (req, res) => {
  const { ancien_mot_de_passe, nouveau_mot_de_passe } = req.body || {};
  if (!nouveau_mot_de_passe || nouveau_mot_de_passe.length < 8) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 8 caractères." });
  }
  const admin = await db.prepare("SELECT * FROM admins WHERE id = ?").get(req.admin.id);
  if (!admin || !bcrypt.compareSync(ancien_mot_de_passe || "", admin.password_hash)) {
    return res.status(401).json({ error: "Mot de passe actuel incorrect." });
  }
  const hash = bcrypt.hashSync(nouveau_mot_de_passe, 12);
  await db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hash, admin.id);
  res.json({ ok: true });
});

// Nom et email du compte admin. Le "nom" sert aussi de réponse de sécurité
// pour la récupération de mot de passe ci-dessous : à choisir mémorisable
// mais pas trop facile à deviner par quelqu'un d'autre.
router.put("/admin/profile", requireAdmin, async (req, res) => {
  const { nom, email } = req.body || {};
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom est requis." });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Email invalide." });
  const normalizedEmail = String(email).toLowerCase().trim();
  const conflict = await db.prepare("SELECT id FROM admins WHERE email = ? AND id != ?").get(normalizedEmail, req.admin.id);
  if (conflict) return res.status(409).json({ error: "Cet email est déjà utilisé par un autre compte." });
  await db.prepare("UPDATE admins SET nom = ?, email = ? WHERE id = ?").run(nom.trim(), normalizedEmail, req.admin.id);
  res.json({ ok: true, admin: { id: req.admin.id, nom: nom.trim(), email: normalizedEmail } });
});

// Récupération de mot de passe SANS envoi d'e-mail : on vérifie l'identité
// avec le nom déjà enregistré sur le compte (voir Paramètres → Sécurité).
// Limité en débit comme la connexion pour éviter le brute-force du nom.
router.post("/admin/forgot-password", loginLimiter, async (req, res) => {
  const { email, nom, nouveau_mot_de_passe } = req.body || {};
  if (!email || !nom || !nouveau_mot_de_passe || nouveau_mot_de_passe.length < 8) {
    return res.status(400).json({ error: "Email, nom enregistré et nouveau mot de passe (8 caractères min.) requis." });
  }
  const admin = await db.prepare("SELECT * FROM admins WHERE email = ?").get(String(email).toLowerCase().trim());
  const nomMatches = admin && admin.nom.trim().toLowerCase() === String(nom).trim().toLowerCase();
  if (!admin || !nomMatches) {
    return res.status(401).json({ error: "Email ou nom enregistré incorrect." });
  }
  const hash = bcrypt.hashSync(nouveau_mot_de_passe, 12);
  await db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hash, admin.id);
  res.json({ ok: true });
});

// ---------- CLIENT (espace client boutique) ----------
router.post("/client/register", loginLimiter, async (req, res) => {
  const { nom, email, telephone, password, accepte_licence } = req.body || {};
  if (!nom || !email || !password || password.length < 8) {
    return res.status(400).json({ error: "Nom, email et mot de passe (8 caractères min.) requis." });
  }
  // Vérification côté serveur, jamais seulement côté client : une case à
  // cocher désactivée en JS (ou un appel direct à l'API) ne doit jamais
  // pouvoir contourner l'acceptation de la licence.
  if (accepte_licence !== true) {
    return res.status(400).json({ error: "Vous devez accepter la licence d'utilisation pour créer un compte." });
  }
  const existing = await db.prepare("SELECT id FROM clients WHERE email = ?").get(String(email).toLowerCase().trim());
  if (existing) return res.status(409).json({ error: "Un compte existe déjà avec cet email." });

  const hash = bcrypt.hashSync(password, 12);
  const info = await db.prepare(`
    INSERT INTO clients (nom, email, telephone, password_hash, licence_acceptee_at)
    VALUES (?,?,?,?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
  `).run(nom, String(email).toLowerCase().trim(), telephone || "", hash);

  const token = signToken({ id: info.lastInsertRowid, email, type: "client" });
  res.cookie("okimart_client_token", token, COOKIE_OPTS_CLIENT);
  res.json({ ok: true, client: { id: info.lastInsertRowid, nom, email } });
});

router.post("/client/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const client = await db.prepare("SELECT * FROM clients WHERE email = ?").get(String(email || "").toLowerCase().trim());
  if (!client || !bcrypt.compareSync(password || "", client.password_hash)) {
    return res.status(401).json({ error: "Identifiants incorrects." });
  }
  const token = signToken({ id: client.id, email: client.email, type: "client" });
  res.cookie("okimart_client_token", token, COOKIE_OPTS_CLIENT);
  res.json({ ok: true, client: { id: client.id, nom: client.nom, email: client.email } });
});

router.post("/client/logout", (req, res) => {
  res.clearCookie("okimart_client_token", { path: "/" });
  res.json({ ok: true });
});

router.get("/client/me", requireClient, async (req, res) => {
  const client = await db.prepare("SELECT id, nom, email, telephone, created_at FROM clients WHERE id = ?").get(req.client.id);
  if (!client) return res.status(401).json({ error: "Non authentifié." });
  res.json({ client });
});

// ---------- Mot de passe oublié (espace client) ----------
// Contrairement à la récupération admin (par nom, un cercle restreint de
// confiance), les clients sont potentiellement nombreux et anonymes : on
// utilise ici un vrai lien de réinitialisation envoyé par e-mail, à usage
// unique et à durée limitée (1h). La réponse est volontairement identique
// que l'email existe ou non, pour ne jamais révéler quels emails sont
// enregistrés (protection contre l'énumération de comptes).
router.post("/client/forgot-password", loginLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email requis." });

  const client = await db.prepare("SELECT * FROM clients WHERE email = ?").get(String(email).toLowerCase().trim());
  if (client) {
    const { nanoid } = require("nanoid");
    const { sendMail } = require("../utils/notify");
    const token = nanoid(40);
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString(); // 1h
    await db.prepare("INSERT INTO password_resets (client_id, token, expires_at) VALUES (?,?,?)").run(client.id, token, expiresAt);

    const siteRow = await db.prepare("SELECT valeur FROM settings WHERE cle = 'site_url'").get();
    const siteUrl = (siteRow && siteRow.valeur) ? siteRow.valeur.replace(/\/$/, "") : "";
    const resetUrl = `${siteUrl}/reset-password.html?token=${encodeURIComponent(token)}`;
    sendMail({
      to: client.email,
      subject: "OKIM ART — Réinitialisation de votre mot de passe",
      html: `
        <div style="font-family:sans-serif; color:#1c1a17; max-width:480px">
          <h2 style="margin-bottom:4px">Réinitialisation de mot de passe</h2>
          <p>Bonjour ${client.nom},</p>
          <p>Vous avez demandé à réinitialiser le mot de passe de votre espace client OKIM ART. Ce lien est valable 1 heure et ne peut être utilisé qu'une seule fois :</p>
          <p><a href="${resetUrl}" style="display:inline-block; padding:.7rem 1.2rem; background:#232f52; color:#fffdf8; text-decoration:none; border-radius:8px">Choisir un nouveau mot de passe</a></p>
          <p style="color:#6b6558; font-size:.85rem">Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail — votre mot de passe actuel reste inchangé.</p>
        </div>`
    }).catch((e) => console.error("[forgot-password] échec envoi e-mail :", e.message));
  }

  res.json({ ok: true, message: "Si un compte existe avec cet email, un lien de réinitialisation vient d'être envoyé." });
});

router.post("/client/reset-password", loginLimiter, async (req, res) => {
  const { token, nouveau_mot_de_passe } = req.body || {};
  if (!token || !nouveau_mot_de_passe || nouveau_mot_de_passe.length < 8) {
    return res.status(400).json({ error: "Lien invalide ou mot de passe trop court (8 caractères min.)." });
  }
  const reset = await db.prepare("SELECT * FROM password_resets WHERE token = ?").get(token);
  if (!reset || reset.used || new Date(reset.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: "Ce lien de réinitialisation est invalide ou a expiré. Refaites une demande." });
  }
  const hash = bcrypt.hashSync(nouveau_mot_de_passe, 12);
  await db.prepare("UPDATE clients SET password_hash = ? WHERE id = ?").run(hash, reset.client_id);
  // Ce lien ET tout autre lien de réinitialisation en attente pour ce
  // client deviennent invalides — évite qu'un ancien lien oublié dans une
  // boîte mail reste exploitable après coup.
  await db.prepare("UPDATE password_resets SET used = 1 WHERE client_id = ?").run(reset.client_id);
  res.json({ ok: true });
});

module.exports = router;
