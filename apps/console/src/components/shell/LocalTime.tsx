"use client";

import { useEffect, useState } from "react";

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
 */
export function LocalTime({ iso, mode = "time" }: { iso: string; mode?: "time" | "datetime" }) {
  const [formatted, setFormatted] = useState<string | null>(null);

  useEffect(() => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      setFormatted(iso);
      return;
    }
    setFormatted(mode === "time" ? date.toLocaleTimeString() : date.toLocaleString());
  }, [iso, mode]);

  // SSR + first paint: the ISO slice is locale-independent, so both agree.
  const fallback = mode === "time" ? iso.slice(11, 19) : iso.replace("T", " ").slice(0, 19);
  return <time dateTime={iso}>{formatted ?? fallback}</time>;
}
