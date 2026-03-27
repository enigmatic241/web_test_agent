# Future Plans & Roadmap

This document outlines planned improvements to the current Web Performance Testing Suite and introduces a Phase-based plan for extending the same agentic framework to **Mobile App (Android & iOS) performance testing**.

---

## Part 1: Web Suite — Future Improvements

### Near-Term (Next 4–6 Weeks)

| Priority | Feature | What It Adds |
|----------|---------|-------------|
| 🔴 High | **Grafana Pre-built Dashboards** | Ship a `grafana/dashboards/vitals.json` that auto-provisions the Core Web Vitals Tracker, Network Sim, and Regression History panels so the team doesn't patch SQL manually. |
| 🔴 High | **Bot-Detection Bypass** | Add Chrome flags and realistic user-agent rotation so IndiaMart's Cloudflare WAF doesn't block headless Lighthouse runs. |
| 🟡 Medium | **Scheduled CI Runs** | Trigger `npm run e2e` via GitHub Actions on a cron schedule (e.g., every night at midnight IST) so regressions are caught before the morning standup. |
| 🟡 Medium | **Baseline Auto-refresh** | After N successful runs with no regressions, automatically promote the current screenshots as the new visual baseline. |
| 🟢 Low | **Email Reporter** | Add a daily summary email reporter (using Nodemailer or SendGrid) to complement Slack for the management overview. |

### Mid-Term (1–3 Months)

- **Phase 4: API / Backend Perf** — Test the IndiaMart REST APIs directly (search, product listing, supplier endpoints) for response time and error rate. Store results in the same TimescaleDB.
- **Multi-Region Testing** — Run from agents in different AWS regions to catch CDN misses and latency for users in different parts of India.
- **Competitive Benchmarking** — Add config to test competitor pages (e.g., IndiaMART vs TradeIndia) and automatically compare LCP side-by-side in Grafana.

### Long-Term (3+ Months)

- **Full Grafana Alerting** — Use Grafana's native alerting (instead of the Slack reporter) to trigger PagerDuty/Opsgenie incidents directly from a threshold breach.
- **Distributed Agent Runner** — Instead of running everything sequentially on one machine, fan-out test pages across multiple free GitHub Actions workers in parallel, cutting Phase 1 run time from ~160s to ~40s.

---

## Part 2: Mobile App Performance Testing Plan

The goal is to mirror the same 3-phase agentic structure from the web suite — **Metrics → Visual → AI Analysis** — but adapted for native Android and iOS apps.

### Tech Stack for Mobile

| Tool | Role |
|------|------|
| **Appium** + `appium-webdriverio` | Cross-platform (Android + iOS) automation driver |
| **adb (Android Debug Bridge)** | Low-level device control & systrace-based performance capture |
| **Perfetto / systrace** | Native CPU/GPU/memory trace on Android |
| **Xcode Instruments** (iOS) | FPS, memory, and CPU profiling on iOS |
| **TimescaleDB** | Same DB! Stores all mobile metrics alongside web vitals |
| **Grafana** | Same dashboards, extended with a "Mobile" folder |

---

### Phase M1: App Launch & Frame Rate Metrics

**Goal:** Measure how fast the app opens and ensure animations run at 60fps.

**What the agent does:**
1. Installs the latest APK/IPA on the device/emulator using Appium.
2. Captures **cold start time** (App Launch Time = time from icon tap to first frame rendered) using `adb shell am start -W` (Android) or XCTest (iOS).
3. Runs `adb shell dumpsys gfxinfo` after a scroll session to collect **Jank frames** (frames that took > 16ms to render, causing visible stuttering).
4. Stores `cold_start_ms`, `jank_frame_percent`, `avg_fps` in a new `mobile_vitals` TimescaleDB hypertable.

**Metrics stored in DB:**
```
cold_start_ms          — how long until the homepage is usable
jank_frame_count       — number of dropped frames in a 5s scroll
avg_fps                — average frames per second during scroll
memory_mb_peak         — peak RAM usage during the session
network_calls_count    — number of API requests on app launch
```

---

### Phase M2: Visual Regression + Network Simulation

**Goal:** Catch UI regressions and test app behavior on poor network connectivity.

**What the agent does:**
1. **Screenshots:** Takes full-screen Appium screenshots of key screens (Home, Search Results, Product Detail). Compares to pixel-baseline using the same `pixelmatch` library already in the project.
2. **Network throttling on Android:** Uses `adb shell tc` or the Android Emulator's built-in network profile (`-netspeed`) to simulate EDGE/3G/4G conditions.
3. **Offline mode:** Forces the app offline and verifies the Error State screen looks exactly as designed (visual regression for the error UI).

---

### Phase M3: AI Root Cause Analysis (Same as Web)

**Goal:** When performance degrades between two app versions (builds), let the AI explain why.

**What the agent does:**
1. Reads the metric delta from TimescaleDB (e.g., cold start went from 1.2s → 2.8s between build v4.1 and v4.2).
2. Reads the `git diff --stat` between the two app version tags.
3. Sends the same JSON payload to **Claude or Gemini** and asks for a root cause analysis.
4. Example AI output: *"Severity: HIGH. Cold start regression caused by a new `SplashScreenContentProvider` added in commit xyz that initializes the analytics SDK synchronously on the main thread. Recommendation: Move SDK init to a background coroutine."*
5. Creates a Jira ticket automatically.

---

### How to Add It to This Repo

The mobile plan slots naturally into the existing structure:

```
agents/
  mobile-launch-agent.ts      ← Phase M1: cold start + jank
  mobile-visual-agent.ts      ← Phase M2: screenshot diffs
  (...reuses analysis-agent.ts for Phase M3)

config/
  mobile-apps.ts              ← APK path, bundle ID, key screens

db/
  schema.sql                  ← ADD: mobile_vitals hypertable

scripts/
  e2e-mobile.sh               ← Same as e2e.sh but for mobile
```

There is no architectural change — the same orchestrator, the same DB, and the same Grafana instance extend naturally to cover both web and mobile performance in a single unified dashboard for your QA team.
