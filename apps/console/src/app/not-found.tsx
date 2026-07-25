import { Topbar } from "@/components/shell/Topbar";
import { EmptyState } from "@/components/shell/EmptyState";

/** Figma "Not Found" (`37:3731`). */
export default function NotFound() {
  return (
    <>
      <Topbar title="Not found" />
      <main className="flex-1 p-8">
        <EmptyState kind="not-found" action={{ href: "/fleet", label: "Back to the fleet" }} />
      </main>
    </>
  );
}
