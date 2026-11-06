// ============================================================
// db.js — connexion PostgreSQL + schéma complet + amorçage initial
// ============================================================
const { Pool, types } = require("pg");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");

// Convertit les BIGINT PostgreSQL (OID 20) en Number JavaScript
types.setTypeParser(20, (val) => {
  if (val === null) return null;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? val : parsed;
});

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL manquant. Définissez-le dans .env (local) ou dans les variables " +
    "d'environnement de votre hébergeur (Render, etc.) — voir .env.example."
  );
}

// Configuration SSL adaptée aux environnements managés (Render, Supabase, Neon...)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
  // Render Free = 512 Mo de RAM et un pooleur Supabase (mode session) dont le
  // nombre de connexions est limité : 10 suffit largement pour une instance.
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000, // 1re connexion TLS après un réveil : 5 s était juste
  keepAlive: true,
  // Aucune requête ne doit pouvoir bloquer indéfiniment une instance gratuite.
  statement_timeout: 20000,
  query_timeout: 25000,
  application_name: "okim-art"
});

pool.on("error", (err) => {
  console.error("[db] Erreur inattendue sur le pool PostgreSQL :", err.message);
});

// ---------------------------------------------------------------
// Émulation de l'API "prepare().get/all/run()" par-dessus `pg`
// ---------------------------------------------------------------
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const NO_ID_TABLES = new Set(["settings", "secure_settings", "idempotency_keys"]);

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
        return { changes: rowCount, lastInsertRowid: rows && rows[0] ? rows[0].id : undefined };
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
 * Exécute une série d'opérations dans une transaction SQL
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
// Schéma PostgreSQL
// ---------------------------------------------------------------
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

CREATE TABLE IF NOT EXISTS software_products (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  slogan TEXT DEFAULT '',
  description_longue TEXT DEFAULT '',
  probleme_resolu TEXT DEFAULT '',
  public_cible TEXT DEFAULT '',
  plateforme TEXT DEFAULT '',
  systeme_compatible TEXT DEFAULT '',
  version_actuelle TEXT DEFAULT '',
  taille TEXT DEFAULT '',
  configuration_min TEXT DEFAULT '',
  licence_type TEXT DEFAULT '',
  demo_url TEXT DEFAULT '',
  video_url TEXT DEFAULT '',
  captures TEXT NOT NULL DEFAULT '[]',
  badge TEXT DEFAULT '',
  popularite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS software_plans (
  id SERIAL PRIMARY KEY,
  software_id INTEGER NOT NULL REFERENCES software_products(id) ON DELETE CASCADE,
  nom TEXT NOT NULL,
  description TEXT DEFAULT '',
  prix INTEGER NOT NULL,
  periodicite TEXT NOT NULL DEFAULT 'unique',
  fonctionnalites TEXT NOT NULL DEFAULT '[]',
  max_devices INTEGER NOT NULL DEFAULT 1,
  max_users INTEGER NOT NULL DEFAULT 1,
  statut TEXT NOT NULL DEFAULT 'actif',
  ordre INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS software_versions (
  id SERIAL PRIMARY KEY,
  software_id INTEGER NOT NULL REFERENCES software_products(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  notes TEXT DEFAULT '',
  fichier TEXT NOT NULL,
  taille_octets INTEGER,
  compatibilite TEXT DEFAULT '',
  type_maj TEXT NOT NULL DEFAULT 'mineure',
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
  status TEXT NOT NULL DEFAULT 'active',
  max_devices INTEGER NOT NULL DEFAULT 1,
  max_users INTEGER NOT NULL DEFAULT 1,
  activated_at TEXT NOT NULL DEFAULT ${NOW_EXPR},
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS software_downloads (
  id SERIAL PRIMARY KEY,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES software_versions(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  downloaded_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS testimonials (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  nom TEXT NOT NULL,
  texte TEXT NOT NULL,
  note INTEGER NOT NULL DEFAULT 5,
  statut TEXT NOT NULL DEFAULT 'en_attente',
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR},
  updated_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  needs_human INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR},
  updated_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  contenu TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_conv ON assistant_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  audience TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  titre TEXT NOT NULL,
  corps TEXT DEFAULT '',
  lien TEXT DEFAULT '',
  lu INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);
CREATE INDEX IF NOT EXISTS idx_notifications_admin ON notifications(audience, lu, created_at) WHERE audience = 'admin';
CREATE INDEX IF NOT EXISTS idx_notifications_client ON notifications(client_id, lu, created_at);

-- Clés d'idempotence (commandes, messages, inscriptions) : évite les doublons
-- lors d'un renvoi (timeout, réveil du serveur, file hors-ligne). Table purement additive.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'in_progress',
  status_code INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW_EXPR}
);
`;

// Index ajoutés pour les requêtes fréquentes (aucune donnée modifiée).
// Exécutés APRÈS les migrations, car certains portent sur des colonnes ajoutées par elles.
const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_photos_public ON photos(statut, ordre, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_category ON photos(category_id);
CREATE INDEX IF NOT EXISTS idx_products_list ON products(statut, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_services_list ON services(statut, ordre);
CREATE INDEX IF NOT EXISTS idx_formations_list ON formations(statut, ordre);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_statut_created ON orders(statut, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_download_tokens_order ON download_tokens(order_id);
CREATE INDEX IF NOT EXISTS idx_session_photos_session ON session_photos(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_photo_status ON sessions_photo(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_photo_client ON sessions_photo(client_id);
CREATE INDEX IF NOT EXISTS idx_software_plans_sw ON software_plans(software_id, statut);
CREATE INDEX IF NOT EXISTS idx_software_versions_sw ON software_versions(software_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_licenses_client ON licenses(client_id);
CREATE INDEX IF NOT EXISTS idx_licenses_order ON licenses(order_id);
CREATE INDEX IF NOT EXISTS idx_licenses_status_exp ON licenses(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_testimonials_public ON testimonials(statut, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trash_purge ON trash(purge_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
`;

// Version du schéma/amorçage : tant qu'elle est inchangée en base, le démarrage
// SAUTE le schéma, les migrations et l'amorçage (≈ 60 requêtes vers Supabase
// à chaque réveil de Render). Incrémentez-la quand vous ajoutez une migration
// ou un réglage par défaut dans ce fichier.
const SCHEMA_VERSION = "2026-11-perf-1";

// ---------------------------------------------------------------
// Migrations sécurisées
// ---------------------------------------------------------------
async function ensureColumn(table, column, typeDef) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table.toLowerCase(), column.toLowerCase()]
  );
  if (rows.length === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
  }
}

async function runMigrations() {
  await ensureColumn("products", "type", "TEXT NOT NULL DEFAULT 'photo'");
  await ensureColumn("order_items", "plan_id", "INTEGER REFERENCES software_plans(id)");
  await ensureColumn("photos", "type", "TEXT NOT NULL DEFAULT 'photo'");
  await ensureColumn("session_photos", "type", "TEXT NOT NULL DEFAULT 'photo'");
  
  await pool.query(`ALTER TABLE session_photos ALTER COLUMN watermark_path DROP NOT NULL`);

  await pool.query(`UPDATE session_photos SET type = 'video' WHERE file_path LIKE 'cloudinary:video:%' AND type <> 'video'`);
  await pool.query(`UPDATE session_photos SET type = 'photo' WHERE file_path LIKE 'cloudinary:image:%' AND type <> 'photo'`);

  await ensureColumn("licenses", "expiry_notified", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("photos", "video_url", "TEXT");

  await ensureColumn("orders", "kkiapay_transaction_id", "TEXT");
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_kkiapay_transaction_id
    ON orders(kkiapay_transaction_id) WHERE kkiapay_transaction_id IS NOT NULL
  `);

  await ensureColumn("clients", "licence_acceptee_at", "TEXT");
  await ensureColumn("sessions_photo", "client_id", "INTEGER REFERENCES clients(id) ON DELETE SET NULL");
}

// ---------------------------------------------------------------
// Amorçage des données par défaut
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

async function initDb() {
  // Démarrage rapide : si le schéma est déjà à jour, on ne refait rien.
  try {
    const { rows } = await pool.query("SELECT to_regclass('public.secure_settings') AS t");
    if (rows[0] && rows[0].t) {
      const v = await pool.query("SELECT valeur FROM secure_settings WHERE cle = 'schema_version'");
      if (v.rows[0] && v.rows[0].valeur === SCHEMA_VERSION) return { skipped: true };
    }
  } catch (e) {
    console.warn("[db] vérification de version impossible, initialisation complète :", e.message);
  }
  await pool.query(SCHEMA_SQL);
  await runMigrations();
  await pool.query(INDEX_SQL);
  await seedDefaults();
  await setSecureSetting("schema_version", SCHEMA_VERSION);
  return { skipped: false };
}

async function getSecureSetting(cle) {
  const row = await db.prepare("SELECT valeur FROM secure_settings WHERE cle = ?").get(cle);
  return row ? row.valeur : "";
}

async function setSecureSetting(cle, valeur) {
  await db.prepare("INSERT INTO secure_settings (cle, valeur) VALUES (?,?) ON CONFLICT (cle) DO UPDATE SET valeur = excluded.valeur").run(cle, valeur);
}

// ---------------------------------------------------------------
// Compte Administrateur Initial
// ---------------------------------------------------------------
async function ensureFirstAdmin() {
  const count = (await db.prepare("SELECT COUNT(*) n FROM admins").get()).n;
  
  if (count > 0) {
    const hasOwner = (await db.prepare("SELECT COUNT(*) n FROM admins WHERE role = 'owner'").get()).n > 0;
    if (!hasOwner) {
      const oldest = await db.prepare("SELECT id FROM admins ORDER BY id ASC LIMIT 1").get();
      if (oldest) await db.prepare("UPDATE admins SET role = 'owner' WHERE id = ?").run(oldest.id);
    }
    return null;
  }

  const email = process.env.FIRST_ADMIN_EMAIL || "admin@okimart.studio";
  const rawPassword = process.env.FIRST_ADMIN_PASSWORD || nanoid(12);
  const hash = bcrypt.hashSync(rawPassword, 12);
  
  await db.prepare("INSERT INTO admins (nom, email, password_hash, role) VALUES (?,?,?,?)")
    .run("Marcellino Kouati", email, hash, "owner");
    
  return { email, rawPassword };
}

module.exports = { db, pool, initDb, ensureFirstAdmin, transaction, getSecureSetting, setSecureSetting };
