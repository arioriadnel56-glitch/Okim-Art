// ============================================================
// snapshot.js — instantané JSON des données publiques, servi par le CDN
// ============================================================
// Pourquoi : la vitrine doit s'afficher sans réveiller le backend Render.
// Après chaque modification faite dans l'administration, ce module publie
// un fichier JSON PUBLIC (mêmes données que les routes /api/* publiques,
// rien de plus) sur Cloudinary. Le frontend lit ce fichier directement :
// aucun réveil du serveur pour un simple visiteur.
//
// - Publication "debounced" (regroupe plusieurs modifications rapprochées).
// - Jamais bloquant : une erreur de publication est journalisée, c'est tout.
// - Aucune donnée privée : voir publicData.js (colonnes explicites).
const data = require("./publicData");
const { getSecureSetting, setSecureSetting } = require("../db");

const PUBLIC_ID = "okimart/snapshot/public-snapshot.json";
const DEBOUNCE_MS = 4000;
let timer = null;
let publishing = false;
let again = false;

function snapshotUrl() {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  return cloud ? `https://res.cloudinary.com/${cloud}/raw/upload/${PUBLIC_ID}` : "";
}

async function buildSnapshot() {
  const [settings, categories, photos, services, formations, products, software, testimonials] = await Promise.all([
    data.getSettings(), data.getCategories(), data.getPhotos({}), data.getServices(),
    data.getFormations(), data.getProducts(), data.getSoftwareList({}), data.getTestimonials()
  ]);
  const assistant = await data.getAssistantConfig();
  const software_detail = {};
  for (const s of software) {
    const d = await data.getSoftwareDetail(s.id);
    if (d) software_detail[s.id] = d;
  }
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    settings, categories, photos, services, formations, products, software, software_detail, testimonials, assistant
  };
}

async function publishNow() {
  if (publishing) { again = true; return; }
  publishing = true;
  try {
    const { cloudinary } = require("./cloudinary"); // chargé à la demande
    const snap = await buildSnapshot();
    const buffer = Buffer.from(JSON.stringify(snap), "utf8");
    await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "raw", type: "upload", public_id: PUBLIC_ID, overwrite: true, invalidate: true },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(buffer);
    });
    await setSecureSetting("snapshot_published_at", snap.generated_at);
    console.log(`[snapshot] publié (${buffer.length} octets) → ${snapshotUrl()}`);
  } catch (e) {
    console.error("[snapshot] publication impossible (non bloquant) :", e.message);
  } finally {
    publishing = false;
    if (again) { again = false; scheduleSnapshot(); }
  }
}

function scheduleSnapshot() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; publishNow(); }, DEBOUNCE_MS);
  if (timer.unref) timer.unref();
}

/** Au démarrage : ne publie que si aucun instantané n'a jamais été publié. */
async function ensureSnapshotOnce() {
  try {
    const done = await getSecureSetting("snapshot_published_at");
    if (!done) await publishNow();
  } catch (e) {
    console.error("[snapshot] vérification initiale impossible :", e.message);
  }
}

module.exports = { buildSnapshot, scheduleSnapshot, publishNow, ensureSnapshotOnce, snapshotUrl };
