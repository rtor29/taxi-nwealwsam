const fs = require('fs');
const path = require('path');
const db = require('../../db');
const config = require('../../config');

class BackupService {
    /**
     * Exports a complete snapshot of all platform data
     */
    async exportBackup() {
        try {
            const timestamp = new Date().toISOString();
            let backupPayload = {
                version: "2.0-postgres",
                platform: "Taxi-Wisam (Najaf)",
                exportedAt: timestamp,
                stats: db.getComputedStats(),
                data: {
                    drivers: db.memoryState.drivers || [],
                    customers: db.memoryState.customers || [],
                    verifications: db.memoryState.verifications || [],
                    routes: db.memoryState.routes || [],
                    bookings: db.memoryState.bookings || [],
                    complaints: db.memoryState.complaints || [],
                    settings: db.memoryState.settings || [],
                    vacancyAds: db.memoryState.vacancyAds || [],
                    auditLogs: db.memoryState.auditLogs || []
                }
            };

            // If PostgreSQL is connected, fetch the raw tables to guarantee absolute consistency
            if (db.isPostgresConnected && db.pool) {
                try {
                    const [
                        usersRes,
                        driversRes,
                        customersRes,
                        docsRes,
                        routesRes,
                        bookingsRes,
                        complaintsRes,
                        settingsRes,
                        auditRes
                    ] = await Promise.all([
                        db.pool.query('SELECT * FROM users ORDER BY created_at ASC'),
                        db.pool.query('SELECT * FROM drivers ORDER BY created_at ASC'),
                        db.pool.query('SELECT * FROM customers ORDER BY created_at ASC'),
                        db.pool.query('SELECT * FROM driver_documents ORDER BY submitted_at ASC'),
                        db.pool.query('SELECT * FROM routes ORDER BY created_at ASC'),
                        db.pool.query('SELECT * FROM bookings ORDER BY created_at ASC'),
                        db.pool.query('SELECT * FROM complaints ORDER BY created_at ASC'),
                        db.pool.query('SELECT * FROM system_settings'),
                        db.pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500')
                    ]);

                    backupPayload.postgresDump = {
                        users: usersRes.rows,
                        drivers: driversRes.rows,
                        customers: customersRes.rows,
                        driver_documents: docsRes.rows,
                        routes: routesRes.rows,
                        bookings: bookingsRes.rows,
                        complaints: complaintsRes.rows,
                        system_settings: settingsRes.rows,
                        audit_logs: auditRes.rows
                    };
                } catch (pgErr) {
                    console.warn('[BackupService] PG dump fetch warning (falling back to memory state):', pgErr.message);
                }
            }

            // Save a server-side copy in data/backups/
            const backupDir = path.join(path.dirname(config.dataFile), 'backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }
            const filename = `backup-tawseela-${timestamp.replace(/[:.]/g, '-')}.json`;
            const backupFilePath = path.join(backupDir, filename);
            fs.writeFileSync(backupFilePath, JSON.stringify(backupPayload, null, 2), 'utf8');

            db.addAuditLog('SystemBackupExported', 'System', 'FullDatabase', {
                filename,
                driverCount: backupPayload.data.drivers.length,
                customerCount: backupPayload.data.customers.length,
                exportedAt: timestamp
            });

            return {
                success: true,
                filename,
                backupPayload
            };
        } catch (error) {
            console.error('[BackupService] exportBackup error:', error);
            throw error;
        }
    }

    /**
     * Restores data from a backup JSON payload into both PostgreSQL and state snapshots
     */
    async restoreBackup(payload) {
        const actualPayload = (payload && payload.backupPayload) ? payload.backupPayload : payload;
        if (!actualPayload || !actualPayload.data) {
            throw new Error('الملف غير صالح، تنقصه حقول البيانات الأساسية (data payload)');
        }

        const data = actualPayload.data;
        const drivers = Array.isArray(data.drivers) ? data.drivers : [];
        const customers = Array.isArray(data.customers) ? data.customers : [];
        const verifications = Array.isArray(data.verifications) ? data.verifications : [];
        const routes = Array.isArray(data.routes) ? data.routes : [];
        const bookings = Array.isArray(data.bookings) ? data.bookings : [];
        const complaints = Array.isArray(data.complaints) ? data.complaints : [];
        const settings = Array.isArray(data.settings) ? data.settings : [];
        const vacancyAds = Array.isArray(data.vacancyAds) ? data.vacancyAds : [];
        const auditLogs = Array.isArray(data.auditLogs) ? data.auditLogs : [];

        // 1. Transactional restoration in PostgreSQL if connected
        if (db.isPostgresConnected && db.pool) {
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');

                // Clear tables in reverse dependency order
                await client.query('DELETE FROM complaints');
                await client.query('DELETE FROM bookings');
                await client.query('DELETE FROM routes');
                await client.query('DELETE FROM driver_documents');
                await client.query('DELETE FROM drivers');
                await client.query('DELETE FROM customers');
                await client.query('DELETE FROM users');

                // Re-insert users & drivers
                for (const d of drivers) {
                    await client.query(`
                        INSERT INTO users (id, phone_number, email, full_name, role, google_id, is_active, is_blocked, created_at)
                        VALUES ($1, $2, $3, $4, 'Driver', $5, $6, $7, $8)
                        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
                    `, [d.driverId, d.phoneNumber, d.email || null, d.fullName, d.googleId || null, !d.isBlocked, !!d.isBlocked, d.createdAt || new Date().toISOString()]);

                    await client.query(`
                        INSERT INTO drivers (driver_id, full_name, phone_number, email, google_id, license_number, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, status, is_verified, is_blocked, rejection_reason, rating_average, total_trips, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                        ON CONFLICT (driver_id) DO UPDATE SET status = EXCLUDED.status, is_verified = EXCLUDED.is_verified, is_blocked = EXCLUDED.is_blocked
                    `, [
                        d.driverId, d.fullName, d.phoneNumber, d.email || null, d.googleId || null,
                        d.licenseNumber || 'IRQ-NJF-1000', d.vehicleMake || null, d.vehicleModel || null,
                        d.vehicleYear || null, d.vehiclePlate || null, d.status || 'Pending',
                        !!d.isVerified, !!d.isBlocked, d.rejectionReason || null,
                        d.ratingAverage || 5.0, d.totalTrips || 0, d.createdAt || new Date().toISOString()
                    ]);
                }

                // Re-insert customers
                for (const c of customers) {
                    await client.query(`
                        INSERT INTO users (id, phone_number, email, full_name, role, google_id, is_active, is_blocked, created_at)
                        VALUES ($1, $2, $3, $4, 'Customer', $5, $6, $7, $8)
                        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
                    `, [c.customerId, c.phoneNumber, c.email || null, c.fullName, c.googleId || null, c.isActive !== false, !!c.isBlocked, c.registeredAt || new Date().toISOString()]);

                    await client.query(`
                        INSERT INTO customers (customer_id, full_name, phone_number, email, google_id, preferred_payment_method, rating_average, total_bookings, is_active, is_blocked, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                        ON CONFLICT (customer_id) DO UPDATE SET preferred_payment_method = EXCLUDED.preferred_payment_method
                    `, [
                        c.customerId, c.fullName, c.phoneNumber, c.email || null, c.googleId || null,
                        c.preferredPaymentMethod || 'Cash', c.ratingAverage || 5.0, c.totalBookings || 0,
                        c.isActive !== false, !!c.isBlocked, c.registeredAt || new Date().toISOString()
                    ]);
                }

                // Re-insert verifications
                for (const v of verifications) {
                    await client.query(`
                        INSERT INTO driver_documents (document_id, driver_id, document_type, file_path, file_url, status, rejection_reason, submitted_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (document_id) DO NOTHING
                    `, [v.documentId, v.driverId, v.documentType || 'DrivingLicense', v.filePath || '', v.fileUrl || v.filePath || '', v.status || 'Pending', v.rejectionReason || null, v.submittedAt || new Date().toISOString()]);
                }

                // Re-insert routes
                for (const r of routes) {
                    await client.query(`
                        INSERT INTO routes (id, driver_id, driver_name, driver_phone, start_name, end_name, start_lat, start_lon, end_lat, end_lon, fare, available_seats, total_seats, departure_time, status, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                        ON CONFLICT (id) DO NOTHING
                    `, [r.id || r.routeId, r.driverId, r.driverName, r.driverPhone || '', r.startName, r.endName, r.startLat, r.startLon, r.endLat, r.endLon, r.fare || 3000, r.availableSeats || 4, r.totalSeats || 4, r.departureTime || '', r.status || 'Active', r.createdAt || new Date().toISOString()]);
                }

                // Re-insert bookings
                for (const b of bookings) {
                    await client.query(`
                        INSERT INTO bookings (id, route_id, customer_id, customer_name, customer_phone, driver_id, pickup_name, dropoff_name, seats_booked, total_fare, status, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                        ON CONFLICT (id) DO NOTHING
                    `, [b.id, b.routeId, b.customerId, b.customerName, b.customerPhone || '', b.driverId, b.pickupName, b.dropoffName, b.seatsBooked || 1, b.totalFare || 3000, b.status || 'Pending', b.createdAt || new Date().toISOString()]);
                }

                // Re-insert complaints
                for (const cmp of complaints) {
                    await client.query(`
                        INSERT INTO complaints (id, user_id, user_name, user_phone, user_role, subject, details, status, resolution_notes, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        ON CONFLICT (id) DO NOTHING
                    `, [cmp.id, cmp.userId, cmp.userName, cmp.userPhone || '', cmp.userRole || 'Customer', cmp.subject, cmp.details || '', cmp.status || 'Open', cmp.resolutionNotes || null, cmp.createdAt || new Date().toISOString()]);
                }

                await client.query('COMMIT');
                console.log('[BackupService] PostgreSQL restored successfully via transaction!');
            } catch (pgError) {
                await client.query('ROLLBACK');
                console.error('[BackupService] PostgreSQL restore transaction rolled back:', pgError);
                throw new Error(`فشلت استعادة قاعدة البيانات في PostgreSQL: ${pgError.message}`);
            } finally {
                client.release();
            }
        }

        // 2. Update Memory State & Snapshot
        db.memoryState = {
            drivers,
            customers,
            verifications,
            routes,
            bookings,
            complaints,
            settings: settings.length > 0 ? settings : db.memoryState.settings,
            vacancyAds: vacancyAds.length > 0 ? vacancyAds : db.memoryState.vacancyAds,
            auditLogs: [
                {
                    id: Date.now(),
                    action: "SystemBackupRestored",
                    entityName: "System",
                    entityId: "FullDatabase",
                    newValuesJson: JSON.stringify({
                        driversRestored: drivers.length,
                        customersRestored: customers.length,
                        routesRestored: routes.length,
                        restoredAt: new Date().toISOString()
                    }),
                    ipAddress: "127.0.0.1",
                    createdAt: new Date().toISOString()
                },
                ...auditLogs
            ]
        };

        db.cleanOrphanRecords();
        db.saveStateSnapshot();

        return {
            success: true,
            message: 'تمت استعادة كافة البيانات وقاعدة البيانات بنجاح تام!',
            restoredCounts: {
                drivers: drivers.length,
                customers: customers.length,
                verifications: verifications.length,
                routes: routes.length,
                bookings: bookings.length,
                complaints: complaints.length
            },
            stats: db.getComputedStats()
        };
    }
}

module.exports = new BackupService();
