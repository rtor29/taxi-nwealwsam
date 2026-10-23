-- Migration: 007_add_driver_fixed_destination.sql
-- Description: Adds fixed_dest_lat, fixed_dest_lng, fixed_dest_label, and route_name to drivers table

ALTER TABLE drivers
ADD COLUMN IF NOT EXISTS fixed_dest_lat DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS fixed_dest_lng DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS fixed_dest_label VARCHAR(255),
ADD COLUMN IF NOT EXISTS route_name VARCHAR(255);
