import { combineReadings, gridAvailability, type SiteReading, type SiteTelemetry } from "../../lib/combine";

/**
 * Two or more inverters next to each other, with the combined total above them.
 *
 * The total comes first deliberately: "what is the house doing" is the question
 * being asked, and "which inverter is doing it" is the follow-up.
 */

function numeric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function power(value: number | null | undefined) {
  const watts = numeric(value);
  if (watts === null) return "—";
  return Math.abs(watts) >= 1000 ? `${watts / 1000} kW` : `${watts} W`;
}

function percent(value: number | null | undefined) {
  const reading = numeric(value);
  return reading === null ? "—" : `${reading}%`;
}

/**
 * A capacity-weighted state of charge is *calculated*, not measured, so it is
 * rounded — unlike provider readings, which are shown at full precision.
 */
function derivedPercent(value: number | null | undefined) {
  const reading = numeric(value);
  return reading === null ? "—" : `${Math.round(reading * 10) / 10}%`;
}

function riskClass(loadPercent: number | null | undefined) {
  const load = numeric(loadPercent);
  if (load === null) return "";
  if (load >= 90) return " is-critical";
  if (load >= 70) return " is-watch";
  return "";
}

function gridLabel(telemetry: SiteTelemetry) {
  const availability = gridAvailability(telemetry);
  if (availability === "outage") return "Off";
  const grid = numeric(telemetry.gridPowerW) ?? 0;
  if (grid > 30) return `Import ${power(grid)}`;
  if (grid < -30) return `Export ${power(Math.abs(grid))}`;
  return "Idle";
}

export default function CompareOverview({ readings }: { readings: SiteReading[] }) {
  const combined = combineReadings(readings);

  return (
    <section className="compare">
      {combined ? (
        <article className={`card compare-total${riskClass(combined.telemetry.loadPercent)}`}>
          <header>
            <span>Whole home</span>
            <small>{combined.siteCount} inverters</small>
            {combined.incomplete ? (
              <em title="At least one inverter's reading is out of date, so this total is incomplete.">
                Partial
              </em>
            ) : null}
          </header>
          <div className="compare-figures">
            <div><span>Home</span><strong>{power(combined.telemetry.loadPowerW)}</strong></div>
            <div><span>Solar</span><strong>{power(combined.telemetry.pvPowerW)}</strong></div>
            <div><span>Grid</span><strong>{gridLabel(combined.telemetry)}</strong></div>
            <div><span>Worst load</span><strong>{percent(combined.telemetry.loadPercent)}</strong></div>
            <div><span>Battery</span><strong>{derivedPercent(combined.telemetry.batterySocPercent)}</strong></div>
          </div>
        </article>
      ) : null}

      <div className="compare-columns">
        {readings.map((reading) => (
          <article key={reading.siteId} className={`card compare-column${riskClass(reading.telemetry.loadPercent)}`}>
            <header>
              <span>{reading.label}</span>
            </header>
            <dl>
              <div><dt>Load</dt><dd>{percent(reading.telemetry.loadPercent)}</dd></div>
              <div><dt>Home</dt><dd>{power(reading.telemetry.loadPowerW)}</dd></div>
              <div><dt>Solar</dt><dd>{power(reading.telemetry.pvPowerW)}</dd></div>
              <div><dt>Grid</dt><dd>{gridLabel(reading.telemetry)}</dd></div>
              <div><dt>Battery</dt><dd>{percent(reading.telemetry.batterySocPercent)}</dd></div>
              <div><dt>Generated</dt><dd>{reading.telemetry.generatedTodayKWh ?? "—"}</dd></div>
              <div><dt>Consumed</dt><dd>{reading.telemetry.consumedTodayKWh ?? "—"}</dd></div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
