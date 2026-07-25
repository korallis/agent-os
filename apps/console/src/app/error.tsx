"use client";

import { EmptyState } from "@/components/shell/EmptyState";

/**
 * Figma "Server Error" (`37:3760`).
 *
 * The most common cause in a local-first product is simply that agentosd is not
 * running, so the copy names that rather than showing a generic failure. The
 * underlying message is shown too — hiding it would make the daemon harder to
 * debug, which is the opposite of what this screen is for.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex-1 p-8 flex flex-col gap-4">
      <EmptyState kind="server-error" body={error.message} />
      <button
        type="button"
        onClick={reset}
        className="self-center rounded-lg bg-panel-2 border border-line-1 px-4 py-2 text-[13px] font-medium text-fg-1 hover:border-line-2 transition-colors"
      >
        Retry
      </button>
    </main>
  );
}
