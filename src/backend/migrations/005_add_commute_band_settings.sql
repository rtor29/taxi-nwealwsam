-- Migration: 005_add_commute_band_settings.sql
-- Description: Adds commute distance bands and max results constants to system_settings table

INSERT INTO system_settings (key, value_json, description, updated_at)
VALUES 
    ('commute_band_green_m', '{"value": 500}', 'نطاق المسافة القريبة الأخضر لكباتن الخط الدائم بالمتر', NOW()),
    ('commute_band_purple_m', '{"value": 1000}', 'نطاق المسافة المتوسطة البنفسجي لكباتن الخط الدائم بالمتر', NOW()),
    ('commute_max_results', '{"value": 100}', 'الحد الأقصى لعدد كباتن الخط الدائم المعروضين للراكب', NOW())
ON CONFLICT (key) DO NOTHING;
