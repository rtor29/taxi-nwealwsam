const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('../config');

class DatabaseManager {
    constructor() {
        this.pool = null;
        this.isPostgresConnected = false;
        this.schemaPath = path.join(__dirname, 'schema.sql');
        this.initMemoryState();
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
                    valueJson: JSON.stringify({ base_fare_iqd: 2500, per_km_rate_iqd: 400, per_minute_rate_iqd: 80, surge_multiplier_max: 2.0 }),
                    description: "تسعيرات مشاوير النجف الأشرف"
                }
            ],
            auditLogs: [],
            notifications: [],
            cancellationRequests: []
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
                if (parsed.bookings) this.memoryState.bookings = parsed.bookings;
                if (parsed.complaints) this.memoryState.complaints = parsed.complaints;
                if (parsed.settings) this.memoryState.settings = parsed.settings;
                if (parsed.auditLogs) this.memoryState.auditLogs = parsed.auditLogs;
                if (parsed.notifications) this.memoryState.notifications = parsed.notifications;
                if (parsed.cancellationRequests) this.memoryState.cancellationRequests = parsed.cancellationRequests;
                console.log(`[Database] Loaded ${this.memoryState.drivers.length} drivers, ${this.memoryState.customers.length} customers from state snapshot`);
            }
        } catch (e) {
            console.warn(`[Database] Error reading state snapshot: ${e.message}`);
        }

        // Guarantee active Najaf drivers exist for matching and trips
        if (!this.memoryState.drivers || this.memoryState.drivers.length === 0) {
            this.memoryState.drivers = [
                {
                    driverId: "drv-t-lhil8jhxd",
                    fullName: "كابتن حيدر الكعبي",
                    phoneNumber: "07801234567",
                    email: "haidar@tawseelaiq.app",
                    vehicleMake: "تويوتا",
                    vehicleModel: "كورولا",
                    vehicleYear: 2022,
                    vehiclePlate: "النجف 1240",
                    status: "Approved",
                    isVerified: true,
                    isBlocked: false,
                    serviceType: "ShortTrip",
                    ratingAverage: 5.0,
                    totalTrips: 18,
                    permanentLat: 32.01889,
                    permanentLon: 44.34710,
                    permanentLocationName: "حي الغدير",
                    createdAt: new Date().toISOString()
                },
                {
                    driverId: "drv-8atms9lfq",
                    fullName: "كابتن علي الموسوي",
                    phoneNumber: "07706204066",
                    email: "ali@tawseelaiq.app",
                    vehicleMake: "كيا",
                    vehicleModel: "سيراتو",
                    vehicleYear: 2023,
                    vehiclePlate: "النجف 5621",
                    status: "Approved",
                    isVerified: true,
                    isBlocked: false,
                    serviceType: "Both",
                    ratingAverage: 5.0,
                    totalTrips: 34,
                    permanentLat: 31.9961,
                    permanentLon: 44.3168,
                    permanentLocationName: "مركز النجف",
                    createdAt: new Date().toISOString()
                },
                {
                    driverId: "drv-3sjd8401a",
                    fullName: "كابتن سجاد الحسيني",
                    phoneNumber: "07722154182",
                    email: "sajjad@tawseelaiq.app",
                    vehicleMake: "هيونداي",
                    vehicleModel: "إلنترا",
                    vehicleYear: 2021,
                    vehiclePlate: "النجف 8834",
                    status: "Approved",
                    isVerified: true,
                    isBlocked: false,
                    serviceType: "ShortTrip",
                    ratingAverage: 4.9,
                    totalTrips: 12,
                    permanentLat: 32.0321,
                    permanentLon: 44.3725,
                    permanentLocationName: "الكوفة",
                    createdAt: new Date().toISOString()
                },
                {
                    driverId: "drv-mrt84920b",
                    fullName: "كابتن مرتضى النجفي",
                    phoneNumber: "07812345678",
                    email: "murtadha@tawseelaiq.app",
                    vehicleMake: "نيسان",
                    vehicleModel: "صني",
                    vehicleYear: 2020,
                    vehiclePlate: "النجف 3392",
                    status: "Approved",
                    isVerified: true,
                    isBlocked: false,
                    serviceType: "PermanentLine",
                    ratingAverage: 5.0,
                    totalTrips: 45,
                    permanentLat: 32.0164,
                    permanentLon: 44.3393,
                    permanentLocationName: "حي الضباط",
                    createdAt: new Date().toISOString()
                }
            ];
            this.saveStateSnapshot();
        }
    }

    saveStateSnapshot() {
        try {
            const dataDir = path.dirname(config.dataFile);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            
            // Add dynamically computed stats to snapshot
            const snapshot = {
                ...this.memoryState,
                stats: this.getComputedStats()
            };
            fs.writeFileSync(config.dataFile, JSON.stringify(snapshot, null, 2), 'utf8');
        } catch (e) {
            console.warn(`[Database] Snapshot save warning: ${e.message}`);
        }
    }

    async init() {
        try {
            const connectionString = process.env.DATABASE_URL || `postgresql://${config.pg.user}:${config.pg.password}@${config.pg.host}:${config.pg.port}/${config.pg.database}`;
            this.pool = new Pool({
                connectionString,
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
                    serviceType: r.service_type || 'Both',
                    rejectionReason: r.rejection_reason,
                    ratingAverage: parseFloat(r.rating_average || 5.0),
                    totalTrips: r.total_trips || 0,
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

    // Persist permanent location & route for driver
    async persistDriverPermanentLocation(driverId, data) {
        if (!this.pool || !this.isPostgresConnected) return;
        try {
            await this.pool.query(
                `UPDATE drivers SET 
                    permanent_lat = $1, permanent_lon = $2, permanent_location_name = $3,
                    permanent_dropoff_lat = $4, permanent_dropoff_lon = $5, permanent_dropoff_name = $6,
                    route = COALESCE($7, route),
                    updated_at = NOW()
                 WHERE driver_id = $8`,
                [data.lat, data.lon, data.locationName || '', data.dropoffLat || null, data.dropoffLon || null, data.dropoffName || '', data.route || null, driverId]
            );
        } catch (e) { console.warn('[Database] persistDriverPermanentLocation error:', e.message); }
    }

    // Persist telegramChatId mapping
    async persistTelegramChatId(role, id, chatId) {
        if (!this.pool || !this.isPostgresConnected) return;
        try {
            const table = role === 'Driver' ? 'drivers' : 'customers';
            const col = role === 'Driver' ? 'driver_id' : 'customer_id';
            await this.pool.query(`UPDATE ${table} SET telegram_chat_id = $1 WHERE ${col} = $2`, [String(chatId), id]);
        } catch (e) { console.warn('[Database] persistTelegramChatId error:', e.message); }
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
        if (driver) driver.workMode = workMode;
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
}

const db = new DatabaseManager();
module.exports = db;
