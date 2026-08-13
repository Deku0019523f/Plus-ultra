'use strict';

/**
 * Messages personnalisés façon "modération humaine" — inspirés du style
 * demandé : salutation avec mention, explication de la règle enfreinte,
 * décompte des chances restantes, ton amical mais ferme.
 */

function chancesLeft(current, max) {
  const left = Math.max(0, max - current);
  return left === 1 ? '1 chance' : `${left} chances`;
}

function warnMessage({ mentionText, reason, current, max }) {
  const left = chancesLeft(current, max);
  return (
    `${mentionText} 👋\n\n` +
    `⚠️ Petit rappel : ${reason || "cette action n'est pas autorisée ici"}.\n\n` +
    `C'est ton avertissement ${current}/${max}. Il te reste ${left} — au bout, c'est le retrait du groupe. ` +
    `On compte sur toi pour garder ça agréable pour tout le monde 🙏`
  );
}

function sanctionMessage({ mentionText, current, max }) {
  return (
    `🚫 SANCTION\n\n` +
    `${mentionText} a atteint ${current}/${max} avertissements.\n\n` +
    `Le membre va être retiré du groupe — et là, c'est terminé pour cette fois 😅`
  );
}

function linkDeniedMessage({ mentionText }) {
  return (
    `${mentionText} 👋\n\n` +
    `🔗 Ici, on évite de poster des liens sans l'accord d'un admin — ton message vient d'être supprimé.\n\n` +
    `Demande la permission à un admin si tu as un lien à partager, ça se passera très bien ✅`
  );
}

function antibotDeletedMessage({ mentionText }) {
  return `${mentionText} 👋\n\n🤖 Les commandes destinées à d'autres bots ne sont pas autorisées ici — message supprimé.`;
}

function welcomeMessage({ mentionText, groupName, customMessage }) {
  if (customMessage?.trim()) {
    return customMessage.replace(/\{membre\}/gi, mentionText).replace(/\{groupe\}/gi, groupName || '');
  }
  return `${mentionText} 👋\n\nBienvenue dans *${groupName || 'le groupe'}* ! Ravi de t'avoir parmi nous 🎉`;
}

module.exports = { warnMessage, sanctionMessage, linkDeniedMessage, antibotDeletedMessage, welcomeMessage };
