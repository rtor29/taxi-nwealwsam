-- Migration: 004_add_driver_fixed_location.sql
-- Description: Adds fixed_lat, fixed_lng, fixed_label, and fixed_updated_at to drivers table

ALTER TABLE drivers
ADD COLUMN IF NOT EXISTS fixed_lat DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS fixed_lng DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS fixed_label VARCHAR(60),
ADD COLUMN IF NOT EXISTS fixed_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_drivers_fixed_lat_lng ON drivers(fixed_lat, fixed_lng) WHERE fixed_lat IS NOT NULL;
