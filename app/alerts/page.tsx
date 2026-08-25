import AlertsPanel from "../components/AlertsPanel";
import { PortalShell } from "../components/PortalShell";

export const dynamic = "force-dynamic";

export default function AlertsPage() {
  return (
    <PortalShell active="Alerts" eyebrow="System health" title="Alerts">
      <AlertsPanel />
    </PortalShell>
  );
}
