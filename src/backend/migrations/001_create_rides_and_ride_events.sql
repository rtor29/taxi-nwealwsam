-- Migration: 001_create_rides_and_ride_events.sql
-- Description: Creates persistent storage for rides lifecycle and granular ride event transitions

CREATE TABLE IF NOT EXISTS rides (
    id VARCHAR(64) PRIMARY KEY,
    rider_id VARCHAR(64) NOT NULL,
    rider_name VARCHAR(128),
    rider_phone VARCHAR(32),
    driver_id VARCHAR(64),
    driver_name VARCHAR(128),
    driver_phone VARCHAR(32),
    vehicle_info VARCHAR(128),
    vehicle_plate VARCHAR(64),
    status VARCHAR(32) NOT NULL,
    pickup_name TEXT NOT NULL,
    pickup_address TEXT NOT NULL,
    pickup_lat DOUBLE PRECISION NOT NULL,
    pickup_lon DOUBLE PRECISION NOT NULL,
    dropoff_name TEXT NOT NULL,
    dropoff_address TEXT NOT NULL,
    dropoff_lat DOUBLE PRECISION NOT NULL,
    dropoff_lon DOUBLE PRECISION NOT NULL,
    vehicle_type VARCHAR(32) DEFAULT 'توفير',
    distance_km NUMERIC(8,2) DEFAULT 0,
    duration_mins INT DEFAULT 0,
    estimated_fare NUMERIC(10,2) DEFAULT 0,
    final_fare NUMERIC(10,2) DEFAULT 0,
    received_amount NUMERIC(10,2) DEFAULT 0,
    fare_difference NUMERIC(10,2) DEFAULT 0,
    review_flag BOOLEAN DEFAULT FALSE,
    cancellation_fee NUMERIC(10,2) DEFAULT 0,
    cancel_reason TEXT,
    cancelled_by VARCHAR(32),
    payment_method VARCHAR(32) DEFAULT 'Cash',
    payment_status VARCHAR(32) DEFAULT 'Pending',
    reconciliation_status VARCHAR(32) DEFAULT 'settled',
    idempotency_key VARCHAR(128),
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    offered_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    arrived_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    arrived_destination_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rides_rider_id ON rides(rider_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver_id ON rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_created_at ON rides(created_at DESC);

CREATE TABLE IF NOT EXISTS ride_events (
    id BIGSERIAL PRIMARY KEY,
    ride_id VARCHAR(64) NOT NULL,
    from_status VARCHAR(32),
    to_status VARCHAR(32) NOT NULL,
    actor_id VARCHAR(64),
    actor_role VARCHAR(32),
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ride_events_ride_id ON ride_events(ride_id);
CREATE INDEX IF NOT EXISTS idx_ride_events_created_at ON ride_events(created_at DESC);
