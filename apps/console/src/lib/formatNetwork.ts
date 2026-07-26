/**
 * Presentation helpers for the Network I/O screens.
 *
 * Kept out of the component files so Fast Refresh can preserve component state
 * (a module that exports both components and plain functions forces a full
 * reload on edit).
 */

/** One outbound HTTP call the daemon recorded (`net.request`). */
export interface NetworkRequestRow {
  requestId: string;
  connectionId: string | null;
  provider: string;
  method: string;
  url: string;
  protocol: string;
  status: number | null;
  durationMs: number;
  requestBytes: number | null;
  responseBytes: number | null;
  error: string | null;
  ts: string;
}

export function statusTone(status: number | null, error: string | null): string {
  if (error !== null) return "text-danger";
  if (status === null) return "text-fg-2";
  if (status >= 500) return "text-danger";
  if (status >= 400) return "text-warn";
  return "text-ok";
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
