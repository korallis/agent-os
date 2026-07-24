import { MicroLabel } from "@agent-os/ui";

interface PagePlaceholderProps {
  title: string;
  phase: string;
  description: string;
  blocks: readonly string[];
}

/**
 * Styled placeholder for console surfaces whose functionality lands in a
 * later phase (§11). Real routes, real shell, mandated design language —
 * content arrives with its phase.
 */
export function PagePlaceholder({ title, phase, description, blocks }: PagePlaceholderProps) {
  return (
    <div>
      <div className="border-b border-rule px-6 py-4 flex items-center justify-between">
        <MicroLabel className="text-black/60">{title}</MicroLabel>
        <MicroLabel className="text-black/40">{phase}</MicroLabel>
      </div>
      <div className="p-6 max-w-3xl">
        <p className="text-sm text-black/60 leading-relaxed">{description}</p>
        <div className="mt-6 border border-rule divide-y divide-[#e5e5e0]">
          {blocks.map((block) => (
            <div key={block} className="px-5 py-4 flex items-center justify-between">
              <MicroLabel className="text-black/50">{block}</MicroLabel>
              <span className="h-1.5 w-24 bg-black/[0.06]" aria-hidden />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
