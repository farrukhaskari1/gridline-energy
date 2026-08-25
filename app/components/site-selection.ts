"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Which inverter the portal is looking at.
 *
 * The selection lives in the URL (`?site=`) rather than in component state, so
 * it survives a reload, can be linked to, and every island on the page agrees
 * without a provider wrapping the whole tree — these pages are server
 * components with client islands, and threading context through them would
 * mean making the pages client components purely to pass a string down.
 *
 * Changing it rewrites the query with `replaceState` and announces it on a
 * custom event, the same channel `EnergyAtmosphere` already uses for readings.
 * No navigation, so nothing remounts and no poll is interrupted.
 */

export const ALL_SITES = "all";
const SITE_EVENT = "gridline:site";
const PARAM = "site";

export function readSiteSelection(): string {
  if (typeof window === "undefined") return ALL_SITES;
  const value = new URLSearchParams(window.location.search).get(PARAM);
  return value && value.trim().length > 0 ? value : ALL_SITES;
}

export function setSiteSelection(siteId: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (siteId === ALL_SITES) url.searchParams.delete(PARAM); else url.searchParams.set(PARAM, siteId);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new CustomEvent<string>(SITE_EVENT, { detail: siteId }));
}

function subscribe(onChange: () => void) {
  window.addEventListener(SITE_EVENT, onChange);
  // Back/forward still moves through history entries this component did not
  // create, and the query it lands on is the source of truth.
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(SITE_EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
}

export function useSiteSelection() {
  // `useSyncExternalStore` rather than state-plus-effect: the URL *is* the
  // store, and this is exactly the case it exists for — it also gives the
  // server render a defined answer instead of a hydration mismatch.
  const siteId = useSyncExternalStore(subscribe, readSiteSelection, () => ALL_SITES);
  const select = useCallback((next: string) => setSiteSelection(next), []);
  return { siteId, isCombined: siteId === ALL_SITES, select };
}

/**
 * Appends the current scope using the name each boundary expects: pages read
 * `?site=` as their URL-backed client store, while API routes accept
 * `?siteId=`. Keeping that distinction here prevents navigation from silently
 * resetting the selector to the combined view.
 */
export function withSite(path: string, siteId: string) {
  const separator = path.includes("?") ? "&" : "?";
  const parameter = path.startsWith("/api/") ? "siteId" : PARAM;
  return `${path}${separator}${parameter}=${encodeURIComponent(siteId)}`;
}
