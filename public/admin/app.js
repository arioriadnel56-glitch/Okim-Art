/**
 * OKIM ART - Admin Panel Client Engine
 * Vanilla JS Application (Version ultra-sécurisée)
 */

(function () {
  "use strict";

  // ==========================================
  // 1. GLOBALS & HELPERS
  // ==========================================

  let categoriesCache = [];
  let activeSessionUpload = null; // État de reprise pour les uploads interrompus

  const SESSION_BATCH_SIZE = 15;
  const SESSION_BATCH_MAX_BYTES = 150 * 1024 * 1024; // 150 MB

  // Formater les devises en FCFA
  function money(amount) {
    const value = Number(amount) || 0;
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "XOF",
      maximumFractionDigits: 0
    }).format(value);
  }

  // Formater les dates ISO au format francophone
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

  // Échapper le HTML pour prévenir les failles XSS
  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Normalisation des chaînes pour recherche (insensible aux accents)
  function normalizeSearch(str) {
    if (!str) return "";
    return str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  // Formatage du numéro WhatsApp (Indicatif Bénin +229 par défaut si 8 chiffres)
  function normalizePhoneForWhatsapp(phone) {
    if (!phone) return "";
    let cleaned = String(phone).replace(/\D/g, "");
    if (cleaned.length === 8) {
      cleaned = "229" + cleaned;
    }
    return cleaned;
  }

  // API Call Wrapper (GET / DELETE) avec sécurisation JSON
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

      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn(`[API WARNING] Réponse non-JSON pour ${endpoint}:`, res.status);
        return null;
      }

      return await res.json();
    } catch (err) {
      console.error(`API Error [${endpoint}]:`, err);
      return null;
    }
  }

  // API Call Wrapper (JSON Payload)
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

      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        return { success: res.ok };
      }

      return await res.json();
    } catch (err) {
      console.error(`API JSON Error [${endpoint}]:`, err);
      return null;
    }
  }

  // API Call Wrapper avec suivi de progression XHR
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
            const data = JSON.parse(xhr.responseText);
            resolve(data);
          } catch (e) {
            resolve({ success: true, text: xhr.responseText });
          }
        } else {
          reject(new Error(`Erreur HTTP ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Erreur réseau")));
      xhr.open(method, `/api/admin${endpoint}`);
      xhr.send(formData);
    });
  }

  // Composant Réutilisable : Wire Dropzone
  function wireDropzone(zoneEl, inputEl, previewEl, options = {}) {
    if (!zoneEl || !inputEl) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      zoneEl.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      zoneEl.classList.add('highlight');
    });

    ['dragleave', 'drop'].forEach(eventName => {
      zoneEl.classList.remove('highlight');
    });

    zoneEl.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = dt.files;
      inputEl.files = files;
      handleFiles(files);
    });

    inputEl.addEventListener('change', () => {
      handleFiles(inputEl.files);
    });

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
        } else if (file.type.startsWith("video/")) {
          const video = document.createElement("video");
          video.src = URL.createObjectURL(file);
          video.controls = true;
          item.appendChild(video);
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
    if (!confirm("Voulez-vous réinitialiser l'affichage des compteurs du dashboard ?")) return;
    const res = await apiJson("/dashboard/reset", {}, "POST");
    if (res && res.success) {
      loadDashboard();
    }
  }

  async function loadNotifications() {
    const notifs = await api("/notifications");
    if (!notifs) return;

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

      list.querySelectorAll(".notif-item").forEach(item => {
        item.addEventListener("click", () => {
          const target = item.getAttribute("data-target");
          if (target && target !== "#") {
            window.location.hash = target;
          }
        });
      });
    }
  }

  // ==========================================
  // 3. PORTFOLIO (PHOTOS & VIDÉOS INTRO)
  // ==========================================

  function setPhotoUploadProgress(percent) {
    const bar = document.getElementById("upload-progress-bar");
    if (bar) {
      bar.style.width = `${percent}%`;
      bar.textContent = `${Math.round(percent)}%`;
    }
  }

  async function uploadShortVideoToCloudinary(file) {
    const sigData = await api("/signature/video");
    if (!sigData) throw new Error("Impossible d'obtenir la signature d'upload.");

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      
      formData.append("file", file);
      formData.append("api_key", sigData.apiKey);
      formData.append("timestamp", sigData.timestamp);
      formData.append("signature", sigData.signature);
      formData.append("folder", sigData.folder);

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const percent = (e.loaded / e.total) * 100;
          setPhotoUploadProgress(percent);
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const resp = JSON.parse(xhr.responseText);
          resolve(resp.secure_url);
        } else {
          reject(new Error("Échec de l'upload vers Cloudinary"));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Erreur réseau Cloudinary")));
      xhr.open("POST", `https://api.cloudinary.com/v1_1/${sigData.cloudName}/video/upload`);
      xhr.send(formData);
    });
  }

  async function handlePortfolioSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const videoRadio = document.getElementById("media-type-video");
    const isVideoMode = videoRadio ? videoRadio.checked : false;
    const fileInput = form.querySelector('input[type="file"]');
    
    if (!fileInput || !fileInput.files.length) {
      alert("Veuillez sélectionner un fichier.");
      return;
    }

    try {
      if (isVideoMode) {
        const videoFile = fileInput.files[0];
        const videoUrl = await uploadShortVideoToCloudinary(videoFile);
        
        await apiJson("/portfolio", {
          title: form.title ? form.title.value : "",
          category_id: form.category_id ? form.category_id.value : "",
          video_url: videoUrl,
          is_video: true
        });
      } else {
        const formData = new FormData(form);
        await apiFormWithProgress("/portfolio", formData, (loaded, total) => {
          const percent = (loaded / total) * 100;
          setPhotoUploadProgress(percent);
        });
      }
      
      form.reset();
      setPhotoUploadProgress(0);
      loadPortfolio();
    } catch (err) {
      alert(`Erreur lors de l'enregistrement: ${err.message}`);
    }
  }

  async function loadPortfolio() {
    const items = await api("/portfolio");
    const container = document.getElementById("portfolio-grid");
    if (!container || !Array.isArray(items)) return;

    container.innerHTML = items.map(item => `
      <div class="portfolio-card">
        ${item.is_video 
          ? `<video src="${esc(item.video_url)}" controls></video>` 
          : `<img src="${esc(item.image_url)}" alt="${esc(item.title)}">`}
        <div class="card-body">
          <h4>${esc(item.title)}</h4>
          <button class="btn-delete" data-id="${item.id}">Supprimer</button>
        </div>
      </div>
    `).join("");

    container.querySelectorAll(".btn-delete").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (confirm("Mettre cet élément à la corbeille ?")) {
          await api(`/portfolio/${btn.dataset.id}`, { method: "DELETE" });
          loadPortfolio();
        }
      });
    });
  }

  // ==========================================
  // 4. CATEGORIES, SERVICES & FORMATIONS
  // ==========================================

  async function loadCategories() {
    categoriesCache = await api("/categories") || [];
    if (!Array.isArray(categoriesCache)) return;

    const selects = document.querySelectorAll(".category-select");
    selects.forEach(select => {
      select.innerHTML = categoriesCache.map(c => 
        `<option value="${c.id}">${esc(c.name)}</option>`
      ).join("");
    });
  }

  async function loadFormations() {
    const list = await api("/formations");
    const container = document.getElementById("formations-list");
    if (!container || !Array.isArray(list)) return;

    container.innerHTML = list.map(f => `
      <div class="formation-item">
        <h3>${esc(f.title)}</h3>
        <p>Prix: ${money(f.price)} | Inscrits: ${f.enrolled_count || 0}</p>
        <button onclick="window.open('/api/admin/formations/${f.id}/report.pdf')">Rapport PDF</button>
        <button class="btn-reset-enrolled" data-id="${f.id}">Réinitialiser Inscrits</button>
      </div>
    `).join("");

    container.querySelectorAll(".btn-reset-enrolled").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (confirm("Réinitialiser la liste des inscrits pour cette formation ?")) {
          await apiJson(`/formations/${btn.dataset.id}/reset-enrolled`, {}, "POST");
          loadFormations();
        }
      });
    });
  }

  // ==========================================
  // 5. COMMANDES
  // ==========================================

  async function loadOrders() {
    const orders = await api("/orders");
    const tableBody = document.querySelector("#orders-table tbody");
    if (!tableBody || !Array.isArray(orders)) return;

    tableBody.innerHTML = orders.map(o => `
      <tr>
        <td>#${o.id}</td>
        <td>${esc(o.client_name)}</td>
        <td>${money(o.total)}</td>
        <td>
          <select class="status-select" data-id="${o.id}">
            <option value="en_attente" ${o.status === 'en_attente' ? 'selected' : ''}>En attente</option>
            <option value="payee" ${o.status === 'payee' ? 'selected' : ''}>Payée</option>
            <option value="livree" ${o.status === 'livree' ? 'selected' : ''}>Livrée</option>
          </select>
        </td>
        <td>
          <button class="btn-delete-order" data-id="${o.id}">Supprimer définitivement</button>
        </td>
      </tr>
    `).join("");

    tableBody.querySelectorAll(".status-select").forEach(select => {
      select.addEventListener("change", async (e) => {
        await apiJson(`/orders/${e.target.dataset.id}/status`, { status: e.target.value }, "PATCH");
      });
    });

    tableBody.querySelectorAll(".btn-delete-order").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (confirm("ATTENTION: La suppression d'une commande est définitive. Continuer ?")) {
          await api(`/orders/${btn.dataset.id}`, { method: "DELETE" });
          loadOrders();
        }
      });
    });
  }

  // ==========================================
  // 6. PARAMÈTRES & RBAC
  // ==========================================

  function applyRBAC(currentUser) {
    if (currentUser && currentUser.role === "secretary") {
      document.querySelectorAll(".admin-only").forEach(el => el.style.display = "none");
    }
  }

  async function loadSettings() {
    const settings = await api("/settings");
    const form = document.getElementById("settings-form");
    if (!form || !settings) return;

    if (form.bio) form.bio.value = settings.bio || "";
    if (form.phone) form.phone.value = settings.phone || "";
    if (form.retention_days) form.retention_days.value = settings.retention_days || 30;
  }

  // ==========================================
  // 7. CORBEILLE
  // ==========================================

  async function loadTrash() {
    const items = await api("/trash");
    const container = document.getElementById("trash-list");
    if (!container || !Array.isArray(items)) return;

    container.innerHTML = items.map(item => `
      <div class="trash-item">
        <span>[${esc(item.type)}] ${esc(item.title || item.name)}</span>
        <button class="btn-restore" data-type="${item.type}" data-id="${item.id}">Restaurer</button>
        <button class="btn-purge" data-type="${item.type}" data-id="${item.id}">Purger</button>
      </div>
    `).join("");

    container.querySelectorAll(".btn-restore").forEach(btn => {
      btn.addEventListener("click", async () => {
        await apiJson(`/trash/restore`, { type: btn.dataset.type, id: btn.dataset.id }, "POST");
        loadTrash();
      });
    });

    container.querySelectorAll(".btn-purge").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (confirm("Purger définitivement cet élément ?")) {
          await apiJson(`/trash/purge`, { type: btn.dataset.type, id: btn.dataset.id }, "DELETE");
          loadTrash();
        }
      });
    });
  }

  // ==========================================
  // 8. SÉANCES PHOTO CLIENTS (/sessions)
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
        alert("Le lot dépasse la taille maximale autorisée (150 Mo).");
        break;
      }

      activeSessionUpload = { sessionId, sentCount: i };

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

  async function loadSessions() {
    const sessions = await api("/sessions");
    const container = document.getElementById("sessions-list");
    if (!container || !Array.isArray(sessions)) return;

    container.innerHTML = sessions.map(s => {
      const phone = normalizePhoneForWhatsapp(s.client_phone);
      const waMessage = encodeURIComponent(`Bonjour ${s.client_name}, voici le lien vers votre galerie photo: ${window.location.origin}/gallery/${s.slug} (Code PIN: ${s.pin_code})`);
      const waUrl = `https://wa.me/${phone}?text=${waMessage}`;

      return `
        <div class="session-card" data-id="${s.id}">
          <h4>${esc(s.client_name)} (${esc(s.title)})</h4>
          <p>PIN: <strong>${esc(s.pin_code)}</strong></p>
          
          <div class="session-upload-box">
            <input type="file" multiple class="session-files-input" id="files-session-${s.id}" style="display:none;">
            <button class="btn-select-files" onclick="document.getElementById('files-session-${s.id}').click()">Sélectionner des photos</button>
            <span class="files-count-label">0 photo(s) sélectionnée(s)</span>
            
            <div class="progress-wrapper" style="display:none; margin-top:8px;">
              <div class="progress-bar-bg" style="background:#e0e0e0; height:10px; border-radius:5px; overflow:hidden;">
                <div class="session-progress-bar" style="background:#4caf50; height:100%; width:0%;"></div>
              </div>
              <small class="progress-status" style="display:block; margin-top:4px;">0%</small>
            </div>
            
            <button class="btn-upload-session" data-id="${s.id}" style="margin-top:8px;" disabled>Envoyer les photos</button>
          </div>

          <br>
          <a href="${waUrl}" target="_blank" class="btn-whatsapp">Partager sur WhatsApp</a>
        </div>
      `;
    }).join("");

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
            if (progressStatus) progressStatus.textContent = `Envoi en cours: ${rounded}% (${current}/${total} photos)`;
          });

          if (progressStatus) progressStatus.textContent = "Téléchargement terminé avec succès !";
          fileInput.value = "";
          if (countLabel) countLabel.textContent = "0 photo(s) sélectionnée(s)";
          
          setTimeout(() => {
            if (progressWrapper) progressWrapper.style.display = "none";
            if (progressBar) progressBar.style.width = "0%";
          }, 3000);
        } catch (err) {
          if (progressStatus) progressStatus.textContent = `Erreur: ${err.message}`;
          uploadBtn.disabled = false;
        }
      });
    });
  }

  // ==========================================
  // 9. LOGICIELS & LICENCES (/software)
  // ==========================================

  async function loadSoftware() {
    const items = await api("/software");
    const container = document.getElementById("software-list");
    if (!container || !Array.isArray(items)) return;

    container.innerHTML = items.map(sw => `
      <div class="software-card">
        <h3>${esc(sw.name)} (v${esc(sw.version)})</h3>
        <p>${esc(sw.description)}</p>
      </div>
    `).join("");
  }

  // ==========================================
  // 10. BOOTSTRAP
  // ==========================================

  async function boot() {
    const user = await api("/auth/admin/me");
    if (!user) return; // Redirection gérée si non authentifié

    applyRBAC(user);

    // Chargement défensif des modules
    loadDashboard();
    loadNotifications();
    loadCategories();
    loadPortfolio();
    loadFormations();
    loadOrders();
    loadSettings();
    loadTrash();
    loadSessions();
    loadSoftware();

    // Attacher événements globaux avec vérification
    const btnResetDash = document.getElementById("btn-reset-dashboard");
    if (btnResetDash) btnResetDash.addEventListener("click", resetDashboardCounters);

    const portfolioForm = document.getElementById("portfolio-form");
    if (portfolioForm) portfolioForm.addEventListener("submit", handlePortfolioSubmit);

    // Dropzone
    wireDropzone(
      document.getElementById("portfolio-dropzone"),
      document.getElementById("portfolio-file-input"),
      document.getElementById("portfolio-preview")
    );
  }

  document.addEventListener("DOMContentLoaded", boot);

})();
