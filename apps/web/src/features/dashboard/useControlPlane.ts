// FF-015 (E12) — control-plane binding hook.
//
// Binds the only real status available in the scaffold: the health probe
// (`src/lib/api.ts`) and the live channel (`src/lib/live.ts`). Project-level
// endpoints are not bound yet (E05/E08), so project fields stay `unknown`
// outside fixture preview — the hook reports connection truth only.
//
// Honest-state rule: `live` requires a successful health check this session.
// Unreachable Toujours -> `unknown` (+ offline / stale / error screens).
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, fetchHealth } from "../../lib/api";
import { buildLiveSocketUrl, connectLive, type LiveStatus } from "../../lib/live";
import { resolveSource, type ScreenResolution } from "./state";
import type { DataSource } from "./types";

export interface ControlPlaneBinding {
  source: DataSource;
  screen: ScreenResolution;
  /** Live channel state; `null` before the socket attempt or in fixture mode. */
  liveStatus: LiveStatus | null;
  apiBase: string;
  /** Re-run the health probe. Safe: idempotent GET, no side effects. */
  retry: () => void;
  retryCount: number;
}

export function useControlPlane(
  envUrl: string | undefined,
  fixtureMode: boolean,
): ControlPlaneBinding {
  const [phase, setPhase] = useState<
    "loading" | "live" | "failed" | "offline"
  >("loading");
  const [hadData, setHadData] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const cancelled = useRef(false);

  const apiBase = apiUrl("", envUrl);

  const probe = useCallback(() => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setPhase("offline");
      return;
    }
    fetchHealth(envUrl)
      .then(() => {
        if (cancelled.current) return;
        setHadData(true);
        setPhase("live");
      })
      .catch(() => {
        if (cancelled.current) return;
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          setPhase("offline");
        } else {
          setPhase("failed");
        }
      });
  }, [envUrl]);

  useEffect(() => {
    cancelled.current = false;
    if (fixtureMode) return () => {};
    probe();
    const socketUrl = buildLiveSocketUrl(
      apiBase,
      "/api/live",
      window.location,
    );
    const conn = connectLive(socketUrl, {
      onEvent: () => undefined,
      onStatus: (s) => {
        if (!cancelled.current) setLiveStatus(s);
      },
      poll: () => fetchHealth(envUrl).then(() => undefined),
    });
    const onOnline = () => probe();
    const onOffline = () => {
      if (!cancelled.current) setPhase("offline");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      cancelled.current = true;
      conn.stop();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [apiBase, envUrl, fixtureMode, probe, retryCount]);

  const retry = useCallback(() => {
    setPhase("loading");
    setRetryCount((n) => n + 1);
  }, []);

  const online =
    typeof navigator === "undefined" ? true : navigator.onLine;
  const resolved = resolveSource({
    fixtureMode,
    online: phase === "offline" ? false : online,
    healthOk: phase === "live",
    fetchFailed: phase === "failed",
    hadPriorData: hadData && phase === "failed",
  });

  return {
    source: resolved.source,
    screen: resolved.screen,
    liveStatus: fixtureMode ? null : liveStatus,
    apiBase,
    retry,
    retryCount,
  };
}
