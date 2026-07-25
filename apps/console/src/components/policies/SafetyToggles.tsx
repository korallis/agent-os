"use client";

import { useEffect, useState } from "react";
import { cn } from "@agent-os/ui";

/**
 * Safety policy toggles (master plan §2.6 #12, §11 Phase 6 [R3]).
 *
 * These are the invariants that keep the fleet honest — cross-family
 * validation, RED-before-builder, SCOUT read-only, verbatim FAIL delivery. They
 * can be turned off, because the Captain owns the machine, but never by
 * accident:
 *
 *  - turning one OFF requires an explicit typed confirmation, and the daemon
 *    independently refuses the write without the confirmation header, so the
 *    dialog is a courtesy rather than the enforcement;
 *  - any policy left off raises a PERSISTENT badge, not a toast. A weakened
 *    safety posture must stay visible for as long as it is weakened.
 */

const POLICY_COPY: Record<string, { label: string; risk: string }> = {
  crossFamilyBuilderValidator: {
    label: "Cross-family builder / validator",
    risk: "A model would be allowed to validate its own family's work.",
  },
  distinctPlannerFamilies: {
    label: "Distinct planner families",
    risk: "Fusion sides could come from one family, losing the independent read.",
  },
  redBaselineGateRequired: {
    label: "RED baseline before builder",
    risk: "A gate could pass without ever proving it can detect the absence.",
  },
  scoutReadOnly: {
    label: "SCOUT read-only",
    risk: "A scouting run could write to your working tree.",
  },
  verbatimFailDelivery: {
    label: "Verbatim FAIL delivery",
    risk: "Failure text could be paraphrased before the builder sees it.",
  },
  haltCapNotYoloOverridable: {
    label: "Halt cap not YOLO-overridable",
    risk: "The validation attempt cap could be bypassed by a YOLO task.",
  },
  destructiveGitDenial: {
    label: "Destructive git denial",
    risk: "Crewmates could run history-rewriting or force-push commands.",
  },
};

type Policies = Record<string, boolean>;

export function SafetyToggles() {
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [pending, setPending] = useState<{ key: string; next: boolean } | null>(null);
  const [confirmTyped, setConfirmTyped] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/agentos/config/effective", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { config?: { policies?: Policies } };
      setPolicies(body.config?.policies ?? null);
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/agentos/config/effective", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { config?: { policies?: Policies } };
        if (!cancelled) setPolicies(body.config?.policies ?? null);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openDisable = (key: string) => {
    setConfirmTyped("");
    setPending({ key, next: false });
  };

  const cancelPending = () => {
    setConfirmTyped("");
    setPending(null);
  };

  const apply = async (key: string, next: boolean) => {
    if (policies === null) return;
    if (!next && confirmTyped !== key) return;
    setMessage(null);
    try {
      const res = await fetch("/api/agentos/config/global/policies", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          // The daemon rejects a safety write without this; the dialog above is
          // the Captain's intent, this header is what carries it.
          "x-agentos-confirm-safety": "true",
        },
        body: JSON.stringify({ ...policies, [key]: next }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        setMessage(body.error?.message ?? `Write refused (HTTP ${res.status}).`);
        return;
      }
      setMessage(
        next
          ? `${POLICY_COPY[key]?.label ?? key} re-enabled.`
          : `${POLICY_COPY[key]?.label ?? key} disabled — override stamped.`,
      );
      await load();
    } catch {
      setMessage("Could not reach the daemon to write the policy.");
    } finally {
      setConfirmTyped("");
      setPending(null);
    }
  };

  if (failed) {
    return <p className="text-[13px] text-danger">Safety policies unavailable from the daemon.</p>;
  }
  if (policies === null) {
    return <p className="text-[13px] text-fg-3">Loading safety policies…</p>;
  }

  const disabled = Object.entries(policies).filter(([, on]) => !on);
  const typedMatches = pending !== null && confirmTyped === pending.key;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-[14px] font-semibold text-fg-1">Safety policies</h3>
          <p className="text-[12px] text-fg-3">
            Turning one off requires confirmation and stamps an override on every affected run.
          </p>
        </div>
        {disabled.length > 0 && (
          // Persistent, not a toast: a weakened posture stays visible while weak.
          <span
            role="status"
            className="shrink-0 rounded-[20px] bg-warn/10 px-3 py-1 text-[11px] font-semibold text-warn"
          >
            {disabled.length} SAFETY OVERRIDE{disabled.length === 1 ? "" : "S"} ACTIVE
          </span>
        )}
      </div>

      {message !== null && <p className="text-[12px] text-fg-2">{message}</p>}

      <div className="flex flex-col gap-2">
        {Object.entries(policies).map(([key, on]) => (
          <div
            key={key}
            className="flex items-center justify-between gap-4 rounded-[10px] border border-line-1 bg-shell px-4 py-3"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[13px] text-fg-1">{POLICY_COPY[key]?.label ?? key}</span>
              {!on && (
                <span className="text-[11px] text-warn">
                  OFF — {POLICY_COPY[key]?.risk ?? "This safety check is not enforced."}
                </span>
              )}
            </div>
            <button
              type="button"
              aria-pressed={on}
              aria-label={`${POLICY_COPY[key]?.label ?? key}: ${on ? "on" : "off"}`}
              onClick={() => (on ? openDisable(key) : void apply(key, true))}
              className={cn(
                "shrink-0 rounded-[20px] px-3 py-1 text-[11px] font-semibold",
                on ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn",
              )}
            >
              {on ? "ON" : "OFF"}
            </button>
          </div>
        ))}
      </div>

      {pending !== null && (
        <div
          role="alertdialog"
          aria-label="Confirm safety policy change"
          className="flex flex-col gap-3 rounded-[10px] border border-warn/40 bg-warn/[0.06] p-4"
        >
          <span className="text-[13px] font-semibold text-warn">
            Disable {POLICY_COPY[pending.key]?.label ?? pending.key}?
          </span>
          <span className="text-[12px] text-fg-2">
            {POLICY_COPY[pending.key]?.risk ?? "This safety check will no longer be enforced."} The
            override is stamped on every run it affects, and a persistent badge stays on this page
            until it is turned back on.
          </span>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-fg-2">
              Type <span className="font-mono text-fg-1">{pending.key}</span> to confirm
            </span>
            <input
              type="text"
              value={confirmTyped}
              onChange={(e) => setConfirmTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label={`Type ${pending.key} to confirm disable`}
              className="rounded-lg border border-line-2 bg-shell px-3 py-1.5 font-mono text-[12px] text-fg-1 outline-none focus:border-warn"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!typedMatches}
              onClick={() => void apply(pending.key, false)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-[12px] font-medium",
                typedMatches
                  ? "bg-warn/15 text-warn"
                  : "cursor-not-allowed bg-panel-2 text-fg-3 opacity-60",
              )}
            >
              Yes, disable it
            </button>
            <button
              type="button"
              onClick={cancelPending}
              className="rounded-lg border border-line-2 px-3 py-1.5 text-[12px] font-medium text-fg-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
