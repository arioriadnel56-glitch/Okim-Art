// ============================================================
// adminAccess.js — restrictions transversales liées au rôle admin
// ============================================================
// Seul le compte "owner" voit l'identifiant du compte client (client_id)
// associé à une commande, une licence ou un témoignage — un compte
// "secretary" (ou tout rôle non-owner, par prudence) reçoit l'objet sans
// ce champ. Utilisé par routes/admin/orders.js, licenses.js, testimonials.js.
// N'altère jamais l'objet original (immutabilité — certains appelants
// réutilisent la ligne d'origine après l'avoir envoyée au client HTTP).
function redactClientId(row, req) {
  if (!row) return row;
  if (req.admin && req.admin.role === "owner") return row;
  const { client_id, ...rest } = row;
  return rest;
}

module.exports = { redactClientId };
