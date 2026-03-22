-- TimescaleDB / PostgreSQL schema for IndiaMart perf framework
-- Enable extension (run as superuser once per database)
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  run_id UUID PRIMARY KEY,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('deploy', 'scheduled', 'manual')),
  deploy_sha TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_runs_triggered_at ON runs (triggered_at DESC);

-- ---------------------------------------------------------------------------
-- Vitals measurements (hypertable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vitals_measurements (
  id BIGSERIAL,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  page_slug TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT '4G',
  run_id UUID NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  lcp_ms DOUBLE PRECISION,
  cls_score DOUBLE PRECISION,
  inp_ms DOUBLE PRECISION,
  fcp_ms DOUBLE PRECISION,
  ttfb_ms DOUBLE PRECISION,
  tbt_ms DOUBLE PRECISION,
  speed_index DOUBLE PRECISION,
  lighthouse_performance_score INT,
  lighthouse_accessibility_score INT,
  lcp_element_selector TEXT,
  raw_json JSONB
);

SELECT public.create_hypertable('vitals_measurements', 'measured_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_vitals_page_measured
  ON vitals_measurements (page_slug, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_vitals_network_measured
  ON vitals_measurements (network, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_vitals_run ON vitals_measurements (run_id);

-- Retention: raw vitals 90 days (TimescaleDB 2.x policy API)
SELECT public.add_retention_policy('vitals_measurements', INTERVAL '90 days', if_not_exists => TRUE);

-- ---------------------------------------------------------------------------
-- Script inventory — Phase 3 (hypertable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS script_inventory (
  id BIGSERIAL,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  page_slug TEXT NOT NULL,
  run_id UUID REFERENCES runs (run_id) ON DELETE SET NULL,
  script_url TEXT NOT NULL,
  script_size_bytes INT,
  blocking_time_ms DOUBLE PRECISION,
  is_third_party BOOLEAN NOT NULL DEFAULT TRUE,
  domain TEXT
);

SELECT public.create_hypertable('script_inventory', 'measured_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_script_inv_page_measured
  ON script_inventory (page_slug, measured_at DESC);

SELECT public.add_retention_policy('script_inventory', INTERVAL '90 days', if_not_exists => TRUE);

-- ---------------------------------------------------------------------------
-- Continuous aggregate: daily summary (p50/p75/p95 via Timescale hyperfunctions
-- can be added later; avg + count are widely supported in CAs)
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_vitals_summary
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 day', measured_at) AS bucket,
  page_slug,
  network,
  avg(lcp_ms) AS lcp_avg,
  avg(cls_score) AS cls_avg,
  avg(inp_ms) AS inp_avg,
  avg(tbt_ms) AS tbt_avg,
  avg(lighthouse_performance_score::double precision) AS lh_perf_avg,
  COUNT(*) AS sample_count
FROM vitals_measurements
GROUP BY bucket, page_slug, network
WITH NO DATA;
