export class MilanoteError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MilanoteError';
  }
}

/** Session expirée ou cookie invalide : l'utilisateur doit renouveler la session. */
export class MilanoteAuthError extends MilanoteError {
  constructor(status: number) {
    super(
      `Session Milanote refusée (HTTP ${status}). Renouveler la session : « npm run session » dans le dossier du serveur ` +
        '(inutile de redémarrer Claude), ou recopier le cookie « __Secure-milanote.session_token » dans MILANOTE_SESSION_TOKEN (voir README).',
      status,
    );
    this.name = 'MilanoteAuthError';
  }
}

export class MilanoteConfigError extends MilanoteError {
  constructor(message: string) {
    super(message);
    this.name = 'MilanoteConfigError';
  }
}

/**
 * Écriture envoyée mais non confirmée à la relecture : l'acquittement socket ne prouve rien.
 * `subject` = élément ou groupe concerné ; `detail` = ce qui manque (absent, contenu différent…).
 */
export class MilanoteUnconfirmedWriteError extends MilanoteError {
  constructor(
    readonly subject: string,
    detail = 'introuvable à la relecture',
  ) {
    super(
      `Écriture non confirmée : ${subject} ${detail}. ` +
        'Aucune nouvelle tentative automatique : vérifier dans Milanote (get_board) avant de relancer, pour ne pas créer de doublon.',
    );
    this.name = 'MilanoteUnconfirmedWriteError';
  }
}

export class MilanoteWriteDisabledError extends MilanoteError {
  constructor() {
    super('Écritures désactivées. Définir MILANOTE_ENABLE_WRITE=1 pour les autoriser, ou utiliser dry_run.');
    this.name = 'MilanoteWriteDisabledError';
  }
}
