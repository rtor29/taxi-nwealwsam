-- Migration: 010_add_driver_fixed_route_geometry.sql
-- Description: Adds fixed_route_geometry to drivers table for caching Mapbox route geometries on server
-- and adds directions_api_enabled setting to system_settings to control Directions API costs.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS fixed_route_geometry JSONB;

INSERT INTO system_settings (key, value_json, description)
VALUES ('directions_api_enabled', 'true', 'Enable Mapbox Directions API for commute driver route caching')
ON CONFLICT (key) DO NOTHING;
