/* ==============================================================
   app.js — logique du tableau de bord OKIM ART
   Vanilla JS, aucune dépendance. Toutes les requêtes passent par
   l'API /api/admin/* protégée par cookie de session (httpOnly).
   ============================================================== */
(function () {
  "use strict";

  const FCFA = new Intl.NumberFormat("fr-FR");
  const money = (n) => (n === null || n === undefined || n === "" ? "—" : FCFA.format(n) + " FCFA");
  const dateFr = (iso) => { try { return new Date(iso).toLocaleDateString("fr-FR", { day:"2-digit", month:"short", year:"numeric" }); } catch(e){ return iso; } };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

  async function api(path, opts = {}) {
    const res = await fetch("/api/admin" + path, Object.assign({ headers: {} }, opts));
    let data = null;
    try { data = await res.json(); } catch (e) { /* réponse vide */ }
    if (res.status === 401) { window.location.href = "login.html"; throw new Error("Non authentifié"); }
    if (!res.ok) throw new Error((data && data.error) || "Erreur serveur (" + res.status + ")");
    return data;
  }
  async function apiJson(path, method, body) {
    return api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  async function apiForm(path, method, formData) {
    return api(path, { method, body: formData });
  }

  /* ================= GARDE D'AUTHENTIFICATION ================= */
  fetch("/api/auth/admin/me").then((r) => {
    if (!r.ok) { window.location.href = "login.html"; return; }
    boot();
  }).catch(() => { window.location.href = "login.html"; });

  /* ================= NAVIGATION ================= */
  function goToSection(name) {
    document.querySelectorAll("#admin-nav button[data-section]").forEach((b) => b.classList.toggle("active", b.dataset.section === name));
    document.querySelectorAll(".admin-section").forEach((s) => s.classList.remove("active"));
    const target = document.getElementById("section-" + name);
    if (target) { target.classList.add("active"); target.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }
  function initNav() {
    const buttons = document.querySelectorAll("#admin-nav button[data-section]");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => goToSection(btn.dataset.section));
    });
    document.getElementById("logout-btn").addEventListener("click", async () => {
      await fetch("/api/auth/admin/logout", { method: "POST" });
      window.location.href = "login.html";
    });
  }

  /* ================= NOTIFICATIONS (cloche) ================= */
  function timeAgo(iso) {
    const d = new Date((iso || "").replace(" ", "T") + "Z");
    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return "à l'instant";
    if (diffMin < 60) return `il y a ${diffMin} min`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) return `il y a ${diffH} h`;
    return dateFr(iso);
  }
  async function loadAdminNotifications() {
    const { notifications, unread } = await api("/notifications");
    const badge = document.getElementById("notif-badge");
    badge.style.display = unread > 0 ? "flex" : "none";
    badge.textContent = unread > 99 ? "99+" : unread;
    const list = document.getElementById("notif-list");
    list.innerHTML = notifications.length ? notifications.map((n) => `
      <button type="button" class="admin-notif-item ${n.lu ? "" : "unread"}" data-id="${n.id}" data-lien="${esc(n.lien || "")}">
        <span class="ni-title">${esc(n.titre)}</span>
        ${n.corps ? `<span class="ni-body">${esc(n.corps)}</span>` : ""}
        <span class="ni-time">${timeAgo(n.created_at)}</span>
      </button>`).join("") : `<div class="admin-notif-empty">Aucune notification pour le moment.</div>`;
    list.querySelectorAll(".admin-notif-item").forEach((item) => item.addEventListener("click", async () => {
      const id = item.dataset.id, lien = item.dataset.lien;
      if (item.classList.contains("unread")) {
        try { await api("/notifications/" + id + "/read", { method: "PATCH" }); item.classList.remove("unread"); await loadAdminNotifications(); } catch (_) {}
      }
      document.getElementById("notif-panel").classList.remove("open");
      if (lien && lien.startsWith("#")) goToSection(lien.slice(1));
    }));
  }
  document.getElementById("notif-bell").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("notif-panel").classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("notif-panel");
    if (panel.classList.contains("open") && !panel.contains(e.target) && e.target.id !== "notif-bell") panel.classList.remove("open");
  });
  document.getElementById("notif-read-all").addEventListener("click", async () => {
    try { await api("/notifications/read-all", { method: "POST" }); await loadAdminNotifications(); } catch (_) {}
  });

  /* ================= DASHBOARD ================= */
  async function loadDashboard() {
    const { stats, reset_at } = await api("/dashboard");
    const cards = [
      ["Photos publiées", stats.photos_publiees + " / " + stats.photos],
      ["Produits en vente", stats.produits],
      ["Commandes", stats.commandes],
      ["En attente de paiement", stats.commandes_en_attente],
      ["Chiffre d'affaires", money(stats.chiffre_affaires)],
      ["Clients", stats.clients],
      ["Formations actives", stats.formations],
      ["Inscriptions formations", stats.inscriptions],
      ["Messages non lus", stats.messages_non_lus],
      ["Séances actives", stats.seances_actives],
      ["Séances archivées", stats.seances_archivees],
      ["Revenus récupération", money(stats.revenus_recuperation)],
      ["Logiciels publiés", stats.logiciels_publies],
      ["Licences actives", stats.licences_actives],
      ["Licences expirées", stats.licences_expirees],
      ["Formules vendues", stats.logiciels_vendus],
      ["CA logiciels", money(stats.chiffre_affaires_logiciels)],
      ["Téléchargements logiciels", stats.telechargements_logiciels],
      ["Témoignages en attente", stats.temoignages_en_attente]
    ];
    document.getElementById("stats-grid").innerHTML = cards.map(([label, val]) =>
      `<div class="admin-stat-card"><small>${esc(label)}</small><span>${esc(val)}</span></div>`
    ).join("");
    document.getElementById("badge-orders").textContent = stats.commandes_en_attente;
    document.getElementById("badge-messages").textContent = stats.messages_non_lus;
    document.getElementById("badge-testimonials").textContent = stats.temoignages_en_attente;
    document.getElementById("dashboard-reset-info").textContent = reset_at
      ? "Compteurs à zéro depuis le " + dateFr(reset_at)
      : "Compteurs jamais réinitialisés (comptage depuis le début)";
  }
  document.getElementById("btn-reset-dashboard").addEventListener("click", async () => {
    if (!confirm("Remettre les compteurs du tableau de bord à zéro ?\n\nAucune donnée n'est supprimée : photos, commandes, messages, clients... restent tous consultables dans leurs sections respectives. Seuls les chiffres affichés ici recommenceront à compter à partir de maintenant.")) return;
    try {
      await apiJson("/dashboard/reset", "POST", {});
      await loadDashboard();
    } catch (err) { alert(err.message); }
  });

  /* ================= UTILITAIRE : DROPZONE IMAGE / VIDÉO ================= */
  function wireDropzone({ zoneId, inputId, previewWrapId, textId, defaultText }) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    const previewWrap = document.getElementById(previewWrapId);
    const textEl = document.getElementById(textId);
    let currentFile = null;

    function showPreview(url, isVideo) {
      previewWrap.innerHTML = !url ? "" : isVideo
        ? `<video src="${esc(url)}" muted controls style="max-width:100%; max-height:160px; border-radius:8px; display:block; margin:0 auto .6rem"></video>`
        : `<img src="${esc(url)}" alt="Aperçu">`;
    }
    zone.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files && input.files[0]) {
        currentFile = input.files[0];
        showPreview(URL.createObjectURL(currentFile), currentFile.type.startsWith("video/"));
        textEl.textContent = currentFile.name;
      }
    });
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("drag"); }));
    zone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) { input.files = e.dataTransfer.files; currentFile = file; showPreview(URL.createObjectURL(file), file.type.startsWith("video/")); textEl.textContent = file.name; }
    });
    return {
      reset(existingUrl, existingIsVideo) { currentFile = null; input.value = ""; showPreview(existingUrl || null, !!existingIsVideo); textEl.textContent = existingUrl ? (existingIsVideo ? "Vidéo actuelle — cliquez pour la remplacer" : "Image actuelle — cliquez pour la remplacer") : defaultText; },
      getFile() { return currentFile; }
    };
  }

  /* ================= PORTFOLIO (PHOTOS) ================= */
  const photoDZ = wireDropzone({ zoneId:"photo-dropzone", inputId:"photo-file", previewWrapId:"photo-preview-wrap", textId:"photo-dropzone-text", defaultText:"Cliquez ou glissez-déposez une image (JPG, PNG, WEBP)" });
  let categoriesCache = [];

  // Bascule l'input/dropzone entre mode image et mode vidéo, et masque les
  // réglages qui n'ont pas de sens pour une vidéo (prix, filigrane).
  function applyPhotoTypeUI() {
    const isVideo = document.getElementById("photo-type-video").checked;
    const input = document.getElementById("photo-file");
    const text = document.getElementById("photo-dropzone-text");
    input.setAttribute("accept", isVideo ? "video/mp4,video/webm,video/quicktime" : "image/jpeg,image/png,image/webp");
    if (!photoDZ.getFile()) text.textContent = isVideo ? "Cliquez ou glissez-déposez une courte vidéo (MP4, WEBM, MOV) — envoyée directement vers Cloudinary" : "Cliquez ou glissez-déposez une image (JPG, PNG, WEBP)";
    document.getElementById("photo-prix-field").style.display = isVideo ? "none" : "";
    document.getElementById("photo-watermark-field").style.display = isVideo ? "none" : "";
  }
  document.getElementById("photo-type-photo").addEventListener("change", applyPhotoTypeUI);
  document.getElementById("photo-type-video").addEventListener("change", applyPhotoTypeUI);

  async function loadCategoriesIntoSelect() {
    const { categories } = await api("/categories");
    categoriesCache = categories;
    const sel = document.getElementById("photo-category");
    sel.innerHTML = `<option value="">— Aucune —</option>` + categories.map((c) => `<option value="${c.id}">${esc(c.nom)}</option>`).join("");
  }

  async function loadPhotos() {
    const { photos } = await api("/photos");
    const tbody = document.querySelector("#table-photos tbody");
    if (!photos.length) { tbody.innerHTML = `<tr><td colspan="6" class="admin-table-empty">Aucune photo pour le moment.</td></tr>`; return; }
    tbody.innerHTML = photos.map((p) => `
      <tr>
        <td>${p.type === "video" ? `<video class="thumb" src="${esc(p.miniature)}" muted></video>` : `<img class="thumb" src="${esc(p.miniature)}" alt="">`}</td>
        <td>${esc(p.titre)} ${p.type === "video" ? '<span class="admin-tag">Vidéo</span>' : ""}${p.prix ? `<br><span class="admin-tag">${money(p.prix)}</span>` : ""}</td>
        <td>${esc(p.categorie_nom || "—")}</td>
        <td><span class="admin-tag ${p.statut === "publie" ? "ok" : "warn"}">${p.statut === "publie" ? "Publié" : "Brouillon"}</span></td>
        <td>${p.a_la_une ? '<span class="admin-tag ok">À la une</span>' : "—"}</td>
        <td class="admin-row-actions">
          <button class="admin-icon-btn" data-edit="${p.id}">Modifier</button>
          <button class="admin-icon-btn danger" data-del="${p.id}">Supprimer</button>
        </td>
      </tr>`).join("");
    tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openPhotoPanel(photos.find(p => p.id == b.dataset.edit))));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deletePhoto(b.dataset.del)));
  }

  function openPhotoPanel(photo) {
    const panel = document.getElementById("panel-photo");
    document.getElementById("panel-photo-title").textContent = photo ? "Modifier" : "Ajouter au portfolio";
    document.getElementById("photo-id").value = photo ? photo.id : "";
    document.getElementById("photo-titre").value = photo ? photo.titre : "";
    document.getElementById("photo-description").value = photo ? photo.description : "";
    document.getElementById("photo-category").value = photo ? (photo.category_id || "") : "";
    document.getElementById("photo-statut").value = photo ? photo.statut : "publie";
    document.getElementById("photo-prix").value = photo ? (photo.prix || "") : "";
    document.getElementById("photo-a-la-une").checked = !!(photo && photo.a_la_une);
    document.getElementById("photo-watermark").checked = photo ? !!photo.watermark : true;
    const isVideo = !!(photo && photo.type === "video");
    document.getElementById("photo-type-video").checked = isVideo;
    document.getElementById("photo-type-photo").checked = !isVideo;
    // Changer de type sur un élément existant obligerait à ré-uploader
    // (les deux formats n'ont pas la même sécurité de stockage) : on
    // verrouille le choix en modification, uniquement libre à la création.
    document.getElementById("photo-type-photo").disabled = !!photo;
    document.getElementById("photo-type-video").disabled = !!photo;
    applyPhotoTypeUI();
    photoDZ.reset(photo ? photo.miniature : null, isVideo);
    panel.classList.add("open");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  document.getElementById("btn-new-photo").addEventListener("click", () => openPhotoPanel(null));
  document.getElementById("cancel-photo").addEventListener("click", () => document.getElementById("panel-photo").classList.remove("open"));

  /* ================= UPLOAD DIRECT VIDÉO → CLOUDINARY =================
     Utilisé uniquement pour le type "Vidéo courte" du portfolio : le fichier
     ne passe JAMAIS par notre serveur Express (pas de FormData vers /api/admin/photos
     avec le fichier lui-même). On récupère une signature côté serveur, puis on
     POST directement à Cloudinary depuis le navigateur, avec suivi de progression
     (XMLHttpRequest — fetch() ne donne pas d'évènement de progression d'upload). */
  async function getVideoUploadSignature() {
    // Route hors du préfixe /api/admin (voir server.js) : on n'utilise donc
    // pas le helper api() qui préfixe automatiquement par /api/admin.
    const res = await fetch("/api/signature/video");
    if (res.status === 401) { window.location.href = "login.html"; throw new Error("Non authentifié"); }
    if (!res.ok) {
      let msg = "Impossible d'obtenir l'autorisation d'upload.";
      try { const data = await res.json(); if (data && data.error) msg = data.error; } catch (e) {}
      throw new Error(msg);
    }
    return res.json(); // { signature, timestamp, apiKey, cloudName, folder }
  }

  function uploadVideoToCloudinary(file, { signature, timestamp, apiKey, cloudName, folder }, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      // IMPORTANT : ces champs doivent correspondre EXACTEMENT à ce qui a
      // été signé côté serveur (timestamp + folder) — voir routes/admin/signature.js.
      // "file" doit être ajouté avant les autres champs signés pour Cloudinary,
      // mais l'ordre n'a en réalité pas d'importance pour un FormData.
      fd.append("file", file);
      fd.append("api_key", apiKey);
      fd.append("timestamp", timestamp);
      fd.append("signature", signature);
      fd.append("folder", folder);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`);

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && data && data.secure_url) {
          resolve(data.secure_url);
        } else {
          reject(new Error((data && data.error && data.error.message) || "Échec de l'envoi vers Cloudinary."));
        }
      };
      xhr.onerror = () => reject(new Error("Connexion à Cloudinary interrompue — vérifiez votre réseau et réessayez."));
      xhr.send(fd);
    });
  }

  function setPhotoUploadProgress(visible, percent) {
    const wrap = document.getElementById("photo-upload-progress");
    wrap.style.display = visible ? "" : "none";
    if (visible) {
      document.getElementById("photo-upload-progress-bar").style.width = percent + "%";
      document.getElementById("photo-upload-progress-text").textContent = `Envoi de la vidéo vers Cloudinary… ${percent} %`;
    }
  }

  document.getElementById("form-photo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("photo-id").value;
    const isVideo = document.getElementById("photo-type-video").checked;
    const file = photoDZ.getFile();
    if (!id && !file) { alert("Veuillez sélectionner un fichier (photo ou vidéo)."); return; }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.textContent;
    submitBtn.disabled = true;

    try {
      let videoUrl = null;

      // Vidéo + nouveau fichier sélectionné : upload direct vers Cloudinary
      // AVANT d'appeler notre propre API — notre serveur ne reçoit ensuite
      // que l'URL Cloudinary (video_url), jamais le fichier vidéo lui-même.
      if (isVideo && file) {
        submitBtn.textContent = "Préparation…";
        const sig = await getVideoUploadSignature();
        setPhotoUploadProgress(true, 0);
        submitBtn.textContent = "Envoi en cours…";
        videoUrl = await uploadVideoToCloudinary(file, sig, (pct) => setPhotoUploadProgress(true, pct));
      }

      const fd = new FormData();
      fd.append("titre", document.getElementById("photo-titre").value);
      fd.append("description", document.getElementById("photo-description").value);
      fd.append("category_id", document.getElementById("photo-category").value);
      fd.append("statut", document.getElementById("photo-statut").value);
      fd.append("type", isVideo ? "video" : "photo");
      fd.append("prix", document.getElementById("photo-prix").value);
      fd.append("a_la_une", document.getElementById("photo-a-la-une").checked ? "1" : "0");
      fd.append("watermark", document.getElementById("photo-watermark").checked ? "1" : "0");

      if (videoUrl) {
        // Circuit Cloudinary : on envoie l'URL, jamais le fichier.
        fd.append("video_url", videoUrl);
      } else if (file) {
        // Circuit classique (photo, filigrane/redimensionnement côté serveur).
        fd.append("file", file);
      }

      submitBtn.textContent = "Enregistrement…";
      await apiForm(id ? "/photos/" + id : "/photos", id ? "PUT" : "POST", fd);
      document.getElementById("panel-photo").classList.remove("open");
      await loadPhotos();
    } catch (err) {
      alert(err.message);
    } finally {
      setPhotoUploadProgress(false, 0);
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
  });
  async function deletePhoto(id) {
    if (!confirm("Déplacer cette photo vers la corbeille ? (récupérable 30 jours)")) return;
    try { await api("/photos/" + id, { method: "DELETE" }); await loadPhotos(); await loadTrash(); await loadDashboard(); } catch (err) { alert(err.message); }
  }

  /* ================= CATEGORIES ================= */
  async function loadCategories() {
    const { categories } = await api("/categories");
    categoriesCache = categories;
    const tbody = document.querySelector("#table-categories tbody");
    tbody.innerHTML = categories.length ? categories.map((c) => `
      <tr>
        <td>${esc(c.nom)}</td><td><span class="admin-tag">${esc(c.slug)}</span></td><td>${esc(c.description || "—")}</td>
        <td class="admin-row-actions">
          <button class="admin-icon-btn" data-edit="${c.id}">Modifier</button>
          <button class="admin-icon-btn danger" data-del="${c.id}">Supprimer</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="4" class="admin-table-empty">Aucune catégorie.</td></tr>`;
    tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
      const c = categories.find(x => x.id == b.dataset.edit);
      document.getElementById("panel-category-title").textContent = "Modifier la catégorie";
      document.getElementById("category-id").value = c.id;
      document.getElementById("category-nom").value = c.nom;
      document.getElementById("category-description").value = c.description || "";
      document.getElementById("panel-category").classList.add("open");
    }));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Déplacer cette catégorie vers la corbeille ? (récupérable 30 jours)")) return;
      try { await api("/categories/" + b.dataset.del, { method: "DELETE" }); await loadCategories(); await loadCategoriesIntoSelect(); await loadTrash(); }
      catch (err) { alert(err.message); }
    }));
  }
  document.getElementById("btn-new-category").addEventListener("click", () => {
    document.getElementById("panel-category-title").textContent = "Ajouter une catégorie";
    document.getElementById("category-id").value = "";
    document.getElementById("form-category").reset();
    document.getElementById("panel-category").classList.add("open");
  });
  document.getElementById("cancel-category").addEventListener("click", () => document.getElementById("panel-category").classList.remove("open"));
  document.getElementById("form-category").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("category-id").value;
    const body = { nom: document.getElementById("category-nom").value, description: document.getElementById("category-description").value };
    try {
      await apiJson(id ? "/categories/" + id : "/categories", id ? "PUT" : "POST", body);
      document.getElementById("panel-category").classList.remove("open");
      await loadCategories(); await loadCategoriesIntoSelect();
    } catch (err) { alert(err.message); }
  });

  /* ================= SERVICES ================= */
  const serviceDZ = wireDropzone({ zoneId:"service-dropzone", inputId:"service-file", previewWrapId:"service-preview-wrap", textId:"service-dropzone-text", defaultText:"Image du service (facultatif) — cliquez ou glissez-déposez" });
  async function loadServices() {
    const { services } = await api("/services");
    const tbody = document.querySelector("#table-services tbody");
    tbody.innerHTML = services.length ? services.map((s) => `
      <tr>
        <td>${s.image ? `<img class="thumb" src="${esc(s.image)}" alt="">` : "—"}</td>
        <td>${esc(s.titre)}</td>
        <td><span class="admin-tag ${s.statut === "actif" ? "ok" : "warn"}">${s.statut === "actif" ? "Actif" : "Inactif"}</span></td>
        <td class="admin-row-actions">
          <button class="admin-icon-btn" data-edit="${s.id}">Modifier</button>
          <button class="admin-icon-btn danger" data-del="${s.id}">Supprimer</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="4" class="admin-table-empty">Aucun service.</td></tr>`;
    tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
      const s = services.find(x => x.id == b.dataset.edit);
      document.getElementById("panel-service-title").textContent = "Modifier le service";
      document.getElementById("service-id").value = s.id;
      document.getElementById("service-titre").value = s.titre;
      document.getElementById("service-prix").value = s.prix || "";
      document.getElementById("service-description").value = s.description || "";
      document.getElementById("service-statut").value = s.statut;
      document.getElementById("service-ordre").value = s.ordre || 0;
      serviceDZ.reset(s.image);
      document.getElementById("panel-service").classList.add("open");
    }));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Déplacer ce service vers la corbeille ? (récupérable 30 jours)")) return;
      try { await api("/services/" + b.dataset.del, { method: "DELETE" }); await loadServices(); await loadTrash(); } catch (err) { alert(err.message); }
    }));
  }
  document.getElementById("btn-new-service").addEventListener("click", () => {
    document.getElementById("panel-service-title").textContent = "Ajouter un service";
    document.getElementById("form-service").reset();
    document.getElementById("service-id").value = "";
    serviceDZ.reset(null);
    document.getElementById("panel-service").classList.add("open");
  });
  document.getElementById("cancel-service").addEventListener("click", () => document.getElementById("panel-service").classList.remove("open"));
  document.getElementById("form-service").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("service-id").value;
    const fd = new FormData();
    ["titre","prix","description","statut","ordre"].forEach((k) => fd.append(k, document.getElementById("service-" + k).value));
    const file = serviceDZ.getFile();
    if (file) fd.append("file", file);
    try {
      await apiForm(id ? "/services/" + id : "/services", id ? "PUT" : "POST", fd);
      document.getElementById("panel-service").classList.remove("open");
      await loadServices();
    } catch (err) { alert(err.message); }
  });

  /* ================= FORMATIONS ================= */
  const formationDZ = wireDropzone({ zoneId:"formation-dropzone", inputId:"formation-file", previewWrapId:"formation-preview-wrap", textId:"formation-dropzone-text", defaultText:"Image (facultatif) — cliquez ou glissez-déposez" });
  async function loadFormations() {
    const { formations } = await api("/formations");
    const tbody = document.querySelector("#table-formations tbody");
    if (!formations.length) { tbody.innerHTML = `<tr><td colspan="7" class="admin-table-empty">Aucune formation.</td></tr>`; return; }
    const rows = await Promise.all(formations.map(async (f) => {
      let nbInscrits = "—";
      try { const r = await api("/formations/" + f.id + "/inscriptions"); nbInscrits = r.inscriptions.length; } catch (e) {}
      return `<tr>
        <td>${f.image ? `<img class="thumb" src="${esc(f.image)}" alt="">` : "—"}</td>
        <td>${esc(f.titre)}</td>
        <td>${esc(f.date_session || "—")}</td>
        <td>${esc(f.places || 0)}</td>
        <td><span class="admin-tag ${f.statut === "actif" ? "ok" : "warn"}">${f.statut === "actif" ? "Actif" : "Inactif"}</span></td>
        <td>
          <button class="admin-icon-btn" data-insc="${f.id}">${nbInscrits} inscrit(s)</button><br>
          <a class="admin-icon-btn" href="/api/admin/formations/${f.id}/inscriptions/report.pdf" target="_blank" style="display:inline-block; margin-top:.3rem">PDF inscrits</a>
          <button class="admin-icon-btn danger" data-reset-insc="${f.id}" style="margin-top:.3rem">Réinitialiser</button>
        </td>
        <td class="admin-row-actions">
          <button class="admin-icon-btn" data-edit="${f.id}">Modifier</button>
          <button class="admin-icon-btn danger" data-del="${f.id}">Supprimer</button>
        </td>
      </tr>`;
    }));
    tbody.innerHTML = rows.join("");
    tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
      const f = formations.find(x => x.id == b.dataset.edit);
      document.getElementById("panel-formation-title").textContent = "Modifier la formation";
      document.getElementById("formation-id").value = f.id;
      document.getElementById("formation-titre").value = f.titre;
      document.getElementById("formation-description").value = f.description || "";
      document.getElementById("formation-programme").value = f.programme || "";
      document.getElementById("formation-prix").value = f.prix || "";
      document.getElementById("formation-duree").value = f.duree || "";
      document.getElementById("formation-date").value = f.date_session || "";
      document.getElementById("formation-lieu").value = f.lieu || "";
      document.getElementById("formation-places").value = f.places || 0;
      document.getElementById("formation-statut").value = f.statut;
      formationDZ.reset(f.image);
      document.getElementById("panel-formation").classList.add("open");
    }));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Déplacer cette formation vers la corbeille ? (récupérable 30 jours)")) return;
      try { await api("/formations/" + b.dataset.del, { method: "DELETE" }); await loadFormations(); await loadTrash(); } catch (err) { alert(err.message); }
    }));
    tbody.querySelectorAll("[data-insc]").forEach((b) => b.addEventListener("click", async () => {
      try {
        const { inscriptions } = await api("/formations/" + b.dataset.insc + "/inscriptions");
        if (!inscriptions.length) { alert("Aucune inscription pour cette formation."); return; }
        alert(inscriptions.map((i) => `${i.nom} — ${i.email}${i.telephone ? " — " + i.telephone : ""} [${i.statut}]`).join("\n"));
      } catch (err) { alert(err.message); }
    }));
    tbody.querySelectorAll("[data-reset-insc]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Réinitialiser le nombre d'inscrits de cette formation ?\n\nLes inscriptions actuelles seront déplacées vers la Corbeille (récupérables 30 jours), et le compteur repartira de zéro.")) return;
      try {
        const r = await apiJson("/formations/" + b.dataset.resetInsc + "/inscriptions/reset", "POST", {});
        alert(`${r.count} inscription(s) déplacée(s) vers la corbeille.`);
        await loadFormations(); await loadTrash();
      } catch (err) { alert(err.message); }
    }));
  }
  document.getElementById("btn-new-formation").addEventListener("click", () => {
    document.getElementById("panel-formation-title").textContent = "Ajouter une formation";
    document.getElementById("form-formation").reset();
    document.getElementById("formation-id").value = "";
    formationDZ.reset(null);
    document.getElementById("panel-formation").classList.add("open");
  });
  document.getElementById("cancel-formation").addEventListener("click", () => document.getElementById("panel-formation").classList.remove("open"));
  document.getElementById("form-formation").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("formation-id").value;
    const fd = new FormData();
    ["titre","description","programme","prix","duree","statut","places"].forEach((k) => fd.append(k, document.getElementById("formation-" + k).value));
    fd.append("date_session", document.getElementById("formation-date").value);
    fd.append("lieu", document.getElementById("formation-lieu").value);
    const file = formationDZ.getFile();
    if (file) fd.append("file", file);
    try {
      await apiForm(id ? "/formations/" + id : "/formations", id ? "PUT" : "POST", fd);
      document.getElementById("panel-formation").classList.remove("open");
      await loadFormations();
    } catch (err) { alert(err.message); }
  });

  /* ================= BOUTIQUE (PRODUITS) ================= */
  const productDZ = wireDropzone({ zoneId:"product-dropzone", inputId:"product-file", previewWrapId:"product-preview-wrap", textId:"product-dropzone-text", defaultText:"Fichier haute résolution — cliquez ou glissez-déposez" });
  async function loadProducts() {
    const { products } = await api("/products");
    const tbody = document.querySelector("#table-products tbody");
    tbody.innerHTML = products.length ? products.map((p) => `
      <tr>
        <td><img class="thumb" src="${esc(p.apercu)}" alt=""></td>
        <td>${esc(p.titre)}</td>
        <td>${money(p.prix)}</td>
        <td><span class="admin-tag ${p.statut === "actif" ? "ok" : "warn"}">${p.statut === "actif" ? "Actif" : "Inactif"}</span></td>
        <td class="admin-row-actions">
          <button class="admin-icon-btn" data-edit="${p.id}">Modifier</button>
          <button class="admin-icon-btn danger" data-del="${p.id}">Supprimer</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="5" class="admin-table-empty">Aucun produit en vente.</td></tr>`;
    tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
      const p = products.find(x => x.id == b.dataset.edit);
      document.getElementById("panel-product-title").textContent = "Modifier le produit";
      document.getElementById("product-id").value = p.id;
      document.getElementById("product-titre").value = p.titre;
      document.getElementById("product-prix").value = p.prix;
      document.getElementById("product-description").value = p.description || "";
      document.getElementById("product-licence").value = p.licence;
      document.getElementById("product-statut").value = p.statut;
      productDZ.reset(p.apercu);
      document.getElementById("panel-product").classList.add("open");
    }));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Déplacer ce produit vers la corbeille ? (récupérable 30 jours)")) return;
      try { await api("/products/" + b.dataset.del, { method: "DELETE" }); await loadProducts(); await loadTrash(); } catch (err) { alert(err.message); }
    }));
  }
  document.getElementById("btn-new-product").addEventListener("click", () => {
    document.getElementById("panel-product-title").textContent = "Ajouter un produit";
    document.getElementById("form-product").reset();
    document.getElementById("product-id").value = "";
    productDZ.reset(null);
    document.getElementById("panel-product").classList.add("open");
  });
  document.getElementById("cancel-product").addEventListener("click", () => document.getElementById("panel-product").classList.remove("open"));
  document.getElementById("form-product").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("product-id").value;
    const fd = new FormData();
    ["titre","prix","description","licence","statut"].forEach((k) => fd.append(k, document.getElementById("product-" + k).value));
    const file = productDZ.getFile();
    if (file) fd.append("file", file);
    if (!id && !file) { alert("Veuillez sélectionner le fichier haute résolution."); return; }
    try {
      await apiForm(id ? "/products/" + id : "/products", id ? "PUT" : "POST", fd);
      document.getElementById("panel-product").classList.remove("open");
      await loadProducts();
    } catch (err) { alert(err.message); }
  });

  /* ================= COMMANDES ================= */
  const ORDER_STATUTS = [
    ["en_attente", "En attente"], ["payee", "Payée"], ["echouee", "Échouée"],
    ["annulee", "Annulée"], ["livree", "Livrée"]
  ];

  function initReportButton() {
    const dateInput = document.getElementById("report-date");
    const link = document.getElementById("report-download");
    const today = new Date();
    const isoToday = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
    dateInput.value = isoToday;
    function updateHref() { link.href = "/api/admin/orders/report.pdf?date=" + encodeURIComponent(dateInput.value || isoToday); }
    updateHref();
    dateInput.addEventListener("change", updateHref);
  }
  initReportButton();

  async function loadOrders() {
    const { orders } = await api("/orders");
    const tbody = document.querySelector("#table-orders tbody");
    tbody.innerHTML = orders.length ? orders.map((o) => `
      <tr>
        <td>${esc(o.numero)}<br><span class="admin-tag">${(o.items || []).map(i => esc(i.titre)).join(", ")}</span></td>
        <td>${esc(o.client_nom)}<br><span class="admin-tag">${esc(o.client_email)}</span></td>
        <td>${money(o.montant)}</td>
        <td>${dateFr(o.created_at)}</td>
        <td>
          <select data-statut="${o.id}" class="admin-tag">
            ${ORDER_STATUTS.map(([v, l]) => `<option value="${v}" ${o.statut === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </td>
        <td class="admin-row-actions"><button class="admin-icon-btn danger" data-del-order="${o.id}">Supprimer</button></td>
      </tr>`).join("") : `<tr><td colspan="6" class="admin-table-empty">Aucune commande.</td></tr>`;
    tbody.querySelectorAll("[data-statut]").forEach((sel) => sel.addEventListener("change", async () => {
      try {
        await apiJson("/orders/" + sel.dataset.statut + "/statut", "PATCH", { statut: sel.value });
        await loadOrders(); await loadDashboard();
      } catch (err) { alert(err.message); }
    }));
    tbody.querySelectorAll("[data-del-order]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Supprimer définitivement cette commande ?\n\nContrairement aux autres suppressions de la plateforme, une commande n'est PAS récupérable via la Corbeille (c'est un enregistrement comptable) — cette action est irréversible.")) return;
      try {
        await api("/orders/" + b.dataset.delOrder, { method: "DELETE" });
        await loadOrders(); await loadDashboard();
      } catch (err) { alert(err.message); }
    }));
  }

  /* ================= MESSAGES ================= */
  const MSG_STATUTS = [["non_lu","Non lu"],["lu","Lu"],["traite","Traité"]];
  async function loadMessages() {
    const { messages } = await api("/messages");
    const tbody = document.querySelector("#table-messages tbody");
    tbody.innerHTML = messages.length ? messages.map((m) => `
      <tr>
        <td>${esc(m.nom)}</td>
        <td>${esc(m.email)}${m.telephone ? "<br>" + esc(m.telephone) : ""}</td>
        <td>${esc((m.sujet ? m.sujet + " — " : "") + m.message).slice(0,120)}</td>
        <td>${dateFr(m.created_at)}</td>
        <td><select data-statut="${m.id}" class="admin-tag">${MSG_STATUTS.map(([v,l]) => `<option value="${v}" ${m.statut===v?"selected":""}>${l}</option>`).join("")}</select></td>
        <td class="admin-row-actions"><button class="admin-icon-btn danger" data-del="${m.id}">Supprimer</button></td>
      </tr>`).join("") : `<tr><td colspan="6" class="admin-table-empty">Aucun message.</td></tr>`;
    tbody.querySelectorAll("[data-statut]").forEach((sel) => sel.addEventListener("change", async () => {
      try { await apiJson("/messages/" + sel.dataset.statut + "/statut", "PATCH", { statut: sel.value }); await loadDashboard(); } catch (err) { alert(err.message); }
    }));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Déplacer ce message vers la corbeille ? (récupérable 30 jours)")) return;
      try { await api("/messages/" + b.dataset.del, { method: "DELETE" }); await loadMessages(); await loadTrash(); await loadDashboard(); } catch (err) { alert(err.message); }
    }));
  }

  /* ================= TÉMOIGNAGES ================= */
  const TESTIMONIAL_STATUTS = { en_attente: "En attente", publie: "Publié", rejete: "Non retenu" };
  const TESTIMONIAL_TAG_CLASS = { en_attente: "warn", publie: "ok", rejete: "bad" };
  async function loadTestimonials() {
    const filter = document.getElementById("testimonials-filter").value;
    const { testimonials } = await api("/testimonials" + (filter ? "?statut=" + filter : ""));
    const tbody = document.querySelector("#table-testimonials tbody");
    tbody.innerHTML = testimonials.length ? testimonials.map((t) => `
      <tr>
        <td>${esc(t.nom)}</td>
        <td>${"★".repeat(t.note)}${"☆".repeat(5 - t.note)}</td>
        <td>${esc(t.texte).slice(0, 140)}${t.texte.length > 140 ? "…" : ""}</td>
        <td>${dateFr(t.created_at)}</td>
        <td><span class="admin-tag ${TESTIMONIAL_TAG_CLASS[t.statut] || ""}">${TESTIMONIAL_STATUTS[t.statut] || t.statut}</span></td>
        <td class="admin-row-actions">
          ${t.statut !== "publie" ? `<button class="admin-icon-btn" data-pub="${t.id}">Publier</button>` : ""}
          ${t.statut !== "rejete" ? `<button class="admin-icon-btn" data-rej="${t.id}">Rejeter</button>` : ""}
          <button class="admin-icon-btn danger" data-del="${t.id}">Supprimer</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="6" class="admin-table-empty">Aucun témoignage${filter ? " pour ce statut" : ""}.</td></tr>`;

    tbody.querySelectorAll("[data-pub]").forEach((b) => b.addEventListener("click", async () => {
      try { await apiJson("/testimonials/" + b.dataset.pub + "/statut", "PATCH", { statut: "publie" }); await loadTestimonials(); await loadDashboard(); } catch (err) { alert(err.message); }
    }));
    tbody.querySelectorAll("[data-rej]").forEach((b) => b.addEventListener("click", async () => {
      try { await apiJson("/testimonials/" + b.dataset.rej + "/statut", "PATCH", { statut: "rejete" }); await loadTestimonials(); await loadDashboard(); } catch (err) { alert(err.message); }
    }));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Supprimer définitivement ce témoignage ? (pas de corbeille pour les témoignages)")) return;
      try { await api("/testimonials/" + b.dataset.del, { method: "DELETE" }); await loadTestimonials(); await loadDashboard(); } catch (err) { alert(err.message); }
    }));
  }
  document.getElementById("testimonials-filter").addEventListener("change", loadTestimonials);

  /* ================= PARAMETRES ================= */
  const profilePhotoDZ = wireDropzone({ zoneId:"profile-photo-dropzone", inputId:"profile-photo-file", previewWrapId:"profile-photo-preview-wrap", textId:"profile-photo-dropzone-text", defaultText:"Photo du photographe (portrait recommandé) — cliquez ou glissez-déposez" });

  async function loadSettings() {
    const { settings } = await api("/settings");
    Object.keys(settings).forEach((k) => {
      const el = document.getElementById("s-" + k);
      if (el) el.value = settings[k];
    });
    profilePhotoDZ.reset(settings.photographe_photo || null);
  }
  document.getElementById("form-settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fields = ["site_nom","photographe_nom","slogan","bio","ville","email","telephone_1","telephone_2","whatsapp","whatsapp_message","instagram","facebook","site_url","gallery_retention_days","gallery_recovery_price","gallery_hd_access_hours"];
    const body = {};
    fields.forEach((k) => { const el = document.getElementById("s-" + k); if (el) body[k] = el.value; });
    try {
      await apiJson("/settings", "PUT", body);
      const file = profilePhotoDZ.getFile();
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        await apiForm("/settings/photo-profil", "POST", fd);
      }
      alert("Paramètres enregistrés.");
    } catch (err) { alert(err.message); }
  });

  async function loadKkiapay() {
    const cfg = await api("/settings/kkiapay");
    document.getElementById("kk-enabled").checked = cfg.enabled;
    document.getElementById("kk-sandbox").checked = cfg.sandbox;
    document.getElementById("kk-public-key").value = cfg.public_key;
    document.getElementById("kk-webhook-url").value = cfg.webhook_url;
    document.getElementById("kk-webhook-secret").value = cfg.webhook_secret;
  }
  document.getElementById("form-kkiapay").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await apiJson("/settings/kkiapay", "PUT", {
        enabled: document.getElementById("kk-enabled").checked,
        sandbox: document.getElementById("kk-sandbox").checked,
        public_key: document.getElementById("kk-public-key").value
      });
      alert("Réglages KKiaPay enregistrés.");
    } catch (err) { alert(err.message); }
  });
  document.getElementById("kk-regenerate").addEventListener("click", async () => {
    if (!confirm("Régénérer le secret ? Vous devrez le remettre à jour dans votre tableau de bord KKiaPay.")) return;
    try {
      const r = await apiJson("/settings/kkiapay/regenerate-secret", "POST", {});
      document.getElementById("kk-webhook-secret").value = r.webhook_secret;
    } catch (err) { alert(err.message); }
  });
  document.getElementById("kk-clear-cache").addEventListener("click", async () => {
    if (!confirm("Vider le cache des paiements déjà validés ? Les commandes déjà payées et leurs liens de téléchargement ne sont pas affectés — seul le journal technique des notifications KKiaPay est effacé.")) return;
    try {
      const r = await apiJson("/settings/kkiapay/clear-cache", "POST", {});
      alert(`Cache vidé — ${r.count} entrée(s) supprimée(s).`);
    } catch (err) { alert(err.message); }
  });

  // GeniusPay : en préparation, voir le commentaire du formulaire dans
  // dashboard.html — seules les clés sont enregistrées pour l'instant, la
  // case "Activer" reste désactivée tant que la route de paiement et la
  // vérification du webhook n'ont pas été construites.
  async function loadGeniuspay() {
    const cfg = await api("/settings/geniuspay");
    document.getElementById("gp-sandbox").checked = cfg.sandbox;
    document.getElementById("gp-api-key").placeholder = cfg.api_key_configured ? "Clé déjà enregistrée — laisser vide pour ne pas la changer" : "pk_live_... ou pk_test_...";
    document.getElementById("gp-api-secret").placeholder = cfg.api_secret_configured ? "Secret déjà enregistré — laisser vide pour ne pas le changer" : "sk_live_... ou sk_test_...";
  }
  document.getElementById("form-geniuspay").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await apiJson("/settings/geniuspay", "PUT", {
        sandbox: document.getElementById("gp-sandbox").checked,
        api_key: document.getElementById("gp-api-key").value,
        api_secret: document.getElementById("gp-api-secret").value
      });
      document.getElementById("gp-api-key").value = "";
      document.getElementById("gp-api-secret").value = "";
      alert("Clés GeniusPay enregistrées. Le paiement effectif sera activé dans une prochaine mise à jour, une fois la documentation webhook intégrée.");
      await loadGeniuspay();
    } catch (err) { alert(err.message); }
  });

  async function loadNotify() {
    const cfg = await api("/settings/notifications");
    ["smtp_host","smtp_port","smtp_user","smtp_from_name","smtp_from_email","notify_webhook_url"].forEach((k) => {
      const el = document.getElementById("n-" + k);
      if (el) el.value = cfg[k] || "";
    });
    document.getElementById("n-smtp_secure").checked = cfg.smtp_secure;
    // Le mot de passe SMTP n'est jamais renvoyé par l'API par sécurité ;
    // on laisse le champ vide (il n'est mis à jour que si l'admin le retape).
  }
  document.getElementById("form-notify").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      smtp_host: document.getElementById("n-smtp_host").value,
      smtp_port: document.getElementById("n-smtp_port").value,
      smtp_secure: document.getElementById("n-smtp_secure").checked,
      smtp_user: document.getElementById("n-smtp_user").value,
      smtp_from_name: document.getElementById("n-smtp_from_name").value,
      smtp_from_email: document.getElementById("n-smtp_from_email").value
    };
    const pass = document.getElementById("n-smtp_pass").value;
    if (pass) body.smtp_pass = pass;
    try {
      await apiJson("/settings/notifications", "PUT", body);
      document.getElementById("n-smtp_pass").value = "";
      alert("Réglages de notification enregistrés.");
    } catch (err) { alert(err.message); }
  });
  document.getElementById("n-test-btn").addEventListener("click", async () => {
    try {
      await apiJson("/settings/notifications/test-email", "POST", {});
      alert("E-mail de test envoyé — vérifiez votre boîte de réception (et les indésirables).");
    } catch (err) { alert(err.message); }
  });
  document.getElementById("n-webhook-save").addEventListener("click", async () => {
    try {
      await apiJson("/settings/notifications", "PUT", { notify_webhook_url: document.getElementById("n-webhook_url").value });
      alert("Webhook enregistré.");
    } catch (err) { alert(err.message); }
  });

  /* ================= ASSISTANT IA — okim.box ================= */
  async function loadAssistant() {
    const cfg = await api("/settings/assistant");
    document.getElementById("as-enabled").checked = cfg.enabled;
    document.getElementById("as-name").value = cfg.name || "";
    document.getElementById("as-intro").value = cfg.intro || "";
    document.getElementById("as-model").value = cfg.model || "";
    const status = document.getElementById("as-key-status");
    status.textContent = cfg.api_key_configured ? "Clé configurée" : "Aucune clé";
    status.className = "admin-tag " + (cfg.api_key_configured ? "ok" : "warn");
    // La clé API n'est jamais renvoyée par l'API par sécurité ; le champ
    // reste vide (elle n'est mise à jour que si l'admin en saisit une nouvelle).
  }
  document.getElementById("form-assistant").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      enabled: document.getElementById("as-enabled").checked,
      name: document.getElementById("as-name").value,
      intro: document.getElementById("as-intro").value,
      model: document.getElementById("as-model").value
    };
    const key = document.getElementById("as-api-key").value;
    if (key) body.api_key = key;
    try {
      await apiJson("/settings/assistant", "PUT", body);
      document.getElementById("as-api-key").value = "";
      await loadAssistant();
      alert("Réglages de l'assistant enregistrés.");
    } catch (err) { alert(err.message); }
  });
  document.getElementById("as-test").addEventListener("click", async () => {
    const result = document.getElementById("as-test-result");
    result.style.display = "block";
    result.textContent = "Test en cours…";
    try {
      const res = await apiJson("/settings/assistant/test", "POST", {});
      result.textContent = "✓ Réponse reçue : « " + res.reply + " »";
    } catch (err) { result.textContent = "✗ " + err.message; }
  });

  let currentAdminRole = null;
  async function loadAdminProfile() {
    try {
      const res = await fetch("/api/auth/admin/me");
      if (!res.ok) return;
      const { admin } = await res.json();
      document.getElementById("admin-nom").value = admin.nom;
      document.getElementById("admin-email").value = admin.email;
      currentAdminRole = admin.role;
      if (admin.role !== "owner") {
        // Compte "employé" (secretary) : Paramètres et Corbeille sont hors
        // périmètre côté serveur (403 — voir requireSection/"systeme" et
        // requireOwner) — on masque aussi ces boutons ici pour ne pas
        // montrer des sections qui échoueraient de toute façon.
        const btnSettings = document.querySelector('#admin-nav button[data-section="settings"]');
        if (btnSettings) btnSettings.style.display = "none";
        const btnTrash = document.querySelector('#admin-nav button[data-section="trash"]');
        if (btnTrash) btnTrash.style.display = "none";
      }
    } catch (e) { /* non bloquant */ }
  }
  document.getElementById("form-admin-profile").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/auth/admin/profile", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nom: document.getElementById("admin-nom").value, email: document.getElementById("admin-email").value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert("Profil mis à jour.");
    } catch (err) { alert(err.message); }
  });
  document.getElementById("form-password").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await fetch("/api/auth/admin/password", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ancien_mot_de_passe: document.getElementById("p-ancien").value,
          nouveau_mot_de_passe: document.getElementById("p-nouveau").value
        })
      }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); });
      alert("Mot de passe modifié.");
      document.getElementById("form-password").reset();
    } catch (err) { alert(err.message); }
  });

  /* ================= COMPTES ADMINISTRATEURS (propriétaire uniquement) ================= */
  function roleLabel(role) {
    if (role === "owner") return "Propriétaire";
    if (role === "secretary") return "Secrétaire";
    return "Admin";
  }
  async function loadAdmins() {
    const res = await fetch("/api/admin/admins");
    if (!res.ok) return; // 403 si non-propriétaire : la section est de toute façon masquée
    const { admins } = await res.json();
    const tbody = document.querySelector("#table-admins tbody");
    tbody.innerHTML = admins.map((a) => `
      <tr>
        <td>${esc(a.nom)}</td>
        <td>${esc(a.email)}</td>
        <td><span class="admin-tag ${a.role === "owner" ? "ok" : ""}">${roleLabel(a.role)}</span></td>
        <td class="admin-row-actions">
          ${a.role === "owner" ? "" : `<button class="admin-icon-btn danger" data-del-admin="${a.id}">Supprimer</button>`}
        </td>
      </tr>`).join("");
    tbody.querySelectorAll("[data-del-admin]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Supprimer ce compte employé ? Il perdra immédiatement l'accès au tableau de bord.")) return;
      try {
        await api("/admins/" + b.dataset.delAdmin, { method: "DELETE" });
        await loadAdmins();
      } catch (err) { alert(err.message); }
    }));
  }
  const formNewAdmin = document.getElementById("form-new-admin");
  if (formNewAdmin) {
    formNewAdmin.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await apiJson("/admins", "POST", {
          nom: document.getElementById("na-nom").value,
          email: document.getElementById("na-email").value,
          password: document.getElementById("na-password").value,
          role: document.getElementById("na-role").value
        });
        formNewAdmin.reset();
        alert("Compte employé créé.");
        await loadAdmins();
      } catch (err) { alert(err.message); }
    });
  }

  /* ================= CORBEILLE ================= */
  const TRASH_TYPE_LABEL = { photos: "Photo", categories: "Catégorie", services: "Service", formations: "Formation", products: "Produit", messages: "Message", inscriptions: "Inscription formation" };

  async function loadTrash() {
    const { items, retention_days } = await api("/trash");
    document.getElementById("badge-trash").textContent = items.length;
    const tbody = document.querySelector("#table-trash tbody");
    tbody.innerHTML = items.length ? items.map((it) => `
      <tr>
        <td><span class="admin-tag">${esc(TRASH_TYPE_LABEL[it.entity_type] || it.entity_type)}</span></td>
        <td>${esc(it.label || ("#" + it.entity_id))}</td>
        <td>${dateFr(it.deleted_at)}</td>
        <td>${dateFr(it.purge_at)}</td>
        <td class="admin-row-actions">
          <button class="admin-icon-btn" data-restore="${it.id}">Restaurer</button>
          <button class="admin-icon-btn danger" data-purge="${it.id}">Supprimer définitivement</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="5" class="admin-table-empty">La corbeille est vide.</td></tr>`;

    tbody.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await apiJson("/trash/" + b.dataset.restore + "/restore", "POST", {});
        await loadTrash();
        await Promise.all([loadPhotos(), loadCategories(), loadCategoriesIntoSelect(), loadServices(), loadFormations(), loadProducts(), loadMessages(), loadDashboard()]);
      } catch (err) { alert(err.message); }
    }));
    tbody.querySelectorAll("[data-purge]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Supprimer définitivement cet élément ? Cette action est irréversible (fichiers compris).")) return;
      try {
        await api("/trash/" + b.dataset.purge, { method: "DELETE" });
        await loadTrash();
      } catch (err) { alert(err.message); }
    }));
  }
  document.getElementById("trash-empty-all").addEventListener("click", async () => {
    if (!confirm("Vider TOUTE la corbeille définitivement, sans attendre les 30 jours ? Cette action est irréversible.")) return;
    try {
      const r = await api("/trash", { method: "DELETE" });
      alert(`${r.count} élément(s) supprimé(s) définitivement.`);
      await loadTrash();
    } catch (err) { alert(err.message); }
  });

  /* ================= GALERIE CLIENT ================= */
  let sessionFiles = [];
  function wireMultiDropzone() {
    const zone = document.getElementById("session-dropzone");
    const input = document.getElementById("session-files");
    const previewWrap = document.getElementById("session-preview-wrap");
    const textEl = document.getElementById("session-dropzone-text");

    function render() {
      previewWrap.innerHTML = sessionFiles.map((f) => f.type.startsWith("video/")
        ? `<video src="${URL.createObjectURL(f)}" muted></video>`
        : `<img src="${URL.createObjectURL(f)}" alt="">`
      ).join("");
      const nbVideos = sessionFiles.filter((f) => f.type.startsWith("video/")).length;
      const nbPhotos = sessionFiles.length - nbVideos;
      textEl.textContent = sessionFiles.length
        ? `${nbPhotos} photo(s), ${nbVideos} vidéo(s) sélectionnée(s) — cliquez pour en ajouter d'autres`
        : "Cliquez ou glissez-déposez toutes les photos et vidéos de la séance (JPG, PNG, WEBP, MP4, WEBM, MOV)";
    }
    function addFiles(fileList) {
      sessionFiles = sessionFiles.concat(Array.from(fileList));
      render();
    }
    zone.addEventListener("click", () => input.click());
    input.addEventListener("change", () => { if (input.files.length) addFiles(input.files); input.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("drag"); }));
    zone.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    return { reset() { sessionFiles = []; render(); } };
  }
  const sessionDZ = wireMultiDropzone();

  // wa.me exige un numéro complet au format international (indicatif pays +
  // numéro, chiffres uniquement, sans "+" ni espaces). Les numéros béninois
  // sont généralement saisis localement (8 chiffres, ex. "97xxxxxx") sans
  // l'indicatif 229 — on le rajoute automatiquement dans ce cas précis.
  // Pour tout autre format (déjà avec indicatif, ou un numéro étranger), on
  // se contente de retirer les caractères non numériques, sans rien deviner
  // de plus.
  function normalizePhoneForWhatsapp(raw) {
    const digits = (raw || "").replace(/[^\d]/g, "");
    if (!digits) return null;
    if (digits.length === 8) return "229" + digits; // numéro béninois local, sans indicatif
    if (digits.startsWith("229") || digits.length > 8) return digits; // déjà avec indicatif (ou international)
    return digits; // repli : au moins tenter avec ce qui a été saisi
  }

  function openSessionPanel() {
    document.getElementById("form-session").style.display = "block";
    document.getElementById("session-created-panel").style.display = "none";
    document.getElementById("session-created-whatsapp").style.display = "none";
    document.getElementById("form-session").reset();
    sessionDZ.reset();
    document.getElementById("panel-session").classList.add("open");
  }
  document.getElementById("btn-new-session").addEventListener("click", openSessionPanel);
  document.getElementById("cancel-session").addEventListener("click", () => document.getElementById("panel-session").classList.remove("open"));
  document.getElementById("session-created-close").addEventListener("click", () => {
    document.getElementById("panel-session").classList.remove("open");
    document.getElementById("session-created-panel").style.display = "none";
    document.getElementById("form-session").style.display = "block";
  });

  document.getElementById("form-session").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sessionFiles.length) { alert("Sélectionnez au moins une photo pour cette séance."); return; }
    const btn = document.getElementById("session-submit-btn");
    btn.disabled = true; btn.textContent = "Envoi en cours…";
    try {
      const fd = new FormData();
      fd.append("client_name", document.getElementById("session-client-name").value);
      fd.append("client_phone", document.getElementById("session-client-phone").value);
      const retention = document.getElementById("session-retention").value;
      const price = document.getElementById("session-recovery-price").value;
      if (retention) fd.append("retention_days", retention);
      if (price) fd.append("recovery_price", price);
      sessionFiles.forEach((f) => fd.append("files", f));

      const r = await apiForm("/sessions", "POST", fd);
      document.getElementById("form-session").style.display = "none";
      document.getElementById("session-created-panel").style.display = "block";
      document.getElementById("session-created-link").value = r.session.link;
      document.getElementById("session-created-pin").value = r.pin;

      // Lien WhatsApp pré-rempli avec le lien de la galerie et le code PIN —
      // "le premier code d'ouverture" : ce PIN n'est affiché qu'une seule
      // fois (voir le commentaire du panneau), donc ce bouton n'a de sens
      // qu'à cet instant précis, juste après la création de la séance.
      const waBtn = document.getElementById("session-created-whatsapp");
      const clientName = document.getElementById("session-client-name").value.trim();
      const phoneDigits = normalizePhoneForWhatsapp(document.getElementById("session-client-phone").value);
      if (phoneDigits) {
        const message = `Bonjour ${clientName || ""},\n\nVoici l'accès à vos photos et vidéos OKIM ART :\n\n📷 Galerie : ${r.session.link}\n🔑 Code PIN : ${r.pin}\n\nCe code est personnel, merci de ne pas le partager.\n\nÀ bientôt !`;
        waBtn.href = "https://wa.me/" + phoneDigits + "?text=" + encodeURIComponent(message);
        waBtn.style.display = "inline-flex";
      } else {
        // Pas de numéro exploitable (champ vide ou format non reconnu) :
        // le bouton reste caché plutôt que d'ouvrir WhatsApp sans destinataire.
        waBtn.style.display = "none";
      }

      await loadSessions();
      await loadDashboard();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false; btn.textContent = "Créer la séance";
    }
  });

  const SESSION_STATUT_LABEL = { active: "Active", archived: "Archivée" };
  let sessionsCache = [];
  async function loadSessions() {
    const { sessions } = await api("/sessions");
    sessionsCache = sessions;
    renderSessions(sessionsCache);
  }
  function renderSessions(sessions) {
    const tbody = document.querySelector("#table-sessions tbody");
    tbody.innerHTML = sessions.length ? sessions.map((s) => `
      <tr>
        <td>${esc(s.client_name)}${s.client_phone ? "<br><span class=\"admin-tag\">" + esc(s.client_phone) + "</span>" : ""}</td>
        <td>${s.nb_photos}${s.nb_videos ? ` + ${s.nb_videos} vidéo(s)` : ""}</td>
        <td><span class="admin-tag ${s.status === "active" ? "ok" : "warn"}">${SESSION_STATUT_LABEL[s.status] || s.status}</span></td>
        <td>${dateFr(s.expires_at)}</td>
        <td>${s.has_hd_access ? '<span class="admin-tag ok">Oui</span>' : '<span class="admin-tag warn">Non (payant)</span>'}</td>
        <td class="admin-row-actions">
          <button class="admin-icon-btn" data-copy="${esc(s.link)}">Copier le lien</button>
          <button class="admin-icon-btn" data-regen="${s.id}">Nouveau PIN</button>
          <button class="admin-icon-btn danger" data-del="${s.id}">Supprimer</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="6" class="admin-table-empty">${sessions === sessionsCache ? "Aucune séance créée." : "Aucune séance ne correspond à cette recherche."}</td></tr>`;

    tbody.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copié ✓"; setTimeout(() => b.textContent = "Copier le lien", 1200); }
      catch (e) { prompt("Copiez ce lien :", b.dataset.copy); }
    }));
    tbody.querySelectorAll("[data-regen]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Générer un nouveau code PIN ? L'ancien cessera immédiatement de fonctionner.")) return;
      try {
        const r = await apiJson("/sessions/" + b.dataset.regen + "/regenerate-pin", "POST", {});
        alert("Nouveau code PIN : " + r.pin + "\n\nNotez-le maintenant — il ne sera plus jamais affiché.");
      } catch (err) { alert(err.message); }
    }));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Supprimer définitivement cette séance et toutes ses photos ? Cette action est irréversible (pas de corbeille pour la galerie client).")) return;
      try { await api("/sessions/" + b.dataset.del, { method: "DELETE" }); await loadSessions(); await loadDashboard(); }
      catch (err) { alert(err.message); }
    }));
  }
  const sessionSearchInput = document.getElementById("session-search");
  // Recherche insensible aux accents : sur un clavier de téléphone, on tape
  // souvent "aicha" sans réfléchir à l'accent de "Aïcha" — sans cette
  // normalisation, la recherche ne trouverait jamais ce genre de nom.
  function normalizeSearch(s) {
    return (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }
  if (sessionSearchInput) {
    sessionSearchInput.addEventListener("input", () => {
      const q = normalizeSearch(sessionSearchInput.value.trim());
      if (!q) { renderSessions(sessionsCache); return; }
      renderSessions(sessionsCache.filter((s) =>
        normalizeSearch(s.client_name).includes(q) ||
        normalizeSearch(s.client_phone).includes(q)
      ));
    });
  }

  /* ================= LOGICIELS ================= */
  const swDZ = wireDropzone({ zoneId:"sw-dropzone", inputId:"sw-file", previewWrapId:"sw-preview-wrap", textId:"sw-dropzone-text", defaultText:"Image / logo affiché sur la carte — cliquez ou glissez-déposez" });
  let currentSoftwareId = null; // id du PRODUIT (products.id), pas de software_products.id
  const SW_PERIOD_LABEL = { unique:"Paiement unique", mensuel:"Mensuel", annuel:"Annuel" };

  async function loadSoftwareCategorySelect() {
    const sel = document.getElementById("sw-category");
    sel.innerHTML = `<option value="">— Aucune —</option>` + categoriesCache.map((c) => `<option value="${c.id}">${esc(c.nom)}</option>`).join("");
  }

  async function loadSoftwareList() {
    const { software } = await api("/software");
    const tbody = document.querySelector("#table-software tbody");
    tbody.innerHTML = software.length ? software.map((s) => `
      <tr>
        <td><img class="thumb" src="${esc(s.apercu)}" alt=""></td>
        <td>${esc(s.titre)}${s.badge ? `<br><span class="admin-tag">${esc(s.badge)}</span>` : ""}</td>
        <td>${s.nb_plans}</td>
        <td>${s.nb_licenses}</td>
        <td><span class="admin-tag ${s.statut === "actif" ? "ok" : "warn"}">${s.statut === "actif" ? "Actif" : "Inactif"}</span></td>
        <td class="admin-row-actions">
          <button class="admin-icon-btn" data-edit="${s.id}">Gérer</button>
          <button class="admin-icon-btn danger" data-del="${s.id}">Supprimer</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="6" class="admin-table-empty">Aucun logiciel pour le moment.</td></tr>`;
    tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openSoftwarePanel(b.dataset.edit)));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteSoftware(b.dataset.del)));
  }

  async function openSoftwarePanel(id) {
    const panel = document.getElementById("panel-software");
    document.getElementById("form-software").reset();
    if (!id) {
      currentSoftwareId = null;
      document.getElementById("panel-software-title").textContent = "Ajouter un logiciel";
      document.getElementById("sw-id").value = "";
      document.getElementById("sw-statut").value = "actif";
      swDZ.reset(null);
      document.getElementById("sw-subpanels").style.display = "none";
      panel.classList.add("open");
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const { software: s } = await api("/software/" + id);
    currentSoftwareId = s.id;
    document.getElementById("panel-software-title").textContent = "Modifier : " + s.titre;
    document.getElementById("sw-id").value = s.id;
    document.getElementById("sw-titre").value = s.titre;
    document.getElementById("sw-description").value = s.description || "";
    document.getElementById("sw-category").value = s.category_id || "";
    document.getElementById("sw-statut").value = s.statut;
    document.getElementById("sw-slogan").value = s.software.slogan || "";
    document.getElementById("sw-badge").value = s.software.badge || "";
    document.getElementById("sw-description-longue").value = s.software.description_longue || "";
    document.getElementById("sw-probleme-resolu").value = s.software.probleme_resolu || "";
    document.getElementById("sw-public-cible").value = s.software.public_cible || "";
    document.getElementById("sw-plateforme").value = s.software.plateforme || "";
    document.getElementById("sw-systeme-compatible").value = s.software.systeme_compatible || "";
    document.getElementById("sw-taille").value = s.software.taille || "";
    document.getElementById("sw-configuration-min").value = s.software.configuration_min || "";
    document.getElementById("sw-licence-type").value = s.software.licence_type || "";
    document.getElementById("sw-demo-url").value = s.software.demo_url || "";
    document.getElementById("sw-video-url").value = s.software.video_url || "";
    swDZ.reset(s.apercu);

    document.getElementById("sw-subpanels").style.display = "block";
    renderCaptures(s.software.captures || []);
    renderPlans(s.plans || []);
    renderVersions(s.versions || []);

    panel.classList.add("open");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  document.getElementById("btn-new-software").addEventListener("click", () => openSoftwarePanel(null));
  document.getElementById("cancel-software").addEventListener("click", () => document.getElementById("panel-software").classList.remove("open"));

  document.getElementById("form-software").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("sw-id").value;
    const fd = new FormData();
    ["titre","description","statut","slogan","badge"].forEach((k) => fd.append(k, document.getElementById("sw-" + k).value));
    fd.append("category_id", document.getElementById("sw-category").value);
    fd.append("description_longue", document.getElementById("sw-description-longue").value);
    fd.append("probleme_resolu", document.getElementById("sw-probleme-resolu").value);
    fd.append("public_cible", document.getElementById("sw-public-cible").value);
    fd.append("plateforme", document.getElementById("sw-plateforme").value);
    fd.append("systeme_compatible", document.getElementById("sw-systeme-compatible").value);
    fd.append("taille", document.getElementById("sw-taille").value);
    fd.append("configuration_min", document.getElementById("sw-configuration-min").value);
    fd.append("licence_type", document.getElementById("sw-licence-type").value);
    fd.append("demo_url", document.getElementById("sw-demo-url").value);
    fd.append("video_url", document.getElementById("sw-video-url").value);
    const file = swDZ.getFile();
    if (file) fd.append("apercu", file);
    try {
      const { software: s } = await apiForm(id ? "/software/" + id : "/software", id ? "PUT" : "POST", fd);
      await loadSoftwareList(); await loadDashboard();
      if (!id) openSoftwarePanel(s.id); // bascule en mode édition pour permettre l'ajout de formules/versions
    } catch (err) { alert(err.message); }
  });

  async function deleteSoftware(id) {
    if (!confirm("Supprimer définitivement ce logiciel (formules et versions comprises) ? Refusé s'il existe déjà des licences émises — passez-le en \"inactif\" dans ce cas.")) return;
    try { await api("/software/" + id, { method: "DELETE" }); document.getElementById("panel-software").classList.remove("open"); await loadSoftwareList(); await loadDashboard(); }
    catch (err) { alert(err.message); }
  }

  /* ---- Captures d'écran ---- */
  function renderCaptures(urls) {
    document.getElementById("sw-captures-list").innerHTML = urls.length ? urls.map((u) => `
      <div style="position:relative; display:inline-block; margin:0 .5rem .5rem 0">
        <img src="${esc(u)}" alt="" style="width:110px; height:80px; object-fit:cover; border-radius:8px">
        <button type="button" class="admin-icon-btn danger" data-capture="${esc(u)}" style="position:absolute; top:2px; right:2px; padding:.1rem .4rem; font-size:.7rem">✕</button>
      </div>`).join("") : `<p style="font-size:.82rem; color:var(--admin-muted,#8a8577)">Aucune capture pour le moment.</p>`;
    document.querySelectorAll("[data-capture]").forEach((b) => b.addEventListener("click", async () => {
      try { await apiJson("/software/" + currentSoftwareId + "/captures", "DELETE", { url: b.dataset.capture }); await openSoftwarePanel(currentSoftwareId); }
      catch (err) { alert(err.message); }
    }));
  }
  document.getElementById("sw-captures-upload").addEventListener("click", async () => {
    const input = document.getElementById("sw-captures-file");
    if (!currentSoftwareId) { alert("Enregistrez d'abord le logiciel."); return; }
    if (!input.files || !input.files.length) { alert("Sélectionnez au moins une image."); return; }
    const fd = new FormData();
    Array.from(input.files).forEach((f) => fd.append("captures", f));
    try { await apiForm("/software/" + currentSoftwareId + "/captures", "POST", fd); input.value = ""; await openSoftwarePanel(currentSoftwareId); }
    catch (err) { alert(err.message); }
  });

  /* ---- Formules (plans) ---- */
  function renderPlans(plans) {
    const tbody = document.querySelector("#table-sw-plans tbody");
    tbody.innerHTML = plans.length ? plans.map((p) => `
      <tr>
        <td>${esc(p.nom)}</td><td>${money(p.prix)}</td><td>${SW_PERIOD_LABEL[p.periodicite] || p.periodicite}</td>
        <td>${p.max_devices}</td><td>${p.max_users}</td>
        <td><span class="admin-tag ${p.statut === "actif" ? "ok" : "warn"}">${p.statut === "actif" ? "Actif" : "Inactif"}</span></td>
        <td class="admin-row-actions">
          <button class="admin-icon-btn" data-edit-plan="${p.id}">Modifier</button>
          <button class="admin-icon-btn danger" data-del-plan="${p.id}">Supprimer</button>
        </td>
      </tr>`).join("") : `<tr><td colspan="7" class="admin-table-empty">Aucune formule — ce logiciel n'est pas encore achetable.</td></tr>`;
    tbody.querySelectorAll("[data-edit-plan]").forEach((b) => b.addEventListener("click", () => {
      const p = plans.find((x) => x.id == b.dataset.editPlan);
      document.getElementById("swp-id").value = p.id;
      document.getElementById("swp-nom").value = p.nom;
      document.getElementById("swp-description").value = p.description || "";
      document.getElementById("swp-prix").value = p.prix;
      document.getElementById("swp-periodicite").value = p.periodicite;
      document.getElementById("swp-max-devices").value = p.max_devices;
      document.getElementById("swp-max-users").value = p.max_users;
      document.getElementById("swp-statut").value = p.statut;
      document.getElementById("swp-fonctionnalites").value = (p.fonctionnalites || []).join("\n");
      document.getElementById("swp-submit-btn").textContent = "Modifier cette formule";
      document.getElementById("form-sw-plan").scrollIntoView({ behavior: "smooth", block: "center" });
    }));
    tbody.querySelectorAll("[data-del-plan]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Supprimer cette formule ? Refusé si des commandes/licences y font déjà référence.")) return;
      try { await api("/software/plans/" + b.dataset.delPlan, { method: "DELETE" }); await openSoftwarePanel(currentSoftwareId); }
      catch (err) { alert(err.message); }
    }));
  }
  function resetPlanForm() {
    document.getElementById("form-sw-plan").reset();
    document.getElementById("swp-id").value = "";
    document.getElementById("swp-submit-btn").textContent = "Ajouter cette formule";
  }
  document.getElementById("swp-cancel").addEventListener("click", resetPlanForm);
  document.getElementById("form-sw-plan").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentSoftwareId) { alert("Enregistrez d'abord le logiciel."); return; }
    const id = document.getElementById("swp-id").value;
    const body = {
      nom: document.getElementById("swp-nom").value,
      description: document.getElementById("swp-description").value,
      prix: Number(document.getElementById("swp-prix").value),
      periodicite: document.getElementById("swp-periodicite").value,
      max_devices: Number(document.getElementById("swp-max-devices").value) || 1,
      max_users: Number(document.getElementById("swp-max-users").value) || 1,
      statut: document.getElementById("swp-statut").value,
      fonctionnalites: document.getElementById("swp-fonctionnalites").value.split("\n").map((s) => s.trim()).filter(Boolean)
    };
    try {
      await apiJson(id ? "/software/plans/" + id : "/software/" + currentSoftwareId + "/plans", id ? "PUT" : "POST", body);
      resetPlanForm();
      await openSoftwarePanel(currentSoftwareId);
    } catch (err) { alert(err.message); }
  });

  /* ---- Versions ---- */
  function renderVersions(versions) {
    const tbody = document.querySelector("#table-sw-versions tbody");
    tbody.innerHTML = versions.length ? versions.map((v) => `
      <tr>
        <td>${esc(v.version)}</td><td><span class="admin-tag">${esc(v.type_maj)}</span></td>
        <td>${dateFr(v.published_at)}</td><td>${esc((v.notes || "").slice(0, 80))}</td>
        <td class="admin-row-actions"><button class="admin-icon-btn danger" data-del-version="${v.id}">Supprimer</button></td>
      </tr>`).join("") : `<tr><td colspan="5" class="admin-table-empty">Aucune version publiée — le téléchargement ne sera pas disponible côté client.</td></tr>`;
    tbody.querySelectorAll("[data-del-version]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Supprimer définitivement cette version (fichier compris) ?")) return;
      try { await api("/software/versions/" + b.dataset.delVersion, { method: "DELETE" }); await openSoftwarePanel(currentSoftwareId); }
      catch (err) { alert(err.message); }
    }));
  }
  document.getElementById("form-sw-version").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentSoftwareId) { alert("Enregistrez d'abord le logiciel."); return; }
    const file = document.getElementById("swv-file").files[0];
    if (!file) { alert("Sélectionnez un fichier."); return; }
    const fd = new FormData();
    fd.append("version", document.getElementById("swv-version").value);
    fd.append("type_maj", document.getElementById("swv-type").value);
    fd.append("compatibilite", document.getElementById("swv-compatibilite").value);
    fd.append("notes", document.getElementById("swv-notes").value);
    fd.append("file", file);
    try {
      await apiForm("/software/" + currentSoftwareId + "/versions", "POST", fd);
      document.getElementById("form-sw-version").reset();
      await openSoftwarePanel(currentSoftwareId);
    } catch (err) { alert(err.message); }
  });

  /* ================= LICENCES ================= */
  let softwareForLicenseCache = [];
  async function loadLicenseSoftwareSelect() {
    const { software } = await api("/software");
    softwareForLicenseCache = software;
    const sel = document.getElementById("lic-software");
    sel.innerHTML = software.map((s) => `<option value="${s.software_id}">${esc(s.titre)}</option>`).join("");
    await loadLicensePlanSelect();
  }
  async function loadLicensePlanSelect() {
    const softwareId = document.getElementById("lic-software").value;
    const sel = document.getElementById("lic-plan");
    sel.innerHTML = `<option value="">— Aucune (licence libre) —</option>`;
    if (!softwareId) return;
    try {
      const { software: s } = await api("/software/" + softwareForLicenseCache.find(x => x.software_id == softwareId).id);
      (s.plans || []).forEach((p) => { sel.innerHTML += `<option value="${p.id}">${esc(p.nom)} — ${money(p.prix)}</option>`; });
    } catch (e) { /* ignore */ }
  }
  document.getElementById("lic-software").addEventListener("change", loadLicensePlanSelect);

  const LIC_STATUT_LABEL = { active:"Active", expiree:"Expirée", suspendue:"Suspendue", annulee:"Annulée" };
  async function loadLicenses() {
    const q = document.getElementById("lic-search").value.trim();
    const status = document.getElementById("lic-filter-status").value;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    const { licenses } = await api("/licenses" + (params.toString() ? "?" + params.toString() : ""));
    const tbody = document.querySelector("#table-licenses tbody");
    tbody.innerHTML = licenses.length ? licenses.map((l) => `
      <tr>
        <td><span class="admin-tag" style="font-family:var(--mono)">${esc(l.license_key)}</span></td>
        <td>${esc(l.logiciel_nom)}${l.plan_nom ? `<br><span class="admin-tag">${esc(l.plan_nom)}</span>` : ""}</td>
        <td>${l.client_nom ? esc(l.client_nom) + "<br><span class=\"admin-tag\">" + esc(l.client_email) + "</span>" : "—"}</td>
        <td>
          <select data-statut="${l.id}" class="admin-tag">
            ${Object.entries(LIC_STATUT_LABEL).map(([v, lb]) => `<option value="${v}" ${l.status===v?"selected":""}>${lb}</option>`).join("")}
          </select>
        </td>
        <td>${l.expires_at ? dateFr(l.expires_at) : "Permanente"}</td>
        <td class="admin-row-actions"><button class="admin-icon-btn" data-extend="${l.id}">+30 jours</button></td>
      </tr>`).join("") : `<tr><td colspan="6" class="admin-table-empty">Aucune licence.</td></tr>`;
    tbody.querySelectorAll("[data-statut]").forEach((sel) => sel.addEventListener("change", async () => {
      try { await apiJson("/licenses/" + sel.dataset.statut + "/status", "PATCH", { status: sel.value }); await loadDashboard(); } catch (err) { alert(err.message); }
    }));
    tbody.querySelectorAll("[data-extend]").forEach((b) => b.addEventListener("click", async () => {
      try { await apiJson("/licenses/" + b.dataset.extend + "/extend", "POST", { days: 30 }); await loadLicenses(); } catch (err) { alert(err.message); }
    }));
  }
  document.getElementById("lic-search").addEventListener("input", () => loadLicenses());
  document.getElementById("lic-filter-status").addEventListener("change", () => loadLicenses());
  document.getElementById("btn-new-license").addEventListener("click", async () => {
    await loadLicenseSoftwareSelect();
    document.getElementById("panel-license").classList.add("open");
    document.getElementById("panel-license").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.getElementById("cancel-license").addEventListener("click", () => document.getElementById("panel-license").classList.remove("open"));
  document.getElementById("form-license").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      software_id: Number(document.getElementById("lic-software").value),
      plan_id: document.getElementById("lic-plan").value ? Number(document.getElementById("lic-plan").value) : null,
      client_id: document.getElementById("lic-client-id").value ? Number(document.getElementById("lic-client-id").value) : null,
      periodicite: document.getElementById("lic-periodicite").value,
      max_devices: Number(document.getElementById("lic-max-devices").value) || 1,
      max_users: Number(document.getElementById("lic-max-users").value) || 1
    };
    try {
      await apiJson("/licenses", "POST", body);
      document.getElementById("panel-license").classList.remove("open");
      document.getElementById("form-license").reset();
      await loadLicenses();
    } catch (err) { alert(err.message); }
  });

  /* ================= BOOT ================= */
  async function boot() {
    initNav();
    try {
      await Promise.all([loadDashboard(), loadCategoriesIntoSelect(), loadAdminNotifications()]);
      await loadAdminProfile();
      await Promise.all([loadPhotos(), loadCategories(), loadServices(), loadFormations(), loadProducts(), loadOrders(), loadMessages(), loadTestimonials(), loadTrash(), loadSessions(), loadSettings(), loadKkiapay(), loadGeniuspay(), loadNotify(), loadAssistant(), loadAdmins(), loadSoftwareList(), loadLicenses()]);
      await loadSoftwareCategorySelect();
      // Rafraîchit la cloche de notifications en tâche de fond, sans
      // recharger toutes les autres sections (léger, appel unique).
      setInterval(() => loadAdminNotifications().catch(() => {}), 45000);
    } catch (err) {
      console.error(err);
    }
  }
})();