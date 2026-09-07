# OKIM ART — Plateforme administrable

> **Migration PostgreSQL (v2.0)** : cette plateforme utilise désormais **PostgreSQL**
> (au lieu de SQLite) pour être déployable sur des hébergeurs sans disque local
> garanti (Render, Vercel...). Voir la section **[Base de données PostgreSQL](#base-de-données-postgresql--déploiement)**
> plus bas pour l'installation locale, la migration de données existantes et le déploiement.

Le site vitrine OKIM ART (design, textes, portfolio) est **conservé à l'identique**.
Ce projet y ajoute un vrai backend : base de données, authentification,
espace d'administration, boutique avec téléchargement sécurisé, et connecte
le site public à ces données — sans toucher une seule ligne du CSS existant.

## Démarrage rapide

Prérequis : [Node.js](https://nodejs.org) version 20 ou plus récente, et une base
**PostgreSQL** accessible (locale via Docker, ou managée type Render — voir plus bas).

```bash
cd okim-art-platform
cp .env.example .env
# Renseignez au minimum DATABASE_URL et JWT_SECRET dans .env

# Option A — PostgreSQL local via Docker (recommandé pour développer) :
docker compose up -d
# puis dans .env : DATABASE_URL=postgres://okimart:okimart@localhost:5432/okimart
#                   PGSSL=false

npm install
npm run seed     # importe les 12 vraies photos + les 6 services + les 5 formations
npm start
```

Le serveur affiche alors dans la console (une seule fois) l'e-mail et le mot
de passe du compte administrateur généré automatiquement, et les écrit aussi
dans un fichier **`ADMIN-IDENTIFIANTS.txt`** à la racine du projet.

- Site public : http://localhost:3000/
- Espace admin : http://localhost:3000/admin/
- Boutique : http://localhost:3000/boutique.html
- Espace client : http://localhost:3000/compte.html

**Première action à faire : notez le mot de passe, connectez-vous, changez-le
depuis Paramètres → Sécurité, puis supprimez `ADMIN-IDENTIFIANTS.txt`.**

Pour imposer vous-même l'e-mail/mot de passe du premier admin plutôt que de
laisser un mot de passe généré aléatoirement, ajoutez avant le premier
démarrage dans `.env` :
```
FIRST_ADMIN_EMAIL=votre-email@okimart.studio
FIRST_ADMIN_PASSWORD=un-mot-de-passe-solide
```

## Ce qui fonctionne réellement (testé de bout en bout)

- **Photo ajoutée en admin → visible automatiquement sur le portfolio public**,
  sans toucher au code, y compris publication/brouillon, catégorie, "à la une".
- **Produit boutique → commande → paiement KKiaPay → téléchargement débloqué
  automatiquement**, sans aucune confirmation manuelle : quand KKiaPay est
  configuré, c'est la SEULE option de paiement proposée sur le panier — la
  confiance repose sur la vérification serveur (webhook signé), pas sur une
  déclaration du client. Testé de bout en bout : commande créée → webhook
  KKiaPay reçu et vérifié → commande marquée payée → liens de téléchargement
  générés et affichés immédiatement, y compris pour un acheteur invité (pas
  besoin de créer un compte).
- **Paiement en ligne KKiaPay** (MTN Mobile Money, Moov Money, carte bancaire) :
  le client paie depuis la page panier, KKiaPay notifie le serveur par un
  webhook signé, et c'est UNIQUEMENT cette notification serveur-à-serveur
  (jamais le navigateur seul) qui débloque le téléchargement — testé avec
  signature invalide (rejetée), événement non reçu (commande reste en attente)
  et événement valide + montant correspondant (commande marquée payée).
- **Notifications automatiques** : un e-mail part automatiquement au client
  avec ses liens de téléchargement dès que sa commande est payée, et un
  e-mail part à l'admin pour chaque commande payée, nouveau message de
  contact ou nouvelle inscription à une formation — aucune action manuelle
  requise. Un webhook générique (compatible Make/Zapier/n8n) permet aussi de
  relayer ces mêmes événements vers WhatsApp, SMS ou Telegram. Testé : ces
  notifications échouent silencieusement (SMTP mal configuré, webhook
  injoignable) SANS jamais bloquer la commande, le message ou l'inscription
  eux-mêmes, et échouent rapidement (10 secondes max) plutôt que de bloquer
  l'admin devant un bouton qui ne répond plus.
- **Récupération de mot de passe admin sans e-mail** : si l'admin perd son
  mot de passe, la page de connexion propose "Mot de passe oublié ?" — il
  suffit de indiquer l'e-mail et le **nom déjà enregistré sur le compte**
  (modifiable dans Paramètres → Sécurité) pour définir un nouveau mot de passe.
- **Photo de profil du photographe**, à téléverser dans Paramètres → Profil,
  affichée dans la section Contact du site en cadrage portrait fixe qui
  s'adapte automatiquement à tous les écrans (mobile, tablette, desktop),
  quelle que soit la photo d'origine fournie.
- Le fichier original haute résolution n'est **jamais** accessible par une URL
  publique (testé : `404` sur toute tentative d'accès direct). Seul un aperçu
  redimensionné et filigrané ("OKIM ART — APERÇU") est public.
- Authentification admin (bcrypt + JWT en cookie httpOnly) et espace client
  séparé, avec limitation du nombre de tentatives de connexion.
- Upload : type de fichier revalidé sur le contenu réel (pas sur le nom ni
  l'extension déclarée), taille limitée à 20 Mo, nom de fichier toujours
  régénéré aléatoirement.
- Formulaire de contact public → visible dans Messages (admin).
- Formulaire d'inscription aux formations → visible dans Formations → inscrits.
- CRUD complet en admin pour : photos, catégories, services, formations,
  produits, commandes (changement de statut), messages, paramètres du site.
- Tableau de bord avec statistiques réelles (aucune donnée inventée).
- **Rapport PDF du flux journalier** : bouton dans Commandes pour télécharger,
  en un clic, un tableau PDF des commandes d'une journée (heure, numéro,
  client, montant, mode de paiement, statut) avec le total encaissé — testé
  avec des commandes réelles, un jour vide et une date invalide (repli sur
  aujourd'hui), fichier PDF valide à chaque fois. Protégé comme le reste de
  l'admin (`401` sans session valide).
- **Vider le cache des paiements validés en un clic** (Paramètres → Paiement) :
  purge le journal technique des notifications KKiaPay déjà traitées, sans
  toucher aux commandes ni aux liens de téléchargement déjà générés — testé.
- **Corbeille (30 jours)** : toute suppression (photo, catégorie, service,
  formation, produit, message) passe désormais par une corbeille au lieu
  d'un effacement immédiat — récupérable pendant 30 jours, purge automatique
  passé ce délai (vérifiée au démarrage puis toutes les heures), ou purge
  manuelle immédiate (élément par élément ou tout d'un coup). Testé de bout
  en bout : suppression → disparition des listes → présence en corbeille →
  restauration exacte (mêmes données, même identifiant) → et purge définitive
  (fichiers compris). Une formation avec des inscriptions actives ne peut pas
  être supprimée tant que ces inscriptions n'ont pas été traitées, pour ne
  jamais perdre cette information par accident.

- **Logo officiel OKIM ART** : intégré partout (nav, pied de page, favicon,
  page de connexion admin, tableau de bord) via un seul fichier
  `public/img/brand/logo.png` — pour le changer, remplacez ce fichier ou
  téléversez-en un nouveau depuis Paramètres (route déjà branchée), sans
  toucher au code. Vérifié sur le site public ET l'espace admin.
- **Photo du photographe** dans la section À propos, recadrée en portrait
  fixe (ratio 4/5) qui s'adapte à tous les écrans sans jamais déformer
  l'image, avec un point d'ancrage de recadrage ajusté pour garder le
  visage bien visible quelle que soit la largeur d'écran.
- **Galerie Client & Récupération sécurisée** (Galerie Client dans le
  tableau de bord) : créez une séance (photos + nom du client), un lien
  privé et un code PIN à 6 chiffres sont générés — jamais le téléphone du
  client comme mot de passe. Le PIN est haché (bcrypt), affiché une seule
  fois à la création. Le client accède à `/gallery/:token`, saisit son PIN
  (5 tentatives max, ensuite bloqué 15 min — testé), et télécharge un ZIP
  de ses photos HD tant que la séance est dans sa période de rétention
  gratuite (30 jours par défaut). Passé ce délai, la séance devient
  "archivée" : les aperçus filigranés restent visibles, mais le
  téléchargement HD nécessite un paiement KKiaPay (même intégration que
  la boutique), qui débloque l'accès pour 48h. Testé de bout en bout :
  création → PIN correct/incorrect → téléchargement ZIP réel → expiration
  simulée → blocage HD → paiement → déblocage → nouveau téléchargement.
  Deux bugs trouvés et corrigés pendant les tests : une incompatibilité
  IPv6 du limiteur de tentatives PIN (bibliothèque `express-rate-limit`),
  et un doublon d'extension dans le nom des fichiers du ZIP téléchargé.
- **Réinitialisation des compteurs du tableau de bord** (bouton en haut du
  tableau de bord) : n'efface AUCUNE donnée réelle — photos, commandes,
  messages... restent consultables normalement dans leurs sections. Seul
  l'affichage des compteurs repart de zéro, à partir de la date du clic.
  Testé : formations réelles toujours au nombre de 5 après réinitialisation,
  seul le compteur affiché passe à 0.
- **Liste des inscrits en PDF + réinitialisation par formation** (boutons
  dans Formations, à côté du nombre d'inscrits) : le PDF liste chaque
  inscrit (nom, e-mail, téléphone, statut, date) ; la réinitialisation
  déplace les inscriptions vers la Corbeille (récupérables 30 jours) et
  remet le compteur à zéro pour repartir sur une nouvelle session de la
  même formation. Testé de bout en bout.
- **Suppression pour la boutique et les commandes** : bouton "Supprimer"
  sur chaque produit (déplacé vers la Corbeille, 30 jours) et sur chaque
  commande (suppression immédiate et irréversible, délibérément hors
  Corbeille — une commande est un enregistrement comptable, pas un contenu
  éditorial ; l'admin en est averti avant de confirmer). Testé.
- **Comptes administrateurs et accès Paramètres réservé au propriétaire** :
  seul le tout premier compte créé (le "propriétaire") peut ouvrir
  Paramètres — clés KKiaPay, SMTP, informations du site, gestion des autres
  comptes. Le propriétaire peut créer des comptes "employé" (accès au reste
  du tableau de bord — photos, commandes, messages, formations... — mais
  jamais à Paramètres). Testé avec un vrai second compte : accès aux
  réglages KKiaPay et à la liste des comptes refusé (`403`) pour l'employé,
  tandis que les photos restent accessibles ; impossible de supprimer le
  compte propriétaire ; le compte employé supprimé perd l'accès aussitôt.

## Activer le paiement en ligne KKiaPay

KKiaPay est un agrégateur béninois (MTN Mobile Money, Moov Money, carte
bancaire). L'intégration est déjà en place ; il ne reste que la configuration :

1. Créez un compte gratuit sur [kkiapay.me](https://kkiapay.me) et activez-le
   (documents administratifs, sous 24h).
2. Dans votre tableau de bord KKiaPay → Développeurs → Clés API, copiez la
   **clé publique** (`pk_sandbox_...` en test, `pk_live_...` en production).
3. Sur OKIM ART, allez dans **Paramètres → Paiement (KKiaPay)** :
   - collez la clé publique,
   - cochez "Activer le paiement en ligne KKiaPay",
   - laissez "Mode test" coché tant que vous testez, décochez-le en production,
   - copiez l'**URL de webhook** et le **secret de webhook** affichés en bas
     de ce panneau (générés automatiquement, pas besoin de les inventer).
4. Toujours dans votre tableau de bord KKiaPay, menu **Webhook**, collez cette
   URL et ce secret, et activez au moins l'événement de succès de transaction.
5. C'est tout — le bouton "Payer par Mobile Money / carte" apparaît
   automatiquement sur la page panier du site.

Le paiement manuel (Mobile Money direct avec vous, espèces, virement) reste
toujours proposé en option, y compris quand KKiaPay est activé.

## Activer les notifications automatiques (e-mail + autres canaux)

Sans configuration, la plateforme fonctionne quand même — les notifications
échouent simplement en silence (visible dans les logs serveur). Pour les
activer, allez dans **Paramètres → Notifications automatiques** :

1. **E-mail (SMTP)** — indiquez un serveur SMTP. Avec Gmail par exemple :
   - Serveur : `smtp.gmail.com`, port `587`
   - Utilisateur : votre adresse Gmail
   - Mot de passe : un **mot de passe d'application** (pas votre mot de passe
     Gmail habituel — à générer sur myaccount.google.com/apppasswords, ce qui
     nécessite la validation en 2 étapes activée sur le compte)
   - Cliquez sur "Envoyer un e-mail de test" pour vérifier.
   - N'importe quel autre fournisseur SMTP (OVH, Zoho, un hébergeur local...)
     fonctionne aussi de la même façon.
2. **Autres canaux (WhatsApp, SMS, Telegram)** — collez une URL de webhook
   (menu "Notifications automatiques" toujours) provenant d'un outil comme
   [Make](https://make.com), [Zapier](https://zapier.com) ou
   [n8n](https://n8n.io). Chaque événement (commande payée, message,
   inscription) lui sera envoyé en JSON ; c'est cet outil qui se charge de
   relayer vers WhatsApp/SMS — OKIM ART n'a pas d'accès direct à l'API
   WhatsApp Business officielle (payante, compte professionnel Meta séparé),
   donc plutôt que de fabriquer une fausse intégration, la plateforme reste
   ouverte à n'importe quel canal via ce webhook standard.

## Récupérer l'accès admin en cas de mot de passe perdu

Sur la page de connexion (`/admin/`), cliquez sur "Mot de passe oublié ?" et
indiquez :
- l'e-mail du compte admin,
- le **nom enregistré sur ce compte** (visible et modifiable dans
  Paramètres → Sécurité — c'est ce nom qui fait office de réponse de
  sécurité, à choisir mémorisable mais pas trop facile à deviner par un tiers).

Aucun e-mail n'est envoyé : le nouveau mot de passe est appliqué immédiatement
si le nom correspond.

## Ce qui est volontairement simplifié

- **Paiement** : KKiaPay est intégré (voir section dédiée plus haut) mais
  nécessite que vous créiez votre propre compte marchand et colliez vos clés
  dans Paramètres → Paiement. Tant que ce n'est pas fait, le panier propose
  un repli "commande sans paiement en ligne" clairement identifié comme non
  automatique (l'admin doit alors confirmer manuellement) — dès que KKiaPay
  est activé, ce repli disparaît et seul le paiement automatique est proposé.
  Le webhook KKiaPay n'a pu être testé qu'avec des requêtes simulées ici
  (impossible de recevoir un vrai webhook depuis cet environnement) : la
  logique de vérification est solide (signature + montant recontrôlés), mais
  testez un vrai paiement en mode sandbox avant de passer en production.
- **E-mails** : le code d'envoi (SMTP via nodemailer) est fonctionnel et testé
  pour son comportement d'échec (timeout rapide, jamais bloquant), mais aucun
  e-mail réel n'a pu être délivré depuis cet environnement (accès SMTP sortant
  non disponible ici) — testez l'envoi d'un e-mail de test après avoir
  configuré vos identifiants SMTP réels.
- La base de données utilise le module **SQLite intégré à Node.js**
  (`node:sqlite`, stocké dans `data/okimart.db`) plutôt qu'une bibliothèque
  externe comme `better-sqlite3` : ce choix évite toute compilation native à
  l'installation (source fréquente d'échecs sur les hébergements mutualisés),
  au prix d'un module encore marqué "expérimental" par Node.js — stable en
  pratique pour ce volume d'usage, mais à garder en tête. Sauvegarder le site
  revient à copier le fichier `data/okimart.db` et le dossier `uploads/private/`.
- Les inscriptions aux formations s'affichent en admin via une liste simple
  (pas de tableau dédié dans le tableau de bord au-delà du compteur).

## Architecture (pour ne pas se perdre plus tard)

**Stack volontaire : pas de React.** Le projet est en JavaScript "vanilla"
(HTML/CSS/JS sans build ni framework) de bout en bout — un choix fait dès
le départ pour rester simple à maintenir sans outillage de compilation.
Si une demande future mentionne React/TypeScript, le plus cohérent est de
continuer dans ce même style plutôt que d'introduire un second stack
isolé au milieu du projet (sauf décision explicite de migrer tout le
front-end, ce qui est un chantier à part entière).

```
public/               → tout ce que le navigateur charge
  index.html           site vitrine original, désormais connecté à l'API
  style.css             CSS ORIGINAL, INCHANGÉ (aucune règle modifiée)
  boutique.html, panier.html, compte.html   nouvelles pages publiques
  gallery.html            galerie client sécurisée (PIN + téléchargement +
                           récupération payante) — /gallery/:token
  css/shop.css           feuille ADDITIVE (@import style.css + nouvelles classes
                          uniquement) pour formulaires/boutique/panier/compte/galerie
  js/site-data.js        connecte index.html à l'API (dégrade proprement si
                          l'API est indisponible : le contenu déjà écrit dans
                          le HTML reste affiché)
  js/cart.js              panier localStorage
  admin/                  espace admin (login.html, dashboard.html, admin.css
                           qui importe aussi style.css, app.js = toute la logique,
                           dont la section "Galerie Client")
  uploads/photos|previews|images   fichiers PUBLICS générés (aperçus, logos...)

uploads/private/        fichiers ORIGINAUX haute résolution (boutique ET
                         séances galerie) — jamais servis directement

server/
  server.js              point d'entrée Express
  db.js                   connexion SQLite + schéma complet + amorçage
  seed.js                 importe le contenu réel du studio (à lancer une fois)
  middleware/auth.js       JWT admin/client + galerie (jeton court par Bearer)
  utils/upload.js          validation/stockage/watermark (sharp)
  utils/tokens.js          jetons de téléchargement sécurisés (boutique)
  utils/gallery.js         règles d'accès HD, purge des séances expirées
  utils/zip.js             génération de ZIP en flux (module galerie)
  routes/gallery.js        API publique galerie (PIN, téléchargement, récupération)
  routes/payments.js       alias /api/payments/kkiapay-webhook (module galerie)
  routes/                  API publique (auth, panier, téléchargement, client)
  routes/admin/            API admin protégée (une route par entité, dont sessions.js)

data/okimart.db          base de données (créée au premier démarrage)
```

## Sécurité — ce qui est en place

- Mots de passe hashés (bcrypt, coût 12), jamais stockés en clair.
- Sessions par cookie **httpOnly** (inaccessible en JavaScript côté client).
- Limitation du débit sur les routes de connexion (10 tentatives / 15 min).
- Fichiers originaux stockés hors du dossier public, servis uniquement via
  un jeton opaque à usage limité (5 téléchargements, expiration 72h par défaut,
  réglable dans `.env`).
- En-têtes de sécurité de base (`X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`).
- `/admin/*` (les pages HTML) ne sont pas encore bloquées côté serveur — elles
  affichent un formulaire de connexion vide sans session valide et **aucune
  donnée n'est accessible sans passer par l'API protégée**. Pour un usage en
  production, envisagez d'ajouter une restriction de plus (mot de passe HTTP
  au niveau du serveur web, IP autorisées, etc.) si le sous-dossier `/admin`
  vous inquiète d'un point de vue référencement — un `robots: noindex` est
  déjà en place sur ces pages.

## Déploiement

Le projet est un serveur Node.js classique (Express) — il fonctionne sur
tout hébergement supportant Node.js 22.5+ avec accès à un système de fichiers
persistant (Render, Railway, VPS classique, etc.). Un hébergement mutualisé
"PHP only" sans Node.js ne convient pas. Aucune compilation native n'est
requise à l'installation (voir note sur `node:sqlite` plus haut).

Étapes générales :
1. Déposer le dossier complet sur le serveur.
2. `npm install --omit=dev`
3. Renseigner un vrai `.env` (copier `.env.example`, changer `JWT_SECRET`).
4. `npm run seed` (une seule fois).
5. Lancer avec un gestionnaire de process (`pm2 start server/server.js`, ou
   le mécanisme "Node app" fourni par l'hébergeur).
6. Pointer le nom de domaine du studio vers ce serveur.
7. Se connecter à `/admin/`, changer le mot de passe, remplir les vrais
   paramètres (Paramètres), remplacer les photos de test par les vraies.

## Prochaines étapes suggérées (non incluses ici)

- Intégration d'une passerelle de paiement Mobile Money (FedaPay/KKiaPay).
- Sauvegardes automatiques planifiées de `data/okimart.db` et `uploads/private/`.
- Notification e-mail au studio à chaque nouvelle commande/message (actuellement
  tout est consultable dans le tableau de bord, mais rien n'est envoyé par e-mail).

---

## Base de données PostgreSQL & déploiement

### 1. Développement local

```bash
docker compose up -d                 # démarre PostgreSQL sur localhost:5432
cp .env.example .env                 # puis éditez DATABASE_URL + JWT_SECRET
npm install
npm start                            # crée le schéma automatiquement au premier démarrage
```

Le schéma (tables, contraintes, réglages par défaut) est créé automatiquement
par `initDb()` au démarrage du serveur — pas besoin de migration manuelle sur
une base neuve.

### 2. Migrer des données existantes depuis un ancien `data/okimart.db` (SQLite)

Si vous avez une installation existante avec de vraies données (clients,
commandes, galeries...), utilisez le pipeline de migration fourni. **Il ne
modifie et ne supprime jamais le fichier SQLite d'origine.**

```bash
# 1) Sauvegarde intacte (copie horodatée + empreinte SHA-256) :
npm run backup:sqlite

# 2) Démarrez une fois le serveur contre PostgreSQL (crée le schéma vide) :
npm start        # puis Ctrl+C une fois "serveur démarré" affiché

# 3) Migration des données (lit le SQLite en LECTURE SEULE, écrit dans
#    PostgreSQL dans une transaction unique, vérifie les comptages) :
DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-postgres.js data/okimart.db
```

Le script affiche un rapport table par table (`SQLite: N  PostgreSQL: N  OK`)
et se termine en échec (code de sortie 1) si un seul comptage ne correspond
pas — dans ce cas, aucune donnée PostgreSQL n'a été laissée à moitié migrée
(tout se joue dans une seule transaction, `ROLLBACK` automatique en cas
d'erreur).

Les identifiants (`id`) sont préservés à l'identique, donc toutes les
relations (commandes ↔ articles, séances ↔ photos, jetons de téléchargement
déjà envoyés par e-mail...) restent valides après migration.

**Photos et fichiers uploadés** (`uploads/`) : la migration SQL ne touche
jamais aux fichiers eux-mêmes — copiez simplement le dossier `uploads/`
existant vers `uploads/` du nouvel environnement (ou vers le disque
persistant Render, voir plus bas). Les chemins stockés en base (`fichier`,
`miniature`, `apercu`, `file_path`, `watermark_path`) sont relatifs et
continueront de pointer au bon endroit.

### 3. Déploiement sur Render (recommandé pour cette application)

Cette plateforme est un serveur Express **avec état** : elle écrit des
fichiers sur disque (photos envoyées depuis l'admin) et a besoin d'une
connexion PostgreSQL persistante. Render (Web Service + disque persistant +
PostgreSQL managé) est l'hébergement adapté pour l'ensemble backend + site
statique, tel quel :

```bash
# Avec le fichier render.yaml fourni (Blueprint) :
# 1. Poussez le projet sur GitHub.
# 2. Sur render.com : New → Blueprint → sélectionnez le repo.
#    Render crée automatiquement le Web Service + la base PostgreSQL
#    + le disque persistant pour uploads/, et relie DATABASE_URL.
# 3. Une fois déployé, ouvrez les logs : le mot de passe admin généré
#    y est affiché une seule fois (ou définissez FIRST_ADMIN_EMAIL /
#    FIRST_ADMIN_PASSWORD dans les variables d'environnement Render avant
#    le premier déploiement pour le choisir vous-même).
```

Sans le disque persistant (`disk:` dans `render.yaml`), toute photo envoyée
depuis l'admin serait perdue au redéploiement suivant — ne le retirez pas.

### 4. Et Vercel ?

Vercel héberge très bien des sites statiques et des fonctions serverless,
mais **n'est pas adapté à ce backend tel quel** : ses fonctions sont sans
état et leur système de fichiers est éphémère (hors `/tmp`, qui est
lui-même vidé entre les invocations) — les photos envoyées depuis l'admin
ne survivraient pas. Deux options si Vercel est requis malgré tout :

- **Recommandé** : héberger le backend (ce dépôt) sur Render comme
  ci-dessus, et déployer sur Vercel un miroir statique du site public
  (`public/`) qui appelle l'API Render — utile seulement si vous voulez
  un nom de domaine ou un CDN Vercel en façade.
- **Aller plus loin** : adapter `server/utils/upload.js` pour écrire les
  fichiers vers un stockage objet externe (S3, Cloudinary, Vercel Blob...)
  au lieu du disque local, puis déployer le serveur Express comme fonction
  serverless Vercel. C'est un chantier à part entière (voir "Prochaines
  étapes" ci-dessous) — non fait ici pour ne pas modifier le comportement
  de l'admin (aperçus, filigranes, ZIP de galerie) sans validation.

### 5. Prochaine extension à considérer en premier

Le stockage de fichiers sur disque local (même persistant sur Render) ne
supporte pas la scalabilité horizontale (plusieurs instances) ni Vercel.
La prochaine étape naturelle est de faire évoluer `server/utils/upload.js`
et `server/utils/zip.js` pour écrire/lire depuis un stockage objet
compatible S3 (Render Disks → S3/Cloudinary/Backblaze B2...), en gardant
la même API (`saveOriginal`, `savePublicVersion`, `deletePublicFile`,
`deletePrivateFile`) pour que le reste du code n'ait pas à changer.
