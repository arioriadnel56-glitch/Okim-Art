/* ==============================================================
   site-data.js — connecte le site public à l'API (données saisies
   depuis l'administration). Dégrade proprement : si l'API est
   indisponible, le contenu déjà présent dans le HTML (rédigé lors
   de la création du site) reste affiché tel quel.
   ============================================================== */
(function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const FCFA = new Intl.NumberFormat("fr-FR");

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("Requête échouée : " + url);
    return r.json();
  }

  /* ---------------- SETTINGS (contact, réseaux, textes) ---------------- */
  async function applySettings() {
    const { settings: s } = await getJSON("/api/settings");
    if (!s || !Object.keys(s).length) return;

    const waLink = "https://wa.me/" + (s.whatsapp || "") + "?text=" + encodeURIComponent(s.whatsapp_message || "");
    ["nav-whatsapp","hero-whatsapp","formation-whatsapp","contact-whatsapp","contact-whatsapp-2"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && s.whatsapp) { el.href = waLink; el.target = "_blank"; el.rel = "noopener"; }
    });
    const emailEl = document.getElementById("contact-email");
    if (emailEl && s.email) emailEl.href = "mailto:" + s.email;

    const setText = (id, val) => { const el = document.getElementById(id); if (el && val) el.textContent = val; };
    setText("email-text", s.email);
    setText("phone-text", s.telephone_1);
    setText("phone2-text", s.telephone_2);
    setText("city-text", s.ville);
    setText("hero-sub", s.slogan_longue || null); // optionnel, garde le texte existant sinon
    setText("about-p1", s.bio);

    const ig = document.getElementById("f-instagram"); if (ig && s.instagram) ig.href = s.instagram;
    const fb = document.getElementById("f-facebook"); if (fb && s.facebook) fb.href = s.facebook;

    document.querySelectorAll(".f-brand, .brand").forEach((el) => {
      const logoImg = el.querySelector(".brand-logo, .f-brand-logo");
      if (logoImg && s.logo) logoImg.src = s.logo;
      if (!s.site_nom) return;
      el.textContent = " " + s.site_nom;
      if (logoImg) el.prepend(logoImg);
    });
    if (s.seo_title) document.title = s.seo_title;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && s.seo_description) metaDesc.setAttribute("content", s.seo_description);

    const photoSlot = document.getElementById("profile-photo-slot");
    if (photoSlot && s.photographe_photo) {
      photoSlot.innerHTML = `<div class="profile-photo"><img src="${esc(s.photographe_photo)}" alt="${esc(s.photographe_nom || "Photographe")}"></div>`;
    }
  }

  /* ---------------- PORTFOLIO ---------------- */
  async function applyPortfolio() {
    const [{ categories }, { photos }] = await Promise.all([getJSON("/api/categories"), getJSON("/api/photos")]);
    if (!photos || !photos.length) return; // garde le portfolio de démonstration existant si rien n'est publié

    const filters = document.getElementById("filters");
    if (filters) {
      filters.innerHTML = `<button class="filter-btn active" data-filter="all">Tous</button>` +
        categories.map((c) => `<button class="filter-btn" data-filter="${esc(c.slug)}">${esc(c.nom)}</button>`).join("");
    }

    const gallery = document.getElementById("gallery");
    if (gallery) {
      gallery.innerHTML = photos.map((p, i) => `
        <div class="g-item${i % 5 === 0 ? " g-tall" : i % 7 === 0 ? " g-wide" : ""}${p.type === "video" ? " g-video" : ""}" data-cat="${esc(p.categorie || "")}">
          ${p.type === "video"
            ? `<video src="${esc(p.miniature)}" muted loop playsinline preload="metadata"></video><span class="g-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>`
            : `<img src="${esc(p.miniature)}" alt="${esc(p.titre)}" loading="lazy">`}
          <div class="caption"><span class="exif">${esc((p.categorie_nom || "PORTFOLIO").toUpperCase())}</span><span class="title">${esc(p.titre)}</span></div>
        </div>`).join("");

      // Les vidéos du portfolio se lisent au survol (desktop) et au tap
      // (mobile), en boucle et sans son — comme un aperçu, pas un lecteur complet.
      gallery.querySelectorAll(".g-video video").forEach((v) => {
        const card = v.closest(".g-item");
        card.addEventListener("mouseenter", () => v.play().catch(() => {}));
        card.addEventListener("mouseleave", () => { v.pause(); v.currentTime = 0; });
        card.addEventListener("click", () => { if (v.paused) v.play().catch(() => {}); else v.pause(); });
      });
    }

    if (filters) {
      const buttons = filters.querySelectorAll(".filter-btn");
      const items = gallery.querySelectorAll(".g-item");
      buttons.forEach((btn) => btn.addEventListener("click", () => {
        buttons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const f = btn.dataset.filter;
        items.forEach((it) => it.classList.toggle("hidden", !(f === "all" || it.dataset.cat === f)));
      }));
    }
  }

  /* ---------------- SERVICES ---------------- */
  async function applyServices() {
    const { services } = await getJSON("/api/services");
    if (!services || !services.length) return;
    const grid = document.querySelector(".services-grid");
    if (!grid) return;
    grid.innerHTML = services.map((s, i) => `
      <div class="service-card reveal in">
        <span class="num">${String(i + 1).padStart(2, "0")}</span>
        <div class="service-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="8"/></svg></div>
        <h3>${esc(s.titre)}</h3>
        <p>${esc(s.description)}</p>
      </div>`).join("");
  }

  /* ---------------- FORMATIONS ---------------- */
  async function applyFormations() {
    const { formations } = await getJSON("/api/formations");
    if (!formations || !formations.length) return;
    const list = document.querySelector(".formation-list");
    if (list) {
      list.innerHTML = formations.map((f) => `
        <div class="formation-item"><h3>${esc(f.titre)}</h3><span>${esc(f.description || f.duree || "")}</span></div>`).join("");
    }
    const select = document.getElementById("enroll-formation");
    if (select) {
      select.innerHTML = formations.map((f) => `<option value="${f.id}">${esc(f.titre)}</option>`).join("");
    }
  }

  /* Envoi d'un formulaire public : enregistré localement, envoyé avec clé d'idempotence (jamais en double),
     repris automatiquement si le serveur dort ou si la connexion tombe. Ne renvoie des données
     (= succès) QUE si le serveur a confirmé ; sinon null + message "en attente" honnête. */
  async function sendForm(kind, label, url, body, form, okEl, errEl) {
    const submitBtn = form.querySelector("[type=submit]");
    if (submitBtn) submitBtn.disabled = true;
    const noticeAnchor = okEl || form;
    try {
      if (!window.OkimApi) { // repli : comportement d'origine
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Échec de l'envoi.");
        return d;
      }
      OkimApi.ui.clearNotice(noticeAnchor);
      const r = await OkimApi.submit({ kind: kind, label: label, url: url, body: body });
      if (r.synced) return r.data || { ok: true };
      if (r.rejected) throw new Error(r.message || "Envoi refusé.");
      if (r.queued) {
        OkimApi.ui.notice(noticeAnchor, r.offline
          ? "Vous êtes hors connexion. Votre demande est conservée sur cet appareil et sera envoyée automatiquement dès le retour du réseau — elle n'est pas encore transmise."
          : "Le serveur met un peu de temps à répondre. Votre demande est conservée et sera renvoyée automatiquement — elle n'est pas encore confirmée.");
        form.reset();
        return null;
      }
      throw new Error("Envoi impossible pour le moment. Vos informations sont conservées, réessayez dans un instant.");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  /* ---------------- FORMULAIRE DE CONTACT ---------------- */
  function wireContactForm() {
    const form = document.getElementById("contact-form");
    if (!form) return;
    const ok = document.getElementById("contact-success");
    const err = document.getElementById("contact-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      ok.classList.remove("show"); err.classList.remove("show");
      const body = {
        nom: document.getElementById("contact-nom").value,
        email: document.getElementById("contact-form-email").value,
        telephone: document.getElementById("contact-telephone").value,
        sujet: document.getElementById("contact-sujet").value,
        message: document.getElementById("contact-message").value
      };
      try {
        const data = await sendForm("message", "Message de contact", "/api/messages", body, form, ok, err);
        if (data) { ok.classList.add("show"); form.reset(); }
      } catch (e2) {
        err.textContent = e2.message; err.classList.add("show");
      }
    });
  }

  /* ---------------- FORMULAIRE D'INSCRIPTION FORMATION ---------------- */
  function wireEnrollForm() {
    const form = document.getElementById("enroll-form");
    if (!form) return;
    const ok = document.getElementById("enroll-success");
    const err = document.getElementById("enroll-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      ok.classList.remove("show"); err.classList.remove("show");
      const formationId = document.getElementById("enroll-formation").value;
      const body = {
        nom: document.getElementById("enroll-nom").value,
        email: document.getElementById("enroll-email").value,
        telephone: document.getElementById("enroll-telephone").value
      };
      try {
        const data = await sendForm("inscription", "Inscription à une formation", `/api/formations/${encodeURIComponent(formationId)}/inscriptions`, body, form, ok, err);
        if (data) { ok.classList.add("show"); form.reset(); }
      } catch (e2) {
        err.textContent = e2.message; err.classList.add("show");
      }
    });
  }

  // Envoi différé confirmé par le serveur (file hors-ligne) : on retire la mention "en attente" et on affiche la confirmation.
  window.addEventListener("okim:synced", (ev) => {
    const kind = ev.detail && ev.detail.item && ev.detail.item.kind;
    const map = { message: "contact-success", inscription: "enroll-success" };
    if (!map[kind]) return;
    document.querySelectorAll(".okim-notice").forEach((n) => n.remove());
    const el = document.getElementById(map[kind]);
    if (el) el.classList.add("show");
  });

  document.addEventListener("DOMContentLoaded", () => {
    applySettings().catch(() => {});
    applyPortfolio().catch(() => {});
    applyServices().catch(() => {});
    applyFormations().catch(() => {});
    wireContactForm();
    wireEnrollForm();
  });
})();
