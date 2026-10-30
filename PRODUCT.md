# Product

<!-- impeccable:product-schema 1 -->

<!-- Inferred from repository evidence and the redesign brief; no product interview was available. Confirm these operating assumptions before they become standing product truth. -->

## Platform

web

## Users

A single household running one M701 sensor. They check the dashboard in passing — on a phone in the room or on a laptop — to answer one question: is the air in here okay right now? Occasionally they scroll into history to see whether a window, a fan, or a new piece of furniture changed things. No account, no team, no multi-site administration.

## Product Purpose

An end-to-end indoor air quality monitor: a Rust serial client reads 17-byte frames from an M701 module, a server stores them in PostgreSQL, and a public dashboard renders the latest 100 readings across seven channels (CO₂, HCHO, TVOC, PM2.5, PM10, temperature, humidity). Success is a glanceable, trustworthy answer about the room, backed by the raw numbers when someone wants them.

## Positioning

One sensor, one room, no onboarding: the page reads the physical module's output directly and shows all seven channels — including formaldehyde and TVOC, which consumer dashboards often hide — without an account or a cloud product in between.

## Operating Context

The dashboard lives at `https://sensor.boxcube.xyz`, served by the Axum server from `server/assets/`. It polls `GET /api/readings` every 5 seconds, shows the latest 100 rows, and works with no build step: plain HTML, CSS, JS, and a bundled Chart.js. The sensor posts new readings continuously; the page states are connecting, live, stale (no reading for 90 s), waiting (server reachable but empty), and offline.

## Capabilities and Constraints

- Static assets only; no bundler, framework, or network font dependency should be required.
- Seven channels with fixed units and comfort thresholds:
  - CO₂ ppm (comfort < 800, elevated < 1200)
  - HCHO µg/m³ (< 80, < 150)
  - TVOC µg/m³ (< 300, < 600)
  - PM2.5 µg/m³ (< 15, < 35)
  - PM10 µg/m³ (< 50, < 100)
  - temperature °C (comfort 20–26)
  - humidity %RH (comfort 40–60)
- One overall verdict, per-channel level flags, 24-point sparklines, three history charts (20/50/100 points), and a recent-readings table.
- API timestamps are naive UTC and localized in the browser.
- Must keep the existing API contract and all working controls: refresh, range selection, URL/localStorage range state, visibility refresh, online retry, and accessible labels.
- Accessibility: keyboard focus, skip link, live/offline status text, `prefers-reduced-motion`, table semantics, and chart text alternatives.

## Brand Commitments

The user asked for a redesign that feels **warm, comfortable, and youthful**. That is a binding visual constraint for this surface. No existing logo, typeface, or palette is contractually fixed; the old editorial look is evidence of function, not identity.

## Evidence on Hand

Real live readings and a current dashboard screenshot at `docs/dashboard.png`. The M701 frame specification is in `docs/m701-frame-spec.ini`, and the module datasheet is in `client/docs/M701-UART-datasheet.pdf`. There are no testimonials, customers, prices, or benchmark claims, and none may be invented.

## Product Principles

1. Answer the room question first; details are available but never in the way.
2. Every number is real measurement, never a decorative placeholder.
3. Calm when things are fine, clear and specific when they are not.
4. The page should feel like part of the home, not a lab instrument.
5. One static page, fast and resilient, even when the sensor disappears.

## Accessibility & Inclusion

Standard web accessibility applies: WCAG AA contrast for text and controls, visible focus, reduced-motion support, semantic table and status announcements, and no color-only meaning for channel state.
