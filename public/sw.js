/* ==============================================================
   sw.js — Service Worker OKIM ART
   --------------------------------------------------------------
   - Précache de la coque du site (pages publiques, CSS, JS, logo) :
     la vitrine s'ouvre instantanément, même hors connexion.
   - Pages : "stale-while-revalidate" (affichage immédiat depuis le
     cache, mise à jour en arrière-plan).
   - Images : cache-first avec plafond (aussi pour les images Cloudinary).
   - /api/* : JAMAIS intercepté ni mis en cache ici (sessions, données
     privées). Les données publiques passent par l'instantané + IndexedDB
     (voir js/okim-core.js).
   - Ne met jamais en cache une réponse qui n'est pas une vraie page
     OKIM ART (écran d'attente de l'hébergeur, erreur 5xx...).
   La version est remplacée à chaque build (scripts/build-static.js) :
   un déploiement purge automatiquement les anciens caches.
   ============================================================== */
const VERSION = "dev"; // @OKIM_VERSION
const SHELL = "okim-shell-" + VERSION;
const IMG = "okim-img-v1";            // images : conservées d'une version à l'autre
const IMG_MAX = 160;
const PRECACHE = /*@OKIM_PRECACHE_START*/[
  "/", "/index.html", "/boutique.html", "/logiciels.html", "/logiciel.html", "/panier.html",
  "/compte.html", "/licence.html", "/gallery.html", "/reset-password.html", "/offline.html",
  "/style.css", "/css/shop.css", "/css/software.css", "/css/okimbox.css",
  "/js/okim-core.js", "/js/site-data.js", "/js/cart.js", "/js/software.js", "/js/okimbox.js",
  "/manifest.json", "/img/brand/logo.png", "/img/brand/icons/icon-192.png"
]/*@OKIM_PRECACHE_END*/;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Tolérant : un fichier introuvable ne doit pas empêcher l'installation.
    await Promise.allSettled(PRECACHE.map((u) => cache.add(new Request(u, { cache: "reload" }))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("okim-shell-") && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Background Sync (Chrome) : demande aux pages ouvertes de vider la file d'attente.
self.addEventListener("sync", (event) => {
  if (event.tag === "okim-outbox") {
    event.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => cs.forEach((c) => c.postMessage({ type: "okim-flush-outbox" }))));
  }
});

function isHtml(res) { return /text\/html/i.test(res.headers.get("content-type") || ""); }

/** Vraie page OKIM ART ? (exclut l'écran d'attente Render ou une page d'erreur d'infrastructure) */
async function isGenuinePage(res) {
  if (!res || !res.ok || res.type === "opaque" || !isHtml(res)) return false;
  const text = (await res.clone().text()).slice(0, 200000);
  return text.indexOf("okim-core.js") !== -1 || text.indexOf("OKIM ART — hors connexion") !== -1;
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

function navKey(url) {
  // /gallery/<jeton> -> même coque que /gallery.html (le jeton est lu par le JS de la page)
  if (url.pathname.startsWith("/gallery/")) return "/gallery.html";
  return url.pathname;
}

async function handleNavigation(request, url) {
  const cache = await caches.open(SHELL);
  const key = navKey(url);
  const isAdmin = url.pathname.startsWith("/admin");
  const cached = (await cache.match(key, { ignoreSearch: true })) ||
    (key.endsWith("/") ? await cache.match(key + "index.html") : null) ||
    (!key.endsWith(".html") && key !== "/" ? await cache.match(key + ".html") : null);

  const revalidate = fetch(request).then(async (res) => {
    if (await isGenuinePage(res)) await cache.put(key, res.clone());
    return res;
  });

  // Administration : réseau d'abord (toujours la dernière version), cache en secours.
  if (isAdmin) {
    try { const res = await revalidate; if (await isGenuinePage(res)) return res; if (cached) return cached; return res; }
    catch (e) { return cached || (await cache.match("/offline.html")) || Response.error(); }
  }
  // Pages publiques : affichage immédiat depuis le cache, rafraîchi en arrière-plan.
  if (cached) { revalidate.catch(() => {}); return cached; }
  try {
    const res = await revalidate;
    if (await isGenuinePage(res)) return res;
    return (await cache.match("/offline.html")) || res;
  } catch (e) {
    return (await cache.match("/offline.html")) || Response.error();
  }
}

async function handleStatic(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: true });
  const fetchAndStore = fetch(request).then((res) => {
    if (res && res.ok && res.type === "basic") cache.put(request, res.clone());
    return res;
  });
  if (hit) { fetchAndStore.catch(() => {}); return hit; }
  return fetchAndStore;
}

async function handleImage(request, url) {
  const cache = await caches.open(IMG);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  // Cloudinary : on redemande en mode CORS pour pouvoir mettre la réponse en cache (une réponse "opaque" n'est pas exploitable hors-ligne).
  const req = url.origin === self.location.origin ? request : new Request(request.url, { mode: "cors", credentials: "omit" });
  const res = await fetch(req);
  if (res && res.ok && res.type !== "opaque") {
    cache.put(request.url, res.clone()).then(() => trimCache(IMG, IMG_MAX)).catch(() => {});
  }
  return res;
}

async function handleFont(request) {
  const cache = await caches.open("okim-fonts-v1");
  const hit = await cache.match(request);
  const net = fetch(request).then((res) => { if (res && (res.ok || res.type === "opaque")) cache.put(request, res.clone()); return res; });
  if (hit) { net.catch(() => {}); return hit; }
  return net;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return; // lecture vidéo/streaming : jamais interceptée
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Polices Google : cache avec revalidation
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(handleFont(request)); return;
  }
  // Images Cloudinary publiques (jamais les assets privés/authentifiés : ils passent par l'API signée)
  if (url.hostname === "res.cloudinary.com") {
    if (/\/image\/upload\//.test(url.pathname) && request.destination === "image") event.respondWith(handleImage(request, url));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // L'API et les fichiers privés ne sont JAMAIS interceptés ni mis en cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/") || url.pathname === "/sw.js") return;

  if (request.mode === "navigate") { event.respondWith(handleNavigation(request, url)); return; }
  if (request.destination === "image") { event.respondWith(handleImage(request, url)); return; }
  if (/\.(?:css|js|json|woff2?|ico|webmanifest|txt|xml)$/i.test(url.pathname)) { event.respondWith(handleStatic(request)); }
});
