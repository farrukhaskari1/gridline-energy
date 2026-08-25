import EnergySavings from "../components/EnergySavings";
import WeatherPanel from "../components/WeatherPanel";
import { PortalShell } from "../components/PortalShell";

export const dynamic = "force-dynamic";

export default function SavingsPage() {
  return (
    <PortalShell active="Savings" eyebrow="Money kept" title="Savings">
      <WeatherPanel />
      <div style={{ height: 16 }} />
      <EnergySavings />
    </PortalShell>
  );
}
