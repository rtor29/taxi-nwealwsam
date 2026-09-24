-- =============================================================================
-- Self-Hosted PostgreSQL Schema for Taxi-Wisam Platform (Najaf Edition)
-- Fully replacing Supabase with local/containerized PostgreSQL
-- All relationships configured with ON DELETE CASCADE to prevent orphaned data
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    phone_number VARCHAR(30),
    email VARCHAR(255) UNIQUE,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'Customer', -- 'Customer', 'Driver', 'Admin', 'Unassigned'
    password_hash TEXT,
    google_id VARCHAR(100),
    profile_picture_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_blocked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- 2. Drivers
CREATE TABLE IF NOT EXISTS drivers (
    driver_id VARCHAR(64) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(150) NOT NULL,
    phone_number VARCHAR(30),
    email VARCHAR(255),
    password_hash TEXT,
    google_id VARCHAR(100),
    license_number VARCHAR(50) NOT NULL,
    vehicle_make VARCHAR(50) DEFAULT 'تويوتا',
    vehicle_model VARCHAR(50) DEFAULT 'كورولا',
    vehicle_year INT DEFAULT 2020,
    vehicle_plate VARCHAR(30) DEFAULT 'النجف',
    status VARCHAR(30) NOT NULL DEFAULT 'Pending', -- 'Pending', 'Approved', 'Rejected', 'Suspended', 'Online', 'Offline'
    is_verified BOOLEAN NOT NULL DEFAULT false,
    is_blocked BOOLEAN NOT NULL DEFAULT false,
    rejection_reason TEXT,
    rating_average NUMERIC(3, 2) NOT NULL DEFAULT 5.00,
    total_trips INT NOT NULL DEFAULT 0,
    latitude NUMERIC(10, 7) DEFAULT 31.9961,
    longitude NUMERIC(10, 7) DEFAULT 44.3168,
    heading NUMERIC(5, 2) DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_verified ON drivers(is_verified);
CREATE INDEX IF NOT EXISTS idx_drivers_blocked ON drivers(is_blocked);

-- 3. Customers
CREATE TABLE IF NOT EXISTS customers (
    customer_id VARCHAR(64) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(150) NOT NULL,
    phone_number VARCHAR(30),
    email VARCHAR(255),
    route TEXT,
    address TEXT,
    plain_password TEXT,
    password_hash TEXT,
    google_id VARCHAR(100),
    preferred_payment_method VARCHAR(30) NOT NULL DEFAULT 'Cash',
    rating_average NUMERIC(3, 2) NOT NULL DEFAULT 5.00,
    total_bookings INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_blocked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(is_active);
CREATE INDEX IF NOT EXISTS idx_customers_blocked ON customers(is_blocked);

-- 4. Driver Documents (Verifications Queue)
CREATE TABLE IF NOT EXISTS driver_documents (
    document_id VARCHAR(64) PRIMARY KEY,
    driver_id VARCHAR(64) NOT NULL REFERENCES drivers(driver_id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL DEFAULT 'DrivingLicense',
    file_path TEXT NOT NULL,
    file_url TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'Pending', -- 'Pending', 'Approved', 'Rejected'
    rejection_reason TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_driver_docs_driver_id ON driver_documents(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_docs_status ON driver_documents(status);

-- 5. Routes (Driver Published Routes)
CREATE TABLE IF NOT EXISTS routes (
    id VARCHAR(64) PRIMARY KEY,
    driver_id VARCHAR(64) NOT NULL REFERENCES drivers(driver_id) ON DELETE CASCADE,
    driver_name VARCHAR(150) NOT NULL,
    driver_phone VARCHAR(30),
    start_name VARCHAR(200) NOT NULL,
    end_name VARCHAR(200) NOT NULL,
    start_lat NUMERIC(10, 7) NOT NULL,
    start_lon NUMERIC(10, 7) NOT NULL,
    end_lat NUMERIC(10, 7) NOT NULL,
    end_lon NUMERIC(10, 7) NOT NULL,
    fare NUMERIC(10, 2) NOT NULL DEFAULT 3000,
    available_seats INT NOT NULL DEFAULT 4,
    total_seats INT NOT NULL DEFAULT 4,
    departure_time VARCHAR(50),
    status VARCHAR(30) NOT NULL DEFAULT 'Active', -- 'Active', 'Completed', 'Cancelled'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routes_driver_id ON routes(driver_id);
CREATE INDEX IF NOT EXISTS idx_routes_status ON routes(status);

-- 6. Bookings
CREATE TABLE IF NOT EXISTS bookings (
    id VARCHAR(64) PRIMARY KEY,
    route_id VARCHAR(64) REFERENCES routes(id) ON DELETE SET NULL,
    customer_id VARCHAR(64) NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    customer_name VARCHAR(150),
    driver_id VARCHAR(64) REFERENCES drivers(driver_id) ON DELETE CASCADE,
    driver_name VARCHAR(150),
    pickup_name VARCHAR(200),
    dropoff_name VARCHAR(200),
    pickup_lat NUMERIC(10, 7),
    pickup_lon NUMERIC(10, 7),
    dropoff_lat NUMERIC(10, 7),
    dropoff_lon NUMERIC(10, 7),
    total_fare NUMERIC(10, 2) NOT NULL DEFAULT 0,
    seats_booked INT NOT NULL DEFAULT 1,
    status VARCHAR(30) NOT NULL DEFAULT 'Pending', -- 'Pending', 'Confirmed', 'Completed', 'Cancelled'
    booking_date VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_customer_id ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_driver_id ON bookings(driver_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

-- 7. Complaints
CREATE TABLE IF NOT EXISTS complaints (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
    user_name VARCHAR(150),
    target_type VARCHAR(30),
    target_id VARCHAR(64),
    target_name VARCHAR(150),
    subject VARCHAR(200) NOT NULL,
    details TEXT NOT NULL,
    priority VARCHAR(20) DEFAULT 'Normal',
    status VARCHAR(30) NOT NULL DEFAULT 'Open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);

-- 8. System Settings
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value_json TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    action VARCHAR(100) NOT NULL,
    entity_name VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    new_values_json TEXT,
    ip_address VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- 10. Dynamic Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'General', -- 'DriverVerification', 'Booking', 'Complaint', 'System'
    is_read BOOLEAN NOT NULL DEFAULT false,
    reference_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
