-- Migration: 011_add_driver_route_locked.sql
-- Description: Adds route_locked column to drivers table to lock driver route modification after initial fixation.
-- Modifications can only be performed by Administrator from the Dashboard.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS route_locked BOOLEAN DEFAULT false;

-- Existing drivers with fixed locations are locked by default
UPDATE drivers SET route_locked = true WHERE fixed_lat IS NOT NULL AND route_locked IS NOT TRUE;
