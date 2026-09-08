// ============================================================
// db.js — connexion PostgreSQL + schéma complet + amorçage initial
// ============================================================
// Migré depuis SQLite (node:sqlite) vers PostgreSQL, pour un déploiement
// sur des plateformes sans disque persistant garanti (Render, Vercel...).
//
// Compatibilité : afin de ne pas réécrire chaque requête SQL une par une,
// `db.prepare(sql).get/all/run(...)` reproduit l'API synchrone utilisée
// partout dans le code existant, mais en version ASYNCHRONE (chaque appel
// renvoie une Promise — tous les appelants ont été mis à jour avec
// async/await). Les placeholders `?` (syntaxe SQLite) sont convertis
// automatiquement en `$1, $2, ...` (syntaxe PostgreSQL), et un
// `RETURNING id` est ajouté automatiquement aux INSERT qui n'en ont pas
// déjà un, pour émuler `lastInsertRowid` de better-sqlite3/node:sqlite.
const { Pool, types } = require("pg");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");

// PostgreSQL renvoie les BIGINT (ex. COUNT(*), SUM(colonne_integer)) sous
// forme de chaîne de caractères par défaut, pour éviter les pertes de
// précision au-delà de Number.MAX_SAFE_INTEGER. Tout le code existant
// compare ces valeurs à des nombres (`if (count > 0)`, `n === 0`...) : on
// les fait donc analyser comme des nombres JS classiques (largement
// suffisant vu les volumes réels de cette plateforme).
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL manquant. Définissez-le dans .env (local) ou dans les variables " +
    "d'environnement de votre hébergeur (Render, etc.) — voir .env.example."
  );
}

// SSL : activé par défaut (obligatoire sur Render/la plupart des hébergeurs
// PostgreSQL managés, qui utilisent des certificats non vérifiables
// simplement). Mettre PGSSL=false pour une base Postgres locale (Docker...)
// qui n'expose pas de TLS.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
});

pool.on("error", (err) => {
  // Erreur sur une connexion inactive du pool (ex. coupure réseau) : ne
  // doit jamais faire planter tout le process.
  console.error("[db] Erreur inattendue sur le pool PostgreSQL :", err.message);
});

// ---------------------------------------------------------------
// Émulation de l'API "prepare().get/all/run()" par-dessus `pg`
// ---------------------------------------------------------------
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Tables sans colonne "id" (clé primaire = "cle") : ne jamais leur ajouter
// RETURNING id, ça ferait échouer la requête.
const NO_ID_TABLES = new Set(["settings", "secure_settings"]);

function needsReturningId(sql) {
  const m = sql.match(/^\s*insert\s+into\s+["`]?(\w+)["`]?/i);
  if (!m) return false;
  if (NO_ID_TABLES.has(m[1].toLowerCase())) return false;
  if (/\breturning\b/i.test(sql)) return false;
  return true;
}

function createDbInterface(queryable) {
  function prepare(sql) {
    async function exec(params) {
      let text = sql;
      if (needsReturningId(text)) {
        text = text.trim().replace(/;\s*$/, "") + " RETURNING id";
      }
      text = convertPlaceholders(text);
      return queryable.query(text, params);
    }
    return {
      async get(...params) {
        const { rows } = await exec(params);
        return rows[0];
      },
      async all(...params) {
        const { rows } = await exec(params);
        return rows;
      },
      async run(...params) {
        const { rows, rowCount } = await exec(params);
        return { changes: rowCount, lastInsertRowid: rows[0] ? rows[0].id : undefined };
      }
    };
  }
  async function rawQuery(text, params = []) {
    return queryable.query(convertPlaceholders(text), params);
  }
  return { prepare, query: rawQuery };
}

const db = createDbInterface(pool);

/**
 * Remplaçant async de db.transaction() (spécifique à better-sqlite3) :
 * exécute `fn(txDb)` (txDb ayant la même API que `db`, mais liée à une
 * connexion dédiée) entre BEGIN/COMMIT, avec ROLLBACK automatique en cas
 * d'erreur. `fn` peut être async.
 */
async function transaction(fn) {
  const client = await pool.connect();
  const txDb = createDbInterface(client);
  try {
    await client.query("BEGIN");
    const result = await fn(txDb);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------
// Schéma (équivalent PostgreSQL du schéma SQLite d'origine)
// ---------------------------------------------------------------
// Note sur les colonnes de date : conservées en TEXT (et non TIMESTAMP),
// au format "YYYY-MM-DD HH:MI:SS" identique à celui produit par le
// `datetime('now')` de SQLite. Tout le code applicatif (comparaisons de
// chaînes, `.split(" ")`, `new Date(...).toISOString()` stocké tel quel...)
// continue donc de fonctionner sans aucun changement.
const NOW_EXPR = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  nom TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  nom TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS photos (
  id SERIAL PRIMARY KEY,
  titre TEXT NOT NULL,
  description TEXT DEFAULT '',
  fichier TEXT NOT NULL,
  miniature TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  statut TEXT NOT NULL DEFAULT 'brouillon',
  a_la_une INTEGER NOT NULL DEFAULT 0,
  prix INTEGER,
  watermark INTEGER NOT NULL DEFAULT 1,
  ordre INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  titre TEXT NOT NULL,
  description TEXT DEFAULT '',
  image TEXT,
  prix TEXT DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'actif',
  ordre INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS formations (
  id SERIAL PRIMARY KEY,
  titre TEXT NOT NULL,
  description TEXT DEFAULT '',
  programme TEXT DEFAULT '',
  image TEXT,
  prix TEXT DEFAULT '',
  duree TEXT DEFAULT '',
  date_session TEXT DEFAULT '',
  lieu TEXT DEFAULT '',
  places INTEGER DEFAULT 0,
  statut TEXT NOT NULL DEFAULT 'actif',
  ordre INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS inscriptions_formation (
  id SERIAL PRIMARY KEY,
  formation_id INTEGER NOT NULL REFERENCES formations(id) ON DELETE CASCADE,
  nom TEXT NOT NULL,
  email TEXT NOT NULL,
  telephone TEXT DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'en_attente',
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  titre TEXT NOT NULL,
  description TEXT DEFAULT '',
  prix INTEGER NOT NULL,
  licence TEXT NOT NULL DEFAULT 'usage personnel',
  fichier_original TEXT NOT NULL,
  apercu TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'actif',
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  nom TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  telephone TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  numero TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  client_nom TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_telephone TEXT DEFAULT '',
  montant INTEGER NOT NULL,
  statut TEXT NOT NULL DEFAULT 'en_attente',
  moyen_paiement TEXT DEFAULT '',
  note_admin TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  titre TEXT NOT NULL,
  prix_unitaire INTEGER NOT NULL,
  quantite INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS download_tokens (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  max_downloads INTEGER NOT NULL DEFAULT 5,
  downloads_used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  nom TEXT NOT NULL,
  email TEXT NOT NULL,
  telephone TEXT DEFAULT '',
  sujet TEXT DEFAULT '',
  message TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'non_lu',
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS settings (
  cle TEXT PRIMARY KEY,
  valeur TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS secure_settings (
  cle TEXT PRIMARY KEY,
  valeur TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS kkiapay_events (
  id SERIAL PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  success INTEGER NOT NULL DEFAULT 0,
  amount INTEGER,
  method TEXT,
  account TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS trash (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT ${NOW_EXPR},
  purge_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions_photo (
  id SERIAL PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL UNIQUE,
  pin_code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  hd_unlocked_until TEXT,
  recovery_price INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR},
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_photos (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions_photo(id) ON DELETE CASCADE,
  titre TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL,
  watermark_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS recovery_transactions (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions_photo(id) ON DELETE CASCADE,
  transaction_reference TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

-- ================================================================
-- MODULE "Outils & Logiciels" — marketplace de produits numériques
-- ================================================================
-- Réutilise volontairement la table "products" existante (un logiciel EST
-- un product, avec type='logiciel') pour hériter gratuitement du panier,
-- des commandes, des order_items et de markOrderPaid déjà en place —
-- "software_products" n'ajoute que les champs propres aux logiciels.
CREATE TABLE IF NOT EXISTS software_products (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  slogan TEXT DEFAULT '',
  description_longue TEXT DEFAULT '',
  probleme_resolu TEXT DEFAULT '',
  public_cible TEXT DEFAULT '',
  plateforme TEXT DEFAULT '',           -- ex. "Web, Windows, macOS"
  systeme_compatible TEXT DEFAULT '',
  version_actuelle TEXT DEFAULT '',
  taille TEXT DEFAULT '',
  configuration_min TEXT DEFAULT '',
  licence_type TEXT DEFAULT '',         -- ex. "Perpétuelle", "Abonnement"
  demo_url TEXT DEFAULT '',
  video_url TEXT DEFAULT '',
  captures TEXT NOT NULL DEFAULT '[]',  -- JSON: tableau d'URLs de captures d'écran
  badge TEXT DEFAULT '',                -- 'nouveau' | 'populaire' | 'promotion' | ''
  popularite INTEGER NOT NULL DEFAULT 0, -- compteur simple (ventes), pour tri "populaire"
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS software_plans (
  id SERIAL PRIMARY KEY,
  software_id INTEGER NOT NULL REFERENCES software_products(id) ON DELETE CASCADE,
  nom TEXT NOT NULL,                    -- "Basic", "Pro", "Business"...
  description TEXT DEFAULT '',
  prix INTEGER NOT NULL,
  periodicite TEXT NOT NULL DEFAULT 'unique', -- unique | mensuel | annuel
  fonctionnalites TEXT NOT NULL DEFAULT '[]', -- JSON: tableau de chaînes
  max_devices INTEGER NOT NULL DEFAULT 1,
  max_users INTEGER NOT NULL DEFAULT 1,
  statut TEXT NOT NULL DEFAULT 'actif', -- actif | inactif
  ordre INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS software_versions (
  id SERIAL PRIMARY KEY,
  software_id INTEGER NOT NULL REFERENCES software_products(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  notes TEXT DEFAULT '',                -- notes de version / changelog
  fichier TEXT NOT NULL,                -- chemin privé (jamais public), voir uploads/private/software
  taille_octets INTEGER,
  compatibilite TEXT DEFAULT '',
  type_maj TEXT NOT NULL DEFAULT 'mineure', -- majeure | mineure | correctif
  published_at TEXT NOT NULL DEFAULT ${NOW_EXPR},
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS licenses (
  id SERIAL PRIMARY KEY,
  license_key TEXT NOT NULL UNIQUE,
  software_id INTEGER NOT NULL REFERENCES software_products(id),
  plan_id INTEGER REFERENCES software_plans(id),
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  order_item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | expiree | suspendue | annulee
  max_devices INTEGER NOT NULL DEFAULT 1,
  max_users INTEGER NOT NULL DEFAULT 1,
  activated_at TEXT NOT NULL DEFAULT ${NOW_EXPR},
  expires_at TEXT,                       -- NULL = licence permanente
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS software_downloads (
  id SERIAL PRIMARY KEY,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES software_versions(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  downloaded_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

-- ================================================================
-- Témoignages clients (section "À propos" du site public)
-- ================================================================
CREATE TABLE IF NOT EXISTS testimonials (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  nom TEXT NOT NULL,
  texte TEXT NOT NULL,
  note INTEGER NOT NULL DEFAULT 5,
  -- en_attente : soumis par le client, pas encore vu par un admin
  -- publie     : visible publiquement sur le site
  -- rejete     : refusé par un admin, jamais affiché publiquement
  statut TEXT NOT NULL DEFAULT 'en_attente',
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR},
  updated_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

-- ================================================================
-- Réinitialisation de mot de passe (espace client)
-- ================================================================
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

-- ================================================================
-- Assistant IA public "okim.box"
-- ================================================================
CREATE TABLE IF NOT EXISTS assistant_conversations (
  id SERIAL PRIMARY KEY,
  -- Identifiant anonyme côté navigateur (pas de compte requis pour discuter) ;
  -- rattaché à un client seulement s'il est connecté au moment du message.
  session_id TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  -- Passé à 1 quand l'IA elle-même juge ne pas pouvoir répondre (voir
  -- server/utils/assistant.js) : un message est alors créé automatiquement
  -- dans la table "messages" et l'admin est notifié comme pour un contact classique.
  needs_human INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR},
  updated_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- 'user' | 'assistant'
  contenu TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_conv ON assistant_messages(conversation_id, created_at);

-- ================================================================
-- Notifications in-app (admin ET client)
-- ================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  audience TEXT NOT NULL, -- 'admin' | 'client'
  -- NULL pour une notification admin (visible par tous les admins) ;
  -- renseigné pour une notification destinée à UN client précis.
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  titre TEXT NOT NULL,
  corps TEXT DEFAULT '',
  lien TEXT DEFAULT '', -- chemin relatif à ouvrir au clic (espace admin ou client)
  lu INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);
CREATE INDEX IF NOT EXISTS idx_notifications_admin ON notifications(audience, lu, created_at) WHERE audience = 'admin';
CREATE INDEX IF NOT EXISTS idx_notifications_client ON notifications(client_id, lu, created_at);
`;

// ---------------------------------------------------------------
// Migrations légères (colonnes ajoutées après coup à des tables déjà
// existantes en production — ne recrée jamais une table, n'efface rien).
// ---------------------------------------------------------------
async function ensureColumn(table, column, addColumnSql) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (rows.length === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${addColumnSql}`);
  }
}
async function runMigrations() {
  // "products" existait déjà avant le module Logiciels : tous les produits
  // déjà en base sont donc explicitement des photos (comportement inchangé).
  await ensureColumn("products", "type", "type TEXT NOT NULL DEFAULT 'photo'");
  // Un article de commande peut désormais référencer la formule (plan)
  // choisie pour un logiciel — NULL pour tout ce qui existait avant.
  await ensureColumn("order_items", "plan_id", "plan_id INTEGER REFERENCES software_plans(id)");

  // Portfolio : une entrée peut désormais être une courte vidéo plutôt
  // qu'une photo. Tout ce qui existe déjà en base reste explicitement 'photo'.
  await ensureColumn("photos", "type", "type TEXT NOT NULL DEFAULT 'photo'");

  // Galerie client : une séance peut désormais contenir des vidéos. Pas de
  // filigrane possible sur une vidéo (pas de traitement vidéo côté serveur) :
  // watermark_path devient nullable — NULL pour une vidéo = "aperçu verrouillé"
  // côté client tant que l'accès HD n'est pas débloqué (voir routes/gallery.js).
  await ensureColumn("session_photos", "type", "type TEXT NOT NULL DEFAULT 'photo'");
  await pool.query(`ALTER TABLE session_photos ALTER COLUMN watermark_path DROP NOT NULL`);

  // CORRECTIF DE DONNÉES : la ligne ci-dessus ajoute "type" avec
  // DEFAULT 'photo' — au moment de cette migration, TOUTES les lignes déjà
  // en base (y compris de vraies vidéos uploadées avant l'existence de cette
  // colonne) ont donc été rétroactivement étiquetées 'photo', quel que soit
  // leur contenu réel. Conséquence concrète : le bouton "Télécharger le ZIP"
  // et le téléchargement individuel se fiaient à cette colonne pour choisir
  // l'extension du fichier (.mp4 vs .jpg) — une vraie vidéo mal étiquetée se
  // retrouvait donc systématiquement renommée ".jpg", illisible une fois
  // téléchargée. On corrige ici les lignes dont la référence Cloudinary dit
  // clairement "video" mais dont la colonne affirme autre chose — la
  // référence est la source de vérité (fixée à l'upload, jamais sujette à
  // une valeur par défaut de colonne).
  await pool.query(`UPDATE session_photos SET type = 'video' WHERE file_path LIKE 'cloudinary:video:%' AND type <> 'video'`);
  await pool.query(`UPDATE session_photos SET type = 'photo' WHERE file_path LIKE 'cloudinary:image:%' AND type <> 'photo'`);

  // Notification "licence bientôt expirée" envoyée une seule fois par licence.
  await ensureColumn("licenses", "expiry_notified", "expiry_notified INTEGER NOT NULL DEFAULT 0");

  // Upload direct signé vers Cloudinary (vidéos lourdes) : l'URL Cloudinary
  // finale est stockée telle quelle, sans jamais transiter par le buffer
  // mémoire d'Express — voir routes/admin/signature.js. NULL = pas de vidéo
  // externe (comportement inchangé pour tout ce qui existe déjà en base).
  await ensureColumn("photos", "video_url", "video_url TEXT");

  // FAILLE CORRIGÉE (rejeu de transaction KKiaPay) : rien ne liait un
  // transaction_id KKiaPay à UNE commande précise. /orders/:id/kkiapay-confirm
  // ne vérifiait que "le montant correspond" — un client pouvait donc payer
  // une commande de 5 000 FCFA une seule fois, puis rejouer ce même
  // transactionId (déjà "success" en base) sur n'importe quelle AUTRE
  // commande de 5 000 FCFA pour la débloquer gratuitement (téléchargements,
  // licences...), sans jamais repayer. L'index UNIQUE ci-dessous empêche
  // qu'un même transactionId soit rattaché à deux commandes différentes —
  // voir routes/kkiapay.js pour la vérification applicative associée.
  await ensureColumn("orders", "kkiapay_transaction_id", "kkiapay_transaction_id TEXT");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_kkiapay_transaction_id
    ON orders(kkiapay_transaction_id) WHERE kkiapay_transaction_id IS NOT NULL
  `);

  // Trace d'acceptation de la licence d'utilisation à l'inscription (preuve
  // de consentement, utile en cas de litige) — NULL pour les comptes créés
  // avant l'ajout de cette exigence.
  await ensureColumn("clients", "licence_acceptee_at", "licence_acceptee_at TEXT");
}

// ---------------------------------------------------------------
// Amorçage (catégories / réglages / secret webhook / rôle owner)
// ---------------------------------------------------------------
async function seedDefaults() {
  const defaultCategories = [
    { nom: "Portraits", slug: "portrait" },
    { nom: "Mode & Studio", slug: "mode" },
    { nom: "Culture", slug: "culture" },
    { nom: "Événement", slug: "evenement" }
  ];
  const catCount = (await db.prepare("SELECT COUNT(*) n FROM categories").get()).n;
  if (catCount === 0) {
    for (const c of defaultCategories) {
      await db.prepare("INSERT INTO categories (nom, slug, description) VALUES (?,?,?)").run(c.nom, c.slug, "");
    }
  }

  const defaultSettings = {
    site_nom: "OKIM ART",
    slogan: "Une image, une histoire.",
    bio: "OKIM ART accompagne particuliers, familles, entreprises et couples à Porto-Novo et dans toute la région, du premier cadrage jusqu'à la livraison finale.",
    photographe_nom: "Marcellino Kouati",
    ville: "Porto-Novo, Bénin",
    telephone_1: "01 98 87 43 00",
    telephone_2: "01 53 43 12 51",
    whatsapp: "229198874300",
    whatsapp_message: "Bonjour, je souhaite prendre rendez-vous avec OKIM ART.",
    email: "contact@okimart.studio",
    instagram: "https://instagram.com/",
    facebook: "https://facebook.com/",
    seo_title: "OKIM ART — Une image, une histoire",
    seo_description: "OKIM ART — studio de photographie et vidéo de Marcellino Kouati à Porto-Novo, Bénin.",
    photographe_photo: "",
    site_url: "",
    logo: "img/brand/logo.png",
    kkiapay_enabled: "0",
    kkiapay_public_key: "",
    kkiapay_sandbox: "1",
    dashboard_reset_at: "",
    gallery_retention_days: "30",
    gallery_recovery_price: "2000",
    gallery_hd_access_hours: "48",
    assistant_enabled: "0",
    assistant_name: "okim.box",
    assistant_intro: "Bonjour, je suis okim.box 👋 Posez-moi vos questions sur nos prestations, la boutique ou vos rendez-vous."
  };
  for (const [k, v] of Object.entries(defaultSettings)) {
    await db.prepare("INSERT INTO settings (cle, valeur) VALUES (?,?) ON CONFLICT (cle) DO NOTHING").run(k, v);
  }

  const existingSecret = await db.prepare("SELECT valeur FROM secure_settings WHERE cle = 'kkiapay_webhook_secret'").get();
  if (!existingSecret) {
    await db.prepare("INSERT INTO secure_settings (cle, valeur) VALUES ('kkiapay_webhook_secret', ?)").run(nanoid(32));
  }
}

/** À appeler une fois au démarrage, avant d'accepter des requêtes HTTP. */
async function initDb() {
  await pool.query(SCHEMA_SQL);
  await runMigrations();
  await seedDefaults();
}

async function getSecureSetting(cle) {
  const row = await db.prepare("SELECT valeur FROM secure_settings WHERE cle = ?").get(cle);
  return row ? row.valeur : "";
}
async function setSecureSetting(cle, valeur) {
  await db.prepare("INSERT INTO secure_settings (cle, valeur) VALUES (?,?) ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur").run(cle, valeur);
}

// ---- Compte administrateur ----
// Si aucun admin n'existe, on en crée un avec un mot de passe généré,
// affiché UNE SEULE FOIS dans la console au démarrage (voir server.js).
async function ensureFirstAdmin() {
  // Migration de compatibilité : si une base existante a déjà un ou
  // plusieurs comptes admin mais aucun "owner", on promeut automatiquement
  // le tout premier compte créé.
  const hasOwner = (await db.prepare("SELECT COUNT(*) n FROM admins WHERE role = 'owner'").get()).n > 0;
  if (!hasOwner) {
    const oldest = await db.prepare("SELECT id FROM admins ORDER BY id ASC LIMIT 1").get();
    if (oldest) await db.prepare("UPDATE admins SET role = 'owner' WHERE id = ?").run(oldest.id);
  }

  const count = (await db.prepare("SELECT COUNT(*) n FROM admins").get()).n;
  if (count > 0) return null;
  const email = process.env.FIRST_ADMIN_EMAIL || "admin@okimart.studio";
  const rawPassword = process.env.FIRST_ADMIN_PASSWORD || nanoid(12);
  const hash = bcrypt.hashSync(rawPassword, 12);
  await db.prepare("INSERT INTO admins (nom, email, password_hash, role) VALUES (?,?,?,?)")
    .run("Marcellino Kouati", email, hash, "owner");
  return { email, rawPassword };
}

module.exports = { db, pool, initDb, ensureFirstAdmin, transaction, getSecureSetting, setSecureSetting };