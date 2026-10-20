const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('../config');

class DatabaseManager {
    constructor() {
        this.pool = null;
        this.isPostgresConnected = false;
        this.schemaPath = path.join(__dirname, 'schema.sql');
        this._saveTimer = null;
        this._isSaving = false;
        this._pendingSave = false;

        // O(1) Fast Hash Index Maps for instant lookup among 10,000+ users
        this.indexes = {
            customersById: new Map(),
            customersByPhone: new Map(),
            driversById: new Map(),
            driversByPhone: new Map(),
            bookingsById: new Map(),
            rideRequestsById: new Map()
        };

        this.initMemoryState();

        // Auto-prune stale logs/messages once every hour to prevent heap bloat
        setInterval(() => {
            this.pruneOldMemoryState();
        }, 3600000);
    }

    _cleanPhone(phone) {
        if (!phone) return '';
        return String(phone).replace(/[^0-9]/g, '');
    }

    rebuildIndexes() {
        this.indexes.customersById.clear();
        this.indexes.customersByPhone.clear();
        for (const c of (this.memoryState.customers || [])) {
            if (c.customerId) this.indexes.customersById.set(c.customerId, c);
            if (c.id) this.indexes.customersById.set(c.id, c);
            if (c.userId) this.indexes.customersById.set(c.userId, c);
            const p = this._cleanPhone(c.phoneNumber || c.phone);
            if (p) this.indexes.customersByPhone.set(p, c);
        }

        this.indexes.driversById.clear();
        this.indexes.driversByPhone.clear();
        for (const d of (this.memoryState.drivers || [])) {
            if (d.driverId) this.indexes.driversById.set(d.driverId, d);
            if (d.id) this.indexes.driversById.set(d.id, d);
            const p = this._cleanPhone(d.phoneNumber || d.phone);
            if (p) this.indexes.driversByPhone.set(p, d);
        }

        this.indexes.bookingsById.clear();
        for (const b of (this.memoryState.bookings || [])) {
            if (b.id) this.indexes.bookingsById.set(b.id, b);
            if (b.bookingId) this.indexes.bookingsById.set(b.bookingId, b);
        }

        this.indexes.rideRequestsById.clear();
        for (const r of (this.memoryState.rideRequests || [])) {
            if (r.id) this.indexes.rideRequestsById.set(r.id, r);
        }
    }

    findCustomer(idOrPhone) {
        if (!idOrPhone) return null;
        const byId = this.indexes.customersById.get(idOrPhone);
        if (byId) return byId;
        const cleanP = this._cleanPhone(idOrPhone);
        if (cleanP) {
            const byPhone = this.indexes.customersByPhone.get(cleanP);
            if (byPhone) return byPhone;
        }
        return (this.memoryState.customers || []).find(c => 
            c.customerId === idOrPhone || 
            c.id === idOrPhone || 
            c.userId === idOrPhone ||
            (cleanP && this._cleanPhone(c.phoneNumber) === cleanP)
        ) || null;
    }

    findDriver(idOrPhone) {
        if (!idOrPhone) return null;
        const byId = this.indexes.driversById.get(idOrPhone);
        if (byId) return byId;
        const cleanP = this._cleanPhone(idOrPhone);
        if (cleanP) {
            const byPhone = this.indexes.driversByPhone.get(cleanP);
            if (byPhone) return byPhone;
        }
        return (this.memoryState.drivers || []).find(d => 
            d.driverId === idOrPhone || 
            d.id === idOrPhone || 
            (cleanP && this._cleanPhone(d.phoneNumber) === cleanP)
        ) || null;
    }

    indexCustomer(customer) {
        if (!customer) return;
        if (customer.customerId) this.indexes.customersById.set(customer.customerId, customer);
        if (customer.id) this.indexes.customersById.set(customer.id, customer);
        if (customer.userId) this.indexes.customersById.set(customer.userId, customer);
        const p = this._cleanPhone(customer.phoneNumber || customer.phone);
        if (p) this.indexes.customersByPhone.set(p, customer);
    }

    indexDriver(driver) {
        if (!driver) return;
        if (driver.driverId) this.indexes.driversById.set(driver.driverId, driver);
        if (driver.id) this.indexes.driversById.set(driver.id, driver);
        const p = this._cleanPhone(driver.phoneNumber || driver.phone);
        if (p) this.indexes.driversByPhone.set(p, driver);
    }

    pruneOldMemoryState() {
        const now = Date.now();
        const twoDaysAgo = now - 48 * 3600 * 1000;
        const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;

        // Prune old chat messages to keep RAM lean
        if (this.memoryState.chatMessages && this.memoryState.chatMessages.length > 5000) {
            this.memoryState.chatMessages = this.memoryState.chatMessages.filter(m => {
                const ts = new Date(m.createdAt || m.timestamp || 0).getTime();
                return ts > twoDaysAgo;
            });
            if (this.memoryState.chatMessages.length > 5000) {
                this.memoryState.chatMessages = this.memoryState.chatMessages.slice(-5000);
            }
        }

        // Prune old completed/cancelled ride requests
        if (this.memoryState.rideRequests && this.memoryState.rideRequests.length > 5000) {
            this.memoryState.rideRequests = this.memoryState.rideRequests.filter(r => {
                if (r.status === 'InProgress' || r.status === 'Accepted' || r.status === 'Arrived' || r.status === 'Pending') {
                    return true;
                }
                const ts = new Date(r.createdAt || 0).getTime();
                return ts > sevenDaysAgo;
            });
        }
    }

    initMemoryState() {
        this.memoryState = {
            drivers: [],
            customers: [],
            verifications: [],
            routes: [],
            bookings: [],
            complaints: [],
            settings: [
                {
                    key: "city_coverage",
                    valueJson: JSON.stringify({ province: "النجف الأشرف", centerLat: 31.9961, centerLon: 44.3168, allowedAreas: ["المركز", "الكوفة", "المشخاب", "الحيدرية", "المناذرة"] }),
                    description: "نطاق تغطية الخدمة المعتمد"
                },
                {
                    key: "matching_settings",
                    valueJson: JSON.stringify({ max_detour_meters: 2000, min_overlap_percentage: 60, search_radius_meters: 5000, time_window_minutes: 30 }),
                    description: "معايير محرك المطابقة الجغرافي بالنجف"
                },
                {
                    key: "pricing_settings",
                    valueJson: JSON.stringify({ base_fare_iqd: 1000, per_km_rate_iqd: 500, per_minute_rate_iqd: 100, min_fare_iqd: 3000, cancellation_fee_iqd: 1500, surge_multiplier_max: 2.0 }),
                    description: "تسعيرة بلي القياسية في العراق (الوضع الافتراضي)"
                }
            ],
            auditLogs: [],
            notifications: [],
            cancellationRequests: [],
            tripRatings: []
        };

        // Load existing state.json if present to guarantee ZERO DATA LOSS
        try {
            if (fs.existsSync(config.dataFile)) {
                const raw = fs.readFileSync(config.dataFile, 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed.drivers) this.memoryState.drivers = parsed.drivers;
                if (parsed.customers) this.memoryState.customers = parsed.customers;
                if (parsed.verifications) this.memoryState.verifications = parsed.verifications;
                if (parsed.routes) this.memoryState.routes = parsed.routes;
                if (parsed.bookings && Array.isArray(parsed.bookings)) {
                    const seen = new Set();
                    const deduplicated = [];
                    for (const b of parsed.bookings) {
                        if (b.status === 'Cancelled' || b.status === 'Rejected') {
                            deduplicated.push(b);
                            continue;
                        }
                        const routeKey = b.routeId || b.driverId || 'general';
                        const custId = b.customerId || b.passengerId || '';
                        const phone = String(b.customerPhone || b.phone || '').replace(/[^0-9]/g, '');
                        const custKey = custId || (phone.length >= 7 ? phone.slice(-8) : '');
                        const key = custKey ? `${routeKey}__${custKey}` : (b.id || b.bookingId);
                        if (!seen.has(key)) {
                            seen.add(key);
                            deduplicated.push(b);
                        }
                    }
                    this.memoryState.bookings = deduplicated;
                }
                if (parsed.complaints) this.memoryState.complaints = parsed.complaints;
                if (parsed.settings) this.memoryState.settings = parsed.settings;
                if (parsed.auditLogs) this.memoryState.auditLogs = parsed.auditLogs;
                if (parsed.notifications) this.memoryState.notifications = parsed.notifications;
                if (parsed.cancellationRequests) this.memoryState.cancellationRequests = parsed.cancellationRequests;
                if (parsed.tripRatings) this.memoryState.tripRatings = parsed.tripRatings;
                if (parsed.rideRequests) this.memoryState.rideRequests = parsed.rideRequests;
                if (parsed.banners) this.memoryState.banners = parsed.banners;
                if (parsed.appConfig) this.memoryState.appConfig = parsed.appConfig;
                console.log(`[Database] Loaded ${this.memoryState.drivers.length} drivers, ${this.memoryState.customers.length} customers, ${(this.memoryState.tripRatings || []).length} trip ratings from state snapshot`);
            }
        } catch (e) {
            console.warn(`[Database] Error reading state snapshot: ${e.message}`);
        }
        // Initialize fast index maps
        this.rebuildIndexes();
    }

    // High-performance, non-blocking asynchronous state snapshot with debouncing & atomic write
    saveStateSnapshot(immediate = false) {
        if (immediate) {
            this._doSaveSnapshotSync();
            return;
        }

        // Debounce: batch rapid mutations into a single background write
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(async () => {
            this._saveTimer = null;
            await this._doSaveSnapshotAsync();
        }, 350);
    }

    async _doSaveSnapshotAsync() {
        if (this._isSaving) {
            this._pendingSave = true;
            return;
        }
        this._isSaving = true;
        try {
            const dataDir = path.dirname(config.dataFile);
            await fs.promises.mkdir(dataDir, { recursive: true });

            const snapshot = {
                ...this.memoryState,
                stats: this.getComputedStats()
            };
            const tempFile = config.dataFile + '.tmp';
            const jsonStr = JSON.stringify(snapshot, null, 2);
            await fs.promises.writeFile(tempFile, jsonStr, 'utf8');
            await fs.promises.rename(tempFile, config.dataFile);
        } catch (e) {
            console.warn(`[Database] Async snapshot save warning: ${e.message}`);
        } finally {
            this._isSaving = false;
            if (this._pendingSave) {
                this._pendingSave = false;
                this.saveStateSnapshot();
            }
        }
    }

    _doSaveSnapshotSync() {
        try {
            const dataDir = path.dirname(config.dataFile);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            const snapshot = {
                ...this.memoryState,
                stats: this.getComputedStats()
            };
            const tempFile = config.dataFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2), 'utf8');
            fs.renameSync(tempFile, config.dataFile);
        } catch (e) {
            console.warn(`[Database] Sync snapshot save warning: ${e.message}`);
        }
    }

    async init() {
        try {
            const connectionString = process.env.DATABASE_URL || `postgresql://${config.pg.user}:${config.pg.password}@${config.pg.host}:${config.pg.port}/${config.pg.database}`;
            this.pool = new Pool({
                connectionString,
                max: Number(process.env.PG_POOL_MAX) || config.pg?.max || 25,
                connectionTimeoutMillis: 3000,
                idleTimeoutMillis: 10000
            });

            // Test connection
            const client = await this.pool.connect();
            console.log('[Database] Connected to PostgreSQL successfully! 🐘');
            this.isPostgresConnected = true;

            // Execute schema.sql to ensure tables exist
            if (fs.existsSync(this.schemaPath)) {
                const schemaSql = fs.readFileSync(this.schemaPath, 'utf8');
                await client.query(schemaSql);
                console.log('[Database] PostgreSQL schema verified with ON DELETE CASCADE and indexes');
            }

            // Ensure plain_password columns exist for existing databases
            try {
                await client.query(`
                    ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT;
                    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS plain_password TEXT;
                    ALTER TABLE customers ADD COLUMN IF NOT EXISTS plain_password TEXT;
                    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT false;
                    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS work_mode VARCHAR(50) DEFAULT 'مشوار قصير';
                    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS points INT DEFAULT 0;
                    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(64);
                    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(100);
                    ALTER TABLE drivers ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ;
                    ALTER TABLE customers ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(64);
                    ALTER TABLE customers ADD COLUMN IF NOT EXISTS telegram_username VARCHAR(100);
                    ALTER TABLE customers ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ;
                    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS driver_phone VARCHAR(50);
                    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50);
                    CREATE INDEX IF NOT EXISTS idx_drivers_telegram_chat ON drivers(telegram_chat_id);
                    CREATE INDEX IF NOT EXISTS idx_customers_telegram_chat ON customers(telegram_chat_id);
                    CREATE TABLE IF NOT EXISTS trip_ratings (
                        id SERIAL PRIMARY KEY,
                        ride_id VARCHAR(100),
                        driver_id VARCHAR(100),
                        passenger_id VARCHAR(100),
                        passenger_name VARCHAR(150),
                        rating INT DEFAULT 5,
                        tags JSONB DEFAULT '[]'::jsonb,
                        comment TEXT,
                        points_earned INT DEFAULT 50,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS idx_trip_ratings_driver ON trip_ratings(driver_id);
                    CREATE INDEX IF NOT EXISTS idx_trip_ratings_ride ON trip_ratings(ride_id);

                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS complainant_id VARCHAR(64);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS complainant_name VARCHAR(150);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS complainant_phone VARCHAR(50);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS accused_id VARCHAR(64);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS accused_name VARCHAR(150);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS accused_phone VARCHAR(50);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS category VARCHAR(100);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS complaint_text TEXT;
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS admin_notes TEXT;
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS action_taken VARCHAR(100);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS ride_id VARCHAR(64);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS user_name VARCHAR(150);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS target_id VARCHAR(64);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS target_name VARCHAR(150);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS subject VARCHAR(200);
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS details TEXT;
                    ALTER TABLE complaints ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'Normal';
                    ALTER TABLE complaints DROP CONSTRAINT IF EXISTS complaints_user_id_fkey;
                    ALTER TABLE complaints ALTER COLUMN user_id DROP NOT NULL;
                    ALTER TABLE complaints ALTER COLUMN description DROP NOT NULL;
                    ALTER TABLE complaints ALTER COLUMN id TYPE VARCHAR(64);
                    CREATE INDEX IF NOT EXISTS idx_complaints_category ON complaints(category);
                    CREATE INDEX IF NOT EXISTS idx_complaints_complainant ON complaints(complainant_phone);
                    CREATE INDEX IF NOT EXISTS idx_complaints_accused ON complaints(accused_phone);
                `);
            } catch (_) {}

            // Check if we need to migrate/seed data from memoryState
            const userCountRes = await client.query('SELECT count(*) FROM users');
            const userCount = parseInt(userCountRes.rows[0].count, 10);
            if (userCount === 0 && (this.memoryState.drivers.length > 0 || this.memoryState.customers.length > 0)) {
                console.log('[Database] Initializing PostgreSQL tables with existing state records...');
                await this.migrateMemoryToPostgres(client);
            } else if (userCount > 0) {
                console.log(`[Database] PostgreSQL contains ${userCount} existing users. Syncing to memory snapshot...`);
                await this.syncPostgresToMemory(client);
            }

            client.release();
        } catch (err) {
            console.warn(`[Database] PostgreSQL connection failed (${err.message}). Using high-performance JSON persistence layer.`);
            this.isPostgresConnected = false;
        }

        // Clean any leftover orphan verifications in memory on boot
        this.cleanOrphanRecords();
    }

    cleanOrphanRecords() {
        const driverIds = new Set(this.memoryState.drivers.map(d => d.driverId));
        const customerIds = new Set(this.memoryState.customers.map(c => c.customerId));

        // Purge verifications for drivers that do not exist
        const initialVerifs = this.memoryState.verifications.length;
        this.memoryState.verifications = this.memoryState.verifications.filter(v => driverIds.has(v.driverId));
        if (this.memoryState.verifications.length !== initialVerifs) {
            console.log(`[Database] Purged ${initialVerifs - this.memoryState.verifications.length} orphan verifications`);
        }

        // Purge routes for drivers that do not exist
        this.memoryState.routes = this.memoryState.routes.filter(r => driverIds.has(r.driverId));

        // Purge bookings for non-existent users
        this.memoryState.bookings = this.memoryState.bookings.filter(b => 
            customerIds.has(b.customerId) || (b.driverId ? driverIds.has(b.driverId) : true)
        );

        this.saveStateSnapshot();
    }

    async migrateMemoryToPostgres(client) {
        try {
            await client.query('BEGIN');

            // 1. Drivers
            for (const d of this.memoryState.drivers) {
                await client.query(`
                    INSERT INTO users (id, phone_number, email, full_name, role, google_id, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, 'Driver', $5, $6, $7, $8)
                    ON CONFLICT (id) DO NOTHING
                `, [d.driverId, d.phoneNumber, d.email || null, d.fullName, d.googleId || null, !d.isBlocked, !!d.isBlocked, d.createdAt || new Date().toISOString()]);

                await client.query(`
                    INSERT INTO drivers (driver_id, full_name, phone_number, email, google_id, license_number, status, is_verified, is_blocked, is_approved, work_mode, rating_average, total_trips, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                    ON CONFLICT (driver_id) DO NOTHING
                `, [
                    d.driverId, d.fullName, d.phoneNumber, d.email || null, d.googleId || null,
                    d.licenseNumber || 'IRQ-NJF-1000', d.status || 'Pending', !!d.isVerified,
                    !!d.isBlocked, !!d.isApproved, d.workMode || 'مشوار قصير', d.ratingAverage || 5.0, d.totalTrips || 0, d.createdAt || new Date().toISOString()
                ]);
            }

            // 2. Customers
            for (const c of this.memoryState.customers) {
                await client.query(`
                    INSERT INTO users (id, phone_number, email, full_name, role, password_hash, plain_password, google_id, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, 'Customer', $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash), plain_password = COALESCE(EXCLUDED.plain_password, users.plain_password)
                `, [c.customerId, c.phoneNumber, c.email || null, c.fullName, c.passwordHash || null, c.plainPassword || null, c.googleId || null, c.isActive !== false, !!c.isBlocked, c.registeredAt || new Date().toISOString()]);

                await client.query(`
                    INSERT INTO customers (customer_id, full_name, phone_number, email, route, address, plain_password, password_hash, google_id, preferred_payment_method, rating_average, total_bookings, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    ON CONFLICT (customer_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, route = COALESCE(EXCLUDED.route, customers.route), address = COALESCE(EXCLUDED.address, customers.address), plain_password = COALESCE(EXCLUDED.plain_password, customers.plain_password), password_hash = COALESCE(EXCLUDED.password_hash, customers.password_hash)
                `, [
                    c.customerId, c.fullName, c.phoneNumber, c.email || null, c.route || c.area || null, c.address || c.area || null, c.plainPassword || null, c.passwordHash || null, c.googleId || null,
                    c.preferredPaymentMethod || 'Cash', c.ratingAverage || 5.0, c.totalBookings || 0,
                    c.isActive !== false, !!c.isBlocked, c.registeredAt || new Date().toISOString()
                ]);
            }

            // 3. Verifications
            for (const v of this.memoryState.verifications) {
                // Ensure driver exists
                const dExists = this.memoryState.drivers.some(d => d.driverId === v.driverId);
                if (dExists) {
                    await client.query(`
                        INSERT INTO driver_documents (document_id, driver_id, document_type, file_path, file_url, status, submitted_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (document_id) DO NOTHING
                    `, [v.documentId, v.driverId, v.documentType || 'DrivingLicense', v.filePath || '', v.fileUrl || v.filePath || '', v.status || 'Pending', v.submittedAt || new Date().toISOString()]);
                }
            }

            // 4. Routes
            for (const r of this.memoryState.routes) {
                const dExists = this.memoryState.drivers.some(d => d.driverId === r.driverId);
                if (dExists) {
                    await client.query(`
                        INSERT INTO routes (id, driver_id, driver_name, driver_phone, start_name, end_name, start_lat, start_lon, end_lat, end_lon, fare, available_seats, total_seats, departure_time, status, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                        ON CONFLICT (id) DO NOTHING
                    `, [r.id || r.routeId, r.driverId, r.driverName, r.driverPhone || '', r.startName, r.endName, r.startLat, r.startLon, r.endLat, r.endLon, r.fare || 3000, r.availableSeats || 4, r.totalSeats || 4, r.departureTime || '', r.status || 'Active', r.createdAt || new Date().toISOString()]);
                }
            }

            await client.query('COMMIT');
            console.log('[Database] Initial migration to PostgreSQL completed successfully!');
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('[Database] Migration to PostgreSQL failed:', e);
        }
    }

    async syncPostgresToMemory(client) {
        try {
            const driversRes = await client.query('SELECT * FROM drivers ORDER BY created_at DESC');
            if (driversRes.rows && driversRes.rows.length > 0) {
                this.memoryState.drivers = driversRes.rows.map(r => ({
                    driverId: r.driver_id,
                    fullName: r.full_name,
                    phoneNumber: r.phone_number,
                    email: r.email,
                    plainPassword: r.plain_password || null,
                    passwordHash: r.password_hash || null,
                    googleId: r.google_id,
                    licenseNumber: r.license_number,
                    vehicleMake: r.vehicle_make,
                    vehicleModel: r.vehicle_model,
                    vehicleYear: r.vehicle_year,
                    vehiclePlate: r.vehicle_plate,
                    status: r.status,
                    isVerified: r.is_verified,
                    isBlocked: r.is_blocked,
                    isApproved: r.is_approved,
                    workMode: r.work_mode || 'مشوار قصير',
                    work_mode: r.work_mode || 'مشوار قصير',
                    workStatus: (r.work_mode === 'خط دائمي' ? 'permanent' : (r.status === 'Online' ? 'taxi' : 'idle')),
                    isOnline: r.status === 'Online' || r.status === 'Active',
                    latitude: r.latitude ? parseFloat(r.latitude) : 31.9961,
                    longitude: r.longitude ? parseFloat(r.longitude) : 44.3168,
                    heading: r.heading ? parseFloat(r.heading) : 0,
                    serviceType: r.service_type || 'Both',
                    rejectionReason: r.rejection_reason,
                    ratingAverage: parseFloat(r.rating_average || 5.0),
                    totalTrips: r.total_trips || 0,
                    points: parseInt(r.points || 0, 10),
                    rewardScore: parseInt(r.points || 0, 10),
                    permanentLat: r.permanent_lat ? parseFloat(r.permanent_lat) : null,
                    permanentLon: r.permanent_lon ? parseFloat(r.permanent_lon) : null,
                    permanentLocationName: r.permanent_location_name || '',
                    permanentDropoffLat: r.permanent_dropoff_lat ? parseFloat(r.permanent_dropoff_lat) : null,
                    permanentDropoffLon: r.permanent_dropoff_lon ? parseFloat(r.permanent_dropoff_lon) : null,
                    permanentDropoffName: r.permanent_dropoff_name || '',
                    telegramChatId: r.telegram_chat_id ? String(r.telegram_chat_id) : null,
                    createdAt: r.created_at
                }));
            }

            try {
                const ratingsRes = await client.query('SELECT * FROM trip_ratings ORDER BY created_at DESC LIMIT 500');
                if (ratingsRes.rows && ratingsRes.rows.length > 0) {
                    this.memoryState.tripRatings = ratingsRes.rows.map(r => ({
                        id: r.id,
                        rideId: r.ride_id,
                        driverId: r.driver_id,
                        passengerId: r.passenger_id,
                        passengerName: r.passenger_name || 'الراكب',
                        rating: parseInt(r.rating || 5, 10),
                        tags: r.tags || [],
                        comment: r.comment || '',
                        pointsEarned: parseInt(r.points_earned || 50, 10),
                        createdAt: r.created_at
                    }));
                }
            } catch (_) {}

            const customersRes = await client.query('SELECT * FROM customers ORDER BY created_at DESC');
            this.memoryState.customers = customersRes.rows.map(r => ({
                customerId: r.customer_id,
                fullName: r.full_name,
                phoneNumber: r.phone_number,
                email: r.email,
                route: r.route || 'النجف الأشرف',
                address: r.address || 'النجف الأشرف',
                plainPassword: r.plain_password || '',
                passwordHash: r.password_hash || '',
                googleId: r.google_id,
                preferredPaymentMethod: r.preferred_payment_method,
                ratingAverage: parseFloat(r.rating_average || 5.0),
                totalBookings: r.total_bookings || 0,
                isActive: r.is_active,
                isBlocked: r.is_blocked,
                permanentLat: r.permanent_lat ? parseFloat(r.permanent_lat) : null,
                permanentLon: r.permanent_lon ? parseFloat(r.permanent_lon) : null,
                permanentLocationName: r.permanent_location_name || '',
                permanentDropoffLat: r.permanent_dropoff_lat ? parseFloat(r.permanent_dropoff_lat) : null,
                permanentDropoffLon: r.permanent_dropoff_lon ? parseFloat(r.permanent_dropoff_lon) : null,
                permanentDropoffName: r.permanent_dropoff_name || '',
                telegramChatId: r.telegram_chat_id ? String(r.telegram_chat_id) : null,
                registeredAt: r.created_at
            }));

            // Merge JSON snapshot records not yet in PostgreSQL (Telegram-registered users etc.)
            try {
                const fs2 = require('fs');
                if (fs2.existsSync(config.dataFile)) {
                    const snap = JSON.parse(fs2.readFileSync(config.dataFile, 'utf8'));
                    const pgCustIds = new Set(this.memoryState.customers.map(c => c.customerId));
                    const pgDrvIds = new Set(this.memoryState.drivers.map(d => d.driverId));
                    if (snap.customers) {
                        for (const c of snap.customers) {
                            if (!pgCustIds.has(c.customerId)) {
                                this.memoryState.customers.unshift(c);
                                this.persistNewCustomer(c).catch(() => {});
                            } else {
                                const exist = this.memoryState.customers.find(x => x.customerId === c.customerId);
                                if (exist) {
                                    if (!exist.permanentLat && c.permanentLat) exist.permanentLat = c.permanentLat;
                                    if (!exist.permanentLon && c.permanentLon) exist.permanentLon = c.permanentLon;
                                    if (!exist.permanentLocationName && c.permanentLocationName) exist.permanentLocationName = c.permanentLocationName;
                                    if (!exist.permanentDropoffLat && c.permanentDropoffLat) exist.permanentDropoffLat = c.permanentDropoffLat;
                                    if (!exist.permanentDropoffLon && c.permanentDropoffLon) exist.permanentDropoffLon = c.permanentDropoffLon;
                                    if (!exist.permanentDropoffName && c.permanentDropoffName) exist.permanentDropoffName = c.permanentDropoffName;
                                    if (!exist.telegramChatId && c.telegramChatId) exist.telegramChatId = c.telegramChatId;
                                }
                            }
                        }
                    }
                    if (snap.drivers) {
                        for (const d of snap.drivers) {
                            if (!pgDrvIds.has(d.driverId)) {
                                this.memoryState.drivers.unshift(d);
                                this.persistNewDriver(d).catch(() => {});
                            } else {
                                const exist = this.memoryState.drivers.find(x => x.driverId === d.driverId);
                                if (exist) {
                                    if (!exist.permanentLat && d.permanentLat) exist.permanentLat = d.permanentLat;
                                    if (!exist.permanentLon && d.permanentLon) exist.permanentLon = d.permanentLon;
                                    if (!exist.permanentLocationName && d.permanentLocationName) exist.permanentLocationName = d.permanentLocationName;
                                    if (!exist.permanentDropoffLat && d.permanentDropoffLat) exist.permanentDropoffLat = d.permanentDropoffLat;
                                    if (!exist.permanentDropoffLon && d.permanentDropoffLon) exist.permanentDropoffLon = d.permanentDropoffLon;
                                    if (!exist.permanentDropoffName && d.permanentDropoffName) exist.permanentDropoffName = d.permanentDropoffName;
                                    if (!exist.telegramChatId && d.telegramChatId) exist.telegramChatId = d.telegramChatId;
                                }
                            }
                        }
                    }
                }
            } catch (_) {}

            const verifsRes = await client.query('SELECT * FROM driver_documents ORDER BY submitted_at DESC');
            this.memoryState.verifications = verifsRes.rows.map(r => ({
                documentId: r.document_id,
                driverId: r.driver_id,
                documentType: r.document_type,
                filePath: r.file_path,
                fileUrl: r.file_url,
                status: r.status,
                rejectionReason: r.rejection_reason,
                submittedAt: r.submitted_at
            }));

            const routesRes = await client.query('SELECT * FROM routes ORDER BY created_at DESC');
            this.memoryState.routes = routesRes.rows.map(r => ({
                id: r.id,
                routeId: r.id,
                driverId: r.driver_id,
                driverName: r.driver_name,
                driverPhone: r.driver_phone,
                startName: r.start_name,
                endName: r.end_name,
                startLat: parseFloat(r.start_lat || 31.9961),
                startLon: parseFloat(r.start_lon || 44.3168),
                endLat: parseFloat(r.end_lat || 32.0321),
                endLon: parseFloat(r.end_lon || 44.3725),
                fare: parseFloat(r.fare || 3000),
                availableSeats: parseInt(r.available_seats || 4, 10),
                totalSeats: parseInt(r.total_seats || 4, 10),
                departureTime: r.departure_time,
                status: r.status || 'Active',
                createdAt: r.created_at
            }));

            try {
                const cmpRes = await client.query('SELECT * FROM complaints ORDER BY created_at DESC');
                if (cmpRes.rows.length > 0) {
                    this.memoryState.complaints = cmpRes.rows.map(r => ({
                        id: r.id,
                        complainantId: r.complainant_id || r.user_id,
                        complainantName: r.complainant_name || r.user_name || 'راكب',
                        complainantPhone: r.complainant_phone || '',
                        accusedId: r.accused_id || r.target_id || '',
                        accusedName: r.accused_name || r.target_name || '',
                        accusedPhone: r.accused_phone || '',
                        category: r.category || r.subject || 'أخرى',
                        complaintText: r.complaint_text || r.details || '',
                        priority: r.priority || 'Normal',
                        status: r.status || 'pending',
                        adminNotes: r.admin_notes || r.resolution_notes || '',
                        actionTaken: r.action_taken || '',
                        rideId: r.ride_id || '',
                        createdAt: r.created_at,
                        resolvedAt: r.resolved_at
                    }));
                }
            } catch (_) {}

            try {
                const settRes = await client.query("SELECT key, value_json FROM system_settings WHERE key IN ('hub_banners', 'app_theme')");
                for (const row of settRes.rows) {
                    if (row.key === 'hub_banners') {
                        try { this.memoryState.banners = JSON.parse(row.value_json); } catch (_) {}
                    }
                    if (row.key === 'app_theme') {
                        try {
                            if (!this.memoryState.appConfig) this.memoryState.appConfig = {};
                            this.memoryState.appConfig.theme = JSON.parse(row.value_json);
                        } catch (_) {}
                    }
                }
            } catch (_) {}

            this.saveStateSnapshot();
        } catch (e) {
            console.warn('[Database] Sync from PostgreSQL to memory warning:', e.message);
        }
    }

    // Persist a newly registered customer directly to PostgreSQL (survives restart)
    async persistNewCustomer(c) {
        if (!this.pool || !this.isPostgresConnected) return;
        try {
            const cl = await this.pool.connect();
            try {
                await cl.query(`INSERT INTO users (id, phone_number, email, full_name, role, password_hash, plain_password, google_id, is_active, is_blocked, created_at) VALUES ($1,$2,$3,$4,'Customer',$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET full_name=EXCLUDED.full_name, phone_number=EXCLUDED.phone_number, password_hash=COALESCE(EXCLUDED.password_hash,users.password_hash), plain_password=COALESCE(EXCLUDED.plain_password,users.plain_password)`,
                    [c.customerId, c.phoneNumber, c.email||null, c.fullName, c.passwordHash||null, c.plainPassword||null, c.googleId||null, c.isActive!==false, !!c.isBlocked, c.registeredAt||new Date().toISOString()]);
                await cl.query(`INSERT INTO customers (customer_id, full_name, phone_number, email, route, address, plain_password, password_hash, google_id, preferred_payment_method, rating_average, total_bookings, is_active, is_blocked, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (customer_id) DO UPDATE SET full_name=EXCLUDED.full_name, phone_number=EXCLUDED.phone_number, route=COALESCE(EXCLUDED.route,customers.route), address=COALESCE(EXCLUDED.address,customers.address), plain_password=COALESCE(EXCLUDED.plain_password,customers.plain_password), password_hash=COALESCE(EXCLUDED.password_hash,customers.password_hash)`,
                    [c.customerId, c.fullName, c.phoneNumber, c.email||null, c.route||c.area||'النجف الأشرف', c.address||c.area||'النجف الأشرف', c.plainPassword||null, c.passwordHash||null, c.googleId||null, c.preferredPaymentMethod||'Cash', c.ratingAverage||5.0, c.totalBookings||0, c.isActive!==false, !!c.isBlocked, c.registeredAt||new Date().toISOString()]);
            } finally { cl.release(); }
        } catch (e) { console.warn('[Database] persistNewCustomer error:', e.message); }
    }

    // Persist a newly registered driver directly to PostgreSQL (survives restart)
    async persistNewDriver(d) {
        if (!this.pool || !this.isPostgresConnected) return;
        try {
            const cl = await this.pool.connect();
            try {
                await cl.query(`INSERT INTO users (id, phone_number, email, full_name, role, google_id, is_active, is_blocked, created_at) VALUES ($1,$2,$3,$4,'Driver',$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
                    [d.driverId, d.phoneNumber, d.email||null, d.fullName, d.googleId||null, !d.isBlocked, !!d.isBlocked, d.registeredAt||d.createdAt||new Date().toISOString()]);
                await cl.query(`INSERT INTO drivers (driver_id, full_name, phone_number, email, license_number, status, is_verified, is_blocked, is_approved, work_mode, rating_average, total_trips, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (driver_id) DO NOTHING`,
                    [d.driverId, d.fullName, d.phoneNumber, d.email||null, d.licenseNumber||'PENDING', d.status||'Pending', !!d.isVerified, !!d.isBlocked, !!d.isApproved, d.workMode||'مشوار قصير', d.ratingAverage||5.0, d.totalTrips||0, d.registeredAt||d.createdAt||new Date().toISOString()]);
            } finally { cl.release(); }
        } catch (e) { console.warn('[Database] persistNewDriver error:', e.message); }
    }

    
    // Persist permanent location & route for passenger
    async persistCustomerPermanentLocation(customerId, data) {
        if (!this.pool || !this.isPostgresConnected) return;
        try {
            await this.pool.query(
                `UPDATE customers SET 
                    permanent_lat = $1, permanent_lon = $2, permanent_location_name = $3,
                    permanent_dropoff_lat = $4, permanent_dropoff_lon = $5, permanent_dropoff_name = $6,
                    route = COALESCE($7, route), address = COALESCE($8, address),
                    updated_at = NOW()
                 WHERE customer_id = $9`,
                [data.lat, data.lon, data.locationName || '', data.dropoffLat || null, data.dropoffLon || null, data.dropoffName || '', data.route || null, data.address || null, customerId]
            );
        } catch (e) { console.warn('[Database] persistCustomerPermanentLocation error:', e.message); }
    }


    // Persist telegramChatId mapping
    async persistTelegramChatId(role, id, chatId, username = null) {
        if (!this.pool || !this.isPostgresConnected) return;
        try {
            const table = role === 'Driver' ? 'drivers' : 'customers';
            const col = role === 'Driver' ? 'driver_id' : 'customer_id';
            await this.pool.query(
                `UPDATE ${table} SET telegram_chat_id = $1, telegram_username = COALESCE($2, telegram_username), telegram_linked_at = NOW() WHERE ${col} = $3`,
                [chatId ? String(chatId) : null, username || null, id]
            );
        } catch (e) {
            try {
                const table = role === 'Driver' ? 'drivers' : 'customers';
                const col = role === 'Driver' ? 'driver_id' : 'customer_id';
                await this.pool.query(`UPDATE ${table} SET telegram_chat_id = $1, telegram_linked_at = NOW() WHERE ${col} = $2`, [chatId ? String(chatId) : null, id]);
            } catch (err) {
                console.warn('[Database] persistTelegramChatId error:', err.message);
            }
        }
    }

    // Record passenger rating of captain, update captain average rating & points, and persist safely
    async recordCustomerTripRating(data) {
        const { rideId, driverId, driverName, customerId, passengerName, rating, tags, comment, pointsEarned } = data;
        const pts = Number(pointsEarned) || 50;
        const numRating = Number(rating) || 5;

        // 1. Memory State Record
        this.memoryState.tripRatings = this.memoryState.tripRatings || [];
        const record = {
            id: 'rating_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            rideId,
            driverId,
            driverName: driverName || 'الكابتن',
            customerId: customerId || null,
            passengerId: customerId || null,
            passengerName: passengerName || 'الراكب',
            rating: numRating,
            tags: Array.isArray(tags) ? tags : [],
            comment: (comment || '').trim(),
            pointsEarned: pts,
            createdAt: new Date().toISOString()
        };
        this.memoryState.tripRatings.unshift(record);

        // 2. Update driver in memory (points, totalTrips, and average rating)
        const driver = this.findDriver(driverId);
        let newRatingAverage = 5.0;
        if (driver) {
            driver.points = (parseInt(driver.points, 10) || 0) + pts;
            driver.rewardScore = driver.points;
            driver.totalTrips = (parseInt(driver.totalTrips, 10) || 0) + 1;

            const prevRatedCount = parseInt(driver.ratedTripsCount || driver.ratingsCount, 10) || 0;
            const newRatedCount = prevRatedCount + 1;
            const prevAvg = parseFloat(driver.ratingAverage) || 5.0;
            const prevSum = parseFloat(driver.totalRatingSum) || (prevAvg * prevRatedCount);
            const newSum = prevSum + numRating;
            newRatingAverage = Math.round((newSum / newRatedCount) * 10) / 10;

            driver.ratedTripsCount = newRatedCount;
            driver.totalRatingSum = newSum;
            driver.ratingAverage = newRatingAverage;
        }

        // 3. Mark on rideRequest in memory
        const ride = (this.memoryState.rideRequests || []).find(r => r.id === rideId);
        if (ride) {
            ride.ratingByCustomer = record;
            ride.isRatedByCustomer = true;
        }

        // 4. PostgreSQL Persistence
        if (this.pool && this.isPostgresConnected) {
            try {
                await this.pool.query(
                    `INSERT INTO trip_ratings (ride_id, driver_id, passenger_id, passenger_name, rating, tags, comment, points_earned, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
                    [rideId, driverId, customerId || null, passengerName || 'الراكب', numRating, JSON.stringify(record.tags), record.comment, pts]
                );
                await this.pool.query(
                    `UPDATE drivers 
                     SET points = COALESCE(points, 0) + $1,
                         rating_average = $2,
                         total_trips = COALESCE(total_trips, 0) + 1,
                         updated_at = NOW()
                     WHERE driver_id = $3`,
                    [pts, newRatingAverage, driverId]
                );
            } catch (pgErr) {
                console.warn('[Database] recordCustomerTripRating PG error:', pgErr.message);
            }
        }

        // 5. Atomic state snapshot save
        this.saveStateSnapshot();

        return {
            record,
            driverTotalPoints: driver ? driver.points : pts,
            driverRatingAverage: newRatingAverage
        };
    }

    // Alias for compatibility
    async recordTripRating(data) {
        return this.recordCustomerTripRating(data);
    }

    // -------------------------------------------------------------------------
    // Dynamic Calculated Statistics (No Drift, 100% Accurate)
    // -------------------------------------------------------------------------
    getComputedStats() {
        const totalDrivers = this.memoryState.drivers.length;
        const verifiedDrivers = this.memoryState.drivers.filter(d => d.isVerified || d.status === 'Approved').length;
        
        // Pending verifications strictly counts drivers whose status is Pending
        const pendingVerifications = this.memoryState.drivers.filter(d => 
            d.status === 'Pending' || (!d.isVerified && d.status !== 'Rejected' && d.status !== 'Suspended')
        ).length;

        const activeRoutes = this.memoryState.routes.filter(r => r.status === 'Active' || !r.status).length;
        const totalUsers = this.memoryState.customers.length;
        const totalBookings = this.memoryState.bookings.length;
        const pendingComplaints = this.memoryState.complaints.filter(c => c.status === 'Pending' || c.status === 'Open').length;

        let totalRevenue = 0;
        for (const b of this.memoryState.bookings) {
            if (b.totalFare) totalRevenue += Number(b.totalFare);
        }

        return {
            totalUsers,
            totalDrivers,
            verifiedDrivers,
            pendingVerifications,
            activeRoutes,
            totalBookings,
            pendingComplaints,
            totalRevenue
        };
    }

    // -------------------------------------------------------------------------
    // Dynamic Notifications for Web Dashboard
    // -------------------------------------------------------------------------
    getDynamicNotifications() {
        const notifications = [];
        
        // 1. Pending Driver Verifications (ONLY for currently existing drivers)
        const pendingDrivers = this.memoryState.drivers.filter(d => 
            d.status === 'Pending' || (!d.isVerified && d.status !== 'Rejected' && d.status !== 'Suspended')
        );

        for (const d of pendingDrivers) {
            notifications.push({
                id: `notif-verif-${d.driverId}`,
                type: 'DriverVerification',
                title: 'طلب توثيق سائق جديد',
                message: `الكابتن ${d.fullName} بانتظار تدقيق الوثائق ورخصة القيادة`,
                driverId: d.driverId,
                driverName: d.fullName,
                phoneNumber: d.phoneNumber,
                actionUrl: 'verifications',
                createdAt: d.createdAt || new Date().toISOString()
            });
        }

        // 2. Open Complaints
        for (const c of this.memoryState.complaints) {
            if (c.status === 'Open' || c.status === 'Pending') {
                notifications.push({
                    id: `notif-comp-${c.id}`,
                    type: 'Complaint',
                    title: `شكوى جديدة: ${c.subject}`,
                    message: c.details || 'بلاغ وارد من مستخدم',
                    actionUrl: 'complaints',
                    createdAt: c.createdAt || new Date().toISOString()
                });
            }
        }

        return {
            totalPending: notifications.length,
            notifications
        };
    }

    // -------------------------------------------------------------------------
    // Driver Lifecycle Management
    // -------------------------------------------------------------------------
    async setDriverStatus(driverId, newStatus, reason = null) {
        let driver = this.memoryState.drivers.find(d => d.driverId === driverId);
        if (!driver && this.isPostgresConnected && this.pool) {
            try {
                const pgRes = await this.pool.query('SELECT * FROM drivers WHERE driver_id = $1 LIMIT 1', [driverId]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    const row = pgRes.rows[0];
                    driver = {
                        driverId: row.driver_id,
                        fullName: row.full_name,
                        phoneNumber: row.phone_number,
                        email: row.email,
                        plainPassword: row.plain_password,
                        passwordHash: row.password_hash,
                        status: row.status,
                        isVerified: row.is_verified,
                        isBlocked: row.is_blocked,
                        rejectionReason: row.rejection_reason
                    };
                    this.memoryState.drivers.unshift(driver);
                }
            } catch (_) {}
        }
        if (!driver) return { success: false, error: 'Driver not found' };

        driver.status = newStatus;
        if (newStatus === 'Approved') {
            driver.isVerified = true;
            driver.isBlocked = false;
            driver.rejectionReason = null;
        } else if (newStatus === 'Rejected') {
            driver.isVerified = false;
            driver.isBlocked = false;
            driver.rejectionReason = reason || 'المستمسكات غير واضحة أو غير مطابقة';
        } else if (newStatus === 'Suspended') {
            driver.isBlocked = true;
            driver.rejectionReason = reason || 'تم تعليق الحساب بقرار إداري';
        }

        // Update all corresponding verification documents for this driver
        const targetDocStatus = newStatus === 'Approved' ? 'Approved' : (newStatus === 'Rejected' ? 'Rejected' : 'Pending');
        for (const doc of this.memoryState.verifications) {
            if (doc.driverId === driverId) {
                doc.status = targetDocStatus;
                if (reason) doc.rejectionReason = reason;
            }
        }

        // Update in PostgreSQL
        if (this.isPostgresConnected && this.pool) {
            try {
                await this.pool.query(`
                    UPDATE drivers 
                    SET status = $1, is_verified = $2, is_blocked = $3, rejection_reason = $4, updated_at = NOW()
                    WHERE driver_id = $5
                `, [driver.status, driver.isVerified, driver.isBlocked, driver.rejectionReason, driverId]);

                await this.pool.query(`
                    UPDATE users
                    SET is_blocked = $1, is_active = $2, updated_at = NOW()
                    WHERE id = $3
                `, [driver.isBlocked, !driver.isBlocked, driverId]);

                await this.pool.query(`
                    UPDATE driver_documents
                    SET status = $1, rejection_reason = $2
                    WHERE driver_id = $3
                `, [targetDocStatus, reason, driverId]);
            } catch (err) {
                console.error('[Database] PostgreSQL setDriverStatus error:', err);
            }
        }

        this.addAuditLog('DriverStatusChanged', 'Driver', driverId, {
            newStatus,
            isVerified: driver.isVerified,
            isBlocked: driver.isBlocked,
            reason
        });

        this.saveStateSnapshot();
        return { success: true, driver, stats: this.getComputedStats() };
    }

    async setDriverApproval(driverId, isApproved) {
        let driver = this.memoryState.drivers.find(d => d.driverId === driverId);
        if (driver) driver.isApproved = isApproved;
        if (this.isPostgresConnected && this.pool) {
            try {
                await this.pool.query('UPDATE drivers SET is_approved = $1, updated_at = NOW() WHERE driver_id = $2', [isApproved, driverId]);
            } catch (err) {
                console.error('[Database] setDriverApproval error:', err);
            }
        }
        this.saveStateSnapshot();
        return { success: true, driver };
    }

    async setDriverWorkMode(driverId, workMode) {
        let driver = this.memoryState.drivers.find(d => d.driverId === driverId);
        if (driver) {
            driver.workMode = workMode;
            driver.work_mode = workMode;
            if (workMode === 'خمول' || workMode === 'idle') {
                driver.workStatus = 'idle';
                driver.isOnline = false;
                driver.status = 'Offline';
                driver.tripStatus = 'Offline';
            } else if (workMode === 'خط دائمي' || workMode === 'permanent') {
                driver.workStatus = 'permanent';
                driver.isOnline = true;
                driver.status = 'Online';
                driver.tripStatus = 'Online';
            } else if (workMode === 'مشوار قصير' || workMode === 'taxi') {
                driver.workStatus = 'taxi';
                driver.isOnline = true;
                driver.status = 'Online';
                driver.tripStatus = 'Online';
            }
        }
        if (this.isPostgresConnected && this.pool) {
            try {
                await this.pool.query('UPDATE drivers SET work_mode = $1, updated_at = NOW() WHERE driver_id = $2', [workMode, driverId]);
            } catch (err) {
                console.error('[Database] setDriverWorkMode error:', err);
            }
        }
        this.saveStateSnapshot();
        return { success: true, driver };
    }

    // -------------------------------------------------------------------------
    // Cascade Delete: Driver
    // -------------------------------------------------------------------------
    async deleteDriver(driverId) {
        const initialLength = this.memoryState.drivers.length;
        const driver = this.memoryState.drivers.find(d => d.driverId === driverId);
        if (!driver) return { success: false, error: 'Driver not found' };

        // 1. Memory Cascade Deletion
        this.memoryState.drivers = this.memoryState.drivers.filter(d => d.driverId !== driverId);
        this.memoryState.verifications = this.memoryState.verifications.filter(v => v.driverId !== driverId);
        this.memoryState.routes = this.memoryState.routes.filter(r => r.driverId !== driverId);
        this.memoryState.bookings = this.memoryState.bookings.filter(b => b.driverId !== driverId);
        this.memoryState.notifications = this.memoryState.notifications.filter(n => n.referenceId !== driverId && n.userId !== driverId);

        // 2. PostgreSQL Cascade Deletion
        if (this.isPostgresConnected && this.pool) {
            try {
                // Deleting from users automatically cascades to drivers, driver_documents, routes, bookings due to ON DELETE CASCADE
                await this.pool.query('DELETE FROM users WHERE id = $1', [driverId]);
                await this.pool.query('DELETE FROM drivers WHERE driver_id = $1', [driverId]);
            } catch (err) {
                console.error('[Database] PostgreSQL deleteDriver error:', err);
            }
        }

        this.addAuditLog('DriverDeletedPermanently', 'Driver', driverId, {
            deletedDriverName: driver.fullName,
            deletedAt: new Date().toISOString()
        });

        this.saveStateSnapshot();
        const updatedStats = this.getComputedStats();
        return { success: true, message: 'تم حذف السائق وبياناته ومستنداته نهائياً من كافة السجلات', stats: updatedStats };
    }

    // -------------------------------------------------------------------------
    // Cascade Delete: Customer
    // -------------------------------------------------------------------------
    async deleteCustomer(customerId) {
        const customer = this.memoryState.customers.find(c => c.customerId === customerId);
        if (!customer) return { success: false, error: 'Customer not found' };

        // 1. Memory Cascade Deletion
        this.memoryState.customers = this.memoryState.customers.filter(c => c.customerId !== customerId);
        this.memoryState.bookings = this.memoryState.bookings.filter(b => b.customerId !== customerId);
        this.memoryState.complaints = this.memoryState.complaints.filter(c => c.userId !== customerId);
        this.memoryState.notifications = this.memoryState.notifications.filter(n => n.userId !== customerId);

        // 2. PostgreSQL Cascade Deletion
        if (this.isPostgresConnected && this.pool) {
            try {
                await this.pool.query('DELETE FROM users WHERE id = $1', [customerId]);
                await this.pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
            } catch (err) {
                console.error('[Database] PostgreSQL deleteCustomer error:', err);
            }
        }

        this.addAuditLog('CustomerDeletedPermanently', 'Customer', customerId, {
            deletedCustomerName: customer.fullName,
            deletedAt: new Date().toISOString()
        });

        this.saveStateSnapshot();
        const updatedStats = this.getComputedStats();
        return { success: true, message: 'تم حذف الراكب وبياناته نهائياً من كافة السجلات', stats: updatedStats };
    }

    addAuditLog(action, entityName, entityId, newValues, ipAddress = '127.0.0.1') {
        const log = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            action,
            entityName,
            entityId,
            newValuesJson: typeof newValues === 'string' ? newValues : JSON.stringify(newValues),
            ipAddress,
            createdAt: new Date().toISOString()
        };
        this.memoryState.auditLogs.unshift(log);
        if (this.memoryState.auditLogs.length > 500) {
            this.memoryState.auditLogs = this.memoryState.auditLogs.slice(0, 500);
        }

        if (this.isPostgresConnected && this.pool) {
            this.pool.query(`
                INSERT INTO audit_logs (action, entity_name, entity_id, new_values_json, ip_address, created_at)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [log.action, log.entityName, log.entityId, log.newValuesJson, log.ipAddress, log.createdAt]).catch(() => {});
        }
    }

    addNotification(type, message, data = {}, userId = null) {
        const notif = {
            id: 'notif-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            notificationId: 'notif-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            type: type || 'General',
            title: data.title || (type === 'NewDriverPending' ? 'توثيق كابتن جديد' : 'إشعار نظام'),
            message: message || '',
            userId: userId || data.driverId || data.customerId || null,
            referenceId: data.verificationId || data.driverId || data.bookingId || null,
            data: data,
            isRead: false,
            createdAt: new Date().toISOString()
        };
        this.memoryState.notifications = this.memoryState.notifications || [];
        this.memoryState.notifications.unshift(notif);
        if (this.memoryState.notifications.length > 300) {
            this.memoryState.notifications = this.memoryState.notifications.slice(0, 300);
        }

        if (this.isPostgresConnected && this.pool) {
            this.pool.query(`
                INSERT INTO notifications (id, user_id, title, message, type, is_read, reference_id, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (id) DO NOTHING
            `, [notif.id, notif.userId, notif.title, notif.message, notif.type, false, notif.referenceId, notif.createdAt]).catch(() => {});
        }
        return notif;
    }

    async executeAtomicBooking({ driverId, passengerId, passengerName, passengerPhone, platform = 'web', seatsToBook = 1 }) {
        const seats = Math.max(1, parseInt(seatsToBook || 1, 10));
        let driver = (this.memoryState.drivers || []).find(d => d.driverId === driverId || d.id === driverId);
        if (!driver) {
            return { success: false, statusCode: 404, error: 'السائق غير موجود' };
        }

        // Prevent duplicate booking for the same passenger
        const cleanPassPhone = String(passengerPhone || '').replace(/[^0-9]/g, '');
        const existingBooking = (this.memoryState.bookings || []).find(b => {
            const isActive = b.status === 'Confirmed' || b.status === 'Pending' || b.status === 'Active' || !b.status;
            if (!isActive) return false;
            const sameDriver = b.driverId === driver.driverId;
            const sameCustId = (passengerId && (b.passengerId === String(passengerId) || b.customerId === String(passengerId)));
            const bPhone = String(b.passengerPhone || b.customerPhone || '').replace(/[^0-9]/g, '');
            const samePhone = cleanPassPhone.length >= 7 && bPhone.length >= 7 && (bPhone.endsWith(cleanPassPhone.slice(-8)) || cleanPassPhone.endsWith(bPhone.slice(-8)));
            return sameDriver && (sameCustId || samePhone);
        });

        if (existingBooking) {
            return {
                success: false,
                statusCode: 409,
                alreadySubscribed: true,
                error: 'أنت مشترك بالفعل في هذا الخط، لا يمكنك تكرار الحجز.'
            };
        }

        const currentSeats = driver.availableSeats !== undefined ? parseInt(driver.availableSeats, 10) : 4;
        if (currentSeats < seats || driver.status === 'full') {
            return { success: false, statusCode: 409, error: 'عذراً، المقاعد مكتملة عند السائق حالياً' };
        }

        driver.availableSeats = Math.max(0, currentSeats - seats);
        if (driver.availableSeats <= 0) {
            driver.status = 'full';
        }

        let route = (this.memoryState.routes || []).find(r => r.driverId === driver.driverId);
        if (route) {
            route.availableSeats = driver.availableSeats;
            if (driver.availableSeats <= 0) route.status = 'Full';
        }

        const bookingId = 'bk-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
        const booking = {
            id: bookingId,
            bookingId: bookingId,
            driverId: driver.driverId,
            driverName: driver.fullName,
            driverPhone: driver.phoneNumber,
            passengerId: String(passengerId),
            passengerName: passengerName || 'راكب',
            passengerPhone: passengerPhone || '',
            platform: platform || 'web',
            seatsBooked: seats,
            status: 'Confirmed',
            createdAt: new Date().toISOString()
        };
        this.memoryState.bookings = this.memoryState.bookings || [];
        this.memoryState.bookings.unshift(booking);

        this.addAuditLog('SeatBooked', 'Booking', bookingId, {
            driverId: driver.driverId,
            remainingSeats: driver.availableSeats,
            platform
        });
        this.saveStateSnapshot();

        if (this.isPostgresConnected && this.pool) {
            try {
                await this.pool.query(`
                    UPDATE drivers 
                    SET available_seats = available_seats - $1,
                        status = CASE WHEN available_seats - $1 <= 0 THEN 'full' ELSE status END,
                        updated_at = NOW()
                    WHERE (driver_id = $2 OR id = $2) AND available_seats >= $1
                `, [seats, driver.driverId]);

                await this.pool.query(`
                    INSERT INTO bookings (id, driver_id, passenger_id, passenger_name, passenger_phone, platform, status, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', NOW())
                    ON CONFLICT (id) DO NOTHING
                `, [bookingId, driver.driverId, String(passengerId), passengerName || 'راكب', passengerPhone || '', platform]);
            } catch (pgErr) {
                console.error('[DB] executeAtomicBooking PG error:', pgErr);
            }
        }

        return {
            success: true,
            statusCode: 200,
            bookingId,
            driver: {
                driverId: driver.driverId,
                name: driver.fullName,
                fullName: driver.fullName,
                phone: driver.phoneNumber,
                phoneNumber: driver.phoneNumber,
                availableSeats: driver.availableSeats,
                totalSeats: driver.totalSeats || 4,
                remainingSeats: driver.availableSeats,
                status: driver.status,
                route: driver.route || driver.permanentLocationName || 'خط دائمي'
            }
        };
    }

    matchPassengerRoute(passengerPoints, maxMeters = 5000) {
        const toRad = deg => deg * Math.PI / 180;
        const haversineMeters = (lat1, lon1, lat2, lon2) => {
            const R = 6371000;
            const dLat = toRad(lat2 - lat1);
            const dLon = toRad(lon2 - lon1);
            const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        };

        const activeDrivers = (this.memoryState.drivers || []).filter(d => {
            if (d.availableSeats === undefined) { d.availableSeats = 4; d.totalSeats = 4; }
            return !d.isBlocked && d.status !== 'Pending' && d.status !== 'Rejected' && d.status !== 'full' &&
                d.availableSeats > 0 &&
                ((d.permanentLat && d.permanentLon) || d.route);
        });

        const results = [];
        for (const d of activeDrivers) {
            const dStartLat = parseFloat(d.permanentLat || d.latitude || 31.9961);
            const dStartLon = parseFloat(d.permanentLon || d.longitude || 44.3168);
            const dEndLat = parseFloat(d.permanentDropoffLat || 32.0321);
            const dEndLon = parseFloat(d.permanentDropoffLon || 44.3725);

            let minDist = Infinity;
            if (Array.isArray(passengerPoints) && passengerPoints.length > 0) {
                for (const pt of passengerPoints) {
                    const pLat = Array.isArray(pt) ? pt[1] : (pt.lat || pt.latitude);
                    const pLon = Array.isArray(pt) ? pt[0] : (pt.lon || pt.longitude);
                    if (pLat && pLon) {
                        const distToStart = haversineMeters(pLat, pLon, dStartLat, dStartLon);
                        const distToEnd = haversineMeters(pLat, pLon, dEndLat, dEndLon);
                        minDist = Math.min(minDist, distToStart, distToEnd);
                    }
                }
            } else {
                minDist = 800;
            }

            if (minDist <= maxMeters) {
                let tier = 3;
                let tierLabel = '🔴 مسار بديل (أكثر من 1500م)';
                let tierColor = '#EF4444';

                if (minDist <= 500) {
                    tier = 1;
                    tierLabel = '🟢 مطابق تماماً (أقل من 500م)';
                    tierColor = '#10B981';
                } else if (minDist <= 1500) {
                    tier = 2;
                    tierLabel = '🟣 مسار قريب (500م - 1500م)';
                    tierColor = '#8B5CF6';
                }

                const vMake = d.vehicleMake || 'تويوتا';
                const vModel = d.vehicleModel || 'كورولا';
                const vPlate = d.vehiclePlate || 'النجف';
                const routeName = d.route || (d.permanentLocationName && d.permanentDropoffName ? `${d.permanentLocationName} ➔ ${d.permanentDropoffName}` : 'خط دائم');

                results.push({
                    driver: d,
                    driverId: d.driverId,
                    name: d.fullName || 'كابتن توصيله',
                    fullName: d.fullName || 'كابتن توصيله',
                    phone: d.phoneNumber || '07800000000',
                    phoneNumber: d.phoneNumber || '07800000000',
                    vehicleModel: `${vMake} ${vModel}`.trim(),
                    plateNumber: vPlate,
                    availableSeats: d.availableSeats !== undefined ? d.availableSeats : 4,
                    totalSeats: d.totalSeats || 4,
                    routeName: routeName,
                    route: routeName,
                    routeGeoJson: {
                        type: 'LineString',
                        coordinates: [
                            [dStartLon, dStartLat],
                            [dEndLon, dEndLat]
                        ]
                    },
                    distanceMeters: Math.round(minDist),
                    minDistanceMeters: Math.round(minDist),
                    tier,
                    tierLabel,
                    tierName: tierLabel,
                    tierColor
                });
            }
        }

        return results.sort((a, b) => a.distanceMeters - b.distanceMeters);
    }
}

const db = new DatabaseManager();
module.exports = db;
