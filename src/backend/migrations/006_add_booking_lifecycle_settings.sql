-- Migration: 006_add_booking_lifecycle_settings.sql
-- Description: Adds booking lifecycle constants to system_settings table and audit columns

INSERT INTO system_settings (key, value_json, description, updated_at)
VALUES 
    ('booking_max_pending_per_rider', '{"value": 3}', 'الحد الأقصى لطلبات الحجز المعلقة المتزامنة للراكب الواحد', NOW()),
    ('booking_expiry_hours', '{"value": 24}', 'المهلة الزمنية بالساعات لانتهاء صلاحية طلب الحجز المعلق تلقائياً', NOW()),
    ('booking_driver_reject_reasons', '["المقاعد مكتملة", "المسار غير متطابق", "الوقت غير مناسب", "أخرى"]', 'قائمة أسباب رفض الحجز المتاحة للكابتن', NOW())
ON CONFLICT (key) DO NOTHING;

ALTER TABLE bookings 
    ADD COLUMN IF NOT EXISTS rejection_reason text,
    ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
    ADD COLUMN IF NOT EXISTS declined_at timestamptz,
    ADD COLUMN IF NOT EXISTS expired_at timestamptz;
