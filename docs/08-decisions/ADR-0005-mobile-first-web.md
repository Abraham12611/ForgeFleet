# ADR-0005 — Responsive PWA before a native Android application

**Status:** Accepted as initial direction.

## Context

Operator primarily works from Samsung Android device via Tailscale. Shipping the core system quickly and avoiding duplicate product code has higher priority than app-store distribution.

## Decision

Build one responsive web UI with mobile task/chat/inbox/fleet navigation. Make it installable as a PWA where supported; later wrap shared client in Capacitor with native notifications and publish via internal testing or organizational private distribution as appropriate.

## Consequences

Fast validation and same surface on desktop/mobile; native notification reliability and Google Play policies require separate testing during v1.1.
