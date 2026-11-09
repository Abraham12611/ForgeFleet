import { useEffect, useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { apiUrl, fetchHealth, type HealthStatus } from "./lib/api";
import { buildLiveSocketUrl, connectLive } from "./lib/live";

const API_ENV = import.meta.env.VITE_PUBLIC_API_URL as string | undefined;

function ConnectionPanel() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<string>("connecting…");

  useEffect(() => {
    let cancelled = false;
    fetchHealth(API_ENV)
      .then((h) => {
        if (!cancelled) {
          setHealth(h);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    const socketUrl = buildLiveSocketUrl(
      apiUrl("", API_ENV),
      "/api/live",
      window.location,
    );
    const conn = connectLive(socketUrl, {
      onEvent: () => setLive("event received"),
      onStatus: (s) => setLive(s),
      poll: () => fetchHealth(API_ENV).then(() => undefined),
    });
    return () => {
      cancelled = true;
      conn.stop();
    };
  }, []);

  return (
    <section>
      <h2>Control-plane connection (spike probe)</h2>
      <dl>
        <dt>API base</dt>
        <dd>
          <code>{apiUrl("", API_ENV)}</code>
        </dd>
        <dt>Health</dt>
        <dd>{health ? `${health.status}` : (error ?? "checking…")}</dd>
        <dt>Live channel</dt>
        <dd>{live}</dd>
      </dl>
      {error && (
        <p role="alert">
          Backend unreachable from this origin. Same-origin /api rewrite or a
          public VITE_PUBLIC_API_URL is required.
        </p>
      )}
    </section>
  );
}

function NotFound() {
  const location = useLocation();
  return (
    <p>
      No route for <code>{location.pathname}</code> — SPA fallback works.
    </p>
  );
}

export default function App() {
  return (
    <main>
      <h1>ForgeFleet web (FF-027 spike)</h1>
      <nav>
        <Link to="/">Status</Link> | <Link to="/fleet">Fleet</Link>
      </nav>
      <Routes>
        <Route path="/" element={<ConnectionPanel />} />
        <Route
          path="/fleet"
          element={<p>Fleet board mounts here after the E12 build.</p>}
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </main>
  );
}
