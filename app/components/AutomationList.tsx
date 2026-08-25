"use client";

import { useState } from "react";

const initialRules = [
  { id: "reserve", name: "Protect evening reserve", detail: "Keep battery above 35% after 6:00 PM", enabled: true, accent: "Battery" },
  { id: "solar", name: "Solar surplus alert", detail: "Notify when export stays above 1 kW for 10 minutes", enabled: true, accent: "Solar" },
  { id: "outage", name: "Grid outage response", detail: "Switch to backup profile when grid becomes unavailable", enabled: false, accent: "Safety" },
];

export function AutomationList() {
  const [rules, setRules] = useState(initialRules);
  return <div className="automation-list">{rules.map((rule) => <article className="automation-row" key={rule.id}>
    <div className="automation-icon">{rule.accent.slice(0, 1)}</div><div className="automation-copy"><span>{rule.accent}</span><h3>{rule.name}</h3><p>{rule.detail}</p></div>
    <button className={rule.enabled ? "toggle on" : "toggle"} aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`} aria-pressed={rule.enabled} onClick={() => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled } : item))}><i /></button>
  </article>)}</div>;
}
