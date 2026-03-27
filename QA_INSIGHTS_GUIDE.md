# QA Insights & Grafana Guide

This guide explains how the QA team can extract actionable insights from the Agentic Performance Test Suite, how to access Grafana, and what each phase of the pipeline physically gives you.

---

## 1. Accessing Grafana
Grafana is automatically provisioned as part of the Docker stack and comes pre-wired to the PostgreSQL (TimescaleDB) instance where the agents store their metrics.

- **URL:** [http://localhost:3001](http://localhost:3001)
- **Login Username:** `admin`
- **Login Password:** `admin`

### Before using Grafana for the first time:
Make sure the database schema is actually applied so the tables exist.
```bash
docker exec -i perf_db psql -U perf_user -d perf_metrics < db/schema.sql
```
*(Once applied, you never need to do this again unless you destroy the Docker volume).*

---

## 2. What Insights Are We Taking? (Phase by Phase)

The framework is divided into 3 automated phases. Each phase replaces a manual QA task with automated intelligence.

### Phase 1: Web Vitals (The "Is it fast?" Phase)
**What it does:** Runs Lighthouse 3 times per page and takes the median to eliminate variance. It tests `homepage`, `search`, `supplier-detail`, `product-listing`, and `category`.
**Insights You Get:**
1. **LCP (Largest Contentful Paint)**: Is the main hero image or text loading fast enough? (Target: < 2.5s)
2. **CLS (Cumulative Layout Shift)**: Does the page jump around while loading, causing accidental misclicks?
3. **INP & TBT (Blocking Time)**: Is the page frozen by heavy JavaScript?
**Grafana Usage:** In Grafana, you can plot LCP over time. If a new deployment goes out and LCP jumps from 2.0s to 4.0s, the dashboard will immediately show a spike.

### Phase 2: Visual & Network QA (The "Does it look right physically?" Phase)
**What it does:** Loads the page under `--offline`, `EDGE`, `SLOW_3G`, and `4G`. Captures full-page screenshots and records video under mobile and desktop viewports.
**Insights You Get:**
1. **Visual Regression (`./diffs/`)**: Comparing to the baseline, the agent draws a red outline over anything that shifted or broke in the CSS/layout. QA no longer has to spot-check padding or missing buttons.
2. **Degradation Alerts (`NetworkSim`)**: If testing on `4G` takes 1s, but testing on `SLOW_3G` takes 8s, the agent flags a "Network Degradation Warning". This tells QA to ask developers to optimize payload size for poor Indian cellular networks.
3. **Session Replay (`./recordings/`)**: If a test fails, QA can literally watch the `.webm` video recording of the browser struggling to load the page.

### Phase 3: AI Script Audit (The "Why is it slow?" Phase)
**What it does:** Sniffs all `.js` files loading on the page and checks the `git diff` of the latest deployment. It sends this to Claude or Gemini.
**Insights You Get:**
1. **3rd-Party Bloat**: You get a list in the DB of every tracking script (Google, Facebook, DoubleClick) and exactly how many milliseconds it blocked the main thread.
2. **Automated Root Cause**: The AI provides a human-readable JSON summary, e.g., *"Severity: HIGH. Root cause: The new `react-carousel` library added in commit abc1234 is increasing TBT by 400ms."*
3. **Zero-Touch Jira**: QA doesn't manually write the bug report. The agent automatically creates the Jira ticket with the AI's root cause analysis and assigns it.

---

## 3. The Daily Workflow for a QA Manager

1. **Morning Check:** Open Grafana (`localhost:3001`), look at the `Daily Vitals Summary` (powered by TimescaleDB continuous aggregates). Ensure no IndiaMart core pages are trending upward in LCP or TBT over the week.
2. **Reviewing Slack Alerts:** Look at the Slack channel. If an alert says **"CRITICAL Regression: Homepage LCP degraded by 45%"**, click the Jira link right in the Slack message.
3. **Investigating a Failure:**
   - Go to the project folder.
   - Open `./diffs/<run-id>/` to see what broke visually.
   - Open `./recordings/<run-id>/` to watch the video of the failure.
   - Open `./raw-reports/<run-id>/` and drag the JSON into the [Lighthouse Viewer](https://googlechrome.github.io/lighthouse/viewer/) for the exact waterfall chart.
4. **Updating Baselines (When a design change is intentional):**
   ```bash
   npm run capture-baselines:force
   ```
   This tells the agent "The new design is correct, stop alerting on visual diffs."
