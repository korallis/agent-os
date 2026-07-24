import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { eventEnvelopeSchema, type EventEnvelope } from "@agent-os/protocol";

/**
 * Append-only NDJSON event log — the source of truth (master plan §9).
 * Every append is fsync'd before the write is acknowledged, so a `kill -9`
 * can at worst leave one partial trailing line, which `readLog` detects
 * and `quarantineCorruptTail` preserves out-of-band.
 */

export interface LogReadResult {
  envelopes: EventEnvelope[];
  /** Byte offset where the first corrupt line starts, or null if clean. */
  corruptTailOffset: number | null;
  /** Raw text of the corrupt tail (for quarantine), empty when clean. */
  corruptTailText: string;
}

export function readLog(logPath: string): LogReadResult {
  if (!existsSync(logPath)) {
    return { envelopes: [], corruptTailOffset: null, corruptTailText: "" };
  }
  const raw = readFileSync(logPath, "utf8");
  const envelopes: EventEnvelope[] = [];
  let offset = 0;
  let lastSeq = 0;
  while (offset < raw.length) {
    const newline = raw.indexOf("\n", offset);
    if (newline === -1) {
      // Unterminated final line — partial write from a hard kill.
      return { envelopes, corruptTailOffset: offset, corruptTailText: raw.slice(offset) };
    }
    const line = raw.slice(offset, newline);
    if (line.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return { envelopes, corruptTailOffset: offset, corruptTailText: raw.slice(offset) };
      }
      const result = eventEnvelopeSchema.safeParse(parsed);
      if (!result.success || result.data.seq <= lastSeq) {
        return { envelopes, corruptTailOffset: offset, corruptTailText: raw.slice(offset) };
      }
      envelopes.push(result.data);
      lastSeq = result.data.seq;
    }
    offset = newline + 1;
  }
  return { envelopes, corruptTailOffset: null, corruptTailText: "" };
}

/**
 * Moves a corrupt tail into `<logDir>/quarantine-<ts>.ndjson` and truncates
 * the log back to its last clean line. Never deletes bytes.
 */
export function quarantineCorruptTail(logPath: string, read: LogReadResult): string | null {
  if (read.corruptTailOffset === null) return null;
  const quarantinePath = join(
    dirname(logPath),
    `quarantine-${Date.now()}-${process.pid}.ndjson`,
  );
  writeFileSync(quarantinePath, read.corruptTailText, { mode: 0o600 });
  const cleanText = read.envelopes.map((e) => JSON.stringify(e)).join("\n");
  const tmpPath = `${logPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, cleanText.length > 0 ? `${cleanText}\n` : "", { mode: 0o600 });
  renameSync(tmpPath, logPath);
  return quarantinePath;
}

export class NdjsonEventLog {
  private fd: number | null = null;

  constructor(private readonly logPath: string) {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  }

  get path(): string {
    return this.logPath;
  }

  private ensureFd(): number {
    if (this.fd === null) {
      this.fd = openSync(this.logPath, "a", 0o600);
    }
    return this.fd;
  }

  /** Appends one envelope as a JSON line and fsyncs before returning. */
  append(envelope: EventEnvelope): void {
    const fd = this.ensureFd();
    const line = `${JSON.stringify(envelope)}\n`;
    writeSync(fd, line, null, "utf8");
    fsyncSync(fd);
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
