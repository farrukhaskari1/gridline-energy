"use client";

import type { ReactNode } from "react";
import { SiteSelector } from "./SiteSelector";
import { WeatherChip } from "./WeatherTheme";
import { useSiteSelection, withSite } from "./site-selection";

const items = [
  { label: "Overview", href: "/" }, { label: "Energy", href: "/energy" }, { label: "Savings", href: "/savings" },
  { label: "Devices", href: "/devices" }, { label: "Alerts", href: "/alerts" },
  { label: "Automations", href: "/automations" }, { label: "Activity", href: "/activity" }, { label: "Compare", href: "/compare" },
];

export function PortalShell({ active, eyebrow, title, children }: { active: string; eyebrow: string; title: string; children: ReactNode }) {
  const { siteId } = useSiteSelection();
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">G</span><span>Gridline</span></div>
        <nav aria-label="Main navigation">{items.map((item) => <a className={item.label === active ? "nav-item active" : "nav-item"} href={withSite(item.href, siteId)} key={item.label}><span className="nav-dot" />{item.label}</a>)}</nav>
        <div className="sidebar-foot"><div className="signal"><span /> Collector online</div><p>Last sync 8 sec ago</p></div>
      </aside>
      <section className="workspace">
        <header className="topbar"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div><div className="top-actions"><WeatherChip /><SiteSelector /><button className="avatar" aria-label="Open account menu">JK</button></div></header>
        {children}
      </section>
    </main>
  );
}
