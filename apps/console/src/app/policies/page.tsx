import type { Metadata } from "next";
import { MicroLabel } from "@agent-os/ui";
import { EffectiveConfig } from "@/components/console/EffectiveConfig";

export const metadata: Metadata = { title: "Policies — Agent OS Console" };

/**
 * Policies (§7.5) — Phase 1 scope: the read-only effective-config chain view
 * with per-key source layers, straight from `/v1/config/effective`. The
 * layered editor, safety-policy toggles, and prompt three-way diffs land in
 * Phase 6.
 */
export default function PoliciesPage() {
  return (
    <div>
      <div className="border-b border-rule px-6 py-4 flex items-center justify-between">
        <MicroLabel className="text-black/60">Policies</MicroLabel>
        <MicroLabel className="text-black/40">
          Layered editor lands in Phase 6 — files are the truth
        </MicroLabel>
      </div>
      <div className="p-6 max-w-4xl">
        <p className="text-sm text-black/60 leading-relaxed mb-8">
          Effective configuration across the Policy Pack layers (shipped → global → project →
          task). Every key shows the layer that supplied its value. Edit{" "}
          <span className="font-mono text-xs">~/.agentos/config/*.json5</span> — valid changes
          hot-reload; invalid changes are rejected wholesale with path-precise errors.
        </p>
        <EffectiveConfig />
      </div>
    </div>
  );
}
