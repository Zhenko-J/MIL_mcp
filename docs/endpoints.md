# Milanote : API interne observée (étape 1 du projet milanote-mcp)

Capture du 2026-10-08, client web Milanote `3.18.136`, compte personnel, board de test **MCP-TEST**.
Méthode : Playwright MCP (réseau, trames WebSocket via un hook `addInitScript`) et analyse statique
des bundles JS de `static.milanote.com` (copie locale, recherche de texte). REA n'a **pas** pu servir dans cette session :
les origines Milanote n'étaient pas autorisées (voir « Inconnues »).

Légende des sources : **[obs]** observé sur le réseau · **[stat]** lu dans le bundle JS, non exécuté · **[inf]** déduction.

Fixtures anonymisées : `test/fixtures/` (ids remplacés de façon cohérente, textes réels masqués, aucun secret).
Les fixtures `ws-*` et `rest-board-mcp-test.json` gardent les textes, tous fictifs, saisis sur le board de test.

---

## 1. Verdict de la porte de décision : les écritures passent par **WebSocket**

| Opération | Canal | Détail |
|---|---|---|
| Lecture (boards, éléments, utilisateur) | REST `GET /api/…` | [obs] |
| Création / modification / suppression d'éléments | **socket.io**, événement `action` | [obs] `ELEMENT_CREATE`, `ELEMENT_UPDATE`, `ELEMENT_SET_TYPE` ; [stat] `ELEMENT_DELETE`, `ELEMENT_MOVE`… |
| Aperçu d'un lien (unfurl) | REST `POST /media-service/api/link` | [obs] appelé entre la création et `ELEMENT_SET_TYPE` |
| Upload d'image | REST `POST /api/elements/attachments/presign`, puis `PUT` S3 | [obs] métadonnées ensuite écrites par WebSocket |

**Conséquence pour le plan.** Un client d'écriture doit parler socket.io (Engine.IO v4) : connexion authentifiée,
émission `42["action",{…}]` et attente de l'acquittement `43[{"status":200}]`.
**Décision (2026-10-08) : ajouter la dépendance `socket.io-client`** au périmètre « SDK MCP + zod ». Elle gère le
protocole complet (ping/pong, ack, reconnexion) ; dans Node, elle accepte `extraHeaders: { cookie: "mn-token=…" }`.

**Écriture validée depuis Node (2026-10-08)** [obs] : une seule connexion WebSocket native Node 24 avec le cookie
`mn-token`, sans jeton WAF ni `tokens` de permission, puis `ELEMENT_CREATE` d'une `CARD`. Acquittement 200, et l'élément
est **retrouvé** par `GET /api/elements` sur MCP-TEST, en section `CANVAS` (id `…NODEts01`, `clientId` choisi librement).

⚠️ L'acquittement `{"status":200}` **ne prouve rien** : le serveur répond 200 à une connexion et à un `update-channels`
**sans cookie**, et `POST /api/actions` répond `success:true` sans rien créer. Le MCP doit toujours **relire en REST**
après une écriture pour confirmer.

Piste écartée : **`POST /api/actions`** avec `{action}` [stat] (le client ne s'en sert que pour une action de navigation).
Testé une fois le 2026-10-08 sur MCP-TEST [obs] : `ELEMENT_CREATE` d'une `CARD` (id `…RESTts01`, payload calqué sur la
capture WebSocket, sans `tokens`, `deviceId` ni `sessionId`). Réponse `200 {"success":true}`, mais **rien n'est créé** :
l'élément est absent du board et `GET /api/elements?ids=…` répond `BOARD_NOT_FOUND`. Le serveur accepte l'appel sans
l'appliquer ; l'endpoint semble réservé à des actions annexes (navigation, analytique). On ne peut pas exclure qu'il manque
un champ, mais un « succès » qui n'écrit rien rend cette voie inutilisable : **les écritures passent par socket.io**.

Le repli sur une v1 en lecture seule reste possible : toute la lecture est en REST.

---

## 2. Authentification

| Élément | Valeur / forme | Source |
|---|---|---|
| Jeton de session | JWT HS256, claims `_id`, `rootBoardId`, `role`, `platform`, `iat` ; **pas d'`exp`** | [obs] |
| Transport n°1 | en-tête `Authorization: Bearer <JWT>` (copie dans `localStorage.token`) | [obs] |
| Transport n°2 | cookie **HttpOnly** `mn-token` (même JWT, cookie de session) | [obs] |
| REST avec cookie seul | `GET /api/boards?ids=…` → 200 sans en-tête Bearer | [obs] |
| Socket.io | authentifié par le cookie `mn-token` ; URL `wss://app.milanote.com/socket.io/?userId=<userId>&EIO=4&transport=websocket` | [obs] |
| `accept-version: 3.18.136` | envoyé par le client, **non requis** (200 sans) | [obs] |
| AWS WAF | cookie `aws-waf-token` (~4 jours) et en-tête `x-aws-waf-token` ; défi JS `awswaf/…/challenge.compact.js`. Il protège `static.milanote.com` (curl → page de défi), mais **pas l'API ni le socket** : depuis Node, sans jeton WAF et avec l'UA par défaut, `users/me`, `boards`, le handshake et le connect socket.io répondent normalement | [obs] |
| Socket sans cookie | connexion et `update-channels` acquittés 200 **même sans cookie** : authentification vérifiée au traitement des actions, pas à la connexion | [obs] |
| Migration en cours | appels `auth/upgrade-better-auth-session` / `downgrade-…`, « legacy token » contre « Better Auth session » | [stat] |
| Connexion | `POST /api/auth/login` (reCAPTCHA invisible et WAF sur la page) : **ne pas automatiser** | [obs] |

**Variables d'environnement à prévoir** (ajustement du brief) : une seule, `MILANOTE_TOKEN` (le JWT, lu dans le cookie
`mn-token` ou dans `localStorage.token`), utilisée en `Authorization: Bearer` pour le REST et en cookie `mn-token` pour le
socket. Ni jeton WAF ni user-agent particulier ne sont nécessaires (testé depuis Node le 2026-10-08).

### Migration Better Auth observée le 2026-10-09 (client `3.18.137`) [obs]

Le lendemain de la capture, le compte était passé sur la nouvelle session :

| Élément | Valeur / forme |
|---|---|
| Cookie de session | **`__Secure-milanote.session_token`**, HttpOnly, Secure, 79 caractères (pas un JWT), expiration ~30 jours (vu : 2026-11-10) |
| `mn-token`, `localStorage.token` | **absents** ; `localStorage.betterAuthSessionUser` contient `{_id, rootBoardId}` |
| Appels REST | **aucun en-tête `Authorization`** ; cookie seul (`withCredentials`), plus `accept-version` et `x-aws-waf-token` |
| Après connexion | `POST /api/auth/upgrade-better-auth-session` |
| Socket.io | même URL (`?userId=…&EIO=4&transport=websocket`) ; depuis Node, le cookie Better Auth en `extraHeaders` suffit : les 5 écritures du test de fumée sont confirmées |
| Depuis Node | REST et socket fonctionnent avec ce seul cookie, sans jeton WAF (test de fumée complet, lecture + 5 écritures) |

Conséquence : le serveur accepte `MILANOTE_SESSION_TOKEN` (valeur de ce cookie, mode `session`) en priorité, et garde
`MILANOTE_TOKEN` (mode `jwt`) en secours. En mode `session`, `userId` et `rootBoardId` sont lus une fois dans `GET users/me`.

Depuis la v0.9 (2026-11-16), le fichier de session vit dans `%USERPROFILE%\.milanote-mcp\` : sous `%LOCALAPPDATA%`, les
processus lancés par l'application Claude (paquet MSIX) lisaient une copie privée redirigée, expirée, et non le fichier
écrit par `npm run session` (voir README). Le serveur relit ce fichier à chaque appel et démarre même sans session.

Les jetons de permission (`tokens: ["<JWT>", …]`, claims `permissionIds`, `aclIds`) viennent de
`GET /api/permissions/token/?ids=…&elementIds=…`. Ils servent aux boards partagés ou publics ; le client les joint à chaque action.

---

## 3. Lecture (REST, base `https://app.milanote.com/api/`)

| Outil MCP | Requête | Réponse | Fixture |
|---|---|---|---|
| (amorçage) | `GET users/me` | `{user:{_id, rootBoardId, quickNotesRootId, clientId, clientTick, …}, elements:{<rootBoardId>: BOARD}}` | `rest-users-me.json` |
| `list_boards` | `GET boards?ids=<rootBoardId>&loadAncestors=true` | `{elements:{<id>: élément}, childrenReturned:{<id>:true}, boardIds, elementCount, …}` : board **et enfants** | `rest-boards-home.json` |
| `get_board` | `GET boards?ids=<boardId>&excludeSelf=false&loadAncestors=true` | même forme ; inclut les sections `CANVAS` et `INBOX` (« À trier ») | `rest-board-mcp-test.json` |
| (contenu de colonnes, etc.) | `GET elements?ids=<id,id,…>&loadAncestors=true[&tokens=<JWT>]` | `{elements:{…}, errors:{<id>:{code:"BOARD_NOT_FOUND"…}}}` | `rest-elements-batch.json` |
| (fraîcheur cache) | `GET boards/modified?ids=<id,…>` | `{modifiedTimes:{…}}` | — |
| `search_boards` (P2) | `GET boards/search?query=<texte>&offset=0&sort=viewed&locale=fr-FR` (loupe du client web) | [obs] 2026-10-09 : `{offset, total, size, results:[{_id, board:<BOARD>, modifiedTime, viewedTime, score, elementCounts, ancestors:[{_id,title}], innerHits:[{_id, elementType, content:["[hit]MCP[/hit]-TEST"], labels}], ownerId, userIds}], sort, timestamp}`. Avec `sort=relevance`, `results` est vide. | `rest-boards-search.json` |
| `list_trash`, `restore_elements` | `GET users/me/trash?other-users=false` (ouverture du panneau Corbeille, capturé le 2026-11-16) | `{totalCount, hasMore, earliestTimestamp, earliestId, elements:{<id>: élément}, comments}` : corbeille de **tout le compte**, plus récents d'abord ; `location:{parentId:"<boardId>-trash", section:"TRASH", position:{addedDate, restoreLocation:{parentId, section, position}}}`. Un élément à la corbeille est **illisible** par `GET elements?ids=` (`errors.<id>.code = "BOARD_DELETED"`, 404) ; `GET boards?ids=<boardId>-trash` répond vide | — |
| `export_board_markdown` (P1) | **Pas d'appel dédié** : rendu Markdown côté client (`src/export/markdown.ts`) à partir de `GET boards?ids=…` par board, en largeur d'abord jusqu'à `depth` (25 boards max). L'export serveur `POST export/<elementId>` `{format, fileType, quality, includeChildBoards, locale, timezone}` [stat] reste non vérifié | — | — |

Remarques :
- Les colonnes (`COLUMN`) et les alias (`ALIAS`, `content.linkTo`) apparaissent dans la réponse ; leur contenu peut
  demander un `GET elements?ids=…` supplémentaire, d'après ce que fait le client [obs].
- Un élément rangé **dans une colonne** a `location.parentId = <id de la colonne>` et `section: "INBOX"`, avec une position
  `{index, score}` au lieu de `{x, y}` [obs]. La section `INBOX` d'un board, elle, correspond à « À trier ».
- `GET users/me` renvoie aussi `user.local.password` (empreinte) et `otToken` : **ne jamais renvoyer cette réponse brute**
  dans un outil MCP.

### Modèle d'élément (pour les schémas Zod)

```
{ id, _id, elementType, location:{ parentId, section, position:{x,y,score}|{index,score} },
  content:{…selon le type…}, acl:{<userId>:number}, meta:{creator, createdTime, modifiedTime, modifiedBy, platform, versionId}, __v }
```

- `elementType` [stat] : `ALIAS BOARD COLUMN CARD LINK LINE IMAGE FILE COMMENT_THREAD TASK_LIST TASK CLONE SKETCH ANNOTATION COLOR_SWATCH DOCUMENT TABLE` (+ `SKELETON`, `UNKNOWN` internes).
- `location.section` [stat] : `CANVAS INBOX TRASH DELETED ATTACHED QUICK_NOTES`.
- Contenu par type [obs] :
  - `BOARD` : `title, icon{type:"mn-svg"|"string",…}, color, secondaryColor, defaultColorPalette[], inbox:"OPEN"|"CLOSED"`.
  - `CARD` (note) : `textContent` = **document ProseMirror** (voir §5).
  - `LINK` : `url, mediaType, link{url,title}, provider{url,name,display}, caption` (ProseMirror) `, showCaption`.
  - `IMAGE` : `image{width,height,original,regular,large,huge,thumb,primaryColor,transparent}, attachmentId, file{type,ext,mime,filename,size}`.

---

## 4. Écriture (socket.io, événement `action`)

Trame émise : `42<n>["action", <payload>]`, acquittement serveur `43<n>[{"status":200}]` [obs].
Champs communs du payload [obs] [stat] :

```
type, timestamp (ms), sync:true,
user:{ _id, clientId, clientTick }, deviceId:"mdid-…", sessionId:"msid-…",
channels:[<boardId parent>, …], tokens:[<jetons de permission>], activity:{track, boardId, elementTypes?}
```

### Génération des ids (côté client) [stat] [obs]

`id = base62(floor(Date.now()/1000)) [6 car.] + clientId [6 car.] + base62(tick % 3844) [2 car., complété par des 0]`
(alphabet base62 `0-9a-zA-Z`). Le serveur valide une longueur de 14 ou 15 et un horodatage postérieur au 2016-02-29.
Le `clientId` est fourni par le serveur (`users/me`) et **change à chaque chargement** ; `clientTick` s'incrémente à chaque id.
Vérifié sur un id réel capturé (2026-10-08T14:25:40Z, tick 814) ; exemple de même forme : `1XeP40TeStCld8`
= `1XeP40` (secondes) + `TeStCl` (client) + `d8` (tick 814).

### Scénarios capturés (tous sur MCP-TEST)

| Outil MCP | Séquence observée | Fixtures |
|---|---|---|
| `create_board` (P2) | `ELEMENT_CREATE {elementType:"BOARD", location:{parentId, section:"CANVAS", position}, content:{title:null,…}}` puis `ELEMENT_UPDATE {updates:[{id, changes:{title, icon, color}}]}` | `ws-02`, `ws-03` |
| `add_link` (P0) | 1. `ELEMENT_CREATE {elementType:"LINK", content:{url:null}}` → 2. REST `POST /media-service/api/link {url, elementId, environmentFolder:"p", userId, locale}` → 3. `ELEMENT_SET_TYPE {id, elementType:"LINK", changes:<réponse unfurl : link, provider, mediaType, image, caption, showCaption>}` | `ws-04`, `http-media-link-*`, `ws-05` |
| `add_note` (P0) | `ELEMENT_CREATE {elementType:"CARD", content:{textContent:null}}` puis `ELEMENT_UPDATE {changes:{textContent:<doc>}, meta:{modifiedVersionId, versionId}}` | `ws-06`, `ws-07` |
| `restore_elements` | `ELEMENT_MOVE_MULTI {moves:[{id, location:<restoreLocation lu dans la corbeille>, from:{parentId:"<boardId>-trash", section:"TRASH", position:{addedDate, restoreLocation}}}], moveOperation:"DROP", monitoring:{operation:"DROP"}, activity:{sourceBoardId:"<boardId>-trash", destinationBoardId:<boardId>, …}, channels:[<boardId>]}` (carte glissée hors du panneau Corbeille, 2026-11-16) | `ws-11` |
| `create_column` | `ELEMENT_CREATE {elementType:"COLUMN", location:{section:"CANVAS", position:{x,y,score}}, content:{title:null}}` (outil « Colonne » glissé sur la toile) puis `ELEMENT_UPDATE {updates:[{id, changes:{title}}]}` (double-clic sur le titre) | `ws-12`, `ws-15` |
| `move_elements` (colonne) | `ELEMENT_MOVE_MULTI` « DROP » vers `{parentId:<colonne>, section:"INBOX", position:{index, score}}` (colonne vide : `{index:0, score:0}`) | `ws-13` |
| `move_elements` (autre board) | `ELEMENT_MOVE_MULTI` « DROP » vers `{parentId:<board cible>, section:"INBOX", position:{index, score}}` (carte relâchée vite sur la carte du sous-board ; un survol d'environ 1 s ouvre le board au lieu de déposer), `channels:[<cible>, <source>]` ; le client envoie ensuite `ELEMENT_UPDATE` du board cible `{inbox:"OPEN", inboxAutomaticOpenTimestamp}` (affichage seulement, non reproduit) | `ws-14`, `ws-14b` |
| `trash_elements` | `ELEMENT_MOVE_MULTI {moves:[{id, location:{parentId:"<boardId>-trash", section:"TRASH", position:{addedDate, restoreLocation:<from>}}, from:<location actuelle>}], moveOperation:"TRASH", monitoring:{operation:"TRASH"}, activity:{sourceBoardId, destinationBoardId, elementTypes}}` (touche Suppr, capturé le 2026-10-09 ; validé sur 10 cartes d'un coup) | `ws-10` |
| `add_image` (P1) | 1. `ELEMENT_CREATE {elementType:"IMAGE", location:{section:"INBOX", position:{index,score}}, content:{image:null}}` → 2. REST `POST /api/elements/attachments/presign {filename, contentType, elementId, fileType:"image", imageType:"ELEMENT", fileSize}` → `{presignedUrl}` → 3. `PUT <presignedUrl>` (S3 `milanote.s3-accelerate.amazonaws.com/p/images/<elementId>/<dossier>/<filename>`, expiration 30 min) → 4. `ELEMENT_UPDATE {changes:{image:{width,height,original,transparent}, file:{type,ext,mime,filename,size,lastModified}}}` | `ws-08`, `http-presign-*`, `ws-09` |

Notes :
- Une image importée par le menu « Images » arrive dans la section **INBOX** (« À trier ») du board ; un glisser-déposer
  la poserait sur `CANVAS` [inf]. Pour le MCP, créer directement en `CANVAS` avec une position.
- `ELEMENT_UPDATE` porte `meta.versionId` au format `<sessionId sans « msid- »>-<n>` [obs] ; rôle exact (contrôle de concurrence ?) inconnu.
- Le serveur relaie aussi les actions des autres utilisateurs (`USER_ACTIVITY_HEARTBEAT`, `USER_DISCONNECT`) : à ignorer.
- Inventaire des types d'action `ELEMENT_*` [stat] : `CREATE, UPDATE, DIFF_UPDATE, SET_TYPE, DELETE, MOVE, MOVE_MULTI, MOVE_AND_UPDATE, DUPLICATE, CONVERT_TO_CLONE, UPDATE_ACL, …`.

---

## 5. Texte riche (notes, légendes)

Format **ProseMirror/TipTap** JSON [obs] :

```json
{"type":"doc","content":[
  {"type":"paragraph","attrs":{"key":"be7iQ","textAlign":"left"},"content":[{"type":"text","text":"Titre"}]},
  {"type":"paragraph","attrs":{"key":"ZsLwN","textAlign":"left"},"content":[
     {"type":"text","text":"Texte "},{"type":"text","marks":[{"type":"bold"}],"text":"gras"}]}]}
```

- `attrs.key` : 5 caractères aléatoires par bloc [obs] (génération côté client, unicité requise inconnue).
- Une note n'a pas de champ « titre » séparé : le titre est le premier paragraphe [obs]. Les styles de titre
  (heading) et de liste existent sans doute [inf], mais n'ont pas été capturés.

---

## 6. Autres endpoints relevés dans le bundle (non déclenchés)

[stat], méthode quand elle est lisible, chemins relatifs à `/api/` :

| Domaine | Endpoints |
|---|---|
| Boards / éléments | `boards`, `boards/modified`, `boards/search`, `boards/{id}/password-pre-fetch`, `elements`, `elements/counts`, `POST elements/duplicate`, `elements/{id}/clones`, `elements/{id}/editors`, `elements/{id}/views`, `PUT elements/{id}/owner`, `PUT elements/{id}/permissions`, `PUT/DELETE elements/{id}/publish`, `PUT/DELETE elements/{id}/public-edit` |
| Fichiers / médias | `POST elements/attachments/presign`, `elements/attachments/track-download`, `POST image`, `POST image/resize`, `POST image/thumb`, `images/search`, `images/remove-background/`, `/media-service/api/link` |
| Actions | `POST actions` (voir §1 : répond 200 sans appliquer un `ELEMENT_CREATE`) |
| Export | `POST export/{id}`, `POST export/{id}/bulk`, `POST export/{id}/zip` |
| Commentaires / libellés | `comments`, `comments/threads`, `labels`, `labels/{id}/usage` |
| Permissions | `permissions/token/`, `permissions/token/{id}`, `permissions/board/{id}` |
| Utilisateur | `users`, `users/me`, `users/me/app-init`, `users/me/counts`, `users/me/history`, `users/me/subscription`, `DELETE/GET users/me/trash`, `users/activity` |
| Auth | `auth/login`, `auth/register`, `auth/clear-session`, `auth-v2/sign-out`, `auth/upgrade-better-auth-session`, `auth/downgrade-better-auth-session` |
| Divers | `version/status`, `locales`, `notifications`, `cms/{x}`, `ping`, `preview/{x}`, `payments/…` |

La suppression définitive passe sans doute par `ELEMENT_DELETE` [stat], non capturé ; la mise à la corbeille (touche Suppr),
observée le 2026-10-09, passe par `ELEMENT_MOVE_MULTI` vers `<boardId>-trash`, section `TRASH` (§4) [obs].

---

## 7. Inconnues restantes

| # | Inconnue | Impact | Comment lever |
|---|---|---|---|
| 1 | ~~AWS WAF hors navigateur~~ **Levée** : API REST et socket.io accessibles depuis Node sans jeton WAF ; une écriture socket depuis Node est appliquée (§1, §2) | — | — |
| 2 | ~~`POST /api/actions` accepte-t-il `ELEMENT_CREATE` ?~~ **Levée** : 200 `success:true` mais aucune création (§1) | Écritures en socket.io | — |
| 3 | ~~Durée de vie du JWT et effet de la migration « Better Auth »~~ **Levée** (2026-10-09) : le compte a migré, le JWT n'existe plus ; le cookie Better Auth expire au bout d'environ 30 jours (§2) | Renouvellement mensuel du cookie | — |
| 4 | Champs minimaux de `ELEMENT_CREATE` : **en partie levée**. `tokens` est inutile sur un board dont on est propriétaire ; `clientId`, `deviceId`, `sessionId` et `versionId` arbitraires sont acceptés. Reste à savoir si `meta`, `channels` et `activity` sont obligatoires | Taille du client | Essais contrôlés sur MCP-TEST |
| 5 | Calcul de `position.score` (65536, 131072, 2883584…) | Placement des cartes | Lecture du bundle (fonction de score) |
| 6 | Rôle de `meta.versionId` / `modifiedVersionId` | Mises à jour concurrentes | Lecture du bundle |
| 7 | Tâches (`TASK_LIST` / `TASK`) et blocs de titre ou de liste ProseMirror — **en partie levée** (2026-10-09) : les captures de lecture montrent `TASK` enfant de `TASK_LIST`, section `INBOX`, position `{index, score: index×65536}`, et les nœuds `heading(level)`, `bulletList`, `orderedList`, `listItem`, `blockquote`, marques `bold`, `italic`, `link(href)`. `add_task` et le Markdown de `add_note` sont construits dessus, **sans capture d'écriture** | Validité des écritures | `scripts/smoke.mjs --write`, puis vérifier l'affichage |
| 8 | Formats de `POST export/{id}` (Markdown ?) — **contournée** : `export_board_markdown` est rendu côté client (2026-10-09) | Qualité du rendu (tableaux Draft.js en brut, état « fait » des tâches inconnu) | Lecture du bundle ou un essai, si l'export serveur devient nécessaire |
| 12 | ~~`add_image` : création en `CANVAS`, URL `original` déduite, légende calquée sur `LINK`~~ **Levée** (2026-10-09, test de fumée) : image affichée et légende rendue. **Largeur levée** (2026-10-09) : `content.width` est en unités de grille de **10 px** (mesuré : 34 → 338 px, 50 → 498 px, 20 → 198 px, bordure comprise) ; 34 est la largeur d'une note standard (15 `CARD` sur 29 dans les captures, colonnes idem). Sans `width`, la carte prend la largeur naturelle de l'image | — | — |
| 13 | `add_task`, `create_board`, Markdown de `add_note` : **validés** par le test de fumée du 2026-10-09 (tâches cochables, sous-board, gras/lien/puces rendus). ~~`search_boards` répond sans résultat~~ **Levée** : capture de la loupe du client web, `sort=viewed` (et non `relevance`) ; valeurs de `sort` acceptées au-delà de `viewed`/`modified` non vérifiées | — | — |
| 14 | **État coché d'une tâche** — **levée** (2026-11-16) : le client web affiche une `TASK` cochée quand `content.isComplete === true` (case remplie, texte grisé, contrôle par Playwright sur MCP-TEST). `completed` + `completionTime`, présents sur d'anciennes tâches (`captures/143-boards-children`), sont acceptés par `ELEMENT_UPDATE` mais sans effet visible. `set_tasks_done` écrit `{isComplete}` par `ELEMENT_UPDATE` (forme générique, non capturée, relue) | — | — |
| 15 | `edit_note` : `ELEMENT_UPDATE {changes:{textContent}}` avec `updates[].meta = {modifiedVersionId: <meta.versionId lu>, versionId: <nouveau>}` (forme de ws-07) — **validé** au test de fumée du 2026-11-16 (ajout en fin de note relu) | — | — |
| 16 | ~~Restaurer, déplacer vers un autre board, ranger dans une colonne~~ **Levée** (2026-11-16, capture Playwright par glisser-déposer sur MCP-TEST) : `ELEMENT_MOVE_MULTI` avec `moveOperation:"DROP"` (§4, fixtures `ws-11` à `ws-15`). Lecture de la corbeille : `GET users/me/trash?other-users=false` (§3) | — | — |
| 18 | Page suivante de `GET users/me/trash` (`hasMore`, `earliestTimestamp`, `earliestId`) : faire défiler le panneau Corbeille n'a déclenché aucune requête lors de la capture | `list_trash` / `restore_elements` ne voient que les ~100 éléments les plus récents du compte | Capturer la requête de la page 2 (défilement réel dans le panneau, ou lecture du bundle) |
| 17 | `GET boards?ids=…&loadAncestors=true` renvoie aussi les **ancêtres** du board (board parent, accueil) : ne pas les prendre pour des sous-boards (corrigé dans `export_board_markdown` le 2026-11-16, qui chargeait le board parent à chaque export) | — | — |
| 9 | Rate limiting | Prudence | Non mesuré ; rester sur des appels unitaires |
| 10 | Preuves REA citables (Evidence IDs), contrôle d'inactivité (pas de polling hors socket) | Traçabilité | Session suivante, une fois les origines autorisées (voir le compte rendu) |
| 11 | Diffusion en direct : un onglet Milanote déjà ouvert n'affiche pas les cartes créées depuis Node avant rechargement. Faut-il viser aussi le canal `<boardId>-LIVE` ? | Confort | Essai avec `channels: [boardId, boardId-LIVE]` |
