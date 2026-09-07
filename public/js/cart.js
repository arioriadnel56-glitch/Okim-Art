/* ==============================================================
   cart.js — panier léger stocké dans localStorage (aucune donnée
   sensible : uniquement id produit / titre / prix affiché / image).
   Le prix réel est de toute façon revérifié côté serveur à la
   création de la commande (voir server/routes/orders.js).
   ============================================================== */
window.OkimCart = (function () {
  "use strict";
  const KEY = "okimart_cart_v1";

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; }
  }
  function write(items) {
    localStorage.setItem(KEY, JSON.stringify(items));
    updateBadges();
  }
  function add(item) {
    const items = read();
    const existing = items.find((i) => String(i.id) === String(item.id));
    if (existing) existing.quantite += 1;
    // product_id/plan_id : présents uniquement pour un article "logiciel"
    // (formule choisie sur la fiche produit). Absents pour une photo —
    // le panier envoie alors product_id = id comme avant (comportement
    // inchangé, voir server/routes/orders.js).
    else items.push({
      id: item.id, titre: item.titre, prix: item.prix, img: item.img, quantite: 1,
      product_id: item.product_id !== undefined ? item.product_id : item.id,
      plan_id: item.plan_id !== undefined ? item.plan_id : null
    });
    write(items);
  }
  function remove(id) {
    write(read().filter((i) => String(i.id) !== String(id)));
  }
  function clear() { write([]); }
  function total() { return read().reduce((sum, i) => sum + i.prix * i.quantite, 0); }
  function count() { return read().reduce((sum, i) => sum + i.quantite, 0); }

  function updateBadges() {
    document.querySelectorAll("#cart-count").forEach((el) => { el.textContent = count(); });
  }
  document.addEventListener("DOMContentLoaded", updateBadges);

  return { read, add, remove, clear, total, count };
})();
