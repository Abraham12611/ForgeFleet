#!/usr/bin/env python3
"""FF-028 local round-trip: drive the REAL Caddy preview ingress on localhost
against a stdlib stub Paperclip backend and verify the security contract
end to end (auth matrix, CORS, WS upgrade, upload rejection, 404s).

Fixture-local by design: stub backend + loopback only. This proves INGRESS
behavior (fail-closed 401/403/404, CORS echo, gated upgrade, proxied 413),
not Vultr/Vercel reachability -- live evidence still needs staging.

Requires the `caddy` binary (used for `validate` and `run`).
Run: python3 scripts/deploy/preview_roundtrip.py
Exit 0 when every case passes; exit 1 otherwise (Caddy always stopped).
"""
import base64
import hashlib
import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CADDYFILE = ROOT / "infra" / "preview-ingress" / "Caddyfile.preview"

BACKEND_HOST, BACKEND_PORT = "127.0.0.1", 18080
INGRESS_HOST, INGRESS_PORT = "127.0.0.1", 18443
SESSION_COOKIE = "stub-session=ok"
ALLOWED_ORIGIN = "https://app.staging.example.invalid"
ALLOWED_PREVIEW = "https://ff-preview-057-forge-fleet.vercel.app"
FOREIGN_ORIGIN = "https://evil.example"
WS_PATH = "/api/companies/acme/events/ws"
CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn
    return deco


# ---------------------------------------------------------------- stub backend

class StubHandler(BaseHTTPRequestHandler):
    server_version = "StubPaperclip/0"
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def _authed(self):
        return SESSION_COOKIE in (self.headers.get("Cookie") or "")

    def _send(self, status, body=b"", ctype="application/json"):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/auth/get-session":
            if self._authed():
                self._send(200, json.dumps({"session": {"id": "stub"}, "user": {"id": "u1"}}))
            else:
                self._send(401, json.dumps({"error": "Board authentication required"}))
        elif self.path in ("/api/liveness", "/api/ready"):
            self._send(200, json.dumps({"status": "ok"}))
        elif self.path == "/api/companies/acme":
            self._send(200, json.dumps({"id": "acme"}))
        elif self.path == "/api/companies/acme/events":
            self._send(200, json.dumps({"events": [], "poll": True}))
        elif self.path == WS_PATH:
            self._handle_ws()
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        if self.path == "/api/uploads":
            length = int(self.headers.get("Content-Length") or 0)
            # Mimic the backend default JSON body limit (verified 10mb):
            # the ingress 1GB safety ceiling lets this through, the backend
            # rule rejects it -- the chain is what this case proves.
            if length > 10 * 1024 * 1024:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                self._send(413, json.dumps({"error": "body too large"}))
                return
            body = self.rfile.read(length) if length else b""
            self._send(200, json.dumps({"received": len(body)}))
        else:
            self._send(404, json.dumps({"error": "not found"}))

    # Minimal RFC 6455 accept-and-echo (text frames only, then close).
    def _handle_ws(self):
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self._send(400, "upgrade required", ctype="text/plain")
            return
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()
        self.wfile.write(
            f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode()
        )
        conn = self.connection
        try:
            while True:
                hdr = _recvn(conn, 2)
                fin_op, mask_len = hdr[0], hdr[1]
                length = mask_len & 0x7F
                if length == 126:
                    length = int.from_bytes(_recvn(conn, 2), "big")
                mask = _recvn(conn, 4)
                payload = bytearray(_recvn(conn, length))
                for i in range(len(payload)):
                    payload[i] ^= mask[i % 4]
                opcode = fin_op & 0x0F
                if opcode == 0x8:
                    conn.sendall(b"\x88\x00")
                    break
                if opcode == 0x1:
                    conn.sendall(bytes([0x81, len(payload)]) + bytes(payload))
        except (ConnectionError, TimeoutError):
            pass
        self.close_connection = True


def _recvn(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed")
        buf += chunk
    return buf


# ---------------------------------------------------------------- driver

def request(method, path, headers=None, body=None):
    conn = http.client.HTTPConnection(INGRESS_HOST, INGRESS_PORT, timeout=10)
    conn.request(method, path, body=body, headers=headers or {})
    resp = conn.getresponse()
    data = resp.read()
    out = dict(status=resp.status, body=data,
               acao=resp.getheader("Access-Control-Allow-Origin"),
               acac=resp.getheader("Access-Control-Allow-Credentials"))
    conn.close()
    return out


def ws_roundtrip(cookie=None):
    """Raw-socket WS handshake + echo + close through the ingress."""
    sock = socket.create_connection((INGRESS_HOST, INGRESS_PORT), timeout=10)
    key = base64.b64encode(b"ff028-test-key-16b!").decode()
    lines = [
        f"GET {WS_PATH} HTTP/1.1",
        f"Host: {INGRESS_HOST}:{INGRESS_PORT}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ]
    if cookie:
        lines.append(f"Cookie: {cookie}")
    lines += ["", ""]
    sock.sendall("\r\n".join(lines).encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(4096)
        if not chunk:
            break
        head += chunk
    status_line = head.split(b"\r\n", 1)[0].decode(errors="replace")
    if "101" not in status_line:
        sock.close()
        return status_line, None
    mask = b"\x01\x02\x03\x04"
    payload = b"hello-ingress"
    masked = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
    sock.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + masked)
    hdr = _recvn(sock, 2)
    length = hdr[1] & 0x7F
    if length == 126:
        length = int.from_bytes(_recvn(sock, 2), "big")
    echo = _recvn(sock, length)
    sock.sendall(b"\x88\x00")
    try:
        sock.recv(2)
    except (ConnectionError, TimeoutError, OSError):
        pass
    sock.close()
    return status_line, echo


@case("caddy validate passes")
def t_validate(ctx):
    return ctx["validate_ok"], "caddyfile rejected" if not ctx["validate_ok"] else ""


@case("GET /api/liveness without session -> 200 (public)")
def t_liveness(_ctx):
    r = request("GET", "/api/liveness")
    return r["status"] == 200, f"got {r['status']}"


@case("GET /api/companies/acme without session -> 401")
def t_no_session(_ctx):
    r = request("GET", "/api/companies/acme")
    return r["status"] == 401, f"got {r['status']}"


@case("GET /api/companies/acme with session -> 200")
def t_session(_ctx):
    r = request("GET", "/api/companies/acme", {"Cookie": SESSION_COOKIE})
    return r["status"] == 200, f"got {r['status']} {r['body'][:80]!r}"


@case("foreign Origin with session -> 403")
def t_foreign(_ctx):
    r = request("GET", "/api/companies/acme",
                {"Cookie": SESSION_COOKIE, "Origin": FOREIGN_ORIGIN})
    return r["status"] == 403, f"got {r['status']}"


@case("allowlisted Origin echoes exactly, no wildcard")
def t_cors(_ctx):
    r = request("GET", "/api/companies/acme",
                {"Cookie": SESSION_COOKIE, "Origin": ALLOWED_PREVIEW})
    ok = (r["status"] == 200 and r["acao"] == ALLOWED_PREVIEW
          and r["acac"] == "true")
    return ok, f"got {r['status']} acao={r['acao']!r} acac={r['acac']!r}"


@case("preflight: allowlisted -> 204, foreign -> 403")
def t_preflight(_ctx):
    a = request("OPTIONS", "/api/companies/acme", {"Origin": ALLOWED_ORIGIN})
    b = request("OPTIONS", "/api/companies/acme", {"Origin": FOREIGN_ORIGIN})
    ok = a["status"] == 204 and a["acao"] == ALLOWED_ORIGIN and b["status"] == 403
    return ok, f"got allowed={a['status']}/{a['acao']!r} foreign={b['status']}"


@case("WS upgrade with session -> 101 + echo + close")
def t_ws(_ctx):
    status, echo = ws_roundtrip(cookie=SESSION_COOKIE)
    ok = "101" in status and echo == b"hello-ingress"
    return ok, f"got {status!r} echo={echo!r}"


@case("WS upgrade without session -> 401, no upgrade")
def t_ws_noauth(_ctx):
    status, _echo = ws_roundtrip()
    return "401" in status and "101" not in status, f"got {status!r}"


@case("poll fallback GET works with session")
def t_poll(_ctx):
    r = request("GET", "/api/companies/acme/events", {"Cookie": SESSION_COOKIE})
    return r["status"] == 200 and b"poll" in r["body"], f"got {r['status']}"


@case("12MB upload rejected 413 through proxy; small upload 200")
def t_upload(_ctx):
    big = request("POST", "/api/uploads", {"Cookie": SESSION_COOKIE}, body=b"x" * (12 * 1024 * 1024))
    small = request("POST", "/api/uploads", {"Cookie": SESSION_COOKIE}, body=b"hello")
    ok = big["status"] == 413 and small["status"] == 200
    return ok, f"got big={big['status']} small={small['status']}"


@case("bridge and unknown paths -> 404")
def t_404(_ctx):
    a = request("GET", "/bridge/status", {"Cookie": SESSION_COOKIE})
    b = request("GET", "/", {"Cookie": SESSION_COOKIE})
    ok = a["status"] == 404 and b["status"] == 404
    return ok, f"got bridge={a['status']} root={b['status']}"


@case("session gate itself 401s without cookie, 200s with it")
def t_gate(_ctx):
    a = request("GET", "/api/auth/get-session")
    b = request("GET", "/api/auth/get-session", {"Cookie": SESSION_COOKIE})
    ok = a["status"] == 401 and b["status"] == 200
    return ok, f"got anon={a['status']} authed={b['status']}"


def wait_port(host, port, deadline_s=15):
    end = time.time() + deadline_s
    while time.time() < end:
        try:
            socket.create_connection((host, port), timeout=1).close()
            return True
        except OSError:
            time.sleep(0.2)
    return False


def main():
    env = dict(os.environ, PREVIEW_INGRESS_BIND=f"http://{INGRESS_HOST}:{INGRESS_PORT}",
               PAPERCLIP_API=f"{BACKEND_HOST}:{BACKEND_PORT}")
    v = subprocess.run(["caddy", "validate", "--config", str(CADDYFILE),
                        "--adapter", "caddyfile"],
                       capture_output=True, text=True, env=env)
    ctx = {"validate_ok": v.returncode == 0}
    if not ctx["validate_ok"]:
        print(v.stderr[-2000:])

    backend = ThreadingHTTPServer((BACKEND_HOST, BACKEND_PORT), StubHandler)
    backend.daemon_threads = True
    threading.Thread(target=backend.serve_forever, daemon=True).start()

    caddy = subprocess.Popen(["caddy", "run", "--config", str(CADDYFILE),
                              "--adapter", "caddyfile"],
                             env=env, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    try:
        if not wait_port(INGRESS_HOST, INGRESS_PORT):
            print("ROUND TRIP: FAIL (ingress did not start)")
            return 1
        failures = 0
        for name, fn in CASES:
            try:
                ok, detail = fn(ctx)
            except Exception as exc:  # noqa: BLE001 -- report, don't crash
                ok, detail = False, f"exception: {exc!r}"
            print(f"[{'PASS' if ok else 'FAIL'}] {name}" + ("" if ok else f" -- {detail}"))
            failures += not ok
        print(f"ROUND TRIP: {'PASS' if failures == 0 else 'FAIL'} "
              f"({len(CASES) - failures}/{len(CASES)} cases, stub backend on loopback)")
        return 1 if failures else 0
    finally:
        caddy.terminate()
        try:
            caddy.wait(timeout=10)
        except subprocess.TimeoutExpired:
            caddy.kill()
        backend.shutdown()


if __name__ == "__main__":
    sys.exit(main())

