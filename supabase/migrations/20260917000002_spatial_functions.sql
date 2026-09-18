-- =============================================================================
-- Migration: 20260917000002_spatial_functions.sql
-- Description: PostGIS Spatial Functions for Taxi-Wisam Platform
-- Features: Nearby Drivers, Route Overlap, Proximity Matching, Detour Calculations
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Find Nearby Online Drivers within a specified radius (in meters)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_find_nearby_drivers(
    p_lat DOUBLE PRECISION,
    p_lon DOUBLE PRECISION,
    p_radius_meters DOUBLE PRECISION DEFAULT 5000.0,
    p_limit INT DEFAULT 20
)
RETURNS TABLE (
    driver_id UUID,
    full_name VARCHAR,
    phone_number VARCHAR,
    rating_average NUMERIC,
    distance_meters DOUBLE PRECISION,
    current_heading NUMERIC,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        d.id AS driver_id,
        u.full_name,
        u.phone_number,
        d.rating_average,
        ST_Distance(
            d.current_location::geography,
            ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography
        ) AS distance_meters,
        d.current_heading,
        ST_Y(d.current_location::geometry) AS latitude,
        ST_X(d.current_location::geometry) AS longitude
    FROM public.drivers d
    JOIN public.users u ON u.id = d.id
    WHERE d.status = 'Online'
      AND d.is_verified = true
      AND d.current_location IS NOT NULL
      AND ST_DWithin(
          d.current_location::geography,
          ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
          p_radius_meters
      )
    ORDER BY distance_meters ASC
    LIMIT p_limit;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Calculate Route Overlap Percentage and Shared Distance between two LineStrings
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_calculate_route_overlap(
    p_route_a GEOMETRY(LineString, 4326),
    p_route_b GEOMETRY(LineString, 4326),
    p_buffer_meters DOUBLE PRECISION DEFAULT 200.0
)
RETURNS TABLE (
    overlap_length_meters DOUBLE PRECISION,
    overlap_percentage_a DOUBLE PRECISION,
    overlap_percentage_b DOUBLE PRECISION
)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_buf_a GEOMETRY;
    v_buf_b GEOMETRY;
    v_intersection GEOMETRY;
    v_len_a DOUBLE PRECISION;
    v_len_b DOUBLE PRECISION;
    v_overlap_len DOUBLE PRECISION := 0.0;
BEGIN
    -- Lengths in meters
    v_len_a := ST_Length(p_route_a::geography);
    v_len_b := ST_Length(p_route_b::geography);

    IF v_len_a = 0 OR v_len_b = 0 THEN
        RETURN QUERY SELECT 0.0::DOUBLE PRECISION, 0.0::DOUBLE PRECISION, 0.0::DOUBLE PRECISION;
        RETURN;
    END IF;

    -- Buffer Route A and intersect with Route B
    v_buf_a := ST_Buffer(p_route_a::geography, p_buffer_meters)::geometry;
    v_intersection := ST_Intersection(p_route_b, v_buf_a);

    IF ST_IsEmpty(v_intersection) THEN
        v_overlap_len := 0.0;
    ELSE
        v_overlap_len := ST_Length(v_intersection::geography);
    END IF;

    RETURN QUERY SELECT 
        v_overlap_len,
        ROUND((LEAST(v_overlap_len / v_len_a, 1.0) * 100.0)::NUMERIC, 2)::DOUBLE PRECISION,
        ROUND((LEAST(v_overlap_len / v_len_b, 1.0) * 100.0)::NUMERIC, 2)::DOUBLE PRECISION;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Check if pickup & dropoff points are within corridor of a Driver's Route
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_is_point_along_route(
    p_pickup_point GEOMETRY(Point, 4326),
    p_dropoff_point GEOMETRY(Point, 4326),
    p_route_geometry GEOMETRY(LineString, 4326),
    p_buffer_meters DOUBLE PRECISION DEFAULT 1000.0
)
RETURNS TABLE (
    is_along_route BOOLEAN,
    pickup_distance_meters DOUBLE PRECISION,
    dropoff_distance_meters DOUBLE PRECISION,
    pickup_loc_fraction DOUBLE PRECISION,
    dropoff_loc_fraction DOUBLE PRECISION
)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_pickup_dist DOUBLE PRECISION;
    v_dropoff_dist DOUBLE PRECISION;
    v_pickup_fraction DOUBLE PRECISION;
    v_dropoff_fraction DOUBLE PRECISION;
    v_valid_direction BOOLEAN;
BEGIN
    -- Distance from route line to points in meters
    v_pickup_dist := ST_Distance(p_route_geometry::geography, p_pickup_point::geography);
    v_dropoff_dist := ST_Distance(p_route_geometry::geography, p_dropoff_point::geography);

    -- Relative location along line (0.0 = start, 1.0 = end)
    v_pickup_fraction := ST_LineLocatePoint(p_route_geometry, p_pickup_point);
    v_dropoff_fraction := ST_LineLocatePoint(p_route_geometry, p_dropoff_point);

    -- Pickup must occur before dropoff along the driver's route
    v_valid_direction := (v_dropoff_fraction > v_pickup_fraction);

    RETURN QUERY SELECT
        (v_pickup_dist <= p_buffer_meters AND v_dropoff_dist <= p_buffer_meters AND v_valid_direction),
        v_pickup_dist,
        v_dropoff_dist,
        v_pickup_fraction,
        v_dropoff_fraction;
END;
$$;
