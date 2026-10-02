/**
 * Paths allowed while the deployment is locked.
 * Security is enforced by secrets on owner/internal routes — not by obscurity.
 */
export function isPlatformLockAllowlistedPath(pathname: string): boolean {
  const path = pathname.split("?")[0] || "/";

  if (
    path === "/health" ||
    path === "/health/live" ||
    path === "/health/ready" ||
    path === "/api/health"
  ) {
    return true;
  }

  if (path === "/maintenance" || path === "/maintenance.html") {
    return true;
  }

  if (path === "/api/platform-lock" || path.startsWith("/api/platform-lock/")) {
    return true;
  }

  // Internal monitoring / backup tooling (still require their own auth).
  if (path.startsWith("/api/observability/")) {
    return true;
  }

  return false;
}
