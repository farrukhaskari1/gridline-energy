import { AutomationList } from "../components/AutomationList";
import { PortalShell } from "../components/PortalShell";

export default function AutomationsPage() {
  return <PortalShell active="Automations" eyebrow="Control" title="Home automations"><div className="automation-intro"><div><span>Read-only preview</span><p>Rules are simulated until safe inverter command endpoints are verified and explicitly enabled.</p></div><button>Create automation</button></div><AutomationList/><article className="card ha-card"><div className="ha-mark">HA</div><div><p className="eyebrow">Home Assistant</p><h2>Ready for MQTT discovery</h2><p>Gridline can publish solar, load, grid, battery and availability sensors to your private broker.</p></div><button>Configure bridge</button></article></PortalShell>;
}
