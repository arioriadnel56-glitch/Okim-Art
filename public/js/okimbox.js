// ============================================================
// okimbox.js — widget flottant de l'assistant IA public "okim.box"
// ============================================================
// Ne s'affiche que si l'assistant est activé côté admin (Paramètres →
// Assistant IA). Session anonyme par navigateur (aucun compte requis),
// conservée dans localStorage pour retrouver la conversation en cas de
// rechargement de page.
(function () {
  "use strict";
  var SESSION_KEY = "okimart_assistant_session";
  var HISTORY_KEY = "okimart_assistant_history";

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function getSessionId() {
    var id = localStorage.getItem(SESSION_KEY);
    return id || null;
  }
  function setSessionId(id) { localStorage.setItem(SESSION_KEY, id); }
  function loadHistory() {
    try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY)) || []; } catch (_) { return []; }
  }
  function saveHistory(h) {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-30))); } catch (_) {}
  }

  function buildWidget(cfg) {
    var initials = (cfg.name || "OB").replace(/[^A-Za-zÀ-ÿ]/g, "").slice(0, 2).toUpperCase();

    var launcher = document.createElement("button");
    launcher.id = "okimbox-launcher";
    launcher.setAttribute("aria-label", "Ouvrir l'assistant " + cfg.name);
    launcher.innerHTML =
      '<span class="ob-dot" aria-hidden="true"></span>' +
      '<svg class="ob-chat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>' +
      '<svg class="ob-close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';

    var win = document.createElement("div");
    win.id = "okimbox-window";
    win.innerHTML =
      '<div class="ob-header">' +
        '<span class="ob-avatar">' + esc(initials) + '</span>' +
        '<div><div class="ob-title">' + esc(cfg.name) + '</div><div class="ob-status">En ligne</div></div>' +
      '</div>' +
      '<div class="ob-messages" id="ob-messages"></div>' +
      '<form class="ob-form" id="ob-form">' +
        '<input type="text" id="ob-input" placeholder="Écrivez votre message…" autocomplete="off" maxlength="2000">' +
        '<button type="submit" aria-label="Envoyer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg></button>' +
      '</form>' +
      '<div class="ob-footer-note">Assistant automatisé — les réponses peuvent contenir des erreurs.</div>';

    document.body.appendChild(launcher);
    document.body.appendChild(win);

    var messagesEl = win.querySelector("#ob-messages");
    var form = win.querySelector("#ob-form");
    var input = win.querySelector("#ob-input");
    var sending = false;

    function addMessage(role, text) {
      var div = document.createElement("div");
      div.className = "ob-msg " + role;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }
    function addHandoffNote() {
      var div = document.createElement("div");
      div.className = "ob-msg handoff";
      div.textContent = "Un membre de l'équipe OKIM ART va prendre le relais sur cette demande.";
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function showTyping() {
      var div = document.createElement("div");
      div.className = "ob-typing";
      div.id = "ob-typing";
      div.innerHTML = "<span></span><span></span><span></span>";
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function hideTyping() {
      var t = document.getElementById("ob-typing");
      if (t) t.remove();
    }

    // Restaure l'historique déjà affiché dans cette session d'onglet.
    var history = loadHistory();
    if (history.length) {
      history.forEach(function (m) { addMessage(m.role === "user" ? "user" : "bot", m.text); });
    } else if (cfg.intro) {
      addMessage("bot", cfg.intro);
      history.push({ role: "assistant", text: cfg.intro });
      saveHistory(history);
    }

    function open() {
      win.classList.add("open");
      launcher.classList.add("open");
      launcher.querySelector(".ob-dot").style.display = "none";
      setTimeout(function () { input.focus(); }, 150);
    }
    function close() {
      win.classList.remove("open");
      launcher.classList.remove("open");
    }
    launcher.addEventListener("click", function () {
      win.classList.contains("open") ? close() : open();
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (sending) return;
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      addMessage("user", text);
      history.push({ role: "user", text: text });
      saveHistory(history);

      sending = true;
      input.disabled = true;
      showTyping();

      fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: getSessionId(), message: text })
      }).then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
        .then(function (res) {
          hideTyping();
          if (res.status !== 200) {
            addMessage("system", res.data.error || "L'assistant est momentanément indisponible.");
            return;
          }
          setSessionId(res.data.session_id);
          addMessage("bot", res.data.reply);
          history.push({ role: "assistant", text: res.data.reply });
          saveHistory(history);
          if (res.data.needs_human) addHandoffNote();
        })
        .catch(function () {
          hideTyping();
          addMessage("system", "Connexion impossible. Vérifiez votre connexion internet et réessayez.");
        })
        .finally(function () {
          sending = false;
          input.disabled = false;
          input.focus();
        });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    fetch("/api/assistant/config").then(function (r) { return r.json(); }).then(function (cfg) {
      if (cfg && cfg.enabled) buildWidget(cfg);
    }).catch(function () { /* assistant indisponible : le widget ne s'affiche simplement pas */ });
  });
})();
