'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config/config');
const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);

const CUSTOM_DIR = path.join(__dirname, 'custom');
const BACKUPS_DIR = path.join(CUSTOM_DIR, '.backups');

// Commandes réservées : un upload ne peut jamais écraser une commande native.
const RESERVED_NAMES = new Set([
  '.plus_ultra', '.plus_ultra_off', '.lien', '.lien_reset', '.lien_tous',
  '.warn', '.unwarn', '.warns', '.mute', '.unmute', '.kick', '.antispam',
  '.antimedia', '.antibot', '.antibot_prefixes', '.blacklist', '.tagall',
  '.info', '.bienvenue', '.vocal', '.reglement', '.status', '.statut', '.help',
]);

// name -> { handler, adminOnly, description, fileName }
const registry = new Map();
// fileName -> onMessage(ctx) — exécuté sur CHAQUE message qui survit à la
// modération (pas les messages supprimés), pour les fonctionnalités type
// "réagir automatiquement" plutôt que "répondre à une commande tapée".
const messageHooks = new Map();

function ensureDirs() {
  fs.mkdirSync(CUSTOM_DIR, { recursive: true });
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function safeFileName(commandName) {
  // le nom de commande sert de nom de fichier : on interdit tout ce qui
  // pourrait sortir du dossier custom/ (traversal) ou casser le filesystem.
  return commandName.replace(/^\./, '').replace(/[^a-z0-9_-]/gi, '_') + '.js';
}

/** Valide la syntaxe JS du fichier sans jamais l'exécuter. */
async function checkSyntax(filePath) {
  try {
    await execFileAsync(process.execPath, ['--check', filePath]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || '').toString().slice(0, 500) };
  }
}

/**
 * Scan avertissement (pas un blocage) : signale les API sensibles présentes
 * dans le fichier, pour que la personne qui valide sache à quoi s'attendre.
 * Ce n'est PAS une sandbox — juste un signal visuel avant activation.
 */
function scanForRiskyApis(source) {
  const flags = [];
  const checks = [
    [/require\(['"]child_process['"]\)/, 'exécution de commandes système (child_process)'],
    [/require\(['"]fs['"]\)/, "accès au système de fichiers (hors dossier de la commande)"],
    [/\bprocess\.exit\(/, 'peut arrêter le process du bot'],
    [/\beval\(/, 'eval() — exécution de code dynamique'],
    [/require\(['"]https?['"]\)|fetch\(/, 'requêtes réseau sortantes'],
    [/db\.raw\b/, 'accès SQL brut à la base (db.raw)'],
  ];
  for (const [re, label] of checks) {
    if (re.test(source)) flags.push(label);
  }
  return flags;
}

/** Valide la forme exportée par le module (contrat attendu). */
function validateShape(mod, expectedName) {
  if (!mod || typeof mod !== 'object') return 'Le fichier doit exporter un objet (module.exports = {...}).';

  if (typeof mod.name !== 'string' || !mod.name.trim()) {
    return '"name" est obligatoire (identifiant unique, même pour un hook sans commande tapée).';
  }
  if (expectedName && mod.name !== expectedName) {
    return `"name" ("${mod.name}") ne correspond pas au nom annoncé ("${expectedName}").`;
  }
  if (!mod.handler && !mod.onMessage) {
    return 'Le fichier doit définir "handler" (commande tapée), "onMessage" (réagit à chaque message), ou les deux.';
  }
  if (mod.handler) {
    if (!mod.name.startsWith(config.commandPrefix)) {
      return `Pour une commande tapée, "name" doit commencer par "${config.commandPrefix}".`;
    }
    if (RESERVED_NAMES.has(mod.name)) return `"${mod.name}" est une commande native — ne peut pas être remplacée.`;
    if (typeof mod.handler !== 'function') return '"handler" doit être une fonction async (ctx) => {...}.';
  }
  if (mod.onMessage && typeof mod.onMessage !== 'function') {
    return '"onMessage" doit être une fonction async (ctx) => {...}.';
  }
  return null;
}

/** Sauvegarde horodatée du fichier existant avant remplacement (pour /rollback). */
async function backupExisting(fileName) {
  const current = path.join(CUSTOM_DIR, fileName);
  if (!fs.existsSync(current)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUPS_DIR, `${stamp}__${fileName}`);
  await fsp.copyFile(current, backupPath);
  return backupPath;
}

function hashContent(source) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
}

/**
 * Point d'entrée principal : reçoit le CONTENU d'un fichier .js (déjà
 * téléchargé depuis Telegram), le valide, sauvegarde l'ancienne version si
 * remplacement, puis charge la nouvelle commande à chaud.
 * Retourne { ok, name?, hash?, replaced?, riskyApis?, error? }.
 */
async function installFromSource(source, declaredName) {
  ensureDirs();

  const tmpPath = path.join(CUSTOM_DIR, `.tmp-${Date.now()}.js`);
  await fsp.writeFile(tmpPath, source, 'utf8');

  const syntax = await checkSyntax(tmpPath);
  if (!syntax.ok) {
    await fsp.unlink(tmpPath).catch(() => {});
    return { ok: false, error: `Erreur de syntaxe :\n${syntax.error}` };
  }

  let mod;
  try {
    delete require.cache[require.resolve(tmpPath)];
    mod = require(tmpPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    return { ok: false, error: `Erreur au chargement : ${err.message}` };
  } finally {
    delete require.cache[require.resolve(tmpPath)];
  }

  const shapeError = validateShape(mod, declaredName);
  if (shapeError) {
    await fsp.unlink(tmpPath).catch(() => {});
    return { ok: false, error: shapeError };
  }

  const fileName = safeFileName(mod.name);
  const finalPath = path.join(CUSTOM_DIR, fileName);
  const riskyApis = scanForRiskyApis(source);

  const backupPath = await backupExisting(fileName);
  await fsp.rename(tmpPath, finalPath);

  // Chargement à chaud : invalide le cache pour reprendre la toute dernière version.
  delete require.cache[require.resolve(finalPath)];
  const finalMod = require(finalPath);

  const displayName = finalMod.name;

  if (finalMod.handler) {
    registry.set(finalMod.name, {
      handler: finalMod.handler,
      adminOnly: finalMod.adminOnly !== false, // par défaut réservé aux admins, plus prudent
      description: finalMod.description || '(pas de description)',
      fileName,
    });
  } else {
    registry.delete(displayName); // au cas où une version précédente avait un handler et plus celle-ci
  }

  if (finalMod.onMessage) {
    messageHooks.set(fileName, {
      name: displayName,
      onMessage: finalMod.onMessage,
      description: finalMod.description || '(pas de description)',
      fileName,
    });
  } else {
    messageHooks.delete(fileName);
  }

  logger.info({ name: displayName, replaced: !!backupPath, hasCommand: !!finalMod.handler, hasHook: !!finalMod.onMessage }, 'Commande personnalisée installée');
  return {
    ok: true,
    name: displayName,
    hash: hashContent(source),
    replaced: !!backupPath,
    riskyApis,
    hasHook: !!finalMod.onMessage,
  };
}

/** Charge toutes les commandes déjà présentes sur disque (démarrage du bot). */
function loadAllFromDisk() {
  ensureDirs();
  const files = fs.readdirSync(CUSTOM_DIR).filter((f) => f.endsWith('.js') && !f.startsWith('.tmp-'));
  let loaded = 0;
  for (const fileName of files) {
    const filePath = path.join(CUSTOM_DIR, fileName);
    try {
      delete require.cache[require.resolve(filePath)];
      const mod = require(filePath);
      const shapeError = validateShape(mod);
      if (shapeError) {
        logger.warn({ fileName, error: shapeError }, 'Commande personnalisée ignorée au démarrage (forme invalide)');
        continue;
      }
      if (mod.handler) {
        registry.set(mod.name, {
          handler: mod.handler,
          adminOnly: mod.adminOnly !== false,
          description: mod.description || '(pas de description)',
          fileName,
        });
      }
      if (mod.onMessage) {
        messageHooks.set(fileName, {
          name: mod.name,
          onMessage: mod.onMessage,
          description: mod.description || '(pas de description)',
          fileName,
        });
      }
      loaded++;
    } catch (err) {
      logger.warn({ fileName, err: err.message }, 'Échec chargement commande personnalisée au démarrage');
    }
  }
  if (loaded) logger.info({ loaded }, 'Commandes personnalisées chargées depuis le disque');
  return loaded;
}

/** Liste combinée (commandes tapées + hooks), pour /commands. */
function list() {
  const seen = new Set();
  const items = [];
  for (const [name, c] of registry.entries()) {
    seen.add(name);
    items.push({ name, adminOnly: c.adminOnly, description: c.description, type: 'commande' });
  }
  for (const h of messageHooks.values()) {
    if (seen.has(h.name)) continue; // déjà listé (même fichier avec les deux capacités)
    items.push({ name: h.name, adminOnly: null, description: h.description, type: 'hook (chaque message)' });
  }
  return items;
}

function get(name) {
  return registry.get(name) || null;
}

/** Trouve le fileName associé à un name, dans registry OU messageHooks. */
function findFileName(name) {
  const cmd = registry.get(name);
  if (cmd) return cmd.fileName;
  for (const h of messageHooks.values()) {
    if (h.name === name) return h.fileName;
  }
  return null;
}

async function remove(name) {
  const fileName = findFileName(name);
  if (!fileName) return false;
  const filePath = path.join(CUSTOM_DIR, fileName);
  await backupExisting(fileName);
  await fsp.unlink(filePath).catch(() => {});
  try {
    delete require.cache[require.resolve(filePath)];
  } catch {
    // déjà absent du cache, rien à faire
  }
  registry.delete(name);
  for (const [key, h] of messageHooks.entries()) {
    if (h.name === name) messageHooks.delete(key);
  }
  return true;
}

/** Restaure la dernière sauvegarde d'une commande (annule le dernier envoi). */
async function rollback(name) {
  const fileName = findFileName(name) || safeFileName(name);
  const backups = fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith(`__${fileName}`))
    .sort()
    .reverse();
  if (!backups.length) return { ok: false, error: 'Aucune sauvegarde disponible pour cette commande.' };

  const latestBackup = path.join(BACKUPS_DIR, backups[0]);
  const source = await fsp.readFile(latestBackup, 'utf8');
  const result = await installFromSource(source);
  if (result.ok) {
    // On consomme la sauvegarde qu'on vient de restaurer, pour ne pas boucler dessus.
    await fsp.unlink(latestBackup).catch(() => {});
  }
  return result;
}

/**
 * Exécute tous les hooks "onMessage" pour un message donné. Chaque hook est
 * isolé dans son propre try/catch : un hook qui plante ne doit jamais
 * empêcher les autres de tourner, ni interrompre le traitement du message
 * par le reste du pipeline.
 */
async function runHooks(ctx) {
  for (const hook of messageHooks.values()) {
    try {
      await hook.onMessage(ctx);
    } catch (err) {
      logger.warn({ hook: hook.name, err: err.message }, 'Erreur dans un hook de commande personnalisée');
    }
  }
}

module.exports = { installFromSource, loadAllFromDisk, list, get, remove, rollback, runHooks, RESERVED_NAMES };
