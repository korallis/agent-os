"use client";

import { useSyncExternalStore } from "react";

/**
 * Render a timestamp in the VIEWER's locale and timezone, after mount.
 *
 * Formatting during render would use the server's locale and timezone during
 * SSR and the browser's afterwards, which is a hydration mismatch. Agent OS is
 * local-first and the Captain wants their own clock, so we deliberately format
 * post-mount rather than pinning a fixed timezone that would be wrong for them.
 *
 * Before mount it renders the stable ISO time portion, so the server and the
 * first client render agree and the value is never blank.
 *
 * `useSyncExternalStore` (not an effect) is the React-recommended client-only
 * gate: getServerSnapshot is false, the client snapshot is true.
 */
function subscribeNoop(): () => void {
  return () => {};
}
function clientTrue(): boolean {
  return true;
}
function serverFalse(): boolean {
  return false;
}

export function LocalTime({ iso, mode = "time" }: { iso: string; mode?: "time" | "datetime" }) {
  const mounted = useSyncExternalStore(subscribeNoop, clientTrue, serverFalse);

  // SSR + first client paint both render the locale-independent ISO slice, so
  // they agree; the viewer's own clock takes over once mounted.
  const date = new Date(iso);
  const valid = !Number.isNaN(date.getTime());
  const text =
    mounted && valid
      ? mode === "time"
        ? date.toLocaleTimeString()
        : date.toLocaleString()
      : mode === "time"
        ? iso.slice(11, 19)
        : iso.replace("T", " ").slice(0, 19);

  return <time dateTime={iso}>{text}</time>;
}
