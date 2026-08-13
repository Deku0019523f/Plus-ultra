# Ultra Agent

Agent WhatsApp intelligent pour la **modération et l'animation de groupes**, multi-comptes et multi-groupes, avec IA (Groq), transcription vocale (Whisper), réponses vocales (TTS français) et relais Telegram pour la connexion.

## Sommaire

- [Stack](#stack)
- [Architecture des données](#architecture-des-données)
- [Installation](#installation)
- [Configuration (.env)](#configuration-env)
- [Démarrage](#démarrage)
- [Déploiement VPS avec PM2](#déploiement-vps-avec-pm2)
- [Utilisation](#utilisation)
- [Bot Telegram (relais de connexion)](#bot-telegram-relais-de-connexion)
- [Commandes WhatsApp](#commandes-whatsapp)
- [API Web](#api-web)
- [Sécurité & isolation](#sécurité--isolation)
- [Dépannage](#dépannage)

## Stack

- Node.js + Express (serveur web/API)
- [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — connexion WhatsApp par **Pairing Code**
- SQLite (better-sqlite3) — source fiable pour les recherches rapides (comptes, groupes, avertissements, autorisations de liens, mutes, liste noire)
- Groq SDK — rotation de modèles texte avec fallback + transcription vocale Whisper-large-v3
- `node-telegram-bot-api` — bot Telegram optionnel pour relayer la connexion WhatsApp
- `ffmpeg-static` — conversion MP3 → OGG/Opus pour les réponses vocales (format natif WhatsApp)
- PM2 — supervision en production

## Architecture des données

```
data/
├── ultra-agent.sqlite          # source de vérité (comptes, groupes, avertissements, liens, mutes, liste noire)
└── users/
    └── {USER_ID}/
        ├── session/             # session Baileys (persistante)
        ├── user.json            # instantané lisible du compte
        └── groups/
            └── {GROUP_JID}/
                ├── config.json          # instantané lisible de la config du groupe
                ├── memory/
                │   ├── current.json     # messages actifs (max configurable, 1000 par défaut)
                │   └── archive/
                │       ├── archive_001.json
                │       └── ...
                ├── cache/
                └── temp/                # fichiers audio temporaires (nettoyés après transcription)
```

Chaque utilisateur, chaque groupe et chaque mémoire est strictement isolé : toute lecture passe par une vérification d'appartenance (`group_jid` + `user_id`) côté SQLite avant d'accéder aux fichiers.

Tables SQLite principales : `users`, `groups` (config + toggles par groupe), `warnings`, `link_authorizations`, `mutes`, `blacklist_words`, `memory_stats`.

## Installation

Prérequis : Node.js ≥ 20, `build-essential` et `python3` sur le VPS (nécessaires pour compiler `better-sqlite3`), `ffmpeg` géré automatiquement via `ffmpeg-static` (aucune install système requise).

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
git clone <votre-repo> ultra-agent && cd ultra-agent
npm install
cp .env.example .env
```

> Si la compilation native de `better-sqlite3` échoue sur un hébergeur très contraint (peu de RAM/CPU), remplacez-la par le module natif `node:sqlite` (Node ≥ 22) dans `src/database/db.js` — c'est le correctif qui avait résolu le même problème sur Darkdeku-Agent hébergé sur un conteneur limité.

## Configuration (.env)

Éditez `.env` (voir `.env.example`) :

| Variable | Description |
|---|---|
| `PORT` | Port du serveur web (défaut 3000) |
| `GROQ_API_KEY` | Clé API Groq (texte + Whisper) |
| `GROQ_TEXT_MODELS` | Liste ordonnée des modèles texte (rotation + fallback). Vérifier régulièrement sur [console.groq.com](https://console.groq.com/docs/models) : Groq déprécie ses modèles sans préavis long |
| `GROQ_VOICE_MODEL` | Modèle de transcription (whisper-large-v3) |
| `MAX_WARNINGS` | Seuil d'avertissements avant expulsion (défaut 3) |
| `MEMORY_LIMIT` | Taille max de `current.json` avant archivage (défaut 1000) |
| `MEMORY_CONTEXT_MESSAGES` | Nombre de messages récents injectés dans le contexte IA (défaut 25, plafonné à 4000 caractères au total) |
| `BOT_NAME` | Nom affiché par l'agent |
| `BOT_LOGO_URL` | Image envoyée dans le message de bienvenue après connexion |
| `WA_VERSION` | Override manuel de version WA Web, format `2,3000,xxxxxxxxx` — à ne remplir que si le pairing échoue en boucle avec le log *"Impossible de confirmer la dernière version WA Web"* |
| `TELEGRAM_BOT_TOKEN` | Token `@BotFather` pour activer le bot Telegram de relais. Laisser vide pour désactiver |
| `AI_REPLY_DELAY_MIN_MS` / `AI_REPLY_DELAY_MAX_MS` | Délai aléatoire (ms) avant l'envoi d'une réponse IA, pour un timing moins "robot" (défaut 10000–60000) |
| `AI_VOICE_REPLY` | `true` pour que l'IA réponde en vocal français par défaut (override possible par groupe via `.vocal`) |

## Démarrage

```bash
npm start          # démarrage simple
npm run dev         # avec nodemon (développement)
```

Le serveur écoute sur `http://IP_DU_VPS:3000`. Ouvrez cette adresse pour connecter un compte WhatsApp par Pairing Code depuis l'interface web (ou utilisez le [bot Telegram](#bot-telegram-relais-de-connexion)).

## Déploiement VPS avec PM2

```bash
npm install -g pm2
npm run pm2:start      # démarre via ecosystem.config.js
pm2 save
pm2 startup            # relance automatique au reboot du VPS
npm run pm2:logs        # suivre les logs
npm run pm2:restart     # redémarrer après une mise à jour
```

Les sessions WhatsApp sont automatiquement restaurées et reconnectées au redémarrage du process (backoff progressif, 5 tentatives max par compte).

> ⚠️ **Ne redémarrez pas le process dans les 3-5 minutes qui suivent un nouveau pairing.** WhatsApp échange plusieurs paquets de synchronisation de clés juste après la liaison ; une coupure pendant cette fenêtre peut corrompre irrémédiablement la session Signal (erreurs `Bad MAC` en boucle) et forcer un nouveau pairing complet.

## Utilisation

1. Ouvrir `http://IP_DU_VPS:3000` (ou envoyer `/connect +225...` au bot Telegram).
2. Renseigner le numéro WhatsApp (format international) et récupérer le **Pairing Code**.
3. Sur le téléphone : *WhatsApp → Appareils connectés → Associer un appareil → Associer avec le numéro de téléphone*, puis saisir le code **sans attendre** (expiration rapide).
4. Une fois connecté, un message de bienvenue est envoyé automatiquement sur le compte.
5. Dans chaque groupe à modérer, un administrateur tape `.plus_ultra` pour activer l'agent — la description du groupe devient automatiquement son règlement de référence.

## Bot Telegram (relais de connexion)

Si `TELEGRAM_BOT_TOKEN` est renseigné, un bot Telegram démarre en parallèle du serveur web (polling) :

| Commande Telegram | Effet |
|---|---|
| `/start` | Crée/retrouve le compte lié à ce chat Telegram |
| `/connect +225XXXXXXXXXX` | Génère un pairing code et le renvoie directement dans Telegram |
| `/status` | Affiche l'état de connexion WhatsApp du compte |
| `/disconnect` | Déconnecte le compte WhatsApp |

Le bot notifie aussi automatiquement le chat Telegram lors d'une connexion réussie, d'une déconnexion (logout depuis le téléphone) ou d'un échec de reconnexion définitif.

## Commandes WhatsApp

Toutes les commandes marquées **admin** sont réservées aux administrateurs du groupe (vérification robuste, y compris avec les identifiants LID de WhatsApp).

| Commande | Accès | Effet |
|---|---|---|
| `.plus_ultra` | admin | Active l'agent dans le groupe |
| `.plus_ultra_off` | admin | Désactive l'agent |
| `.lien @membre N` | admin | Autorise N liens à ce membre |
| `.lien_reset @membre` | admin | Remet à zéro le quota de liens consommés d'un membre |
| `.lien_tous N` | admin | Autorise N liens à **tous** les membres actuels du groupe |
| `.warn @membre [raison]` | admin | Ajoute un avertissement (expulsion automatique au seuil) |
| `.unwarn @membre` | admin | Retire un avertissement |
| `.warns [@membre]` | tous | Affiche les avertissements du groupe ou d'un membre |
| `.mute @membre [durée]` | admin | Rend un membre muet — messages supprimés silencieusement. Durée optionnelle : `30m`, `2h`, `1d` (sans durée = indéfini) |
| `.unmute @membre` | admin | Lève le mute |
| `.kick @membre` | admin | Expulsion directe, sans passer par le seuil d'avertissements |
| `.antispam on\|off` | admin | Anti-flood : sanctionne un membre qui envoie trop de messages sur une courte fenêtre |
| `.antimedia on\|off` | admin | Bloque images/vidéos/stickers/documents envoyés par les non-admins |
| `.antibot on\|off` | admin | Supprime les messages qui ressemblent à des commandes destinées à **d'autres** bots (préfixes `.` `!` `/` `#` non reconnus par Ultra Agent) |
| `.blacklist ajouter\|retirer\|liste <mot>` | admin | Gère une liste de mots interdits, supprimés automatiquement |
| `.tagall [message]` | admin | Mentionne tous les membres du groupe |
| `.info` | tous | Affiche les informations du groupe (membres, admins, date de création) |
| `.bienvenue on\|off [message]` | admin | Message d'accueil automatique aux nouveaux membres. Le message personnalisé accepte `{membre}` et `{groupe}` |
| `.vocal on\|off\|defaut` | admin | Bascule les réponses de l'IA en vocal ou texte **pour ce groupe** (`defaut` = suit `AI_VOICE_REPLY` du `.env`) |
| `.reglement` | admin | Réactualise le règlement depuis la description du groupe |
| `.status` | tous | Affiche l'état complet de l'agent dans le groupe (tous les toggles) |
| `.help` | tous | Affiche la liste des commandes |

L'IA répond aussi lorsqu'elle est **mentionnée** ou lorsqu'on **répond directement à un de ses messages** (quote), et modère automatiquement (avertissement + expulsion au seuil) les messages qui enfreignent le règlement — un pré-filtre local (anti-liens, anti-spam, anti-média, liste noire) évite un appel IA à chaque message pour rester économe en tokens et éviter les dépassements de quota (TPM).

## API Web

Toutes les routes sous `/api` (hors `/api/register`) exigent l'en-tête `x-api-key`, obtenu via :

```
POST /api/register           → { userId, apiKey }
```

| Route | Effet |
|---|---|
| `GET /api/status` | État de connexion du compte |
| `POST /api/pairing` | `{ phoneNumber }` → génère un pairing code |
| `GET /api/groups` | Liste les groupes du compte connecté |
| `GET /api/groups/:groupId` | Détail d'un groupe (appartenance vérifiée) |
| `POST /api/groups/:groupId/enable` | Active un groupe |
| `POST /api/groups/:groupId/disable` | Désactive un groupe |
| `GET /api/groups/:groupId/memory` | Messages récents en mémoire |
| `GET /api/groups/:groupId/stats` | Statistiques mémoire (compteur, archives) |

Un utilisateur ne peut jamais accéder aux groupes d'un autre compte : chaque route vérifie `group_jid` + `user_id` avant de répondre (404 sinon).

## Sécurité & isolation

- Sessions et données isolées par utilisateur (`data/users/{USER_ID}`) et par groupe.
- Toute vérification d'appartenance passe par SQLite (jamais par simple confiance dans les chemins).
- Aucune clé API n'est exposée au frontend ni dans les logs (`pino` avec `redact`).
- Aucune action administrative (suppression de message, expulsion) n'est tentée sans avoir vérifié au préalable que le bot est bien administrateur du groupe.
- Le moteur de modération IA ne sanctionne jamais directement : il propose une décision structurée ; c'est le code applicatif qui décide et exécute.
- Le contexte envoyé à l'IA (mémoire du groupe + message courant) est systématiquement tronqué avant l'appel, pour ne jamais dépasser les limites de tokens des modèles Groq.
- Une erreur sur un message, un compte ou un appel Groq n'interrompt jamais le reste du service.

## Dépannage

- **Pairing code généré mais rien ne se passe sur le téléphone, timeout `408` après ~2min** : quasi toujours une version WA Web périmée renvoyée silencieusement par `fetchLatestBaileysVersion()` (bug connu et actif côté Baileys). Vérifiez le log `"Impossible de confirmer la dernière version WA Web"` au démarrage et fixez `WA_VERSION` manuellement (voir `.env.example`), ou mettez à jour `@whiskeysockets/baileys`.
- **Erreurs `Bad MAC` / `Failed to decrypt message` en boucle, le bot ne reçoit plus aucun message (texte ou vocal)** : session Signal corrompue, généralement causée par un redémarrage du process pendant la fenêtre de stabilisation post-pairing (voir avertissement dans [Déploiement](#déploiement-vps-avec-pm2)). Seule solution : `rm -rf data/users/{USER_ID}/session` puis un nouveau pairing, en laissant tourner sans interruption ensuite.
- **`.help` toujours affiché à l'ancienne, une commande "ne passe pas"** : vérifiez `git status` avant de pousser — un fichier modifié oublié dans le commit reproduit exactement ce symptôme (le fichier n'apparaît alors pas dans le diff du `git pull` côté VPS).
- **L'IA ne répond plus après quelques messages, erreur `413 Request too large` / `rate_limit_exceeded`** : un modèle Groq a été déprécié (changez `GROQ_TEXT_MODELS`, voir [console.groq.com/docs/models](https://console.groq.com/docs/models)) ou le contexte envoyé était trop volumineux (déjà plafonné par défaut dans `src/ai/prompts.js`, à ajuster si le souci persiste).
- **Un vocal envoyé par le bot affiche "souci avec le fichier audio"** : WhatsApp exige de l'OGG/Opus pour un `ptt: true`, jamais du MP3 brut — géré automatiquement par `ffmpeg-static` (`src/ai/tts.js`) ; si l'erreur persiste, vérifiez que `ffmpeg-static` est bien installé (`npm install`).
- **Le bot ne détecte pas qu'un admin est admin, ou ne réagit pas à une mention/réponse** : WhatsApp identifie parfois le même compte par un LID plutôt que son numéro selon le contexte. Toute la détection (admin, mention, kick, mute...) résout ces deux formats — si le souci persiste après une mise à jour, vérifiez que tous les fichiers modifiés ont bien été poussés (voir point `git status` ci-dessus).
- **Un lien passe alors qu'il ne devrait pas** : la détection de lien (`src/moderation/antiLink.js`) repose sur une liste de TLD + une liste de services connus (t.me, wa.me, discord.gg, raccourcisseurs...) — par nature jamais totalement exhaustive. Ajoutez le domaine manquant dans `KNOWN_LINK_SERVICES_RE` ou la liste de TLD.
- **Le bot ne peut pas expulser un membre** : il doit être administrateur du groupe WhatsApp.
- **Erreur de compilation `better-sqlite3`** : installez `build-essential python3`, ou basculez sur `node:sqlite` (voir section Installation).
- **`GROQ_API_KEY` manquante** : l'IA conversationnelle et la modération se désactivent silencieusement (aucun crash) ; l'anti-liens et les commandes restent pleinement fonctionnels puisqu'ils ne dépendent pas de l'IA.
