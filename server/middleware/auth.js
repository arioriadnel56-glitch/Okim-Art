const jwt = require("jsonwebtoken");

// FAILLE CORRIGÉE : si JWT_SECRET n'est pas défini, le serveur démarrait
// quand même avec cette valeur par défaut codée en dur (donc visible par
// quiconque a accès au code source) — n'importe qui aurait pu forger un
// jeton admin ou client valide. On refuse maintenant de démarrer sans
// secret configuré, comme pour DATABASE_URL dans db.js.
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error(
    "JWT_SECRET manquant. Définissez-le dans .env (local) ou dans les variables " +
    "d'environnement de votre hébergeur (Render, etc.) — voir .env.example. " +
    "Générez-en un avec : openssl rand -hex 32"
  );
}

function signToken(payload, expiresIn = "7d") {
  return jwt.sign(payload, SECRET, { expiresIn });
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.okimart_admin_token;
  if (!token) return res.status(401).json({ error: "Non authentifié." });
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.type !== "admin") throw new Error("mauvais type de jeton");
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Session invalide ou expirée." });
  }
}

/**
 * Réservé au compte "propriétaire" (role: "owner"). Utilisé pour protéger
 * les Paramètres (clés de paiement, SMTP, informations du site...) : même
 * un compte admin/employé créé plus tard par le propriétaire n'y a pas
 * accès. À chaîner APRÈS requireAdmin (a besoin de req.admin déjà rempli).
 */
function requireOwner(req, res, next) {
  if (!req.admin || req.admin.role !== "owner") {
    return res.status(403).json({ error: "Accès réservé au propriétaire du compte." });
  }
  next();
}

/**
 * Contrôle d'accès par section pour le rôle "secretary" (compte secrétaire).
 * - "owner" : accès total, toujours autorisé, quelle que soit la section.
 * - "secretary" : autorisé UNIQUEMENT sur les sections listées dans
 *   SECRETARY_SECTIONS (Contenu / Boutique / Clients — mêmes groupes que la
 *   barre latérale de l'admin), et jamais en DELETE : un secrétaire peut
 *   consulter, créer et modifier, mais jamais supprimer une fiche existante.
 * - tout autre rôle (ex. "admin" générique, comportement historique) :
 *   inchangé, accès complet — cette fonction ne restreint que "secretary".
 * À chaîner APRÈS requireAdmin.
 */
const SECRETARY_SECTIONS = new Set(["contenu", "boutique", "clients"]);
function requireSection(section) {
  return function (req, res, next) {
    if (!req.admin) return res.status(401).json({ error: "Non authentifié." });
    if (req.admin.role !== "secretary") return next();
    if (!SECRETARY_SECTIONS.has(section)) {
      return res.status(403).json({ error: "Accès réservé au propriétaire du compte." });
    }
    if (req.method === "DELETE") {
      return res.status(403).json({ error: "Le compte secrétaire ne peut pas supprimer d'éléments." });
    }
    next();
  };
}

function requireClient(req, res, next) {
  const token = req.cookies?.okimart_client_token;
  if (!token) return res.status(401).json({ error: "Non authentifié." });
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.type !== "client") throw new Error("mauvais type de jeton");
    req.client = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Session invalide ou expirée." });
  }
}

/**
 * Authentification de la galerie client : un jeton court (2h), délivré
 * uniquement après validation du code PIN, envoyé par le client dans
 * l'en-tête Authorization (pas de cookie — plusieurs galeries peuvent être
 * ouvertes en parallèle dans des onglets différents). Le jeton est scopé à
 * une séance précise (session_id) ET revérifié contre le :token de l'URL,
 * pour qu'un jeton dérobé ne serve qu'à la séance pour laquelle il a été émis.
 */
function requireGalleryAccess(req, res, next) {
  const header = req.get("authorization") || "";
  // Accepte aussi le jeton en paramètre d'URL (?auth=...) : un <a href> de
  // téléchargement direct (navigation plein-écran, pas un fetch()) ne peut
  // pas envoyer d'en-tête Authorization personnalisé — indispensable pour
  // que le fichier individuel se télécharge nativement (et atterrisse dans
  // la galerie photo du téléphone), plutôt que de passer par un blob JS.
  const token = header.startsWith("Bearer ") ? header.slice(7) : (req.query.auth || null);
  if (!token) return res.status(401).json({ error: "Accès galerie non authentifié." });
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.type !== "gallery") throw new Error("mauvais type de jeton");
    if (decoded.access_token !== req.params.token) throw new Error("jeton hors-scope");
    req.gallery = decoded; // { type, session_id, access_token }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Accès expiré — veuillez ressaisir le code PIN." });
  }
}

module.exports = { signToken, requireAdmin, requireOwner, requireSection, requireClient, requireGalleryAccess, SECRET };