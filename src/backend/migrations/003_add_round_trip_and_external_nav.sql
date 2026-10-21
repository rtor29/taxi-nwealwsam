-- Migration: 003_add_round_trip_and_external_nav.sql
-- Description: Adds round trip fields, leg tracking, waiting fees, and external nav constants

ALTER TABLE rides
ADD COLUMN IF NOT EXISTS trip_type VARCHAR(20) DEFAULT 'ONE_WAY',
ADD COLUMN IF NOT EXISTS expected_wait_minutes INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS actual_wait_minutes INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS return_destination JSONB,
ADD COLUMN IF NOT EXISTS leg1_distance NUMERIC(8,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS leg1_duration NUMERIC(8,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS leg2_distance NUMERIC(8,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS leg2_duration NUMERIC(8,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS wait_fee NUMERIC(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS wait_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS return_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS return_arrived_at TIMESTAMPTZ;

-- System Settings additions for round trip, waiting time, and external navigation
INSERT INTO system_settings (key, value_json, description, updated_at)
VALUES 
('minute_wait_rate_iqd', '{"value": 100}', 'تعرفة دقيقة الانتظار لمشاوير الذهاب والإياب د.ع', NOW()),
('free_wait_minutes', '{"value": 5}', 'دقائق الانتظار المجانية في موقع الوجهة الأولى لمشاوير الذهاب والإياب', NOW()),
('max_wait_minutes', '{"value": 60}', 'الحد الأقصى لدقائق الانتظار المسموح بها في الوجهة الأولى', NOW()),
('round_trip_discount_percent', '{"value": 0}', 'نسبة الخصم المئوية على رحلة العودة في مشاوير الذهاب والإياب', NOW()),
('external_nav_timeout_minutes', '{"value": 15}', 'الحد الأقصى لمهلة الملاحة الخارجية قبل استئناف احتساب نبضات الاتصال بالدقائق', NOW())
ON CONFLICT (key) DO NOTHING;
