import LoadEvents from "../components/LoadEvents";
import { PortalShell } from "../components/PortalShell";

export default function ActivityPage() {
  return <PortalShell active="Activity" eyebrow="Demand intelligence" title="Load events"><LoadEvents /></PortalShell>;
}
