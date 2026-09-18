-- =============================================================================
-- Migration: 20260917000001_initial_schema.sql
-- Description: Core Schema for Taxi-Wisam Platform (Supabase PostgreSQL + PostGIS)
-- Tables: 24 Entities + Spatial GiST Indexes + Relationships
-- =============================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- -----------------------------------------------------------------------------
-- 1. USERS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'Customer', -- Customer, Driver, Admin
    profile_picture_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON public.users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users(role);

-- -----------------------------------------------------------------------------
-- 2. DRIVERS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.drivers (
    id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    license_number VARCHAR(50) UNIQUE NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Offline', -- Offline, Online, Busy, InTrip
    is_verified BOOLEAN NOT NULL DEFAULT false,
    rating_average NUMERIC(3, 2) NOT NULL DEFAULT 5.00,
    total_trips INT NOT NULL DEFAULT 0,
    current_location GEOMETRY(Point, 4326),
    current_heading NUMERIC(5, 2),
    last_location_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drivers_status ON public.drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_is_verified ON public.drivers(is_verified);
CREATE INDEX IF NOT EXISTS idx_drivers_location_gist ON public.drivers USING GIST(current_location);

-- -----------------------------------------------------------------------------
-- 3. CUSTOMERS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customers (
    id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    emergency_phone VARCHAR(30),
    preferred_payment_method VARCHAR(30) NOT NULL DEFAULT 'Cash',
    rating_average NUMERIC(3, 2) NOT NULL DEFAULT 5.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 4. VEHICLES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
    plate_number VARCHAR(30) UNIQUE NOT NULL,
    make VARCHAR(50) NOT NULL,
    model VARCHAR(50) NOT NULL,
    year INT NOT NULL,
    color VARCHAR(30) NOT NULL,
    total_seats INT NOT NULL DEFAULT 4,
    vehicle_type VARCHAR(30) NOT NULL DEFAULT 'Sedan', -- Sedan, SUV, Van, Minibus
    photo_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_driver_id ON public.vehicles(driver_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate_number ON public.vehicles(plate_number);

-- -----------------------------------------------------------------------------
-- 5. DRIVER DOCUMENTS (Private Storage References)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL, -- NationalId, DrivingLicense, VehicleRegistration, BackgroundCheck
    bucket_name VARCHAR(100) NOT NULL DEFAULT 'driver-documents',
    file_path TEXT NOT NULL,
    file_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'Pending', -- Pending, Approved, Rejected
    rejection_reason TEXT,
    verified_at TIMESTAMPTZ,
    verified_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_docs_driver_id ON public.driver_documents(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_docs_status ON public.driver_documents(status);

-- -----------------------------------------------------------------------------
-- 6. DRIVER ROUTES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
    vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
    route_name VARCHAR(150) NOT NULL,
    start_name VARCHAR(150) NOT NULL,
    end_name VARCHAR(150) NOT NULL,
    start_point GEOMETRY(Point, 4326) NOT NULL,
    end_point GEOMETRY(Point, 4326) NOT NULL,
    route_geometry GEOMETRY(LineString, 4326) NOT NULL,
    buffer_distance_meters NUMERIC(8, 2) NOT NULL DEFAULT 1000.0,
    departure_time TIME NOT NULL,
    estimated_duration_minutes INT NOT NULL DEFAULT 60,
    available_seats INT NOT NULL DEFAULT 4,
    price_per_seat NUMERIC(10, 2) NOT NULL,
    is_recurring BOOLEAN NOT NULL DEFAULT true,
    recurring_days VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5', -- 1=Mon .. 7=Sun
    status VARCHAR(30) NOT NULL DEFAULT 'Active', -- Active, Suspended, Archived
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_routes_driver_id ON public.driver_routes(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_routes_status ON public.driver_routes(status);
CREATE INDEX IF NOT EXISTS idx_driver_routes_geom_gist ON public.driver_routes USING GIST(route_geometry);
CREATE INDEX IF NOT EXISTS idx_driver_routes_start_gist ON public.driver_routes USING GIST(start_point);
CREATE INDEX IF NOT EXISTS idx_driver_routes_end_gist ON public.driver_routes USING GIST(end_point);

-- -----------------------------------------------------------------------------
-- 7. ROUTE POINTS (Waypoints along routes)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.route_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id UUID NOT NULL REFERENCES public.driver_routes(id) ON DELETE CASCADE,
    sequence_order INT NOT NULL,
    stop_name VARCHAR(150) NOT NULL,
    point_geometry GEOMETRY(Point, 4326) NOT NULL,
    estimated_minutes_from_start INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_points_route_seq ON public.route_points(route_id, sequence_order);
CREATE INDEX IF NOT EXISTS idx_route_points_geom_gist ON public.route_points USING GIST(point_geometry);

-- -----------------------------------------------------------------------------
-- 8. ROUTE AREAS (Geographical polygons for coverage zones)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.route_areas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id UUID REFERENCES public.driver_routes(id) ON DELETE CASCADE,
    area_name VARCHAR(150) NOT NULL,
    area_type VARCHAR(50) NOT NULL DEFAULT 'Coverage', -- Coverage, PickupZone, DropoffZone, Restricted
    area_geometry GEOMETRY(Polygon, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_areas_route_id ON public.route_areas(route_id);
CREATE INDEX IF NOT EXISTS idx_route_areas_geom_gist ON public.route_areas USING GIST(area_geometry);

-- -----------------------------------------------------------------------------
-- 9. BOOKINGS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
    driver_route_id UUID REFERENCES public.driver_routes(id) ON DELETE RESTRICT,
    seats_booked INT NOT NULL DEFAULT 1,
    pickup_name VARCHAR(150) NOT NULL,
    dropoff_name VARCHAR(150) NOT NULL,
    pickup_point GEOMETRY(Point, 4326) NOT NULL,
    dropoff_point GEOMETRY(Point, 4326) NOT NULL,
    booking_date DATE NOT NULL,
    total_fare NUMERIC(10, 2) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Pending', -- Pending, Confirmed, InProgress, Completed, Cancelled
    cancellation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_customer ON public.bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_route ON public.bookings(driver_route_id);
CREATE INDEX IF NOT EXISTS idx_bookings_date_status ON public.bookings(booking_date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_pickup_gist ON public.bookings USING GIST(pickup_point);
CREATE INDEX IF NOT EXISTS idx_bookings_dropoff_gist ON public.bookings USING GIST(dropoff_point);

-- -----------------------------------------------------------------------------
-- 10. TRANSPORT REQUESTS (Regular commute requests by customers)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transport_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    seats_needed INT NOT NULL DEFAULT 1,
    pickup_name VARCHAR(150) NOT NULL,
    dropoff_name VARCHAR(150) NOT NULL,
    pickup_point GEOMETRY(Point, 4326) NOT NULL,
    dropoff_point GEOMETRY(Point, 4326) NOT NULL,
    desired_departure_time TIME NOT NULL,
    recurring_days VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5',
    max_budget NUMERIC(10, 2),
    status VARCHAR(30) NOT NULL DEFAULT 'Open', -- Open, Matched, Fulfilled, Expired, Cancelled
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transport_req_customer ON public.transport_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_transport_req_status ON public.transport_requests(status);
CREATE INDEX IF NOT EXISTS idx_transport_req_pickup_gist ON public.transport_requests USING GIST(pickup_point);
CREATE INDEX IF NOT EXISTS idx_transport_req_dropoff_gist ON public.transport_requests USING GIST(dropoff_point);

-- -----------------------------------------------------------------------------
-- 11. SHORT TRIP REQUESTS (On-demand trips)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.short_trip_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    driver_id UUID REFERENCES public.drivers(id) ON DELETE SET NULL,
    pickup_name VARCHAR(150) NOT NULL,
    dropoff_name VARCHAR(150) NOT NULL,
    pickup_point GEOMETRY(Point, 4326) NOT NULL,
    dropoff_point GEOMETRY(Point, 4326) NOT NULL,
    route_geometry GEOMETRY(LineString, 4326),
    estimated_distance_meters NUMERIC(10, 2),
    estimated_duration_seconds INT,
    fare NUMERIC(10, 2) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Searching', -- Searching, Accepted, Arrived, InProgress, Completed, Cancelled
    accepted_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_short_trips_customer ON public.short_trip_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_short_trips_driver ON public.short_trip_requests(driver_id);
CREATE INDEX IF NOT EXISTS idx_short_trips_status ON public.short_trip_requests(status);
CREATE INDEX IF NOT EXISTS idx_short_trips_pickup_gist ON public.short_trip_requests USING GIST(pickup_point);
CREATE INDEX IF NOT EXISTS idx_short_trips_dropoff_gist ON public.short_trip_requests USING GIST(dropoff_point);

-- -----------------------------------------------------------------------------
-- 12. DRIVER ADS (Charter / Shared ride advertisements)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_ads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    start_name VARCHAR(150) NOT NULL,
    end_name VARCHAR(150) NOT NULL,
    start_point GEOMETRY(Point, 4326) NOT NULL,
    end_point GEOMETRY(Point, 4326) NOT NULL,
    route_geometry GEOMETRY(LineString, 4326),
    price NUMERIC(10, 2) NOT NULL,
    available_seats INT NOT NULL DEFAULT 4,
    departure_datetime TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Active', -- Active, Expired, Full, Cancelled
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_ads_driver ON public.driver_ads(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_ads_status ON public.driver_ads(status);
CREATE INDEX IF NOT EXISTS idx_driver_ads_start_gist ON public.driver_ads USING GIST(start_point);
CREATE INDEX IF NOT EXISTS idx_driver_ads_end_gist ON public.driver_ads USING GIST(end_point);

-- -----------------------------------------------------------------------------
-- 13. CUSTOMER ADS (Riders seeking specific shared routes)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_ads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    pickup_name VARCHAR(150) NOT NULL,
    dropoff_name VARCHAR(150) NOT NULL,
    pickup_point GEOMETRY(Point, 4326) NOT NULL,
    dropoff_point GEOMETRY(Point, 4326) NOT NULL,
    budget NUMERIC(10, 2),
    needed_seats INT NOT NULL DEFAULT 1,
    needed_datetime TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Active', -- Active, Expired, Matched, Cancelled
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_ads_customer ON public.customer_ads(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_ads_status ON public.customer_ads(status);
CREATE INDEX IF NOT EXISTS idx_customer_ads_pickup_gist ON public.customer_ads USING GIST(pickup_point);
CREATE INDEX IF NOT EXISTS idx_customer_ads_dropoff_gist ON public.customer_ads USING GIST(dropoff_point);

-- -----------------------------------------------------------------------------
-- 14. MATCHES (Matching engine correlations)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transport_request_id UUID REFERENCES public.transport_requests(id) ON DELETE CASCADE,
    customer_ad_id UUID REFERENCES public.customer_ads(id) ON DELETE CASCADE,
    driver_route_id UUID REFERENCES public.driver_routes(id) ON DELETE CASCADE,
    driver_ad_id UUID REFERENCES public.driver_ads(id) ON DELETE CASCADE,
    match_score NUMERIC(5, 2) NOT NULL,
    route_overlap_percentage NUMERIC(5, 2) NOT NULL,
    detour_distance_meters NUMERIC(8, 2) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Suggested', -- Suggested, Viewed, Accepted, Rejected, Expired
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_matches_score ON public.matches(match_score DESC);
CREATE INDEX IF NOT EXISTS idx_matches_transport_req ON public.matches(transport_request_id);
CREATE INDEX IF NOT EXISTS idx_matches_driver_route ON public.matches(driver_route_id);

-- -----------------------------------------------------------------------------
-- 15. NOTIFICATIONS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    body TEXT NOT NULL,
    type VARCHAR(50) NOT NULL, -- BookingUpdate, DriverArrived, MatchingOffer, SystemAlert, PaymentSuccess
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_read BOOLEAN NOT NULL DEFAULT false,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications(user_id, is_read);

-- -----------------------------------------------------------------------------
-- 16. RATINGS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
    short_trip_request_id UUID REFERENCES public.short_trip_requests(id) ON DELETE SET NULL,
    rater_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    rated_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    score INT NOT NULL CHECK (score >= 1 AND score <= 5),
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ratings_rated ON public.ratings(rated_id);

-- -----------------------------------------------------------------------------
-- 17. COMPLAINTS (With Private Attachment Support)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    target_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
    short_trip_request_id UUID REFERENCES public.short_trip_requests(id) ON DELETE SET NULL,
    category VARCHAR(50) NOT NULL, -- Behavior, VehicleCondition, Overcharge, RouteDeviation, Other
    description TEXT NOT NULL,
    attachment_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'Pending', -- Pending, UnderInvestigation, Resolved, Dismissed
    admin_notes TEXT,
    resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_complaints_user ON public.complaints(user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON public.complaints(status);

-- -----------------------------------------------------------------------------
-- 18. PAYMENTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
    short_trip_request_id UUID REFERENCES public.short_trip_requests(id) ON DELETE SET NULL,
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
    driver_id UUID REFERENCES public.drivers(id) ON DELETE RESTRICT,
    amount NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'IQD',
    payment_method VARCHAR(30) NOT NULL, -- Cash, ZainCash, AsiaHawala, CreditCard
    transaction_reference VARCHAR(100) UNIQUE,
    status VARCHAR(30) NOT NULL DEFAULT 'Pending', -- Pending, Completed, Failed, Refunded
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_customer ON public.payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_driver ON public.payments(driver_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(status);

-- -----------------------------------------------------------------------------
-- 19. SUBSCRIPTIONS (Driver Monthly/Weekly Service Fees)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
    plan_name VARCHAR(100) NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    billing_cycle VARCHAR(20) NOT NULL DEFAULT 'Monthly', -- Daily, Weekly, Monthly, Yearly
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    auto_renew BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_driver ON public.subscriptions(driver_id, is_active);

-- -----------------------------------------------------------------------------
-- 20. INVOICES
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
    booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    total_amount NUMERIC(10, 2) NOT NULL,
    tax_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(30) NOT NULL DEFAULT 'Issued', -- Issued, Paid, Overdue, Cancelled
    pdf_url TEXT,
    due_date DATE NOT NULL,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_user ON public.invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices(status);

-- -----------------------------------------------------------------------------
-- 21. OUTBOX MESSAGES (Reliable Transactional Messaging)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outbox_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed ON public.outbox_messages(created_at) WHERE processed_at IS NULL;

-- -----------------------------------------------------------------------------
-- 22. AUDIT LOGS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_name VARCHAR(100) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    old_values JSONB,
    new_values JSONB,
    ip_address VARCHAR(50),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON public.audit_logs(entity_name, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON public.audit_logs(created_at DESC);

-- -----------------------------------------------------------------------------
-- 23. SYSTEM SETTINGS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 24. REFRESH TOKENS (Identity & Session Management)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    jwt_id VARCHAR(100) NOT NULL,
    is_used BOOLEAN NOT NULL DEFAULT false,
    is_revoked BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON public.refresh_tokens(token);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON public.refresh_tokens(user_id);
