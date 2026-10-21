-- Migration: 002_add_dispatch_and_reconciliation_constants.sql
-- Description: Adds system settings constants for dispatch, reconciliation, and speed limits

INSERT INTO system_settings (key, value_json, description, updated_at)
VALUES 
('dispatch_constants', '{"proximity_radius_meters": 1000, "step_timeout_seconds": 20, "speed_jump_limit_kmh": 140}', 'ثوابت التوزيع والاقتراب وحدود السرعة لدورة الرحلة', NOW()),
('reconciliation_constants', '{"fare_discrepancy_threshold_iqd": 500, "fare_rounding_multiple_iqd": 250, "cancellation_fee_iqd": 1500}', 'ثوابت المطابقة المالية ورسوم الإلغاء والتقريب المالي', NOW()),
('proximity_radius_meters', '{"value": 1000}', 'نصف قطر اقتراب الكابتن من موقع الانطلاق بالمتر', NOW()),
('step_timeout_seconds', '{"value": 20}', 'مهلة عرض الرحلة للكابتن قبل الانتقال للمرشح التالي بالثواني', NOW()),
('speed_jump_limit_kmh', '{"value": 140}', 'الحد الأقصى للسرعة المسموحة بين نقطتي موقع متتاليتين كم/ساعة', NOW()),
('fare_discrepancy_threshold_iqd', '{"value": 500}', 'حد فرق الكروة المسموح قبل تحويل المشوار للمراجعة الإدارية د.ع', NOW()),
('fare_rounding_multiple_iqd', '{"value": 250}', 'معامل تقريب الأجرة لأقرب مضاعف د.ع', NOW()),
('cancellation_fee_iqd', '{"value": 1500}', 'رسوم إلغاء الرحلة بعد مرور المهلة أو وصول الكابتن د.ع')
ON CONFLICT (key) DO NOTHING;
