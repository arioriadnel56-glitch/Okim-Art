/* ==============================================================
   software.js — module public "Outils & Logiciels" : catalogue,
   filtres, et fiche produit détaillée.
   ============================================================== */
(function () {
  "use strict";
  var FCFA = new Intl.NumberFormat("fr-FR");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function badgeLabel(b) { return b === "nouveau" ? "Nouveau" : b === "populaire" ? "Populaire" : b === "promotion" ? "Promotion" : ""; }

  /* ---------------- CATALOGUE (logiciels.html) ---------------- */
  function renderCard(s) {
    var badge = badgeLabel(s.badge);
    return '<a class="sw-card" href="logiciel.html?id=' + s.id + '">' +
      (badge ? '<span class="sw-badge ' + s.badge + '">' + badge + '</span>' : '') +
      '<div class="thumb"><img src="' + esc(s.apercu) + '" alt="' + esc(s.nom) + '" loading="lazy"></div>' +
      '<div class="body">' +
        (s.categorie_nom ? '<span class="cat">' + esc(s.categorie_nom) + '</span>' : '') +
        '<h3>' + esc(s.nom) + '</h3>' +
        '<p class="slogan">' + esc(s.slogan || s.description || "") + '</p>' +
        '<span class="price-from">' + (s.prix_a_partir_de != null ? "à partir de " + FCFA.format(s.prix_a_partir_de) + " FCFA" : "Sur devis") + '</span>' +
        '<div class="actions">' +
          '<span class="btn btn-ghost">Découvrir</span>' +
        '</div>' +
      '</div></a>';
  }

  function initCatalog() {
    var grid = document.getElementById("sw-grid");
    if (!grid) return;
    var all = [];

    function applyFilters() {
      var q = (document.getElementById("sw-search").value || "").toLowerCase().trim();
      var cat = document.getElementById("sw-cat").value;
      var lic = document.getElementById("sw-licence").value;
      var filtered = all.filter(function (s) {
        if (q && !((s.nom || "") + " " + (s.description || "") + " " + (s.slogan || "")).toLowerCase().includes(q)) return false;
        if (cat && s.categorie !== cat) return false;
        if (lic && s.licence_type !== lic) return false;
        return true;
      });
      grid.innerHTML = filtered.map(renderCard).join("");
      document.getElementById("sw-empty").style.display = filtered.length ? "none" : "block";
    }

    function load() {
      var sort = document.getElementById("sw-sort").value;
      var url = "/api/software" + (sort ? "?sort=" + encodeURIComponent(sort) : "");
      fetch(url).then(function (r) { return r.json(); }).then(function (data) {
        all = data.software || [];
        var cats = {}, lics = {};
        all.forEach(function (s) { if (s.categorie) cats[s.categorie] = s.categorie_nom; if (s.licence_type) lics[s.licence_type] = true; });
        var catSelect = document.getElementById("sw-cat");
        Object.keys(cats).forEach(function (slug) {
          var opt = document.createElement("option"); opt.value = slug; opt.textContent = cats[slug]; catSelect.appendChild(opt);
        });
        var licSelect = document.getElementById("sw-licence");
        Object.keys(lics).forEach(function (l) {
          var opt = document.createElement("option"); opt.value = l; opt.textContent = l; licSelect.appendChild(opt);
        });
        applyFilters();
      }).catch(function () {
        document.getElementById("sw-empty").style.display = "block";
      });
    }

    ["sw-search", "sw-cat", "sw-licence"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", applyFilters);
      document.getElementById(id).addEventListener("change", applyFilters);
    });
    document.getElementById("sw-sort").addEventListener("change", load);
    load();
  }

  /* ---------------- FICHE PRODUIT (logiciel.html) ---------------- */
  function initDetail() {
    var root = document.getElementById("sw-detail-root");
    if (!root) return;
    var params = new URLSearchParams(location.search);
    var id = params.get("id");
    if (!id) { root.innerHTML = "<p class='shop-empty'>Logiciel introuvable.</p>"; return; }

    fetch("/api/software/" + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) throw new Error("introuvable");
      return r.json();
    }).then(function (data) {
      renderDetail(data.software);
    }).catch(function () {
      root.innerHTML = "<p class='shop-empty'>Ce logiciel n'est plus disponible.</p>";
    });
  }

  function renderDetail(s) {
    document.title = s.titre + " — OKIM ART";

    document.getElementById("sw-cat").textContent = s.categorie_nom || "Outils & Logiciels";
    document.getElementById("sw-title").textContent = s.titre;
    document.getElementById("sw-slogan").textContent = s.slogan || s.description || "";
    document.getElementById("sw-cover").src = s.apercu || "img/brand/logo.png";
    document.getElementById("sw-cover").alt = s.titre;

    var demoBtn = document.getElementById("sw-demo-btn");
    if (s.demo_url) { demoBtn.href = s.demo_url; demoBtn.target = "_blank"; demoBtn.rel = "noopener"; }
    else demoBtn.style.display = "none";

    // Présentation
    var presBlock = document.getElementById("sw-presentation");
    var pres = "";
    if (s.description_longue) pres += "<p>" + esc(s.description_longue).replace(/\n/g, "<br>") + "</p>";
    if (s.probleme_resolu) pres += "<p><strong>Problème résolu :</strong> " + esc(s.probleme_resolu) + "</p>";
    if (s.public_cible) pres += "<p><strong>Public cible :</strong> " + esc(s.public_cible) + "</p>";
    presBlock.innerHTML = pres || ("<p>" + esc(s.description || "") + "</p>");

    // Infos techniques
    var tech = [
      ["Plateforme", s.plateforme], ["Système compatible", s.systeme_compatible],
      ["Version actuelle", s.version_actuelle || (s.derniere_version && s.derniere_version.version)],
      ["Taille", s.taille], ["Configuration minimale", s.configuration_min],
      ["Type de licence", s.licence_type],
      ["Dernière mise à jour", s.derniere_version ? (s.derniere_version.published_at || "").slice(0, 10) : ""]
    ].filter(function (t) { return t[1]; });
    var techEl = document.getElementById("sw-tech");
    if (tech.length) {
      techEl.innerHTML = tech.map(function (t) { return "<div><dt>" + esc(t[0]) + "</dt><dd>" + esc(t[1]) + "</dd></div>"; }).join("");
    } else {
      document.getElementById("sw-tech-section").style.display = "none";
    }

    // Captures d'écran
    var captures = s.captures || [];
    var screensSection = document.getElementById("sw-screens-section");
    if (captures.length) {
      document.getElementById("sw-screens").innerHTML = captures.map(function (u) {
        return '<img src="' + esc(u) + '" alt="Capture d\u2019écran de ' + esc(s.titre) + '" loading="lazy">';
      }).join("");
    } else { screensSection.style.display = "none"; }

    // Vidéo de démonstration
    var videoSection = document.getElementById("sw-video-section");
    if (s.video_url) {
      var isEmbed = /youtube\.com|youtu\.be|vimeo\.com/.test(s.video_url);
      document.getElementById("sw-video").innerHTML = isEmbed
        ? '<iframe src="' + esc(toEmbedUrl(s.video_url)) + '" allowfullscreen></iframe>'
        : '<video src="' + esc(s.video_url) + '" controls></video>';
    } else { videoSection.style.display = "none"; }

    // Formules (plans)
    var plans = s.plans || [];
    var plansSection = document.getElementById("sw-plans-section");
    if (plans.length) {
      var maxPrice = Math.max.apply(null, plans.map(function (p) { return p.prix; }));
      document.getElementById("sw-plans").innerHTML = plans.map(function (p) {
        var feats = (p.fonctionnalites || []).map(function (f) { return "<li>" + esc(f) + "</li>"; }).join("");
        var period = p.periodicite === "mensuel" ? "/mois" : p.periodicite === "annuel" ? "/an" : "";
        return '<div class="sw-plan' + (p.prix === maxPrice && plans.length > 1 ? " featured" : "") + '">' +
          '<span class="plan-name">' + esc(p.nom) + '</span>' +
          (p.description ? '<p style="font-size:.85rem;color:var(--ink-soft);margin:0">' + esc(p.description) + '</p>' : '') +
          '<span class="plan-price">' + FCFA.format(p.prix) + ' FCFA<small> ' + period + '</small></span>' +
          '<ul>' + feats + '</ul>' +
          '<button class="btn btn-primary" data-plan="' + p.id + '" data-product="' + s.id + '" data-titre="' + esc(s.titre + " — " + p.nom) + '" data-prix="' + p.prix + '" data-img="' + esc(s.apercu) + '">Acheter maintenant</button>' +
        '</div>';
      }).join("");
      plansSection.querySelectorAll("[data-plan]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          window.OkimCart.add({
            id: "sw-" + btn.dataset.product + "-" + btn.dataset.plan,
            titre: btn.dataset.titre, prix: Number(btn.dataset.prix), img: btn.dataset.img,
            product_id: Number(btn.dataset.product), plan_id: Number(btn.dataset.plan)
          });
          btn.textContent = "Ajouté au panier ✓";
          setTimeout(function () { btn.textContent = "Acheter maintenant"; }, 1400);
        });
      });
    } else {
      plansSection.innerHTML = "<p class='shop-empty'>Aucune formule n'est disponible pour le moment. Contactez OKIM ART pour un devis.</p>";
    }
  }

  function toEmbedUrl(url) {
    var yt = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]+)/);
    if (yt) return "https://www.youtube.com/embed/" + yt[1];
    var vim = url.match(/vimeo\.com\/(\d+)/);
    if (vim) return "https://player.vimeo.com/video/" + vim[1];
    return url;
  }

  document.addEventListener("DOMContentLoaded", function () {
    initCatalog();
    initDetail();
  });
})();
