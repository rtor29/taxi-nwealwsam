-- =============================================================================
-- Migration: 20260917000003_storage_buckets.sql
-- Description: Supabase Storage Buckets and Row Level Security (RLS) Policies
-- Buckets: driver-documents (PRIVATE), complaint-attachments (PRIVATE),
--          vehicle-photos (PUBLIC), user-avatars (PUBLIC)
-- =============================================================================

-- Insert storage buckets if they do not exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
    (
        'driver-documents',
        'driver-documents',
        false, -- Strictly PRIVATE
        10485760, -- 10MB limit
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    ),
    (
        'complaint-attachments',
        'complaint-attachments',
        false, -- Strictly PRIVATE
        10485760, -- 10MB limit
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf']
    ),
    (
        'vehicle-photos',
        'vehicle-photos',
        true, -- Public for viewing vehicle images in app
        5242880, -- 5MB limit
        ARRAY['image/jpeg', 'image/png', 'image/webp']
    ),
    (
        'user-avatars',
        'user-avatars',
        true, -- Public for viewing profile pictures
        5242880, -- 5MB limit
        ARRAY['image/jpeg', 'image/png', 'image/webp']
    )
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- Storage Policies: driver-documents (STRICT PRIVATE)
-- Public access is forbidden. Only Service Role or Authorized Admin can read.
-- -----------------------------------------------------------------------------
CREATE POLICY "driver_docs_service_role_all"
ON storage.objects
FOR ALL
TO service_role
USING (bucket_id = 'driver-documents')
WITH CHECK (bucket_id = 'driver-documents');

-- -----------------------------------------------------------------------------
-- Storage Policies: complaint-attachments (STRICT PRIVATE)
-- -----------------------------------------------------------------------------
CREATE POLICY "complaint_service_role_all"
ON storage.objects
FOR ALL
TO service_role
USING (bucket_id = 'complaint-attachments')
WITH CHECK (bucket_id = 'complaint-attachments');

-- -----------------------------------------------------------------------------
-- Storage Policies: vehicle-photos (PUBLIC READ)
-- -----------------------------------------------------------------------------
CREATE POLICY "vehicle_photos_public_read"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'vehicle-photos');

CREATE POLICY "vehicle_photos_service_role_all"
ON storage.objects
FOR ALL
TO service_role
USING (bucket_id = 'vehicle-photos')
WITH CHECK (bucket_id = 'vehicle-photos');

-- -----------------------------------------------------------------------------
-- Storage Policies: user-avatars (PUBLIC READ)
-- -----------------------------------------------------------------------------
CREATE POLICY "user_avatars_public_read"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'user-avatars');

CREATE POLICY "user_avatars_service_role_all"
ON storage.objects
FOR ALL
TO service_role
USING (bucket_id = 'user-avatars')
WITH CHECK (bucket_id = 'user-avatars');
