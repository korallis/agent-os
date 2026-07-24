import localFont from "next/font/local";

/**
 * Geist Sans / Geist Mono — the Agent OS type system.
 * Exposed as CSS variables (`--font-geist-sans`, `--font-geist-mono`)
 * consumed by the `--font-sans` / `--font-mono` theme tokens.
 */
export const geistSans = localFont({
  src: "./GeistVF.woff2",
  variable: "--font-geist-sans",
  display: "swap",
});

export const geistMono = localFont({
  src: "./GeistMonoVF.woff2",
  variable: "--font-geist-mono",
  display: "swap",
});
