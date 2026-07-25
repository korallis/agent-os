import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Single-use, short-lived tickets for terminal attach (master plan §8, §10.2).
 *
 * The PTY channel is the only WebSocket in the product, and it streams a live
 * pane, so it is the most sensitive surface after the auth store. A ticket is
 * therefore:
 *   - minted only by an authenticated REST call that names the session,
 *   - bound to that one session id,
 *   - valid once, and
 *   - valid briefly.
 *
 * Query strings leak into logs and browser history far more readily than
 * headers, which is exactly why the credential in the URL must be a one-shot
 * ticket rather than the daemon token.
 */

const TICKET_TTL_MS = 30_000;

interface Ticket {
  sessionId: string;
  expiresAt: number;
}

export class PtyTicketStore {
  private readonly tickets = new Map<string, Ticket>();

  /** Mint a single-use ticket for one session. */
  issue(sessionId: string, now = Date.now()): { ticket: string; expiresAt: number } {
    this.prune(now);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + TICKET_TTL_MS;
    this.tickets.set(ticket, { sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * Consume a ticket, returning the session it authorises. Returns null when
   * the ticket is unknown, already used, or expired — the three cases are
   * deliberately indistinguishable to the caller.
   */
  consume(candidate: string, now = Date.now()): string | null {
    this.prune(now);
    // Constant-time compare against each live ticket so a timing signal cannot
    // be used to discover a valid prefix.
    let matchedKey: string | null = null;
    const candidateBuf = Buffer.from(candidate);
    for (const key of this.tickets.keys()) {
      const keyBuf = Buffer.from(key);
      if (keyBuf.length !== candidateBuf.length) continue;
      if (timingSafeEqual(keyBuf, candidateBuf)) {
        matchedKey = key;
        break;
      }
    }
    if (matchedKey === null) return null;
    const ticket = this.tickets.get(matchedKey);
    this.tickets.delete(matchedKey);
    if (ticket === undefined || ticket.expiresAt <= now) return null;
    return ticket.sessionId;
  }

  private prune(now: number): void {
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(key);
    }
  }

  size(): number {
    return this.tickets.size;
  }
}
