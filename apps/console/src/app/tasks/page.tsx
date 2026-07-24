import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/console/PagePlaceholder";

export const metadata: Metadata = { title: "Tasks — Agent OS Console" };

export default function TasksPage() {
  return (
    <PagePlaceholder
      title="Tasks"
      phase="Lands in Phase 3"
      description="SHIP and SCOUT task board: dispatch, live fusion columns, phase steppers, the wake queue, and the typed task state machine recorded by the substrate."
      blocks={["Task board (SHIP / SCOUT)", "State machine timeline", "Wake queue → brain", "Dispatch with per-task overrides"]}
    />
  );
}
