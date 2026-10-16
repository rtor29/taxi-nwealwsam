-- =============================================================================
-- Migration: 20261017000001_row_level_security.sql
-- Description: Comprehensive Row Level Security (RLS) for Taxi-Wisam Platform
-- Guarantees that each user can ONLY access and see their own data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. USERS TABLE RLS
-- -----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_select_own" ON public.users;
CREATE POLICY "users_select_own"
ON public.users FOR SELECT
TO authenticated
USING (
    id = auth.uid() 
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "users_update_own" ON public.users;
CREATE POLICY "users_update_own"
ON public.users FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "users_service_role_all" ON public.users;
CREATE POLICY "users_service_role_all"
ON public.users FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 2. CUSTOMERS TABLE RLS
-- -----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customers_select_own" ON public.customers;
CREATE POLICY "customers_select_own"
ON public.customers FOR SELECT
TO authenticated
USING (
    id = auth.uid() 
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "customers_update_own" ON public.customers;
CREATE POLICY "customers_update_own"
ON public.customers FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "customers_service_role_all" ON public.customers;
CREATE POLICY "customers_service_role_all"
ON public.customers FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 3. DRIVERS TABLE RLS
-- -----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.drivers ENABLE ROW LEVEL SECURITY;

-- Drivers can see their full own row, and passengers can only see active/online drivers for hailing
DROP POLICY IF EXISTS "drivers_select_policy" ON public.drivers;
CREATE POLICY "drivers_select_policy"
ON public.drivers FOR SELECT
TO authenticated
USING (
    id = auth.uid() 
    OR status IN ('Online', 'Approved', 'Active')
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "drivers_update_own" ON public.drivers;
CREATE POLICY "drivers_update_own"
ON public.drivers FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "drivers_service_role_all" ON public.drivers;
CREATE POLICY "drivers_service_role_all"
ON public.drivers FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 4. BOOKINGS TABLE RLS (STRICT USER ISOLATION)
-- -----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.bookings ENABLE ROW LEVEL SECURITY;

-- Passengers see ONLY their bookings, Drivers see ONLY their assigned bookings
DROP POLICY IF EXISTS "bookings_select_own" ON public.bookings;
CREATE POLICY "bookings_select_own"
ON public.bookings FOR SELECT
TO authenticated
USING (
    customer_id = auth.uid()
    OR driver_id = auth.uid()
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "bookings_insert_own" ON public.bookings;
CREATE POLICY "bookings_insert_own"
ON public.bookings FOR INSERT
TO authenticated
WITH CHECK (
    customer_id = auth.uid()
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "bookings_update_participants" ON public.bookings;
CREATE POLICY "bookings_update_participants"
ON public.bookings FOR UPDATE
TO authenticated
USING (
    customer_id = auth.uid()
    OR driver_id = auth.uid()
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
)
WITH CHECK (
    customer_id = auth.uid()
    OR driver_id = auth.uid()
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "bookings_service_role_all" ON public.bookings;
CREATE POLICY "bookings_service_role_all"
ON public.bookings FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 5. RIDE REQUESTS TABLE RLS
-- -----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.ride_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ride_requests_select_policy" ON public.ride_requests;
CREATE POLICY "ride_requests_select_policy"
ON public.ride_requests FOR SELECT
TO authenticated
USING (
    customer_id = auth.uid()
    OR assigned_driver_id = auth.uid()
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "ride_requests_insert_own" ON public.ride_requests;
CREATE POLICY "ride_requests_insert_own"
ON public.ride_requests FOR INSERT
TO authenticated
WITH CHECK (customer_id = auth.uid());

DROP POLICY IF EXISTS "ride_requests_update_policy" ON public.ride_requests;
CREATE POLICY "ride_requests_update_policy"
ON public.ride_requests FOR UPDATE
TO authenticated
USING (
    customer_id = auth.uid()
    OR assigned_driver_id = auth.uid()
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "ride_requests_service_role_all" ON public.ride_requests;
CREATE POLICY "ride_requests_service_role_all"
ON public.ride_requests FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 6. CHAT MESSAGES TABLE RLS
-- -----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chat_messages_select_policy" ON public.chat_messages;
CREATE POLICY "chat_messages_select_policy"
ON public.chat_messages FOR SELECT
TO authenticated
USING (
    sender_id = auth.uid()
    OR recipient_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM public.ride_requests rr 
        WHERE rr.id = request_id 
          AND (rr.customer_id = auth.uid() OR rr.assigned_driver_id = auth.uid())
    )
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "chat_messages_insert_policy" ON public.chat_messages;
CREATE POLICY "chat_messages_insert_policy"
ON public.chat_messages FOR INSERT
TO authenticated
WITH CHECK (
    sender_id = auth.uid()
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "chat_messages_service_role_all" ON public.chat_messages;
CREATE POLICY "chat_messages_service_role_all"
ON public.chat_messages FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 7. DRIVER DOCUMENTS TABLE RLS
-- -----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.driver_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "driver_docs_select_own" ON public.driver_documents;
CREATE POLICY "driver_docs_select_own"
ON public.driver_documents FOR SELECT
TO authenticated
USING (
    driver_id = auth.uid()
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "driver_docs_insert_own" ON public.driver_documents;
CREATE POLICY "driver_docs_insert_own"
ON public.driver_documents FOR INSERT
TO authenticated
WITH CHECK (driver_id = auth.uid());

DROP POLICY IF EXISTS "driver_docs_service_role_all" ON public.driver_documents;
CREATE POLICY "driver_docs_service_role_all"
ON public.driver_documents FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 8. COMPLAINTS TABLE RLS
-- -----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.complaints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "complaints_select_own" ON public.complaints;
CREATE POLICY "complaints_select_own"
ON public.complaints FOR SELECT
TO authenticated
USING (
    user_id = auth.uid()
    OR (SELECT role FROM public.users WHERE id = auth.uid()) = 'Admin'
);

DROP POLICY IF EXISTS "complaints_insert_own" ON public.complaints;
CREATE POLICY "complaints_insert_own"
ON public.complaints FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "complaints_service_role_all" ON public.complaints;
CREATE POLICY "complaints_service_role_all"
ON public.complaints FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
