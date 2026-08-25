import EnergyAnalytics from "../components/EnergyAnalytics";
import { PortalShell } from "../components/PortalShell";

export default function EnergyPage() {
  return <PortalShell active="Energy" eyebrow="Measured performance" title="Energy intelligence"><EnergyAnalytics /></PortalShell>;
}
