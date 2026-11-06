/* ==============================================================
   okim-core.js — couche "réseau intelligent" du frontend OKIM ART
   --------------------------------------------------------------
   À charger en PREMIER dans <head> (script classique, sans defer) :
   il enveloppe fetch/XMLHttpRequest AVANT que le code des pages ne
   s'exécute, ce qui évite de réécrire les pages existantes.

   Ce qu'il fait :
   1. Réveil à la demande du backend Render (jamais de ping périodique) :
      une seule procédure de réveil partagée, tentatives progressives et
      limitées, animation aux couleurs d'OKIM ART, reprise automatique de
      l'action en attente — le visiteur ne voit jamais l'écran Render.
   2. Données publiques (vitrine, catalogue) servies depuis un instantané
      CDN + cache local : aucun réveil du backend pour un simple visiteur.
   3. File d'attente persistante (IndexedDB) pour les formulaires et les
      confirmations de paiement, avec états : en attente / synchronisation /
      synchronisé / erreur. Aucun succès n'est affiché sans réponse serveur.
   4. Enregistrement du Service Worker, bandeau hors-connexion, scripts
      tiers chargés après le contenu principal.
   ============================================================== */
(function () {
  "use strict";
  if (window.OkimApi) return;

  /* ---------------- Configuration ---------------- */
  var CFG = Object.assign({
    snapshotUrl: "",          // URL CDN de l'instantané public (injectée au build — voir scripts/build-static.js)
    healthPath: "/api/health",
    wakeDelays: [1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 10000, 10000, 10000], // ≈ 70 s au total, puis abandon
    probeTimeout: 10000,
    awakeTtl: 10 * 60 * 1000, // Render s'endort après ~15 min d'inactivité : on considère "éveillé" 10 min après le dernier succès
    getTimeout: 30000,
    writeTimeout: 60000,
    uploadTimeout: 300000,
    snapshotMaxAge: 2 * 60 * 1000,
    maxOutboxAttempts: 8
  }, window.OKIM_CONFIG || {}, /*@OKIM_CONFIG_START*/{}/*@OKIM_CONFIG_END*/);

  var origFetch = window.fetch.bind(window);
  var IS_ADMIN = location.pathname.indexOf("/admin") === 0;

  /* ---------------- Utilitaires ---------------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function isOffline() { return navigator.onLine === false; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function uid() {
    var a = new Uint8Array(24);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function jsonResponse(status, data, source) {
    return new Response(JSON.stringify(data), { status: status, headers: { "Content-Type": "application/json; charset=utf-8", "X-Okim-Source": source || "local" } });
  }
  function emit(name, detail) { try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) { /* ancien navigateur */ } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }

  function OkimError(message, code, extra) {
    var e = new Error(message);
    e.name = "OkimError"; e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  /* ---------------- Interface (CSS injecté, aux couleurs OKIM ART) ---------------- */
  var css = [
    "#okim-wake{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;padding:1.2rem;background:rgba(20,26,48,.92);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);font-family:'Work Sans',system-ui,sans-serif;color:#f5f1e6}",
    "#okim-wake.show{display:flex;animation:okw-in .35s ease both}",
    "@keyframes okw-in{from{opacity:0}to{opacity:1}}",
    "#okim-wake .okw-card{width:min(92vw,420px);text-align:center}",
    "#okim-wake .okw-logo{width:84px;height:auto;display:block;margin:0 auto 1.4rem;filter:drop-shadow(0 6px 18px rgba(0,0,0,.35))}",
    "#okim-wake .okw-ring{width:64px;height:64px;margin:0 auto 1.5rem;border-radius:50%;border:2px solid rgba(217,189,139,.25);border-top-color:#d9bd8b;animation:okw-spin 1.1s cubic-bezier(.5,.1,.5,.9) infinite;position:relative}",
    "#okim-wake .okw-ring::after{content:'';position:absolute;inset:14px;border-radius:50%;border:2px solid rgba(177,141,84,.35);border-bottom-color:#b18d54;animation:okw-spin 1.7s linear infinite reverse}",
    "@keyframes okw-spin{to{transform:rotate(360deg)}}",
    "#okim-wake h2{font-family:'Fraunces',Georgia,serif;font-weight:500;font-size:1.45rem;margin:0 0 .6rem;color:#fffdf8}",
    "#okim-wake p{margin:0 auto;max-width:34ch;font-size:.95rem;line-height:1.55;color:#d9cfb6}",
    "#okim-wake .okw-bar{height:3px;border-radius:3px;background:rgba(255,255,255,.12);margin:1.5rem auto 0;width:180px;overflow:hidden}",
    "#okim-wake .okw-bar i{display:block;height:100%;width:40%;background:linear-gradient(90deg,#b18d54,#d9bd8b);border-radius:3px;animation:okw-bar 1.6s ease-in-out infinite}",
    "@keyframes okw-bar{0%{transform:translateX(-110%)}100%{transform:translateX(280%)}}",
    "#okim-wake .okw-actions{display:none;gap:.7rem;justify-content:center;margin-top:1.5rem;flex-wrap:wrap}",
    "#okim-wake.failed .okw-actions{display:flex}",
    "#okim-wake.failed .okw-ring,#okim-wake.failed .okw-bar{display:none}",
    "#okim-wake .okw-btn{font:inherit;font-weight:500;cursor:pointer;border-radius:999px;padding:.7rem 1.4rem;border:1px solid #b18d54;background:#b18d54;color:#141a30}",
    "#okim-wake .okw-btn.ghost{background:transparent;color:#f5f1e6;border-color:rgba(245,241,230,.4)}",
    ".okim-toast{position:fixed;left:50%;bottom:1.2rem;transform:translateX(-50%);z-index:2147482900;display:none;align-items:center;gap:.7rem;background:#141a30;color:#f5f1e6;border:1px solid rgba(217,189,139,.4);padding:.6rem 1.1rem;border-radius:999px;font:500 .85rem 'Work Sans',system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25)}",
    ".okim-toast.show{display:flex}",
    ".okim-toast .okw-dot{width:14px;height:14px;border-radius:50%;border:2px solid rgba(217,189,139,.3);border-top-color:#d9bd8b;animation:okw-spin 1s linear infinite}",
    "#okim-offline{position:fixed;top:0;left:0;right:0;z-index:2147482800;display:none;background:#3c4a7a;color:#f5f1e6;text-align:center;font:500 .8rem 'Work Sans',system-ui,sans-serif;padding:.4rem .8rem}",
    "#okim-offline.show{display:block}",
    "#okim-sync{position:fixed;left:1rem;bottom:1rem;z-index:2147482950;display:none;max-width:min(92vw,360px);background:#fffdf8;color:#1c1a17;border:1px solid #d9cfb6;border-left:4px solid #b18d54;border-radius:12px;padding:.65rem .9rem;font:400 .85rem/1.4 'Work Sans',system-ui,sans-serif;box-shadow:0 10px 30px rgba(20,26,48,.18)}",
    "#okim-sync.show{display:block}",
    "#okim-sync.error{border-left-color:#b3261e}",
    "#okim-sync.ok{border-left-color:#2e7d4f}",
    "#okim-sync button{font:inherit;font-weight:500;margin:.45rem .5rem 0 0;border:1px solid #b18d54;background:transparent;color:#141a30;border-radius:999px;padding:.25rem .8rem;cursor:pointer}",
    ".okim-notice{margin:.8rem 0 0;padding:.7rem .9rem;border-radius:10px;background:#ece5d3;border-left:4px solid #b18d54;font-size:.9rem;color:#1c1a17}",
    /* Squelettes de chargement */
    ".okim-skel{position:relative;overflow:hidden;background:#ece5d3;border-radius:12px;min-height:1em}",
    ".okim-skel::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:okim-shimmer 1.4s infinite}",
    "@keyframes okim-shimmer{100%{transform:translateX(100%)}}",
    ".okim-skel-card{border:1px solid #d9cfb6;border-radius:18px;overflow:hidden;background:#fffdf8}",
    ".okim-skel-card .t{aspect-ratio:4/3;border-radius:0}",
    ".okim-skel-card .l{height:14px;margin:.9rem 1rem 0}",
    ".okim-skel-card .l.s{width:55%;margin-bottom:1rem}",
    "@media (prefers-reduced-motion:reduce){.okim-skel::after,#okim-wake .okw-ring,#okim-wake .okw-ring::after,#okim-wake .okw-bar i{animation-duration:3s}}"
  ].join("\n");
  var styleEl = document.createElement("style");
  styleEl.setAttribute("data-okim", "core");
  styleEl.textContent = css;
  (document.head || document.documentElement).appendChild(styleEl);

  function onReady(fn) {
    if (document.body) fn(); else document.addEventListener("DOMContentLoaded", fn, { once: true });
  }

  /* ---------------- Écran d'attente OKIM ART (réveil du serveur) ---------------- */
  var wakeEl = null, wakeRetryCb = null, wakeCloseCb = null;
  function ensureWakeEl() {
    if (wakeEl) return wakeEl;
    wakeEl = document.createElement("div");
    wakeEl.id = "okim-wake";
    wakeEl.setAttribute("role", "status");
    wakeEl.setAttribute("aria-live", "polite");
    wakeEl.innerHTML =
      '<div class="okw-card">' +
      '<img class="okw-logo" src="/img/brand/logo.png" alt="OKIM ART" width="84" height="73">' +
      '<div class="okw-ring" aria-hidden="true"></div>' +
      '<h2 class="okw-title">Un instant…</h2>' +
      '<p class="okw-msg"></p>' +
      '<div class="okw-bar" aria-hidden="true"><i></i></div>' +
      '<div class="okw-actions"><button type="button" class="okw-btn okw-retry">Réessayer</button>' +
      '<button type="button" class="okw-btn ghost okw-close">Fermer</button></div>' +
      '</div>';
    document.body.appendChild(wakeEl);
    wakeEl.querySelector(".okw-retry").addEventListener("click", function () { if (wakeRetryCb) wakeRetryCb(); });
    wakeEl.querySelector(".okw-close").addEventListener("click", function () { if (wakeCloseCb) wakeCloseCb(); });
    return wakeEl;
  }
  function setWakeText(title, msg) {
    var el = ensureWakeEl();
    el.querySelector(".okw-title").textContent = title;
    el.querySelector(".okw-msg").textContent = msg;
  }
  function showWake() { onReady(function () { ensureWakeEl(); wakeEl.classList.remove("failed"); wakeEl.classList.add("show"); }); }
  function hideWake() { if (wakeEl) wakeEl.classList.remove("show", "failed"); }

  /* Petit témoin non bloquant (chargements silencieux) */
  var toastEl = null;
  function toast(show, text) {
    onReady(function () {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.className = "okim-toast";
        toastEl.setAttribute("role", "status");
        toastEl.innerHTML = '<span class="okw-dot"></span><span class="okim-toast-text"></span>';
        document.body.appendChild(toastEl);
      }
      if (text) toastEl.querySelector(".okim-toast-text").textContent = text;
      toastEl.classList.toggle("show", !!show);
    });
  }

  /* ---------------- Réveil à la demande ---------------- */
  var Wake = {
    inflight: null,   // promesse partagée : un seul réveil à la fois, quel que soit le nombre de requêtes en attente
    waiters: 0,       // nombre de requêtes "overlay" qui attendent
    lastOk: parseInt(ssGet("okim_awake_at") || "0", 10) || 0,
    fresh: function () { return Date.now() - Wake.lastOk < CFG.awakeTtl; },
    markAwake: function () { Wake.lastOk = Date.now(); ssSet("okim_awake_at", String(Wake.lastOk)); },
    markAsleep: function () { Wake.lastOk = 0; ssSet("okim_awake_at", "0"); }
  };

  /** Un seul essai de sonde. Vrai uniquement si le serveur répond en JSON, base de données prête. */
  function probe() {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, CFG.probeTimeout);
    return origFetch(CFG.healthPath + "?t=" + Date.now(), { cache: "no-store", credentials: "omit", signal: ctl.signal })
      .then(function (res) {
        if (!res.ok || !/json/i.test(res.headers.get("content-type") || "")) return false;
        return res.json().then(function (j) { return !!(j && j.ok && j.ready !== false); });
      })
      .catch(function () { return false; })
      .then(function (ok) { clearTimeout(t); return ok; });
  }

  /** Procédure de réveil : tentatives progressives et limitées. Résout true/false (jamais ne rejette). */
  function runWake(onProgress) {
    if (Wake.inflight) return Wake.inflight;
    var started = Date.now();
    Wake.inflight = (async function () {
      for (var i = 0; i <= CFG.wakeDelays.length; i++) {
        if (isOffline()) return false;
        if (await probe()) { Wake.markAwake(); emit("okim:awake", { ms: Date.now() - started, attempts: i + 1 }); return true; }
        if (i === CFG.wakeDelays.length) break;
        if (onProgress) onProgress(Date.now() - started, i + 1);
        await sleep(CFG.wakeDelays[i]);
      }
      return false;
    })();
    var clear = function () { Wake.inflight = null; };
    Wake.inflight.then(clear, clear);
    return Wake.inflight;
  }

  function wakeMessage(elapsed) {
    if (elapsed < 8000) return ["Connexion à OKIM ART…", "Nous préparons votre espace. Cela ne prend que quelques instants."];
    if (elapsed < 25000) return ["Préparation de votre espace…", "Merci de votre patience. Votre action reprendra automatiquement, sans rien refaire."];
    return ["Presque prêt…", "Le démarrage prend un peu plus de temps que d'habitude. Ne fermez pas cette page, nous continuons."];
  }

  /**
   * Garantit que le backend répond avant d'envoyer une requête.
   * overlay=true : animation plein écran (action demandée par l'utilisateur) ;
   * overlay=false : témoin discret non bloquant (chargement de données).
   * Résout true si éveillé, false si l'utilisateur ferme l'écran d'indisponibilité.
   */
  async function ensureAwake(overlay) {
    if (Wake.fresh()) return true;
    if (isOffline()) return false;
    Wake.waiters++;
    var uiTimer = null, shown = false;
    var onProgress = function (elapsed) {
      var m = wakeMessage(elapsed);
      if (overlay) setWakeText(m[0], m[1]); else toast(true, "Connexion au serveur…");
    };
    try {
      // On n'affiche l'animation qu'après 500 ms : un serveur déjà éveillé ne provoque aucun flash.
      uiTimer = setTimeout(function () {
        shown = true;
        if (overlay) { var m = wakeMessage(0); setWakeText(m[0], m[1]); showWake(); } else toast(true, "Connexion au serveur…");
      }, 500);
      while (true) {
        var ok = await runWake(onProgress);
        if (ok) return true;
        if (!overlay) return false;             // silencieux : l'appelant décide (cache, message...)
        if (isOffline()) return false;
        // Échec après plusieurs tentatives : message d'indisponibilité avec possibilité de réessayer.
        clearTimeout(uiTimer); shown = true;
        setWakeText("Service momentanément indisponible", "Nous n'avons pas pu joindre OKIM ART pour le moment. Vos informations sont conservées : vous pouvez réessayer.");
        showWake();
        wakeEl.classList.add("failed");
        var decision = await new Promise(function (resolve) {
          wakeRetryCb = function () { resolve("retry"); };
          wakeCloseCb = function () { resolve("close"); };
        });
        wakeRetryCb = wakeCloseCb = null;
        if (decision === "close") return false;
        wakeEl.classList.remove("failed");
        var m0 = wakeMessage(0); setWakeText(m0[0], m0[1]);
      }
    } finally {
      clearTimeout(uiTimer);
      Wake.waiters--;
      if (Wake.waiters <= 0) { Wake.waiters = 0; hideWake(); toast(false); }
    }
  }

  /* ---------------- Requête "intelligente" ---------------- */
  function looksAsleep(res) {
    if (res.status === 502 || res.status === 503 || res.status === 504) return true;
    var ct = res.headers.get("content-type") || "";
    return /text\/html/i.test(ct); // une route API ne renvoie jamais de HTML : c'est l'écran d'attente de l'hébergeur
  }
  function hasIdemKey(headers) {
    if (!headers) return false;
    if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.has("Idempotency-Key");
    return Object.keys(headers).some(function (k) { return k.toLowerCase() === "idempotency-key"; });
  }
  function timedFetch(url, init, timeout) {
    var ctl = new AbortController();
    var userSignal = init.signal;
    if (userSignal) {
      if (userSignal.aborted) ctl.abort(); else userSignal.addEventListener("abort", function () { ctl.abort(); }, { once: true });
    }
    var t = setTimeout(function () { ctl.abort(); }, timeout);
    // Le délai ne couvre que l'attente des en-têtes : un long téléchargement/streaming n'est jamais coupé.
    return origFetch(url, Object.assign({}, init, { signal: ctl.signal })).then(
      function (r) { clearTimeout(t); return r; },
      function (e) { clearTimeout(t); throw e; }
    );
  }

  async function smartRequest(url, init, mode) {
    init = init || {};
    var method = String(init.method || "GET").toUpperCase();
    var overlay = mode === "overlay";
    var safeToRetry = method === "GET" || method === "HEAD" || hasIdemKey(init.headers);
    var isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
    var timeout = method === "GET" || method === "HEAD" ? CFG.getTimeout : (isForm ? CFG.uploadTimeout : CFG.writeTimeout);
    var attempts = 0;

    while (true) {
      if (isOffline()) throw OkimError("Vous êtes hors connexion.", "offline");
      if (!Wake.fresh()) {
        var awake = await ensureAwake(overlay);
        if (!awake) throw OkimError(isOffline() ? "Vous êtes hors connexion." : "Le service est momentanément indisponible.", isOffline() ? "offline" : "unavailable");
      }
      var res;
      try {
        res = await timedFetch(url, init, timeout);
      } catch (e) {
        if (init.signal && init.signal.aborted) throw e;
        Wake.markAsleep();
        // La requête a peut-être atteint le serveur : sans clé d'idempotence on ne la rejoue JAMAIS.
        if (!safeToRetry) throw OkimError("Connexion interrompue pendant l'envoi. Vérifiez avant de renvoyer : l'opération a peut-être été enregistrée.", "maybe-processed", { cause: e });
        if (++attempts > 2) throw OkimError("Le service est momentanément indisponible.", "unavailable", { cause: e });
        continue;
      }
      if (looksAsleep(res)) {
        var notProcessed = res.status !== 504; // 502/503/HTML = refus avant traitement ; 504 = ambigu
        Wake.markAsleep();
        if (!(safeToRetry || notProcessed)) {
          return jsonResponse(504, { error: "Connexion interrompue pendant l'envoi. Vérifiez avant de renvoyer : l'opération a peut-être été enregistrée.", maybe_processed: true }, "okim");
        }
        if (++attempts > 2) return jsonResponse(503, { error: "Le service est momentanément indisponible. Réessayez dans un instant." }, "okim");
        continue;
      }
      Wake.markAwake();
      return res;
    }
  }

  /* ---------------- IndexedDB (cache de données + file d'attente) ---------------- */
  var DB = (function () {
    var dbp = null, mem = { kv: {}, outbox: {} }, broken = false;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!window.indexedDB) return reject(new Error("no-idb"));
        var req = indexedDB.open("okimart", 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
          if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error("blocked")); };
      });
      dbp.catch(function () { broken = true; });
      return dbp;
    }
    function tx(store, mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(store, mode), s = t.objectStore(store), out = fn(s);
          t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
          t.onerror = t.onabort = function () { reject(t.error); };
        });
      });
    }
    function wrap(store, op, key, val) {
      return open().then(function () {
        if (op === "get") return tx(store, "readonly", function (s) { return s.get(key); });
        if (op === "all") return tx(store, "readonly", function (s) { return s.getAll(); });
        if (op === "put") return tx(store, "readwrite", function (s) { return s.put(val); });
        if (op === "del") return tx(store, "readwrite", function (s) { return s["delete"](key); });
      }).catch(function () {
        // IndexedDB indisponible (navigation privée...) : repli mémoire, valable le temps de la page.
        var m = mem[store];
        if (op === "get") return m[key];
        if (op === "all") return Object.keys(m).map(function (k) { return m[k]; });
        if (op === "put") { m[store === "kv" ? val.k : val.id] = val; return; }
        if (op === "del") { delete m[key]; }
      });
    }
    return {
      get: function (k) { return wrap("kv", "get", k).then(function (r) { return r ? r.v : undefined; }); },
      set: function (k, v) { return wrap("kv", "put", null, { k: k, v: v }); },
      del: function (k) { return wrap("kv", "del", k); },
      outAll: function () { return wrap("outbox", "all"); },
      outPut: function (item) { return wrap("outbox", "put", null, item); },
      outDel: function (id) { return wrap("outbox", "del", id); },
      isBroken: function () { return broken; }
    };
  })();

  /* ---------------- Données publiques : instantané CDN → cache → API ---------------- */
  var Snapshot = (function () {
    var mem = null, memAt = 0, inflight = null;
    function load() {
      if (!CFG.snapshotUrl) return Promise.resolve(null);
      if (mem && Date.now() - memAt < CFG.snapshotMaxAge) return Promise.resolve(mem);
      if (inflight) return inflight; // les 5 appels simultanés d'une page partagent UNE seule lecture
      inflight = (async function () {
        var cached = await DB.get("snapshot");
        if (cached && Date.now() - cached.at < CFG.snapshotMaxAge) { mem = cached.data; memAt = cached.at; return mem; }
        try {
          var res = await timedFetch(CFG.snapshotUrl, { cache: "no-cache", mode: "cors", credentials: "omit" }, 4000);
          if (!res.ok) throw new Error("snapshot " + res.status);
          var data = await res.json();
          if (!data || typeof data !== "object" || !data.settings) throw new Error("snapshot invalide");
          mem = data; memAt = Date.now();
          DB.set("snapshot", { at: memAt, data: data });
          return data;
        } catch (e) {
          if (cached) { mem = cached.data; memAt = Date.now() - CFG.snapshotMaxAge + 15000; return mem; } // hors-ligne / CDN indisponible : dernier instantané connu
          return null;
        }
      })();
      var done = function () { inflight = null; };
      inflight.then(done, done);
      return inflight;
    }
    function nullsLast(a, b, dir) {
      var an = a == null, bn = b == null;
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      return dir * (a - b);
    }
    function route(snap, u) {
      var p = u.pathname.replace(/\/+$/, ""), q = u.searchParams, m;
      switch (p) {
        case "/api/settings": return { settings: snap.settings };
        case "/api/categories": return { categories: snap.categories };
        case "/api/services": return { services: snap.services };
        case "/api/formations": return { formations: snap.formations };
        case "/api/products": return snap.products ? { products: snap.products } : undefined;
        case "/api/testimonials": return { testimonials: snap.testimonials };
        case "/api/assistant/config": return snap.assistant;
        case "/api/photos": {
          var list = snap.photos || [];
          if (q.get("category")) list = list.filter(function (x) { return x.categorie === q.get("category"); });
          if (q.get("featured") === "1") list = list.filter(function (x) { return Number(x.a_la_une) === 1; });
          var off = parseInt(q.get("offset"), 10) || 0, lim = parseInt(q.get("limit"), 10);
          if (off || lim) list = list.slice(off, lim ? off + lim : undefined);
          return { photos: list };
        }
        case "/api/software": {
          var sw = (snap.software || []).map(function (x, i) { return { x: x, i: i }; });
          sw = sw.filter(function (e) {
            return (!q.get("category") || e.x.categorie === q.get("category")) &&
              (!q.get("licence") || e.x.licence_type === q.get("licence")) &&
              (!q.get("badge") || e.x.badge === q.get("badge"));
          });
          var sort = q.get("sort");
          sw.sort(function (a, b) {
            var r = sort === "prix_asc" ? nullsLast(a.x.prix_a_partir_de, b.x.prix_a_partir_de, 1)
              : sort === "prix_desc" ? nullsLast(a.x.prix_a_partir_de, b.x.prix_a_partir_de, -1)
              : sort === "populaire" ? (b.x.popularite || 0) - (a.x.popularite || 0) : 0;
            return r || a.i - b.i;
          });
          return { software: sw.map(function (e) { return e.x; }) };
        }
      }
      if ((m = p.match(/^\/api\/software\/(\d+)$/)) && snap.software_detail) {
        var d = snap.software_detail[m[1]];
        return d ? { software: d } : { __status: 404, error: "Logiciel introuvable." };
      }
      return undefined;
    }
    return { load: load, route: route };
  })();

  var PUBLIC_GET = /^\/api\/(settings|categories|photos|services|formations|products|software(\/\d+)?|testimonials|assistant\/config)\/?$/;

  async function publicGet(u, init) {
    var snap = await Snapshot.load();
    if (snap) {
      var body = Snapshot.route(snap, u);
      if (body !== undefined) {
        if (body.__status) return jsonResponse(body.__status, { error: body.error }, "snapshot");
        return jsonResponse(200, body, "snapshot");
      }
    }
    var key = "pub:" + u.pathname + u.search;
    var cached = await DB.get(key);
    // Données déjà en cache et serveur endormi : on les sert tout de suite, SANS réveiller le backend.
    if (cached && !Wake.fresh()) return jsonResponse(200, cached, "cache");
    try {
      var res = await smartRequest(u.pathname + u.search, init, "silent");
      if (res.ok) res.clone().json().then(function (d) { DB.set(key, d); }).catch(function () {});
      else if (cached) return jsonResponse(200, cached, "cache");
      return res;
    } catch (e) {
      if (cached) return jsonResponse(200, cached, "cache");
      throw e;
    }
  }

  /* ---------------- Interception de fetch (même origine, /api/*) ---------------- */
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string" || input instanceof URL) {
        var u = new URL(String(input), location.href);
        if (u.origin === location.origin && u.pathname.indexOf("/api/") === 0 && u.pathname !== CFG.healthPath) {
          init = init || {};
          if (init.okim === "raw") { var i2 = Object.assign({}, init); delete i2.okim; return origFetch(input, i2); }
          var method = String(init.method || "GET").toUpperCase();
          if (method === "GET" && PUBLIC_GET.test(u.pathname)) return publicGet(u, init);
          return smartRequest(u.pathname + u.search, init, "overlay");
        }
      }
    } catch (e) { /* URL illisible : comportement natif */ }
    return origFetch(input, init);
  };

  /* XMLHttpRequest (téléversements de l'administration) : on garantit simplement que le serveur est éveillé avant l'envoi. */
  (function patchXhr() {
    if (!window.XMLHttpRequest) return;
    var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__okimApi = new URL(String(url), location.href).pathname.indexOf("/api/") === 0; } catch (e) { this.__okimApi = false; }
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this, args = arguments;
      if (!xhr.__okimApi || Wake.fresh() || isOffline()) return send.apply(xhr, args);
      ensureAwake(true).then(function (ok) {
        if (ok) send.apply(xhr, args); else xhr.dispatchEvent(new Event("error"));
      });
    };
  })();

  /* Liens/téléchargements directs vers /api/* : on réveille d'abord, puis on navigue (jamais d'écran hébergeur). */
  document.addEventListener("click", function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    var a = ev.target.closest && ev.target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href.indexOf("/api/") !== 0 || Wake.fresh()) return;
    ev.preventDefault();
    ensureAwake(true).then(function (ok) {
      if (!ok) return;
      var t = document.createElement("a");
      t.href = href; if (a.hasAttribute("download")) t.setAttribute("download", a.getAttribute("download") || "");
      if (a.target) t.target = a.target;
      document.body.appendChild(t); t.click(); t.remove();
    });
  }, true);

  /* ---------------- File d'attente persistante ---------------- */
  var Outbox = (function () {
    var running = false, timer = null, pageId = uid();
    var listeners = [];
    var lastSyncedAt = 0;

    function all() { return DB.outAll().then(function (l) { return (l || []).sort(function (a, b) { return a.createdAt - b.createdAt; }); }); }
    function notify() { all().then(function (l) { render(l); listeners.forEach(function (fn) { try { fn(l); } catch (e) { /* écouteur défaillant */ } }); }); }

    function build(spec) {
      return {
        id: uid(), kind: spec.kind || "form", label: spec.label || "Envoi", url: spec.url, method: (spec.method || "POST").toUpperCase(),
        headers: spec.headers || {}, body: spec.body == null ? null : (typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body)),
        idem: uid(), state: "syncing", attempts: 0, createdAt: Date.now(), nextAt: 0, lastError: null, owner: pageId, meta: spec.meta || null
      };
    }

    async function send(item, overlay) {
      var headers = Object.assign({ "Content-Type": "application/json", "Idempotency-Key": item.idem }, item.headers);
      var res;
      try {
        res = await smartRequest(item.url, { method: item.method, headers: headers, body: item.body }, overlay ? "overlay" : "silent");
      } catch (e) {
        item.attempts++; item.lastError = e.message; item.deferred = true;
        item.state = item.attempts >= CFG.maxOutboxAttempts ? "error" : "pending";
        item.nextAt = Date.now() + Math.min(60000, Math.pow(2, item.attempts) * 2000);
        await DB.outPut(item); notify();
        return { queued: item.state === "pending", failed: item.state === "error", offline: e.code === "offline", error: e };
      }
      var data = null;
      try { data = await res.json(); } catch (e) { /* corps vide */ }
      if (res.ok && res.status !== 202) {
        await DB.outDel(item.id); lastSyncedAt = Date.now();
        // Commande envoyée via la file : on mémorise l'étape de paiement à proposer (reprise sur panier.html).
        if (item.kind === "order" && item.deferred && data && data.order) await DB.set("pending_payment", { order: data.order, at: Date.now() });
        emit("okim:synced", { item: item, status: res.status, data: data });
        notify();
        return { synced: true, status: res.status, data: data };
      }
      var retryLater = res.status === 202 || res.status >= 500 || (res.status === 409 && data && data.in_progress);
      if (retryLater) {
        item.attempts++; item.deferred = true; item.lastError = (data && data.error) || ("HTTP " + res.status);
        item.state = item.attempts >= CFG.maxOutboxAttempts ? "error" : "pending";
        item.nextAt = Date.now() + (res.status === 202 ? 3000 : Math.min(60000, Math.pow(2, item.attempts) * 2000));
        await DB.outPut(item); notify();
        return { queued: item.state === "pending", pending: true, status: res.status, data: data };
      }
      // Refus définitif du serveur (validation, droits...) : inutile de réessayer.
      await DB.outDel(item.id);
      emit("okim:rejected", { item: item, status: res.status, data: data });
      notify();
      return { rejected: true, status: res.status, data: data, message: (data && data.error) || "Envoi refusé." };
    }

    /** Enregistre PUIS envoie. Retourne {synced|queued|rejected|failed...} — jamais un faux succès. */
    async function submit(spec) {
      var item = build(spec);
      await DB.outPut(item); notify();
      if (isOffline()) { item.state = "pending"; item.deferred = true; item.lastError = "offline"; await DB.outPut(item); notify(); registerBackgroundSync(); return { queued: true, offline: true, id: item.id }; }
      var r = await send(item, true);
      r.id = item.id;
      if (r.queued) registerBackgroundSync();
      return r;
    }

    /** Suivi d'une opération dont la page gère elle-même l'envoi (confirmation de paiement) : persiste pour reprise. */
    async function track(spec) {
      var item = build(spec); item.tracked = true;
      await DB.outPut(item); notify();
      return item.id;
    }
    async function untrack(id) { await DB.outDel(id); notify(); }

    async function flush(opts) {
      opts = opts || {};
      if (running || isOffline()) return;
      running = true;
      try {
        var list = await all();
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          if (it.state === "syncing" && it.owner === pageId && !it.tracked) continue; // envoi en cours dans cette page
          if (it.state === "syncing" && it.owner === pageId && it.tracked && Date.now() - it.createdAt < 120000) continue; // la page gère
          if (it.state === "error" && !opts.includeErrors) continue;
          if (it.state === "pending" && it.nextAt > Date.now() && !opts.force) continue;
          it.state = "syncing"; it.owner = pageId; await DB.outPut(it); notify();
          await send(it, false);
        }
      } finally { running = false; schedule(); }
    }
    function schedule() {
      if (timer) { clearTimeout(timer); timer = null; }
      all().then(function (l) {
        var pend = l.filter(function (x) { return x.state === "pending"; });
        if (!pend.length || isOffline()) return;
        var next = Math.max(1000, Math.min.apply(null, pend.map(function (x) { return x.nextAt; })) - Date.now());
        timer = setTimeout(function () { flush(); }, next);
      });
    }
    function registerBackgroundSync() {
      try {
        if (navigator.serviceWorker && "SyncManager" in window) {
          navigator.serviceWorker.ready.then(function (reg) { return reg.sync.register("okim-outbox"); }).catch(function () {});
        }
      } catch (e) { /* non supporté */ }
    }

    /* --- Puce d'état : en attente / synchronisation / synchronisé / erreur --- */
    var chip = null, hideTimer = null;
    function render(list) {
      onReady(function () {
        if (!chip) {
          chip = document.createElement("div");
          chip.id = "okim-sync"; chip.setAttribute("role", "status"); chip.setAttribute("aria-live", "polite");
          document.body.appendChild(chip);
          chip.addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            if (b.dataset.act === "retry") flush({ force: true, includeErrors: true });
            if (b.dataset.act === "drop") all().then(function (l) { l.filter(function (x) { return x.state === "error"; }).forEach(function (x) { DB.outDel(x.id); }); notify(); });
          });
        }
        clearTimeout(hideTimer);
        var syncing = list.filter(function (x) { return x.state === "syncing"; });
        var pending = list.filter(function (x) { return x.state === "pending"; });
        var errors = list.filter(function (x) { return x.state === "error"; });
        chip.className = "";
        if (errors.length) {
          chip.className = "show error";
          chip.innerHTML = "<strong>Erreur d'envoi</strong><br>" + esc(errors[0].label) + (errors.length > 1 ? " (+" + (errors.length - 1) + ")" : "") +
            " n'a pas pu être transmis.<br><button data-act='retry'>Réessayer</button><button data-act='drop'>Abandonner</button>";
        } else if (syncing.length) {
          chip.className = "show";
          chip.innerHTML = "<strong>Synchronisation…</strong><br>" + esc(syncing[0].label) + (syncing.length > 1 ? " (+" + (syncing.length - 1) + ")" : "");
        } else if (pending.length) {
          chip.className = "show";
          chip.innerHTML = "<strong>" + pending.length + " en attente d'envoi</strong><br>" + esc(pending[0].label) +
            (isOffline() ? " — sera envoyé dès le retour de la connexion." : " — nouvel essai en cours.") +
            "<br><button data-act='retry'>Envoyer maintenant</button>";
        } else if (Date.now() - lastSyncedAt < 4000) {
          chip.className = "show ok";
          chip.innerHTML = "<strong>Synchronisé ✓</strong><br>Confirmé par le serveur.";
          hideTimer = setTimeout(function () { chip.className = ""; }, 4000);
        } else {
          chip.className = "";
        }
      });
    }

    window.addEventListener("online", function () { notify(); flush({ force: true }); });
    window.addEventListener("offline", function () { notify(); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) flush(); });
    onReady(function () {
      // Au chargement d'une page : on relance ce qui était resté en attente (page fermée, réseau coupé...).
      all().then(function (l) {
        var changed = l.filter(function (x) { return x.state === "syncing" && x.owner !== pageId; });
        return Promise.all(changed.map(function (x) { x.state = "pending"; return DB.outPut(x); })).then(function () { notify(); flush(); });
      });
    });

    return {
      submit: submit, track: track, untrack: untrack, flush: flush, list: all,
      onChange: function (fn) { listeners.push(fn); }
    };
  })();

  /* ---------------- Bandeau hors connexion ---------------- */
  (function () {
    function upd() {
      onReady(function () {
        var el = document.getElementById("okim-offline");
        if (!el) {
          el = document.createElement("div"); el.id = "okim-offline"; el.setAttribute("role", "status");
          el.textContent = "Mode hors connexion — vous consultez les pages enregistrées. Les envois reprendront au retour du réseau.";
          document.body.appendChild(el);
        }
        el.classList.toggle("show", isOffline());
      });
    }
    window.addEventListener("online", upd); window.addEventListener("offline", upd); upd();
  })();

  /* ---------------- Squelettes de chargement ---------------- */
  function skeletonCards(container, n) {
    if (!container) return;
    var html = "";
    for (var i = 0; i < (n || 6); i++) html += '<div class="okim-skel-card" aria-hidden="true"><div class="okim-skel t"></div><div class="okim-skel l"></div><div class="okim-skel l s"></div></div>';
    container.innerHTML = html;
  }
  function notice(afterEl, text) {
    if (!afterEl) return;
    var n = afterEl.parentNode.querySelector(".okim-notice[data-for='" + (afterEl.id || "x") + "']");
    if (!n) { n = document.createElement("p"); n.className = "okim-notice"; n.setAttribute("data-for", afterEl.id || "x"); n.setAttribute("role", "status"); afterEl.insertAdjacentElement("afterend", n); }
    n.textContent = text;
    return n;
  }
  function clearNotice(afterEl) {
    var n = afterEl && afterEl.parentNode.querySelector(".okim-notice[data-for='" + (afterEl.id || "x") + "']");
    if (n) n.remove();
  }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms || 250); }; }

  /* ---------------- Scripts tiers : après le contenu principal ---------------- */
  function loadDeferredScripts() {
    var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1500); };
    var go = function () {
      idle(function () {
        if (isOffline()) return;
        document.querySelectorAll("script[data-okim-defer-src]").forEach(function (old) {
          var s = document.createElement("script");
          s.src = old.getAttribute("data-okim-defer-src"); s.async = true;
          Array.prototype.forEach.call(old.attributes, function (at) { if (/^data-(?!okim)/.test(at.name)) s.setAttribute(at.name, at.value); });
          document.head.appendChild(s);
        });
        emit("okim:idle");
      });
    };
    if (document.readyState === "complete") go(); else window.addEventListener("load", go, { once: true });
  }
  loadDeferredScripts();

  /* ---------------- Service Worker ---------------- */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(function (reg) {
        reg.update().catch(function () {});
      }).catch(function () { /* l'application fonctionne sans Service Worker */ });
      navigator.serviceWorker.addEventListener("message", function (ev) {
        if (ev.data && ev.data.type === "okim-flush-outbox") Outbox.flush({ force: true });
      });
    });
  }

  /* ---------------- API publique ---------------- */
  window.OkimApi = {
    config: CFG,
    /** Garantit que le backend répond (animation OKIM ART si besoin). Résout true/false. */
    ensureAwake: function (overlay) { return ensureAwake(overlay !== false); },
    /** Formulaire/commande : enregistré localement, envoyé avec clé d'idempotence, repris automatiquement si besoin. */
    submit: Outbox.submit,
    /** Suivi persistant d'une opération que la page envoie elle-même (ex. confirmation de paiement). */
    track: Outbox.track, untrack: Outbox.untrack,
    outbox: { list: Outbox.list, flush: Outbox.flush, onChange: Outbox.onChange },
    kv: { get: DB.get, set: DB.set, del: DB.del },
    ui: { skeletonCards: skeletonCards, notice: notice, clearNotice: clearNotice, debounce: debounce },
    isOffline: isOffline,
    _wake: Wake, _probe: probe
  };
})();
