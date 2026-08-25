import { PortalShell } from "../components/PortalShell";
import DeviceDetails from "../components/DeviceDetails";

export default function DevicesPage() {
  return <PortalShell active="Devices" eyebrow="System" title="Devices and health"><DeviceDetails /></PortalShell>;
}
