// API client foundation. Mirrors the upstream Paperclip contract shape
// (same-origin /api, cookie credentials) while allowing a split origin via
// VITE_PUBLIC_API_URL for the Vercel -> Vultr topology.
//
// Security rule: session cookies travel with `credentials: "include"`, so a
// deployed/cross-origin base must be a public HTTPS origin. Plain HTTP,
// IP literals, userinfo and non-routable placeholder domains are rejected.
// Plain-HTTP localhost is allowed ONLY for local development behind the
// explicit `allowInsecureLocalhost` flag — never in a deployed bundle.

export interface ApiBaseOptions {
  /** Permit `http://localhost|127.0.0.1|::1` for local dev only. */
  allowInsecureLocalhost?: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function resolveApiBase(
  envUrl: string | undefined,
  options: ApiBaseOptions = {},
): string {
  const trimmed = envUrl?.trim().replace(/\/+$/, "");
  // Empty/undefined keeps same-origin /api (Vultr-bundled fallback, dev proxy).
  if (!trimmed) return "/api";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `VITE_PUBLIC_API_URL must be an absolute http(s) URL, got: ${envUrl}`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `VITE_PUBLIC_API_URL must not contain credentials, got: ${envUrl}`,
    );
  }
  const host = url.hostname.toLowerCase();

  if (url.protocol === "http:") {
    // Local-dev escape hatch only: never enabled in a deployed bundle.
    if (options.allowInsecureLocalhost && LOOPBACK_HOSTS.has(host)) {
      return `${url.origin}/api`;
    }
    throw new Error(
      `VITE_PUBLIC_API_URL must be a public HTTPS origin (http rejected: ` +
        `session cookies would travel over plaintext or be blocked as mixed ` +
        `content), got: ${envUrl}`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `VITE_PUBLIC_API_URL must be a public HTTPS origin, got: ${envUrl}`,
    );
  }
  if (
    IPV4.test(host) ||
    host.includes(":") ||
    LOOPBACK_HOSTS.has(host) ||
    /\.local$|\.ts\.net$|\.invalid$|\.example$/i.test(host)
  ) {
    // IP literals have no trustworthy cookie scope; the rest are hosts a
    // Vercel-hosted browser cannot (or must not) reach, including the
    // non-routable FF-028 placeholder domain.
    throw new Error(
      `VITE_PUBLIC_API_URL must be a public HTTPS origin, got: ${envUrl}`,
    );
  }
  return `${url.origin}/api`;
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
