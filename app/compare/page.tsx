import CompareOverview from "../components/CompareOverview";
import { PortalShell } from "../components/PortalShell";
import type { SiteReading } from "../../lib/combine";

export const dynamic = "force-dynamic";

/**
 * Slice 1 of multi-account: the compare layout, rendered from fixed readings so
 * the shape can be judged before any of the account plumbing exists.
 *
 * Slice 3 replaces `fixtures` with the live per-site readings and moves the
 * selector into the shell; this page is scaffolding, not the destination.
 */
const fixtures: SiteReading[] = [
  {
    siteId: "fixture-a",
    label: "Gorsi Rd",
    batteryCapacityKWh: 2,
    recordedAt: Date.now(),
    telemetry: {
      pvPowerW: 1240, loadPowerW: 1900, gridPowerW: 660, batteryPowerW: 0,
      batterySocPercent: 96, generatorPowerW: 0, loadPercent: 47,
      inputVoltage: 223, temperatureC: 46.6, generatedTodayKWh: 11.6,
      consumedTodayKWh: 33.5, online: true,
    },
  },
  {
    siteId: "fixture-b",
    label: "Shed",
    batteryCapacityKWh: 6,
    recordedAt: Date.now(),
    telemetry: {
      pvPowerW: 3100, loadPowerW: 2400, gridPowerW: -700, batteryPowerW: -820,
      batterySocPercent: 61, generatorPowerW: 0, loadPercent: 30,
      inputVoltage: 219, temperatureC: 51.2, generatedTodayKWh: 24.9,
      consumedTodayKWh: 18.2, online: true,
    },
  },
];

export default function ComparePage() {
  return (
    <PortalShell active="Compare" eyebrow="Multi-account" title="Compare inverters">
      <p className="data-notice">
        Layout preview for multi-account support. These two inverters are fixed
        sample readings — live data arrives in slice 3.
      </p>
      <CompareOverview readings={fixtures} />
    </PortalShell>
  );
}
