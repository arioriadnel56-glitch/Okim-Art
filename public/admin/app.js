/**
 * OKIM ART - Admin Panel Client Engine
 * Vanilla JS Application
 */

(function () {
  "use strict";

  // ==========================================
  // 1. GLOBALS & HELPERS
  // ==========================================

  let categoriesCache = [];
  let activeSessionUpload = null;

  const SESSION_BATCH_SIZE = 15;
  const SESSION_BATCH_MAX_BYTES = 150 * 1024 * 1024; // 150 MB

  function money(amount) {
    const value = Number(amount) || 0;
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "XOF",
      maximumFractionDigits: 0
    }).format(value);
  }

  function dateFr(isoString) {
    if (!isoString) return "-";
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    }).format(date);
  }

  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizePhoneForWhatsapp(phone) {
    if (!phone) return "";
    let cleaned = String(phone).replace(/\D/g, "");
    if (cleaned.length === 8) {
      cleaned = "229" + cleaned;
    }
    return cleaned;
  }

  // Requête API classique (GET / DELETE)
  async function api(endpoint, options = {}) {
    try {
      const res = await fetch(`/api/admin${endpoint}`, {
        headers: { "Accept": "application/json" },
        ...options
      });
      if (res.status === 401) {
        window.location.href = "login.html";
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error(`API Error [${endpoint}]:`, err);
      return null;
    }
  }

  // Requête API JSON (POST / PUT / PATCH)
  async function apiJson(endpoint, data, method = "POST") {
    try {
      const res = await fetch(`/api/admin${endpoint}`, {
        method: method,
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(data)
      });
      if (res.status === 401) {
        window.location.href = "login.html";
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error(`API JSON Error [${endpoint}]:`, err);
      return null;
    }
  }

  // Requête API FormData AVEC SUIVI DE PROGRESSION (XMLHttpRequest)
  function apiFormWithProgress(endpoint, formData, onProgress, method = "POST") {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      if (xhr.upload && onProgress) {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            onProgress(e.loaded, e.total);
          }
        });
      }

      xhr.addEventListener("load", () => {
        if (xhr.status === 401) {
          window.location.href = "login.html";
          return reject(new Error("Non autorisé (401)"));
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            resolve({ success: true });
          }
        } else {
          reject(new Error(`Erreur HTTP ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Erreur réseau pendant le téléversement")));
      xhr.open(method, `/api/admin${endpoint}`);
      xhr.send(formData);
    });
  }

  function wireDropzone(zoneEl, inputEl, previewEl, options = {}) {
    if (!zoneEl || !inputEl) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      zoneEl.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => zoneEl.classList.add('highlight'));
    ['dragleave', 'drop'].forEach(eventName => zoneEl.classList.remove('highlight'));

    zoneEl.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      inputEl.files = files;
      handleFiles(files);
    });

    inputEl.addEventListener('change', () => handleFiles(inputEl.files));

    function handleFiles(files) {
      if (!previewEl || files.length === 0) return;
      previewEl.innerHTML = "";
      Array.from(files).forEach(file => {
        const item = document.createElement("div");
        item.className = "preview-item";
        if (file.type.startsWith("image/")) {
          const img = document.createElement("img");
          img.src = URL.createObjectURL(file);
          item.appendChild(img);
        } else {
          item.textContent = file.name;
        }
        previewEl.appendChild(item);
      });
      if (options.onChange) options.onChange(files);
    }
  }

  // ==========================================
  // 2. DASHBOARD & NOTIFICATIONS
  // ==========================================

  async function loadDashboard() {
    const data = await api("/dashboard");
    if (!data) return;

    const setTxt = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setTxt("stat-photos", data.photosCount || 0);
    setTxt("stat-orders", data.ordersCount || 0);
    setTxt("stat-revenue", money(data.totalRevenue));
    setTxt("stat-enrollments", data.enrollmentsCount || 0);
    setTxt("stat-licenses", data.licensesCount || 0);
    setTxt("stat-downloads", data.downloadsCount || 0);
  }

  async function resetDashboardCounters() {
    if (!confirm("Voulez-vous réinitialiser l'affichage des compteurs ?")) return;
    const res = await apiJson("/dashboard/reset", {}, "POST");
    if (res && res.success) loadDashboard();
  }

  async function loadNotifications() {
    const notifs = await api("/notifications");
    if (!notifs || !Array.isArray(notifs)) return;

    const badge = document.getElementById("notif-badge");
    const list = document.getElementById("notif-list");
    
    const unreadCount = notifs.filter(n => !n.is_read).length;
    if (badge) {
      badge.textContent = unreadCount;
      badge.style.display = unreadCount > 0 ? "inline-block" : "none";
    }

    if (list) {
      list.innerHTML = notifs.map(n => `
        <div class="notif-item ${n.is_read ? '' : 'unread'}" data-target="${esc(n.target_hash || '#')}">
          <p class="notif-msg">${esc(n.message)}</p>
          <span class="notif-date">${dateFr(n.created_at)}</span>
        </div>
      `).join("");
    }
  }

  // ==========================================
  // 3. ENVOI PAR LOTS ET BARRE DE PROGRESSION
  // ==========================================

  async function uploadSessionFiles(sessionId, files, onProgress) {
    const fileArray = Array.from(files);
    let sentCount = activeSessionUpload ? activeSessionUpload.sentCount : 0;
    const totalFiles = fileArray.length;

    for (let i = sentCount; i < totalFiles; i += SESSION_BATCH_SIZE) {
      const batch = fileArray.slice(i, i + SESSION_BATCH_SIZE);
      const formData = new FormData();

      let batchBytes = 0;
      batch.forEach(f => {
        batchBytes += f.size;
        formData.append("photos", f);
      });

      if (batchBytes > SESSION_BATCH_MAX_BYTES) {
        alert("Un lot dépasse la taille maximale de 150 Mo.");
        break;
      }

      activeSessionUpload = { sessionId, sentCount: i };

      // Calcul dynamique de la progression globale
      await apiFormWithProgress(`/sessions/${sessionId}/photos`, formData, (batchLoaded, batchTotal) => {
        if (onProgress) {
          const currentBatchProgress = batchLoaded / batchTotal;
          const globalProgress = ((i + currentBatchProgress * batch.length) / totalFiles) * 100;
          onProgress(globalProgress, i + Math.floor(currentBatchProgress * batch.length), totalFiles);
        }
      });

      sentCount += batch.length;
      activeSessionUpload.sentCount = sentCount;

      if (onProgress) {
        onProgress((sentCount / totalFiles) * 100, sentCount, totalFiles);
      }
    }

    activeSessionUpload = null;
  }

  // ==========================================
  // 4. GALERIES & SÉANCES PHOTO CLIENTS
  // ==========================================

  async function loadSessions() {
    const sessions = await api("/sessions");
    const container = document.getElementById("sessions-list");
    if (!container || !Array.isArray(sessions)) return;

    container.innerHTML = sessions.map(s => {
      const phone = normalizePhoneForWhatsapp(s.client_phone);
      const waMessage = encodeURIComponent(`Bonjour ${s.client_name}, voici le lien vers votre galerie photo: ${window.location.origin}/gallery/${s.slug} (Code PIN: ${s.pin_code})`);
      const waUrl = `https://wa.me/${phone}?text=${waMessage}`;

      return `
        <div class="session-card" data-id="${s.id}" style="border: 1px solid #ddd; padding: 15px; margin-bottom: 15px; border-radius: 8px; background: #fff;">
          <h4>${esc(s.client_name)} — ${esc(s.title)}</h4>
          <p>Code PIN d'accès : <strong>${esc(s.pin_code)}</strong></p>
          
          <div class="session-upload-box" style="background: #f4f6f8; padding: 12px; border-radius: 6px; margin: 10px 0;">
            <input type="file" multiple class="session-files-input" id="files-session-${s.id}" accept="image/*" style="display:none;">
            
            <button type="button" class="btn-select-files" onclick="document.getElementById('files-session-${s.id}').click()">
              📁 Sélectionner les photos
            </button>
            <span class="files-count-label" style="margin-left: 10px; font-weight: 500;">0 photo sélectionnée</span>
            
            <!-- BLOC VISUEL DU PROCESSUS DE TÉLÉCHARGEMENT -->
            <div class="progress-wrapper" style="display:none; margin-top: 12px;">
              <div style="background:#e0e0e0; height:12px; border-radius:6px; overflow:hidden; width: 100%;">
                <div class="session-progress-bar" style="background:#2196F3; height:100%; width:0%; transition: width 0.2s;"></div>
              </div>
              <small class="progress-status" style="display:block; margin-top:6px; font-weight:bold; color:#333;">Initialisation...</small>
            </div>
            
            <div style="margin-top: 10px;">
              <button type="button" class="btn-upload-session" data-id="${s.id}" style="padding: 8px 16px; cursor: pointer;" disabled>
                🚀 Lancer le téléversement
              </button>
            </div>
          </div>

          <a href="${waUrl}" target="_blank" class="btn-whatsapp" style="color: #25D366; font-weight: bold; text-decoration: none;">
            📲 Partager par WhatsApp
          </a>
        </div>
      `;
    }).join("");

    // Attachement dynamique du processus de suivi à chaque séance
    container.querySelectorAll(".session-card").forEach(card => {
      const sessionId = card.dataset.id;
      const fileInput = card.querySelector(".session-files-input");
      const countLabel = card.querySelector(".files-count-label");
      const uploadBtn = card.querySelector(".btn-upload-session");
      const progressWrapper = card.querySelector(".progress-wrapper");
      const progressBar = card.querySelector(".session-progress-bar");
      const progressStatus = card.querySelector(".progress-status");

      if (!fileInput || !uploadBtn) return;

      fileInput.addEventListener("change", () => {
        const count = fileInput.files.length;
        if (countLabel) countLabel.textContent = `${count} photo(s) sélectionnée(s)`;
        uploadBtn.disabled = count === 0;
      });

      uploadBtn.addEventListener("click", async () => {
        if (!fileInput.files.length) return;

        uploadBtn.disabled = true;
        if (progressWrapper) progressWrapper.style.display = "block";

        try {
          await uploadSessionFiles(sessionId, fileInput.files, (percent, current, total) => {
            const rounded = Math.round(percent);
            if (progressBar) progressBar.style.width = `${rounded}%`;
            if (progressStatus) progressStatus.textContent = `Envoi en cours : ${rounded}% (${current}/${total} photos transférées)`;
          });

          if (progressStatus) progressStatus.textContent = "✅ Galerie mise à jour avec succès !";
          fileInput.value = "";
          if (countLabel) countLabel.textContent = "0 photo sélectionnée";

          setTimeout(() => {
            if (progressWrapper) progressWrapper.style.display = "none";
            if (progressBar) progressBar.style.width = "0%";
            uploadBtn.disabled = true;
          }, 3500);

        } catch (err) {
          if (progressStatus) progressStatus.textContent = `❌ Erreur : ${err.message}`;
          uploadBtn.disabled = false;
        }
      });
    });
  }

  // ==========================================
  // 5. INITIALISATION (BOOTSTRAP)
  // ==========================================

  async function boot() {
    const user = await api("/auth/admin/me");
    if (!user) return;

    if (user.role === "secretary") {
      document.querySelectorAll(".admin-only").forEach(el => el.style.display = "none");
    }

    loadDashboard();
    loadNotifications();
    loadSessions();

    const btnResetDash = document.getElementById("btn-reset-dashboard");
    if (btnResetDash) btnResetDash.addEventListener("click", resetDashboardCounters);

    wireDropzone(
      document.getElementById("portfolio-dropzone"),
      document.getElementById("portfolio-file-input"),
      document.getElementById("portfolio-preview")
    );
  }

  document.addEventListener("DOMContentLoaded", boot);

})();
