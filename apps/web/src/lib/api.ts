// API client foundation. Mirrors the upstream Paperclip contract shape
// (same-origin /api, cookie credentials) while allowing a split origin via
// VITE_PUBLIC_API_URL for the Vercel -> Vultr topology.

export function resolveApiBase(envUrl: string | undefined): string {
  const trimmed = envUrl?.trim().replace(/\/+$/, "");
  // Empty/undefined keeps same-origin /api (Vultr-bundled fallback, dev proxy).
  if (!trimmed) return "/api";
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error(
      `VITE_PUBLIC_API_URL must be an absolute http(s) URL, got: ${envUrl}`,
    );
  }
  if (/localhost|127\.0\.0\.1|\.local\b|\.ts\.net/i.test(trimmed)) {
    // A Vercel-hosted browser cannot reach loopback/tailnet hosts.
    throw new Error(
      `VITE_PUBLIC_API_URL must be a public HTTPS origin, got: ${envUrl}`,
    );
  }
  return `${trimmed}/api`;
}

export function apiUrl(path: string, envUrl: string | undefined): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${resolveApiBase(envUrl)}${normalized}`;
}

export interface ApiRequestOptions extends RequestInit {
  /** Per-caller GET deadline in ms; 0 disables. */
  timeoutMs?: number;
}

export async function apiFetch(
  path: string,
  envUrl: string | undefined,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const { timeoutMs = 15000, ...init } = options;
  const controller = new AbortController();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  try {
    return await fetch(apiUrl(path, envUrl), {
      // Session cookie (Better Auth) must travel cross-origin.
      credentials: "include",
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthStatus {
  status: "ok" | "starting";
  version?: string;
  commit?: string | null;
  deploymentMode?: "local_trusted" | "authenticated";
}

export async function fetchHealth(
  envUrl: string | undefined,
): Promise<HealthStatus> {
  const res = await apiFetch("/health", envUrl, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`health check failed: HTTP ${res.status}`);
  return (await res.json()) as HealthStatus;
}
