# Ultra Agent

Agent WhatsApp intelligent pour la **modération et l'animation de groupes**, multi-comptes et multi-groupes, avec IA (Groq) et transcription vocale (Whisper).

## Sommaire

- [Stack](#stack)
- [Architecture des données](#architecture-des-données)
- [Installation](#installation)
- [Configuration (.env)](#configuration-env)
- [Démarrage](#démarrage)
- [Déploiement VPS avec PM2](#déploiement-vps-avec-pm2)
- [Utilisation](#utilisation)
- [Commandes WhatsApp](#commandes-whatsapp)
- [API Web](#api-web)
- [Sécurité & isolation](#sécurité--isolation)
- [Dépannage](#dépannage)

## Stack

- Node.js + Express (serveur web/API)
- [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — connexion WhatsApp par **Pairing Code**
- SQLite (better-sqlite3) — source fiable pour les recherches rapides (comptes, groupes, avertissements, autorisations de liens)
- Groq SDK — rotation de modèles texte avec fallback + transcription vocale Whisper-large-v3
- PM2 — supervision en production

## Architecture des données

```
data/
├── ultra-agent.sqlite          # source de vérité (comptes, groupes, avertissements, liens)
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

## Installation

Prérequis : Node.js ≥ 20, `build-essential` et `python3` sur le VPS (nécessaires pour compiler `better-sqlite3`).

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
| `GROQ_TEXT_MODELS` | Liste ordonnée des modèles texte (rotation + fallback) |
| `GROQ_VOICE_MODEL` | Modèle de transcription (whisper-large-v3) |
| `MAX_WARNINGS` | Seuil d'avertissements avant expulsion (défaut 3) |
| `MEMORY_LIMIT` | Taille max de `current.json` avant archivage (défaut 1000) |
| `BOT_NAME` | Nom affiché par l'agent |
| `BOT_LOGO_URL` | Image envoyée dans le message de bienvenue après connexion |

## Démarrage

```bash
npm start          # démarrage simple
npm run dev         # avec nodemon (développement)
```

Le serveur écoute sur `http://IP_DU_VPS:3000`. Ouvrez cette adresse pour connecter un compte WhatsApp par Pairing Code depuis l'interface web.

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

## Utilisation

1. Ouvrir `http://IP_DU_VPS:3000`.
2. Renseigner le numéro WhatsApp (format international) et récupérer le **Pairing Code**.
3. Sur le téléphone : *WhatsApp → Appareils connectés → Associer un appareil → Associer avec le numéro de téléphone*, puis saisir le code.
4. Une fois connecté, un message de bienvenue est envoyé automatiquement sur le compte.
5. Dans chaque groupe à modérer, un administrateur tape `.plus_ultra` pour activer l'agent — la description du groupe devient automatiquement son règlement de référence.

## Commandes WhatsApp

| Commande | Accès | Effet |
|---|---|---|
| `.plus_ultra` | admin | Active l'agent dans le groupe |
| `.plus_ultra_off` | admin | Désactive l'agent |
| `.lien @membre N` | admin | Autorise N liens à ce membre |
| `.warn @membre` | admin | Ajoute un avertissement (expulsion automatique au seuil) |
| `.unwarn @membre` | admin | Retire un avertissement |
| `.warns [@membre]` | tous | Affiche les avertissements du groupe ou d'un membre |
| `.reglement` | admin | Réactualise le règlement depuis la description du groupe |
| `.status` | tous | Affiche l'état de l'agent dans le groupe |
| `.help` | tous | Affiche la liste des commandes |

L'IA répond aussi lorsqu'elle est mentionnée (`@UltraAgent ...`), et modère automatiquement (avertissement + expulsion au seuil) les messages qui enfreignent le règlement — un pré-filtre local évite un appel IA à chaque message pour rester économe en tokens.

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
- Une erreur sur un message, un compte ou un appel Groq n'interrompt jamais le reste du service.

## Dépannage

- **Pairing code refusé / bloqué sur "Connexion..."** : vérifiez que le VPS a un accès sortant stable à Internet et laissez le délai de 3s avant la demande de code se dérouler sans interruption (déjà géré dans le code).
- **Le bot ne peut pas expulser un membre** : il doit être administrateur du groupe WhatsApp.
- **Erreur de compilation `better-sqlite3`** : installez `build-essential python3`, ou basculez sur `node:sqlite` (voir section Installation).
- **`GROQ_API_KEY` manquante** : l'IA conversationnelle et la modération se désactivent silencieusement (aucun crash) ; l'anti-liens et les commandes restent pleinement fonctionnels puisqu'ils ne dépendent pas de l'IA.
