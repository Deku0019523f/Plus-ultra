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
  if (typeof mod.name !== 'string' || !mod.name.startsWith(config.commandPrefix)) {
    return `"name" doit être une chaîne commençant par "${config.commandPrefix}".`;
  }
  if (expectedName && mod.name !== expectedName) {
    return `"name" ("${mod.name}") ne correspond pas au nom annoncé ("${expectedName}").`;
  }
  if (RESERVED_NAMES.has(mod.name)) return `"${mod.name}" est une commande native — ne peut pas être remplacée.`;
  if (typeof mod.handler !== 'function') return '"handler" doit être une fonction async (ctx) => {...}.';
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

  registry.set(finalMod.name, {
    handler: finalMod.handler,
    adminOnly: finalMod.adminOnly !== false, // par défaut réservé aux admins, plus prudent
    description: finalMod.description || '(pas de description)',
    fileName,
  });

  logger.info({ name: finalMod.name, replaced: !!backupPath }, 'Commande personnalisée installée');
  return {
    ok: true,
    name: finalMod.name,
    hash: hashContent(source),
    replaced: !!backupPath,
    riskyApis,
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
      registry.set(mod.name, {
        handler: mod.handler,
        adminOnly: mod.adminOnly !== false,
        description: mod.description || '(pas de description)',
        fileName,
      });
      loaded++;
    } catch (err) {
      logger.warn({ fileName, err: err.message }, 'Échec chargement commande personnalisée au démarrage');
    }
  }
  if (loaded) logger.info({ loaded }, 'Commandes personnalisées chargées depuis le disque');
  return loaded;
}

function list() {
  return [...registry.entries()].map(([name, c]) => ({ name, adminOnly: c.adminOnly, description: c.description }));
}

function get(name) {
  return registry.get(name) || null;
}

async function remove(name) {
  const entry = registry.get(name);
  if (!entry) return false;
  const filePath = path.join(CUSTOM_DIR, entry.fileName);
  await backupExisting(entry.fileName);
  await fsp.unlink(filePath).catch(() => {});
  delete require.cache[require.resolve(filePath)] && require.resolve(filePath); // no-op safe
  registry.delete(name);
  return true;
}

/** Restaure la dernière sauvegarde d'une commande (annule le dernier envoi). */
async function rollback(name) {
  const entry = registry.get(name);
  const fileName = entry ? entry.fileName : safeFileName(name);
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

module.exports = { installFromSource, loadAllFromDisk, list, get, remove, rollback, RESERVED_NAMES };
