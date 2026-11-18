import { io, type Socket } from 'socket.io-client';
import { cookieHeader, type AuthSource, type Settings } from '../config.js';
import { MilanoteError } from './errors.js';

const CONNECT_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 10_000;

export type Emit = (action: object) => Promise<void>;

/** Ce dont la façade a besoin côté socket (remplaçable par un faux dans les tests). */
export interface SocketLike {
  withConnection<T>(userId: string, fn: (emit: Emit) => Promise<T>): Promise<T>;
}

/**
 * Canal d'écriture socket.io (événement `action`). Une connexion par opération d'écriture,
 * fermée ensuite : les écritures sont rares, et cela évite de gérer une session longue.
 * L'acquittement `{status:200}` ne prouve pas l'écriture : l'appelant doit relire en REST.
 */
export class ActionSocket implements SocketLike {
  constructor(
    private readonly settings: Settings,
    private readonly auth: AuthSource,
  ) {}

  async withConnection<T>(userId: string, fn: (emit: Emit) => Promise<T>): Promise<T> {
    const socket: Socket = io(this.settings.baseUrl, {
      path: '/socket.io',
      query: { userId },
      transports: ['websocket'],
      extraHeaders: { cookie: cookieHeader(this.auth.current().auth) },
      reconnection: false,
      timeout: CONNECT_TIMEOUT_MS,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', (err: Error) =>
          reject(new MilanoteError(`Connexion socket Milanote impossible : ${err.message}`)),
        );
      });
      const emit: Emit = async (action) => {
        const ack = (await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('action', action)) as { status?: number } | undefined;
        if (!ack || ack.status !== 200) {
          throw new MilanoteError(`Action refusée par Milanote (ack ${JSON.stringify(ack)})`, ack?.status);
        }
      };
      return await fn(emit);
    } finally {
      socket.disconnect();
    }
  }
}
