import { describe, expect, it } from "vitest";
import { PtyTicketStore } from "../src/pty/tickets.js";

/**
 * Attach tickets are the credential that reaches the browser, so their
 * single-use and expiry properties are asserted directly rather than inferred
 * from the WS handshake behaving.
 */
describe("PTY attach tickets", () => {
  it("authorises exactly one redemption", () => {
    const store = new PtyTicketStore();
    const { ticket } = store.issue("01JSESSIONAAAAAAAAAAAAAAAA");

    expect(store.consume(ticket)).toBe("01JSESSIONAAAAAAAAAAAAAAAA");
    // A captured ticket — from a log, history, or a shoulder — is already spent.
    expect(store.consume(ticket)).toBeNull();
  });

  it("expires and cannot be redeemed late", () => {
    const store = new PtyTicketStore();
    const now = 1_000_000;
    const { ticket, expiresAt } = store.issue("01JSESSIONBBBBBBBBBBBBBBBB", now);

    expect(expiresAt).toBeGreaterThan(now);
    expect(store.consume(ticket, expiresAt + 1)).toBeNull();
  });

  it("binds a ticket to the session it was minted for", () => {
    const store = new PtyTicketStore();
    const a = store.issue("01JSESSIONCCCCCCCCCCCCCCCC");
    const b = store.issue("01JSESSIONDDDDDDDDDDDDDDDD");

    expect(store.consume(a.ticket)).toBe("01JSESSIONCCCCCCCCCCCCCCCC");
    expect(store.consume(b.ticket)).toBe("01JSESSIONDDDDDDDDDDDDDDDD");
  });

  it("rejects an unknown ticket without leaking which part was wrong", () => {
    const store = new PtyTicketStore();
    store.issue("01JSESSIONEEEEEEEEEEEEEEEE");
    expect(store.consume("not-a-real-ticket")).toBeNull();
    // The real ticket is still redeemable — a failed guess must not burn it.
    expect(store.size()).toBe(1);
  });
});
