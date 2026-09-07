// ============================================================
// seed.js — amorce la base avec le contenu réel du site OKIM ART
// (les 12 photos fournies, les services, les formations)
// Usage : node server/seed.js
// Sans danger : si des photos/services/formations existent déjà, ne double pas.
// ============================================================
const fs = require("fs");
const path = require("path");
const { db, initDb } = require("./db");
const { saveOriginal, savePublicVersion } = require("./utils/upload");

const SEED_DIR = path.join(__dirname, "..", "seed-assets", "portfolio");

const PHOTOS = [
  { file: "mode-manteau-noir.jpg", slug: "mode", titre: "Portrait mode en studio", description: "Manteau noir et coiffure tressée dorée.", a_la_une: 1 },
  { file: "culture-enfant-hijab.jpg", slug: "culture", titre: "Portrait culturel", description: "Portrait d'une enfant en hijab avec un panier de fruits." },
  { file: "culture-portrait-spirituel.jpg", slug: "culture", titre: "Portrait spirituel", description: "Chapelet et Coran, portrait de recueillement." },
  { file: "culture-parure-traditionnelle.jpg", slug: "culture", titre: "Parure traditionnelle", description: "Portrait en parure et perles traditionnelles.", a_la_une: 1 },
  { file: "mode-robe-noire.jpg", slug: "mode", titre: "Élégance en studio", description: "Portrait glamour en robe noire et gants en dentelle." },
  { file: "mode-duo-soiree.jpg", slug: "mode", titre: "Duo — soirée élégante", description: "Duo en robes noires assorties, séance de soirée." },
  { file: "evenement-bouquet.jpg", slug: "evenement", titre: "Bouquet & élégance", description: "Portrait en robe noire avec bouquet de fleurs." },
  { file: "evenement-duo-fete.jpg", slug: "evenement", titre: "Tenue de fête", description: "Duo en tenues de fête roses brodées." },
  { file: "evenement-robe-ceremonie.jpg", slug: "evenement", titre: "Robe de cérémonie", description: "Portrait en robe de cérémonie rose brodée." },
  { file: "portrait-duo-urbain.jpg", slug: "portrait", titre: "Duo — style urbain", description: "Duo en style urbain décontracté.", a_la_une: 1 },
  { file: "mode-exterieur-rouge.jpg", slug: "mode", titre: "Séance en extérieur", description: "Séance mode en extérieur, robe rouge." },
  { file: "portrait-beaute.jpg", slug: "portrait", titre: "Portrait beauté", description: "Portrait beauté, serviette blanche." }
];

const SERVICES = [
  { titre: "Studio photo", description: "Portraits en lumière contrôlée, packshots et prises de vue produit.", ordre: 1 },
  { titre: "Portraits & Mode", description: "Séances portrait et mode, en studio ou en décor naturel.", ordre: 2 },
  { titre: "Enfants & Famille", description: "Souvenirs de famille, spontanés ou mis en scène, à tout âge.", ordre: 3 },
  { titre: "Thématiques culturelles", description: "Traditions, cérémonies et patrimoine mis en valeur avec justesse.", ordre: 4 },
  { titre: "Événements & Mariages", description: "Couverture complète : préparatifs, cérémonie, réception, film souvenir.", ordre: 5 },
  { titre: "Formations", description: "Ateliers pratiques photo et vidéo, du débutant au niveau avancé.", ordre: 6 }
];

const FORMATIONS = [
  { titre: "Initiation photo studio", description: "Niveau débutant", programme: "Bases du cadrage, de l'exposition et de la lumière en studio.", ordre: 1 },
  { titre: "Portrait & lumière naturelle", description: "Niveau intermédiaire", programme: "Composer et exposer un portrait en lumière naturelle.", ordre: 2 },
  { titre: "Prise de vue événementielle", description: "Niveau intermédiaire", programme: "Couvrir un événement en autonomie, du repérage à la livraison.", ordre: 3 },
  { titre: "Initiation à la vidéo", description: "Niveau débutant", programme: "Bases du cadrage vidéo, du son et du montage simple.", ordre: 4 },
  { titre: "Montage & post-production", description: "Niveau avancé", programme: "Étalonnage, retouche et livraison finale.", ordre: 5 }
];

async function run() {
  // Assure la connexion, le schéma et l'amorçage des réglages/catégories
  // par défaut avant d'importer le contenu (utile si `npm run seed` est
  // exécuté sur une base toute neuve, sans avoir démarré le serveur avant).
  await initDb();

  const photoCount = (await db.prepare("SELECT COUNT(*) n FROM photos").get()).n;
  if (photoCount === 0) {
    const catBySlug = {};
    (await db.prepare("SELECT * FROM categories").all()).forEach(c => { catBySlug[c.slug] = c.id; });

    for (const p of PHOTOS) {
      const filePath = path.join(SEED_DIR, p.file);
      if (!fs.existsSync(filePath)) { console.log("Ignoré (fichier absent) :", p.file); continue; }
      const buffer = fs.readFileSync(filePath);
      const fichier = await saveOriginal(buffer);
      const miniature = await savePublicVersion(buffer, { watermarkText: "OKIM ART" });
      await db.prepare(`
        INSERT INTO photos (titre, description, fichier, miniature, category_id, statut, a_la_une, watermark)
        VALUES (?,?,?,?,?, 'publie', ?, 1)
      `).run(p.titre, p.description, fichier, miniature, catBySlug[p.slug] || null, p.a_la_une || 0);
      console.log("Photo importée :", p.titre);
    }
  } else {
    console.log("Des photos existent déjà — portfolio non réimporté.");
  }

  const serviceCount = (await db.prepare("SELECT COUNT(*) n FROM services").get()).n;
  if (serviceCount === 0) {
    for (const s of SERVICES) {
      await db.prepare("INSERT INTO services (titre, description, statut, ordre) VALUES (?,?, 'actif', ?)").run(s.titre, s.description, s.ordre);
    }
    console.log("Services importés :", SERVICES.length);
  } else {
    console.log("Des services existent déjà — non réimportés.");
  }

  const formationCount = (await db.prepare("SELECT COUNT(*) n FROM formations").get()).n;
  if (formationCount === 0) {
    for (const f of FORMATIONS) {
      await db.prepare("INSERT INTO formations (titre, description, programme, statut, ordre) VALUES (?,?,?, 'actif', ?)").run(f.titre, f.description, f.programme, f.ordre);
    }
    console.log("Formations importées :", FORMATIONS.length);
  } else {
    console.log("Des formations existent déjà — non réimportées.");
  }

  console.log("\nAmorçage terminé.");
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
