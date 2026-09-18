-- =============================================================================
-- Migration: 20260917000004_seed_data.sql
-- Description: Default System Settings & Initial Configuration for Taxi-Wisam
-- =============================================================================

INSERT INTO public.system_settings (key, value, description)
VALUES 
    ('matching_settings', '{"max_detour_meters": 1500, "min_overlap_percentage": 60.0, "time_window_minutes": 30, "search_radius_meters": 5000}'::jsonb, 'Parameters governing route matching and nearby search'),
    ('pricing_settings', '{"base_fare_iqd": 3000, "per_km_rate_iqd": 500, "per_minute_rate_iqd": 100, "surge_multiplier_max": 2.5}'::jsonb, 'Fare calculation rules for short and regular trips'),
    ('cancellation_policy', '{"free_cancellation_window_minutes": 5, "penalty_percentage": 25.0}'::jsonb, 'Trip cancellation penalties and grace periods'),
    ('support_contacts', '{"phone": "+9647700000000", "email": "support@taxi-wisam.iq", "whatsapp": "+9647800000000"}'::jsonb, 'Official support contact details')
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = NOW();
