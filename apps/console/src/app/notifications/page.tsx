import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { NotificationsView } from "@/components/notifications/NotificationsView";

export const metadata: Metadata = { title: "Notifications — AgentOS" };

/** Notifications — Figma frame `17:940`, backed by the real wake queue. */
export default function NotificationsPage() {
  return (
    <>
      <Topbar title="Notifications" />
      <NotificationsView />
    </>
  );
}
