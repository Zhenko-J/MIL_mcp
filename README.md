# milanote-mcp

Serveur [MCP](https://modelcontextprotocol.io) local (stdio) qui permet à un assistant comme Claude de **lire** et
d'**écrire** dans [Milanote](https://milanote.com) : lister et lire des boards, les exporter en Markdown, chercher,
ajouter des notes, liens, images, listes de tâches, colonnes et sous-boards, déplacer des cartes, les mettre à la
corbeille et les restaurer.

> [!WARNING]
> **Projet non officiel, sans lien avec Milanote.** Milanote ne publie pas d'API : ce serveur parle à l'API interne
> du client web, observée dans un navigateur ([docs/endpoints.md](docs/endpoints.md)). Elle peut changer à tout moment
> et casser le serveur. Les conditions d'utilisation de Milanote n'ont pas été vérifiées pour cet usage : à utiliser
> sur **son propre compte**, à ses risques, de façon modérée (aucun appel en masse, aucune automatisation de la
> connexion). « Milanote » est une marque de son propriétaire.

## Sommaire

- [Outils](#outils)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Ouvrir la session Milanote](#ouvrir-la-session-milanote)
- [Brancher le serveur](#brancher-le-serveur)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Garde-fous](#garde-fous)
- [Variables d'environnement](#variables-denvironnement)
- [Tests](#tests)
- [Limites connues](#limites-connues)
- [Licence](#licence)

## Outils

| Outil | Rôle | Écriture |
|---|---|---|
| `session_status` | État de la session (source, jours restants, écritures, rafraîchissement) ; `check` la vérifie auprès de Milanote. Jamais le jeton | non |
| `list_boards` | Boards et alias contenus dans un board (accueil par défaut), y compris dans les colonnes | non |
| `get_board` | Contenu structuré d'un board : notes, liens, images, fichiers, listes de tâches (état coché), tableaux, sous-boards, colonnes, section et position | non |
| `export_board_markdown` | Markdown d'un board ; `depth` inclut les sous-boards, `output_path` écrit un fichier `.md` (jamais d'écrasement sans `overwrite`) | non (Milanote) |
| `search_boards` | Recherche plein texte dans tous les boards (la loupe du client web) | non |
| `add_note` | Carte note en Markdown ligne à ligne | oui |
| `edit_note` | Complète (`append`, défaut) ou remplace (`replace`) le texte d'une note | oui |
| `add_link` | Carte lien (aperçu récupéré par Milanote ; `title` le remplace) | oui |
| `add_image` | Téléverse une image locale (PNG, JPEG, GIF, WebP, 25 Mo max) avec légende et largeur facultatives | oui |
| `add_task` | Liste de tâches : titre facultatif + une tâche par entrée | oui |
| `set_tasks_done` | Coche ou décoche des tâches | oui |
| `create_board` | Sous-board avec titre et couleur facultative | oui |
| `create_column` | Colonne sur le canvas, titre facultatif | oui |
| `move_elements` | Range des cartes dans une colonne, les envoie dans « À trier » d'un autre board, ou les ressort d'une colonne | oui |
| `trash_elements` | Met des cartes à la corbeille de leur board (restaurable, comme la touche Suppr) | oui |
| `list_trash` | Cartes de la corbeille d'un board (date, emplacement de restauration) | non |
| `restore_elements` | Remet des cartes de la corbeille à leur emplacement d'origine | oui |

Tous les outils acceptent un id de board (14 caractères) **ou l'URL** `https://app.milanote.com/<id>/…` copiée du
navigateur. Aucun outil ne supprime définitivement : la suppression passe toujours par la corbeille du board.

`add_note` et `edit_note` lisent un Markdown ligne à ligne : `# titre`, `- puce`, `1. numéro`, `> citation`, **gras**,
*italique*, `code`, [texte](url). Une ligne reste un bloc ; le texte brut passe tel quel.

## Prérequis

- Node.js 22 ou plus récent.
- Google Chrome ou Microsoft Edge installé (pour ouvrir la session une fois ; aucun navigateur n'est téléchargé).
- Un compte Milanote.
- Un client MCP : Claude Code, Claude Desktop ou tout client compatible stdio.

Développé et testé sous Windows 11. Le code n'utilise que des API Node portables ; macOS et Linux devraient fonctionner
mais n'ont pas été essayés.

## Installation

```bash
git clone https://github.com/Zhenko-J/milanote-mcp.git
```

```bash
cd milanote-mcp
```

```bash
npm install
```

```bash
npm run build
```

Le serveur compilé est `dist/src/server.js`.

## Ouvrir la session Milanote

Le serveur utilise le cookie de session du client web (`__Secure-milanote.session_token`, valable environ 30 jours).
Aucun identifiant ni mot de passe n'est stocké, et la connexion n'est jamais automatisée.

```bash
npm run session
```

Le script ouvre Milanote dans Chrome (ou Edge : `MILANOTE_BROWSER=msedge`) avec un **profil dédié**, rangé dans
`~/.milanote-mcp/profile` (`%USERPROFILE%\.milanote-mcp\profile` sous Windows), hors du dépôt. Tu te connectes toi-même
dans la fenêtre ; dès que la session est détectée, la fenêtre se ferme et le cookie est écrit dans
`~/.milanote-mcp/session.json`. Les fois suivantes, le script relit le profil sans ouvrir de fenêtre tant qu'il est
connecté.

- `npm run session -- --check` : état du fichier, sans rien ouvrir.
- `npm run session -- --login` : force la fenêtre (changer de compte, session invalide).
- `npm run session -- --refresh` : sans fenêtre uniquement ; code 2 si le profil n'est plus connecté.

**Pas de redémarrage nécessaire.** Le serveur démarre même sans session et relit le fichier à chaque appel : après un
`npm run session`, l'appel suivant fonctionne. Sans session, chaque outil renvoie un message qui dit quoi faire.

**Rafraîchissement automatique.** Quand la session manque, a expiré ou expire dans moins de 7 jours, le serveur lance
en arrière-plan `npm run session -- --refresh` (au plus une fois toutes les 10 minutes). Il n'ouvre jamais de fenêtre :
si le profil n'est plus connecté, il faut relancer `npm run session` soi-même. `MILANOTE_AUTO_REFRESH=0` le désactive.

**Variante sans navigateur.** Copier la valeur du cookie depuis les outils de développement du navigateur
(F12 > Application > Cookies > `https://app.milanote.com` > `__Secure-milanote.session_token`) dans la variable
d'environnement `MILANOTE_SESSION_TOKEN`. Elle prime sur le fichier. Ne jamais la coller dans un chat ni dans un fichier
versionné.

> [!NOTE]
> **Claude Desktop sous Windows.** L'application est distribuée en paquet MSIX : les processus qu'elle lance (dont un
> serveur MCP) voient `%LOCALAPPDATA%` à travers une copie privée. C'est pourquoi la session vit dans le dossier
> utilisateur (`%USERPROFILE%`), qui n'est pas redirigé.

## Brancher le serveur

Remplacer `/chemin/vers/milanote-mcp` par le dossier cloné.

**Claude Code**, lecture seule :

```bash
claude mcp add milanote --scope user -- node /chemin/vers/milanote-mcp/dist/src/server.js
```

Avec les écritures (créer, déplacer, mettre à la corbeille) :

```bash
claude mcp add milanote --scope user --env MILANOTE_ENABLE_WRITE=1 -- node /chemin/vers/milanote-mcp/dist/src/server.js
```

**Claude Desktop**, dans `claude_desktop_config.json` (Paramètres > Développeur > Modifier la configuration) :

```json
{
  "mcpServers": {
    "milanote": {
      "command": "node",
      "args": ["C:\\chemin\\vers\\milanote-mcp\\dist\\src\\server.js"],
      "env": { "MILANOTE_ENABLE_WRITE": "1" }
    }
  }
}
```

Après un `npm run build`, reconnecter le serveur (`/mcp` dans Claude Code, redémarrage de Claude Desktop) pour charger
la nouvelle version. Pour vérifier : demander à Claude d'appeler `session_status` avec `check: true`.

## Exemples d'utilisation

Quelques demandes typiques à l'assistant, une fois le serveur branché :

- « Liste mes boards Milanote » → `list_boards`.
- « Résume le board https://app.milanote.com/1Xe…/inspiration » → `get_board`.
- « Exporte ce board et ses sous-boards en Markdown dans `notes/board.md` » → `export_board_markdown` avec `depth` et
  `output_path`.
- « Où ai-je noté le devis du menuisier ? » → `search_boards`.
- « Ajoute une note avec le compte rendu de la réunion » → `add_note` (Markdown).
- « Crée une colonne À valider et range-y les trois liens du haut » → `create_column`, puis `move_elements`.
- « Coche les deux premières tâches de la liste » → `set_tasks_done`.
- « J'ai supprimé une carte par erreur, remets-la » → `list_trash`, puis `restore_elements`.

Chaque outil d'écriture accepte `dry_run: true`, qui renvoie les actions qui seraient envoyées sans rien modifier.

## Garde-fous

- **Écritures désactivées par défaut** : il faut `MILANOTE_ENABLE_WRITE=1`. Sans cette variable, seul `dry_run: true`
  fonctionne pour les outils d'écriture.
- **Jamais de nouvelle tentative automatique** d'une écriture.
- **Chaque écriture est relue, contenu compris.** Milanote acquitte même des requêtes sans effet : le serveur relit
  l'élément jusqu'à 3 fois (1,5 s, 2,5 s, 4 s) et vérifie le texte d'une note, l'URL d'un lien, le fichier d'une image,
  le titre d'un board, l'état d'une tâche, l'emplacement d'une carte déplacée. Sinon : erreur « non confirmée ».
- **Une écriture à la fois** : deux appels simultanés passent l'un après l'autre.
- **Pas de carte orpheline** : si une étape échoue après la création (aperçu, téléversement, titre), la carte déjà
  créée est mise à la corbeille du board et l'erreur le dit.
- **Pas de suppression définitive** : uniquement la corbeille du board, restaurable.
- `MILANOTE_BASE_URL` n'accepte qu'une origine `https://…milanote.com` : le cookie ne part jamais ailleurs.
- Le jeton n'est jamais journalisé ni renvoyé ; les journaux vont sur stderr. Cache en mémoire uniquement (60 s).

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `MILANOTE_ENABLE_WRITE` | désactivé | `1` pour autoriser les écritures |
| `MILANOTE_SESSION_TOKEN` | — | Cookie de session ; sinon le serveur lit le fichier de `npm run session` |
| `MILANOTE_SESSION_FILE` | `~/.milanote-mcp/session.json` | Fichier de session |
| `MILANOTE_HOME` | `~/.milanote-mcp` | Dossier du profil navigateur et du fichier de session |
| `MILANOTE_BROWSER` | `chrome` | Navigateur de `npm run session` (`chrome` ou `msedge`) |
| `MILANOTE_AUTO_REFRESH` | activé | `0` pour ne jamais lancer le rafraîchissement en arrière-plan |
| `MILANOTE_CACHE_TTL_MS` | `60000` | Durée du cache mémoire des boards |
| `MILANOTE_TIMEOUT_MS` | `15000` | Délai des requêtes REST |
| `MILANOTE_LOCALE` | `fr-fr` | Langue de l'aperçu des liens |
| `MILANOTE_BASE_URL` | `https://app.milanote.com` | Origine de l'API (seule une origine `https://…milanote.com` est acceptée) |
| `MILANOTE_TOKEN` | — | Ancien jeton JWT (`mn-token`), pour un compte qui n'aurait pas migré vers la session actuelle |

## Tests

```bash
npm test
```

58 tests hors réseau : fixtures anonymisées de `test/fixtures/` (trames et réponses observées, identifiants et textes
remplacés), et un faux Milanote en mémoire (`test/fakes.ts`) qui teste la façade : relectures, écriture sans effet,
file d'écriture, carte orpheline, export partiel, corbeille, déplacements, session paresseuse.

Test de bout en bout contre la vraie API, **sur un board de test vide créé pour l'occasion** (jamais sur un board
réel) :

```bash
node scripts/smoke.mjs <id_du_board_de_test>
```

Avec `--write` (et donc des écritures réelles), le script crée sur ce board une note, un lien, une image, une liste de
tâches, un sous-board et une colonne, les déplace, met une carte à la corbeille puis la restaure, et met enfin tout ce
qu'il a créé à la corbeille du board de test.

## Limites connues

- Un onglet Milanote déjà ouvert n'affiche les cartes créées par le serveur qu'après rechargement.
- Placement approximatif des nouvelles cartes : colonne x=25, sous la carte la plus basse (hauteur des notes estimée).
- Une image plus petite que la carte est agrandie (et floue) : réduire `width` dans ce cas.
- `list_trash` et `restore_elements` ne lisent que la première page de la corbeille du compte (les éléments les plus
  récents, une centaine) ; un élément plus ancien se restaure dans le client web.
- `move_elements` vers un autre board dépose les cartes dans « À trier » sans ouvrir ce panneau.
- `edit_note` en mode `replace` écrase le texte : lire la note avant.
- Les tâches, colonnes et déplacements suivent des formes observées sur le client web ; voir les inconnues restantes
  dans [docs/endpoints.md §7](docs/endpoints.md).

## Licence

[Apache-2.0](LICENSE). Voir aussi [NOTICE](NOTICE).
