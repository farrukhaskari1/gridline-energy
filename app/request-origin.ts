/**
 * Local-development escape hatch for the API routes.
 *
 * The hostname comes from the incoming request URL, which Next.js derives from
 * the `Host` header. That header is attacker-controlled, so on a deployed site
 * a request carrying `Host: localhost` would otherwise skip authentication and
 * reach the owner's iTel account and stored history. The bypass is therefore
 * only honoured outside production builds.
 */
export function isLocalPreview(hostname: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
