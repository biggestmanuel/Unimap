-- UniMap schema. PostGIS because the campus boundary check, corridor
-- snapping and "nearest POI" queries are all spatial operations that
-- would otherwise be slow hand-rolled maths in SQL.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ── POIs ────────────────────────────────────────────────────────────
-- One row per campus location. Coordinates are geography(WGS84) so
-- ST_DWithin/ST_Distance do great-circle maths for us.
CREATE TABLE IF NOT EXISTS pois (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  category        text        NOT NULL DEFAULT 'other',
  description     text,
  accessibility   text[]      NOT NULL DEFAULT '{}',
  safety          boolean     NOT NULL DEFAULT false,
  location        geography(Point, 4326) NOT NULL,

  -- Provenance: which source last wrote this row.
  source          text        NOT NULL DEFAULT 'seed',
  verified_at     timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pois_name_not_blank CHECK (btrim(name) <> '')
);

-- Case-insensitive uniqueness so "neh" and "NEH" cannot coexist.
CREATE UNIQUE INDEX IF NOT EXISTS pois_name_lower_key ON pois (lower(name));
CREATE INDEX IF NOT EXISTS pois_category_idx ON pois (category);
-- Spatial index: required for ST_DWithin / ORDER BY distance to be fast.
CREATE INDEX IF NOT EXISTS pois_location_gix ON pois USING gist (location);

-- Full-text search over name + description.
CREATE INDEX IF NOT EXISTS pois_search_idx ON pois
  USING gin (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')));

-- ── Corrections ─────────────────────────────────────────────────────
-- Student submissions. Deliberately separate from pois: a correction is
-- a *proposal* and never mutates campus data until an admin approves it.
CREATE TABLE IF NOT EXISTS corrections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poi_id          uuid REFERENCES pois(id) ON DELETE CASCADE,

  -- Set when the student is proposing a location that does not exist yet.
  proposed_name   text,
  proposed_category text,
  proposed_location geography(Point, 4326),

  kind            text        NOT NULL
                  CHECK (kind IN ('moved', 'renamed', 'removed', 'created', 'detail')),

  detail          text        NOT NULL,
  reporter_email  text,
  reporter_device text,

  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_note     text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- A proposal must target something: either an existing POI or a new one.
  CONSTRAINT corrections_has_target CHECK (poi_id IS NOT NULL OR proposed_name IS NOT NULL)
);

-- The moderation queue: list pending, newest first.
CREATE INDEX IF NOT EXISTS corrections_queue_idx
  ON corrections (status, created_at DESC);

-- ── Users ───────────────────────────────────────────────────────────
-- Minimal for now. Roles gate the admin panel; auth lands in Phase 5.
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  display_name  text,
  role          text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Sessions ──────────────────────────────────────────────────────────
-- Server-side and revocable, rather than a stateless JWT: an admin account
-- must be killable immediately, and the admin panel is low-traffic enough
-- that a lookup per request costs nothing.
--
-- Only the SHA-256 of the token is stored, so a database leak does not hand
-- over live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON CASCADE,
  token_hash  text NOT NULL UNIQUE,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
-- Supports the sweep that deletes expired rows.
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ── Audit trail ─────────────────────────────────────────────────────
-- Append-only. Who changed what, and when, for campus data corrections.
CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  actor        text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  before_data  jsonb,
  after_data   jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log (entity_type, entity_id);

-- ── Walk graph (Phase 4) ────────────────────────────────────────────
-- Present now so the schema is settled before anyone traces footpaths.
-- Two edge classes: corridors are the backbone, footpaths are shortcuts
-- that are only routable when connected at BOTH ends.
CREATE TABLE IF NOT EXISTS graph_edges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  osm_id        bigint,
  geom          geometry(LineString, 4326) NOT NULL,
  edge_class    text NOT NULL CHECK (edge_class IN ('corridor', 'footpath')),
  name          text,
  walk_speed_mps numeric(4,2) NOT NULL DEFAULT 1.35,
  surface       text,
  source        text NOT NULL DEFAULT 'osm',

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT graph_edges_geoms_not_empty CHECK (ST_NPoints(geom) >= 2)
);

CREATE INDEX IF NOT EXISTS graph_edges_geom_gix ON graph_edges USING gist (geom);

-- A footpath is only usable if it meets the network twice; enforcement
-- happens in the router, but this index makes the query cheap.
CREATE INDEX IF NOT EXISTS graph_edges_class_idx ON graph_edges (edge_class);

-- ── Student walk traces ─────────────────────────────────────────────
-- Recorded on a phone when the app notices the user is walking somewhere
-- the graph does not cover -- "you are not on any edge".
--
-- These are *proposals*, like corrections: nothing here mutates graph_edges
-- until an admin approves it. Raw traces are noisy (tunnel drift, GPS
-- jitter, someone walking in circles), so the geometry is kept exactly as
-- submitted and the review step is where it gets cleaned up.
CREATE TABLE IF NOT EXISTS walk_traces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  geom          geometry(LineString, 4326) NOT NULL,
  point_count   int NOT NULL,
  distance_m    numeric(10,2),

  -- How far the user was from the graph while recording. Large values mean
  -- the trace was captured precisely because the path was missing, which is
  -- what makes those worth reviewing first.
  max_off_graph_m numeric(8,2),

  reporter_device text,
  note           text,

  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'merged')),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT walk_traces_not_empty CHECK (ST_NPoints(geom) >= 2),
  CONSTRAINT walk_traces_points_sane CHECK (point_count >= 2 AND point_count <= 20000)
);

CREATE INDEX IF NOT EXISTS walk_traces_geom_gix ON walk_traces USING gist (geom);
CREATE INDEX IF NOT EXISTS walk_traces_queue_idx ON walk_traces (status, created_at DESC);

-- ── Triggers ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pois_touch ON pois;
CREATE TRIGGER pois_touch BEFORE UPDATE ON pois
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();