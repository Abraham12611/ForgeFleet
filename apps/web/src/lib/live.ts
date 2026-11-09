// Live-update transport: WebSocket first, HTTP polling fallback.
// Upstream Paperclip's LiveUpdatesProvider assumes a same-origin socket and
// falls back to 15s polling when disconnected; this module makes that policy
// explicit and split-origin safe.

export const DISCONNECTED_POLL_INTERVAL_MS = 15_000;

export function buildLiveSocketUrl(
  apiBase: string,
  path: string,
  location: Pick<Location, "host" | "protocol">,
): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  try {
    // Absolute split-origin base: reuse its host, upgrade to ws/wss.
    const url = new URL(apiBase);
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}${normalized}`;
  } catch {
    // Relative same-origin base ("/api"): derive from the browser location.
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}${normalized}`;
  }
}

export type LiveStatus = "live" | "polling" | "offline";

export interface LiveConnection {
  status: LiveStatus;
  stop: () => void;
}

export interface LiveHooks {
  onEvent: (event: unknown) => void;
  onStatus: (status: LiveStatus) => void;
  /** Poll fallback used when the socket is unavailable or drops. */
  poll: () => Promise<void>;
  pollIntervalMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

/** Connect a live channel; fall back to interval polling on any failure. */
export function connectLive(
  socketUrl: string,
  hooks: LiveHooks,
): LiveConnection {
  const WS = hooks.WebSocketImpl ?? WebSocket;
  const intervalMs = hooks.pollIntervalMs ?? DISCONNECTED_POLL_INTERVAL_MS;
  let stopped = false;
  let socket: WebSocket | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const startPolling = () => {
    if (stopped || pollTimer !== undefined) return;
    hooks.onStatus("polling");
    void hooks.poll().catch(() => undefined);
    pollTimer = setInterval(() => {
      void hooks.poll().catch(() => undefined);
    }, intervalMs);
  };
  const stopPolling = () => {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  let created: WebSocket | null = null;
  try {
    created = new WS(socketUrl);
  } catch {
    startPolling();
    return {
      status: "polling",
      stop: () => {
        stopped = true;
        stopPolling();
      },
    };
  }
  socket = created;

  socket.onopen = () => {
    if (stopped) return;
    stopPolling();
    hooks.onStatus("live");
  };
  socket.onmessage = (ev) => {
    if (stopped) return;
    hooks.onEvent((ev as MessageEvent).data);
  };
  socket.onerror = () => {
    // onclose follows; keep polling decision there.
  };
  socket.onclose = () => {
    if (stopped) return;
    startPolling();
  };

  return {
    status: "polling",
    stop: () => {
      stopped = true;
      stopPolling();
      try {
        socket?.close();
      } catch {
        // Already closed; polling is stopped either way.
      }
    },
  };
}
