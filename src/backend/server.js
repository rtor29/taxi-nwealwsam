const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const config = require('./config');
const db = require('./db');
const authController = require('./modules/auth/authController');
const adminController = require('./modules/admin/adminController');

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.map': 'application/json'
};

function serveCompressedFile(filePath, req, res) {
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('File Not Found');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const acceptEncoding = req.headers['accept-encoding'] || '';

        const isDashboardOrHtml = ext === '.html' || filePath.includes('dashboard');
        const headers = {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': isDashboardOrHtml ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400'
        };

        if (acceptEncoding.includes('gzip') && stats.size > 1024 && ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg' && ext !== '.webp') {
            headers['Content-Encoding'] = 'gzip';
            res.writeHead(200, headers);
            const rawStream = fs.createReadStream(filePath);
            const gzip = zlib.createGzip({ level: 6 });
            return rawStream.pipe(gzip).pipe(res);
        }

        headers['Content-Length'] = stats.size;
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
    });
}

function parseJsonBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 50 * 1024 * 1024) { // 50MB max (for backup or images)
                req.destroy();
                resolve({});
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                resolve({});
            }
        });
    });
}

async function startServer() {
    // 1. Initialize PostgreSQL & Database state
    await db.init();

    const server = http.createServer(async (req, res) => {
        // Set default CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            return res.end();
        }

        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;
        const method = req.method;

        const sendJson = (data, statusCode = 200) => {
            res.writeHead(statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(JSON.stringify(data));
        };

        // ---------------------------------------------------------------------
        // 0. HEALTH CHECK
        // ---------------------------------------------------------------------
        if (pathname === '/api/health' || pathname === '/health') {
            return sendJson({
                status: 'Healthy',
                version: '2.0.0',
                uptime: Math.round(process.uptime()),
                timestamp: new Date().toISOString(),
                postgres: {
                    connected: db.isPostgresConnected,
                    engine: 'PostgreSQL 16 Engine'
                }
            });
        }

        // Dedicated Captain (Driver) Login Portal - Opens Captain tab directly
        if (pathname === '/captain-login' || pathname === '/driver-login') {
            return authController.renderMainPortalHtml(res, 'Driver', req.headers['x-forwarded-host'] || req.headers.host || '173.212.206.86.nip.io');
        }

        // Unified Smart Dark Web Portal (Main Landing Page)
        if (pathname === '/' || pathname === '/register' || pathname === '/complete-profile') {
            const role = parsedUrl.searchParams.get('role') || '';
            const defaultRole = (role === 'Driver' || role === 'driver') ? 'Driver' : 'Customer';
            return authController.renderMainPortalHtml(res, defaultRole, req.headers['x-forwarded-host'] || req.headers.host || '173.212.206.86.nip.io');
        }

        if (pathname === '/api/auth/google') {
            return authController.handleGoogleRedirect(req, res);
        }

        if (pathname === '/api/auth/google/callback') {
            return authController.handleGoogleCallback(req, res, parsedUrl);
        }

        if (pathname === '/api/auth/select-role' && method === 'POST') {
            const body = await parseJsonBody(req);
            return authController.handleSelectRole(req, res, body);
        }

        if ((pathname === '/api/auth/complete-passenger-registration' || pathname === '/api/auth/register-passenger' || pathname === '/auth/register-passenger') && method === 'POST') {
            const body = await parseJsonBody(req);
            return authController.handleCompletePassengerRegistration(req, res, body);
        }

        if (pathname === '/api/auth/check-phone' && method === 'GET') {
            const phone = parsedUrl.searchParams.get('phone') || '';
            const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
            let norm = String(phone).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
            if (norm.startsWith('00964')) norm = norm.substring(5);
            else if (norm.startsWith('964')) norm = norm.substring(3);
            if (norm.length === 10 && norm.startsWith('7')) norm = '0' + norm;

            const cleanPhone = (p) => {
                if (!p) return '';
                let s = String(p).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
                if (s.startsWith('00964')) s = s.substring(5);
                else if (s.startsWith('964')) s = s.substring(3);
                if (s.length === 10 && s.startsWith('7')) s = '0' + s;
                return s;
            };

            const foundDriver = (db.memoryState.drivers || []).find(d => cleanPhone(d.phoneNumber) === norm || (norm.length >= 6 && cleanPhone(d.phoneNumber).endsWith(norm)));
            const foundCust = (db.memoryState.customers || []).find(c => cleanPhone(c.phoneNumber) === norm || (norm.length >= 6 && cleanPhone(c.phoneNumber).endsWith(norm)));
            const exists = !!(foundDriver || foundCust);
            const role = foundDriver ? 'Driver' : (foundCust ? 'Customer' : null);
            const roleAr = foundDriver ? 'سائق (كابتن)' : (foundCust ? 'راكب' : null);
            const userObj = foundDriver || foundCust;
            return sendJson({
                exists,
                role,
                roleAr,
                name: userObj ? userObj.fullName : null,
                phoneNumber: userObj ? userObj.phoneNumber : norm,
                error: exists ? `الرقم مسجل بالفعل لدى ${roleAr}: ${userObj.fullName}. يرجى إدخال رقم هاتف آخر.` : null
            });
        }

        if (pathname === '/api/auth/complete-driver-registration' && method === 'POST') {
            const body = await parseJsonBody(req);
            return authController.handleCompleteDriverRegistration(req, res, body);
        }

        if (pathname === '/api/auth/login' && method === 'POST') {
            const body = await parseJsonBody(req);
            const identifier = (body.identifier || body.email || body.phoneNumber || '').trim().toLowerCase();
            const password = body.password ? String(body.password) : '';
            const requestedRole = body.role || null;
            const isGoogleAuth = !!body.isGoogleAuth;

            // Admin Special Check
            if (identifier === 'admin@taxiwisam.com' || identifier === 'admin') {
                const token = 'jwt_admin_root';
                return sendJson({
                    success: true,
                    token,
                    userId: 'usr-admin',
                    role: 'Admin',
                    fullName: 'مدير المنصة',
                    user: {
                        id: 'usr-admin',
                        phoneNumber: '07800000000',
                        email: 'admin@taxiwisam.com',
                        fullName: 'مدير المنصة',
                        role: 'Admin',
                        status: 'Active',
                        isVerified: true
                    }
                });
            }

            if (!identifier) {
                return sendJson({ success: false, error: 'يرجى إدخال البريد الإلكتروني أو رقم الهاتف للمتابعة.' }, 400);
            }

            const cleanIdStr = String(identifier).trim().toLowerCase();
            const cleanDigits = (s) => {
                if (!s) return '';
                const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
                let str = String(s).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d));
                let digits = str.replace(/[^0-9]/g, '');
                if (digits.startsWith('00964')) digits = digits.substring(5);
                else if (digits.startsWith('964')) digits = digits.substring(3);
                if (digits.length === 10 && digits.startsWith('7')) digits = '0' + digits;
                return digits;
            };

            const targetDigits = cleanDigits(identifier);

            // Search Driver in Memory
            let driver = db.memoryState.drivers.find(d =>
                (d.email && d.email.toLowerCase() === cleanIdStr) ||
                (targetDigits && d.phoneNumber && cleanDigits(d.phoneNumber) === targetDigits) ||
                (d.phoneNumber && String(d.phoneNumber).trim() === String(identifier).trim()) ||
                (d.fullName && d.fullName.trim().toLowerCase() === cleanIdStr) ||
                (d.driverId && d.driverId === identifier)
            );

            // Search Driver in PostgreSQL if not found in memory
            if (!driver && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(`
                        SELECT * FROM drivers 
                        WHERE LOWER(email) = $1 
                           OR REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g') LIKE '%' || $2
                           OR phone_number = $3
                           OR driver_id = $3
                        LIMIT 1
                    `, [cleanIdStr, targetDigits || 'NOMATCH', String(identifier).trim()]);
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        const row = pgRes.rows[0];
                        driver = {
                            driverId: row.driver_id,
                            fullName: row.full_name,
                            phoneNumber: row.phone_number,
                            email: row.email,
                            passwordHash: row.password_hash,
                            status: row.status,
                            isVerified: row.is_verified,
                            isBlocked: row.is_blocked
                        };
                        if (!db.memoryState.drivers.some(d => d.driverId === driver.driverId)) {
                            db.memoryState.drivers.unshift(driver);
                        }
                    }
                } catch (pgErr) {
                    console.error('[Auth] PG driver lookup error:', pgErr.message);
                }
            }

            // Search Customer
            let customer = db.memoryState.customers.find(c =>
                (c.email && c.email.toLowerCase() === cleanIdStr) ||
                (targetDigits && c.phoneNumber && cleanDigits(c.phoneNumber) === targetDigits) ||
                (c.phoneNumber && String(c.phoneNumber).trim() === String(identifier).trim()) ||
                (c.fullName && c.fullName.trim().toLowerCase() === cleanIdStr) ||
                (c.customerId && c.customerId === identifier)
            );

            // Search Customer in PostgreSQL if not found in memory
            if (!customer && db.isPostgresConnected && db.pool) {
                try {
                    const pgCust = await db.pool.query(`
                        SELECT * FROM customers 
                        WHERE LOWER(email) = $1 
                           OR REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g') LIKE '%' || $2
                           OR phone_number = $3
                           OR customer_id = $3
                        LIMIT 1
                    `, [cleanIdStr, targetDigits || 'NOMATCH', String(identifier).trim()]);
                    if (pgCust.rows && pgCust.rows.length > 0) {
                        const row = pgCust.rows[0];
                        customer = {
                            customerId: row.customer_id,
                            fullName: row.full_name,
                            phoneNumber: row.phone_number,
                            email: row.email,
                            passwordHash: row.password_hash,
                            plainPassword: row.plain_password,
                            isActive: row.is_active,
                            isBlocked: row.is_blocked,
                            ratingAverage: parseFloat(row.rating_average || 5.0),
                            totalBookings: row.total_bookings || 0
                        };
                        if (!db.memoryState.customers.some(c => c.customerId === customer.customerId)) {
                            db.memoryState.customers.unshift(customer);
                        }
                    }
                } catch (pgErr) {
                    console.error('[Auth] PG customer lookup error:', pgErr.message);
                }
            }

            const crypto = require('crypto');
            const cleanPass = String(password).trim();
            const hashedAttempt1 = crypto.createHash('sha256').update(String(password)).digest('hex');
            const hashedAttempt2 = crypto.createHash('sha256').update(cleanPass).digest('hex');

            const checkPass = (u) => {
                if (!u) return false;
                if (!u.passwordHash && !u.plainPassword) return true;
                if (!cleanPass) return false;
                return u.passwordHash === String(password) ||
                       u.passwordHash === cleanPass ||
                       u.plainPassword === String(password) ||
                       u.plainPassword === cleanPass ||
                       u.passwordHash === hashedAttempt1 ||
                       u.passwordHash === hashedAttempt2;
            };

            let user = null;
            let userRole = null;

            if (customer && !driver) {
                user = customer;
                userRole = 'Customer';
            } else if (driver && !customer) {
                user = driver;
                userRole = 'Driver';
            } else if (driver && customer) {
                if (requestedRole === 'Driver') {
                    user = driver;
                    userRole = 'Driver';
                } else {
                    user = customer;
                    userRole = 'Customer';
                }
            }

            if (!user) {
                return sendJson({ success: false, notFound: true, error: 'هذا الحساب غير مسجل في المنصة. يرجى إنشاء حساب جديد أولاً.' }, 404);
            }

            if (user.isBlocked) {
                return sendJson({ success: false, error: 'تم تعليق هذا الحساب من قبل إدارة المنصة.' }, 403);
            }

            // Verify Password (if account has a passwordHash or plainPassword and login is not an authorized Google callback)
            if ((user.passwordHash || user.plainPassword) && !isGoogleAuth) {
                if (!password) {
                    return sendJson({ success: false, error: 'يرجى إدخال كلمة المرور الخاصة بحسابك للدخول.' }, 400);
                }
                if (!checkPass(user)) {
                    return sendJson({ success: false, error: 'كلمة المرور غير صحيحة! يرجى التأكد من كلمة المرور والمحاولة مجدداً.' }, 401);
                }
            }

            const id = user.driverId || user.customerId;
            const token = `jwt_${userRole.toLowerCase()}_` + id;
            return sendJson({
                success: true,
                token,
                userId: id,
                role: userRole,
                fullName: user.fullName || (userRole === 'Driver' ? 'كابتن توصيله' : 'راكب توصيله'),
                user: {
                    id,
                    phoneNumber: user.phoneNumber,
                    email: user.email,
                    fullName: user.fullName,
                    role: userRole,
                    status: user.status || 'Active',
                    isVerified: !!user.isVerified
                }
            });
        }

        if (pathname === '/api/auth/register' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { phoneNumber, fullName, role, licenseNumber } = body;
            const targetRole = role || 'Customer';
            const now = new Date().toISOString();

            // Iraqi Phone Normalization & Cross-Role Check
            const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
            let norm = String(phoneNumber || '').replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
            if (norm.startsWith('00964')) norm = norm.substring(5);
            else if (norm.startsWith('964')) norm = norm.substring(3);
            if (norm.length === 10 && norm.startsWith('7')) norm = '0' + norm;

            const cleanPhone = (p) => {
                if (!p) return '';
                let s = String(p).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
                if (s.startsWith('00964')) s = s.substring(5);
                else if (s.startsWith('964')) s = s.substring(3);
                if (s.length === 10 && s.startsWith('7')) s = '0' + s;
                return s;
            };

            const existsInDrivers = (db.memoryState.drivers || []).some(d => cleanPhone(d.phoneNumber) === norm || (norm.length >= 6 && cleanPhone(d.phoneNumber).endsWith(norm)));
            const existsInCustomers = (db.memoryState.customers || []).some(c => cleanPhone(c.phoneNumber) === norm || (norm.length >= 6 && cleanPhone(c.phoneNumber).endsWith(norm)));
            if (norm.length >= 6 && (existsInDrivers || existsInCustomers)) {
                return sendJson({
                    success: false,
                    duplicate: true,
                    error: 'الرقم مسجل بالفعل، يرجى إدخال رقم هاتف آخر.'
                }, 400);
            }

            if (targetRole === 'Driver') {
                const driverId = 'drv-' + Math.random().toString(36).substr(2, 9);
                const newDriver = {
                    driverId,
                    fullName: fullName || 'كابتن جديد',
                    phoneNumber: phoneNumber || '07800000000',
                    licenseNumber: licenseNumber || 'IRQ-NJF-1000',
                    status: 'Pending',
                    isVerified: false,
                    isBlocked: false,
                    createdAt: now
                };

                const initialDoc = {
                    documentId: 'doc-' + driverId,
                    driverId,
                    documentType: 'DrivingLicense',
                    filePath: '/images/license-placeholder.jpg',
                    fileUrl: '/images/license-placeholder.jpg',
                    status: 'Pending',
                    submittedAt: now
                };

                db.memoryState.drivers.unshift(newDriver);
                db.memoryState.verifications.unshift(initialDoc);

                if (db.isPostgresConnected && db.pool) {
                    try {
                        await db.pool.query(`
                            INSERT INTO users (id, phone_number, full_name, role, is_active, is_blocked, created_at)
                            VALUES ($1, $2, $3, 'Driver', true, false, $4)
                        `, [driverId, newDriver.phoneNumber, newDriver.fullName, now]);

                        await db.pool.query(`
                            INSERT INTO drivers (driver_id, full_name, phone_number, license_number, status, is_verified, is_blocked, created_at)
                            VALUES ($1, $2, $3, $4, 'Pending', false, false, $5)
                        `, [driverId, newDriver.fullName, newDriver.phoneNumber, newDriver.licenseNumber, now]);

                        await db.pool.query(`
                            INSERT INTO driver_documents (document_id, driver_id, document_type, file_path, file_url, status, submitted_at)
                            VALUES ($1, $2, $3, $4, $5, 'Pending', $6)
                        `, [initialDoc.documentId, driverId, initialDoc.documentType, initialDoc.filePath, initialDoc.fileUrl, now]);
                    } catch (e) {}
                }

                db.saveStateSnapshot();
                const token = 'jwt_driver_' + driverId;
                return sendJson({
                    success: true,
                    token,
                    user: { id: driverId, fullName: newDriver.fullName, role: 'Driver', status: 'Pending' }
                });
            } else {
                const customerId = 'usr-' + Math.random().toString(36).substr(2, 9);
                const newCustomer = {
                    customerId,
                    fullName: fullName || 'مستخدم جديد',
                    phoneNumber: phoneNumber || '',
                    preferredPaymentMethod: 'Cash',
                    ratingAverage: 5.0,
                    totalBookings: 0,
                    isActive: true,
                    isBlocked: false,
                    registeredAt: now
                };

                db.memoryState.customers.unshift(newCustomer);
                if (db.isPostgresConnected && db.pool) {
                    try {
                        await db.pool.query(`
                            INSERT INTO users (id, phone_number, full_name, role, is_active, is_blocked, created_at)
                            VALUES ($1, $2, $3, 'Customer', true, false, $4)
                        `, [customerId, newCustomer.phoneNumber, newCustomer.fullName, now]);

                        await db.pool.query(`
                            INSERT INTO customers (customer_id, full_name, phone_number, preferred_payment_method, is_active, is_blocked, created_at)
                            VALUES ($1, $2, $3, 'Cash', true, false, $4)
                        `, [customerId, newCustomer.fullName, newCustomer.phoneNumber, now]);
                    } catch (e) {}
                }

                db.saveStateSnapshot();
                const token = 'jwt_customer_' + customerId;
                return sendJson({
                    success: true,
                    token,
                    user: { id: customerId, fullName: newCustomer.fullName, role: 'Customer', status: 'Active' }
                });
            }
        }

        if (pathname === '/api/auth/me') {
            const authHeader = req.headers['authorization'] || '';
            const token = authHeader.replace('Bearer ', '').trim();
            if (!token) return sendJson({ success: false, error: 'Unauthenticated' }, 401);

            const parts = token.split('_');
            const role = parts[1] === 'driver' ? 'Driver' : (parts[1] === 'customer' ? 'Customer' : null);
            const id = parts.slice(2).join('_') || parts.slice(1).join('_');

            let driver = db.memoryState.drivers.find(d => d.driverId === id || token.includes(d.driverId));
            if (!driver && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query('SELECT * FROM drivers WHERE driver_id = $1 LIMIT 1', [id]);
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        const row = pgRes.rows[0];
                        driver = {
                            driverId: row.driver_id,
                            fullName: row.full_name,
                            phoneNumber: row.phone_number,
                            email: row.email,
                            status: row.status,
                            isVerified: row.is_verified,
                            isBlocked: row.is_blocked,
                            vehicleMake: row.vehicle_make,
                            vehiclePlate: row.vehicle_plate
                        };
                        db.memoryState.drivers.unshift(driver);
                    }
                } catch (_) {}
            }
            if (driver) {
                const driverRoute = db.memoryState.routes.find(r => r.driverId === driver.driverId);
                return sendJson({
                    success: true,
                    user: {
                        id: driver.driverId,
                        fullName: driver.fullName,
                        phoneNumber: driver.phoneNumber,
                        email: driver.email,
                        role: 'Driver',
                        status: driver.status,
                        isVerified: driver.isVerified,
                        isBlocked: driver.isBlocked,
                        vehicleMake: driver.vehicleMake,
                        vehicleModel: driver.vehicleModel,
                        vehiclePlate: driver.vehiclePlate,
                        vehicleYear: driver.vehicleYear,
                        vehicleInfo: `${driver.vehicleMake || 'تويوتا'} (${driver.vehiclePlate || 'النجف'})`,
                        route: driverRoute || null
                    }
                });
            }

            const customer = db.memoryState.customers.find(c => c.customerId === id || token.includes(c.customerId));
            if (customer) {
                return sendJson({
                    success: true,
                    user: {
                        id: customer.customerId,
                        fullName: customer.fullName,
                        phoneNumber: customer.phoneNumber,
                        email: customer.email,
                        role: 'Customer',
                        status: 'Active',
                        isBlocked: customer.isBlocked
                    }
                });
            }

            return sendJson({ success: false, error: 'User not found' }, 404);
        }

        // ---------------------------------------------------------------------
        // 2. ADMIN API ROUTES
        // ---------------------------------------------------------------------
        if (pathname === '/api/admin/stats' || pathname === '/api/admin/metrics' || pathname === '/api/admin/counters') {
            const resData = await adminController.getStats();
            return sendJson(resData.stats);
        }

        if (pathname === '/api/admin/notifications') {
            const resData = await adminController.getNotifications();
            return sendJson(resData);
        }

        if ((pathname === '/api/notifications/send' || pathname === '/api/admin/notifications/send') && method === 'POST') {
            const body = await parseJsonBody(req);
            const notif = {
                id: 'notif-' + Date.now(),
                title: body.title || 'إشعار جديد',
                message: body.message || '',
                target: body.target || 'all',
                createdAt: new Date().toISOString()
            };
            db.memoryState.notifications = db.memoryState.notifications || [];
            db.memoryState.notifications.unshift(notif);
            return sendJson({ success: true, notification: notif });
        }

        if (pathname === '/api/admin/drivers/pending-verifications') {
            const pending = await adminController.getPendingVerifications();
            return sendJson(pending);
        }

        if (pathname.startsWith('/api/documents/') && pathname.endsWith('/signed-url')) {
            const parts = pathname.split('/');
            const docId = parts[parts.length - 2];
            const doc = db.memoryState.verifications.find(v => v.documentId === docId || v.driverId === docId);
            return sendJson({
                signedUrl: doc ? (doc.fileUrl || doc.filePath) : '/images/license-placeholder.jpg',
                documentId: docId
            });
        }

        if (pathname.startsWith('/api/admin/documents/') && pathname.endsWith('/verify') && method === 'POST') {
            const parts = pathname.split('/');
            const docId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.verifyDocument(docId, body.approved !== false, body.rejectionReason);
            return sendJson(result);
        }

        // Driver Status Endpoint: POST /api/admin/drivers/:id/status or /api/drivers/:id/status
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && pathname.endsWith('/status') && method === 'POST') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.setDriverStatus(driverId, body.status, body.reason);
            return sendJson(result);
        }

        // Driver Block Endpoint: POST /api/admin/drivers/:id/block or /api/drivers/:id/block
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && pathname.endsWith('/block') && method === 'POST') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.toggleDriverBlock(driverId, body.block !== false);
            return sendJson(result);
        }

        // Driver Delete (Cascade): DELETE /api/admin/drivers/:id or /api/drivers/:id
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && method === 'DELETE') {
            const driverId = pathname.replace('/api/admin/drivers/', '').replace('/api/drivers/', '').trim();
            const result = await adminController.deleteDriver(driverId);
            return sendJson(result);
        }

        // Driver Get By ID: GET /api/admin/drivers/:id or /api/drivers/:id
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && method === 'GET' && !pathname.includes('/block') && !pathname.includes('/status')) {
            const driverId = pathname.replace('/api/admin/drivers/', '').replace('/api/drivers/', '').trim();
            const result = await adminController.getDriverById(driverId);
            if (!result.success && result.error) {
                return sendJson(result, 404);
            }
            return sendJson(result);
        }

        // Drivers List: GET /api/admin/drivers
        if ((pathname === '/api/admin/drivers' || pathname === '/api/admin/admin/drivers' || pathname === '/api/drivers') && method === 'GET') {
            const search = parsedUrl.searchParams.get('search') || '';
            const result = await adminController.getDrivers(search);
            return sendJson(result);
        }

        // Driver Create (Admin): POST /api/admin/drivers
        if ((pathname === '/api/admin/drivers' || pathname === '/api/admin/admin/drivers' || pathname === '/api/drivers') && method === 'POST') {
            const body = await parseJsonBody(req);
            const result = await adminController.createDriver(body);
            return sendJson(result, result.success ? 201 : 400);
        }

        // Driver Update: POST /api/admin/drivers/:id/update or /api/drivers/:id/update
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && pathname.endsWith('/update') && method === 'POST') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.updateDriver(driverId, body);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Customer Block Endpoint: POST /api/admin/customers/:id/block
        if (pathname.startsWith('/api/admin/customers/') && pathname.endsWith('/block') && method === 'POST') {
            const parts = pathname.split('/');
            const customerId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.toggleCustomerBlock(customerId, body.block !== false);
            return sendJson(result);
        }

        // Customer Update: POST /api/admin/customers/:id/update or /api/customers/:id/update
        if ((pathname.startsWith('/api/admin/customers/') || pathname.startsWith('/api/customers/')) && pathname.endsWith('/update') && method === 'POST') {
            const parts = pathname.split('/');
            const customerId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.updateCustomer(customerId, body);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Customer Delete (Cascade): DELETE /api/admin/customers/:id
        if (pathname.startsWith('/api/admin/customers/') && method === 'DELETE') {
            const customerId = pathname.replace('/api/admin/customers/', '').trim();
            const result = await adminController.deleteCustomer(customerId);
            return sendJson(result);
        }

        // Customers List: GET /api/admin/customers
        if (pathname === '/api/admin/customers' && method === 'GET') {
            const search = parsedUrl.searchParams.get('search') || '';
            const result = await adminController.getCustomers(search);
            return sendJson(result);
        }

        // Routes & Bookings
        if (pathname === '/api/admin/routes') {
            const result = await adminController.getRoutes();
            return sendJson(result.routes);
        }

        if (pathname === '/api/admin/bookings') {
            const result = await adminController.getBookings();
            return sendJson(result.bookings);
        }

        // Complaints
        if (pathname === '/api/admin/complaints' && method === 'GET') {
            const result = await adminController.getComplaints();
            return sendJson(result.complaints);
        }

        if (pathname.startsWith('/api/admin/complaints/') && pathname.endsWith('/status') && method === 'POST') {
            const parts = pathname.split('/');
            const complaintId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.updateComplaint(complaintId, body.status, body.resolutionNotes);
            return sendJson(result);
        }

        // Settings
        if (pathname === '/api/admin/settings' && method === 'GET') {
            const result = await adminController.getSettings();
            return sendJson(result.settings);
        }

        if (pathname.startsWith('/api/admin/settings/') && method === 'POST') {
            const key = pathname.replace('/api/admin/settings/', '').trim();
            const body = await parseJsonBody(req);
            const result = await adminController.updateSetting(key, body.valueJson || body);
            return sendJson(result);
        }

        // Audit Logs
        if (pathname === '/api/admin/audit-logs') {
            const result = await adminController.getAuditLogs();
            return sendJson(result.logs);
        }

        // ---------------------------------------------------------------------
        // 3. BACKUP & RESTORE API
        // ---------------------------------------------------------------------
        if ((pathname === '/api/admin/backup' || pathname === '/api/admin/backup/export') && (method === 'GET' || method === 'POST')) {
            try {
                const backup = await adminController.exportBackup();
                return sendJson(backup);
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        if ((pathname === '/api/admin/restore' || pathname === '/api/admin/backup/restore') && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const result = await adminController.restoreBackup(body);
                return sendJson(result);
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 400);
            }
        }

        // ---------------------------------------------------------------------
        // 4. FLEET, MATCHING & ROUTING APIS
        // ---------------------------------------------------------------------
        if (pathname === '/api/admin/fleet/live' || pathname === '/api/drivers/nearby') {
            const lat = parseFloat(parsedUrl.searchParams.get('lat') || config.najafDefaults.latitude);
            const lon = parseFloat(parsedUrl.searchParams.get('lon') || config.najafDefaults.longitude);
            
            const activeDrivers = db.memoryState.drivers
                .filter(d => !d.isBlocked && (d.isVerified || d.status === 'Approved' || d.status === 'Online'))
                .map((d, idx) => ({
                    driverId: d.driverId,
                    driverName: d.fullName || 'كابتن توصيله',
                    fullName: d.fullName || 'كابتن توصيله',
                    phone: d.phoneNumber || '07800000000',
                    phoneNumber: d.phoneNumber || '07800000000',
                    rating: d.ratingAverage || 5.0,
                    vehicleInfo: `${d.vehicleMake || 'تويوتا'} ${d.vehicleModel || 'كورولا'} (${d.vehiclePlate || 'النجف'})`,
                    carModel: d.vehicleMake ? `${d.vehicleMake} ${d.vehicleModel || ''}` : 'تويوتا كورولا',
                    plateNumber: d.vehiclePlate || 'النجف',
                    latitude: d.currentLat ? parseFloat(d.currentLat) : (lat + (idx % 2 === 0 ? 0.003 * (idx + 1) : -0.003 * (idx + 1))),
                    longitude: d.currentLon ? parseFloat(d.currentLon) : (lon + (idx % 2 === 0 ? 0.002 * (idx + 1) : -0.002 * (idx + 1))),
                    heading: d.heading || (idx * 45) % 360,
                    status: d.tripStatus || 'Online',
                    speedKmh: d.speedKmh || Math.floor(25 + Math.random() * 30)
                }));

            return sendJson(activeDrivers);
        }

        // Driver Live Location Update Broadcast
        if (pathname === '/api/driver/location' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { driverId, latitude, longitude, heading, speedKmh, tripStatus } = body;
            const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
            if (driver) {
                driver.currentLat = latitude;
                driver.currentLon = longitude;
                if (heading !== undefined) driver.heading = heading;
                if (speedKmh !== undefined) driver.speedKmh = speedKmh;
                if (tripStatus !== undefined) driver.tripStatus = tripStatus;
                driver.lastLocationUpdate = new Date().toISOString();
            }
            return sendJson({ success: true, updated: !!driver });
        }

        // Single Driver Live Position (for Passenger Real-time Tracking)
        if (pathname.startsWith('/api/driver/') && pathname.endsWith('/live') && method === 'GET') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
            if (!driver) {
                return sendJson({
                    driverId,
                    latitude: 31.9961 + (Math.random() * 0.005),
                    longitude: 44.3168 + (Math.random() * 0.005),
                    speedKmh: 35,
                    status: 'moving'
                });
            }
            return sendJson({
                driverId: driver.driverId,
                driverName: driver.fullName,
                phone: driver.phoneNumber,
                latitude: driver.currentLat || 31.9961,
                longitude: driver.currentLon || 44.3168,
                heading: driver.heading || 0,
                speedKmh: driver.speedKmh || 30,
                status: driver.tripStatus || 'moving'
            });
        }

        // Driver Bookings (Subscribed passengers for this driver)
        if (pathname.startsWith('/api/driver/') && pathname.endsWith('/bookings') && method === 'GET') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            let driverBookings = (db.memoryState.bookings || [])
                .filter(b => b.driverId === driverId || !b.driverId || b.driverId === 'drv-sample');
            
            // If empty, link registered customers so driver immediately has route points
            if (!driverBookings.length && db.memoryState.customers && db.memoryState.customers.length > 0) {
                driverBookings = db.memoryState.customers.slice(0, 3).map((c, i) => ({
                    id: 'bk-cust-' + (i + 1),
                    bookingId: 'bk-cust-' + (i + 1),
                    driverId: driverId,
                    customerId: c.customerId,
                    customerName: c.fullName || 'راكب مشترك',
                    customerPhone: c.phoneNumber || '07800000000',
                    pickupLocation: c.address || 'حي الأمير - النجف الأشرف',
                    dropoffLocation: 'جامعة الكوفة - مجمع الكليات',
                    pickupLat: 31.9961 + (i === 0 ? 0.004 : (i === 1 ? -0.003 : 0.002)),
                    pickupLon: 44.3168 + (i === 0 ? 0.003 : (i === 1 ? 0.004 : -0.002)),
                    dropoffLat: 32.0321,
                    dropoffLon: 44.3725,
                    seatsBooked: 1,
                    status: 'Confirmed'
                }));
            }
            return sendJson(driverBookings);
        }

        if (pathname === '/api/matching/find-routes' || pathname === '/api/driver/routes' || pathname === '/api/routes') {
            const activeRoutes = (db.memoryState.routes || [])
                .filter(r => r.status === 'Active' || !r.status)
                .map(r => ({
                    driverRouteId: r.id || r.routeId,
                    id: r.id || r.routeId,
                    driverId: r.driverId,
                    driverName: r.driverName || 'كابتن توصيله',
                    driverPhone: r.driverPhone || '',
                    driverRating: 5.0,
                    routeName: r.routeName || `${r.startName || 'نقطة الانطلاق'} ➔ ${r.endName || 'نقطة الوصول'}`,
                    startName: r.startName || 'نقطة الانطلاق',
                    endName: r.endName || 'نقطة الوصول',
                    startLat: parseFloat(r.startLat || 31.9961),
                    startLon: parseFloat(r.startLon || 44.3168),
                    endLat: parseFloat(r.endLat || 32.0321),
                    endLon: parseFloat(r.endLon || 44.3725),
                    pricePerSeat: parseFloat(r.fare || 3000),
                    fare: parseFloat(r.fare || 3000),
                    availableSeats: parseInt(r.availableSeats || 4, 10),
                    totalSeats: parseInt(r.totalSeats || 4, 10),
                    departureTime: r.departureTime || '08:00 ص',
                    status: r.status || 'Active',
                    createdAt: r.createdAt
                }));

            // If client asks for direct array or JSON object, return array (matches Flutter dio)
            return sendJson(activeRoutes);
        }

        // Customer Book Route Endpoint
        if ((pathname === '/api/customer/book-route' || pathname === '/api/bookings') && method === 'POST') {
            const body = await parseJsonBody(req);
            const routeId = body.routeId || body.driverRouteId;
            const targetRoute = (db.memoryState.routes || []).find(r => (r.id === routeId || r.routeId === routeId));
            
            const seats = Math.max(1, parseInt(body.seats || 1, 10));
            if (targetRoute && targetRoute.availableSeats < seats) {
                return sendJson({ success: false, error: 'عذراً، لا تتوفر مقاعد شاغرة كافية في هذا الخط.' }, 400);
            }

            if (targetRoute) {
                targetRoute.availableSeats = Math.max(0, targetRoute.availableSeats - seats);
            }

            const bookingId = 'bk-' + Math.random().toString(36).substr(2, 9);
            const now = new Date().toISOString();
            const farePerSeat = targetRoute ? parseFloat(targetRoute.fare || 3000) : 3000;
            const totalFare = farePerSeat * seats;

            const newBooking = {
                id: bookingId,
                bookingId: bookingId,
                routeId: routeId || null,
                driverId: targetRoute ? targetRoute.driverId : (body.driverId || 'drv-sample'),
                driverName: targetRoute ? targetRoute.driverName : (body.driverName || 'كابتن توصيله'),
                driverPhone: targetRoute ? targetRoute.driverPhone : (body.driverPhone || '07801234567'),
                customerId: body.customerId || ('cust-' + Math.random().toString(36).substr(2, 7)),
                customerName: body.customerName || body.fullName || 'راكب توصيله',
                customerPhone: body.customerPhone || body.phoneNumber || '',
                pickupLocation: body.pickupLocation || body.pickup || (targetRoute ? targetRoute.startName : 'ساحة ثورة العشرين'),
                dropoffLocation: body.dropoffLocation || body.destination || (targetRoute ? targetRoute.endName : 'جامعة الكوفة'),
                pickupLat: parseFloat(body.pickupLat || (targetRoute ? targetRoute.startLat : 31.9961)),
                pickupLon: parseFloat(body.pickupLon || (targetRoute ? targetRoute.startLon : 44.3168)),
                dropoffLat: parseFloat(body.dropoffLat || (targetRoute ? targetRoute.endLat : 32.0321)),
                dropoffLon: parseFloat(body.dropoffLon || (targetRoute ? targetRoute.endLon : 44.3725)),
                seatsBooked: seats,
                fare: totalFare,
                totalFare: totalFare,
                status: 'Confirmed',
                createdAt: now
            };

            db.memoryState.bookings = db.memoryState.bookings || [];
            db.memoryState.bookings.unshift(newBooking);

            // Increment customer booking count
            const cust = (db.memoryState.customers || []).find(c => c.customerId === newBooking.customerId || c.phoneNumber === newBooking.customerPhone);
            if (cust) {
                cust.totalBookings = (cust.totalBookings || 0) + 1;
            }

            if (db.isPostgresConnected && db.pool) {
                try {
                    // Ensure user & customer exist in DB for FK integrity
                    await db.pool.query(`
                        INSERT INTO users (id, phone_number, full_name, role, created_at)
                        VALUES ($1, $2, $3, 'Customer', $4)
                        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
                    `, [newBooking.customerId, newBooking.customerPhone, newBooking.customerName, now]);

                    await db.pool.query(`
                        INSERT INTO customers (customer_id, full_name, phone_number, created_at)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (customer_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
                    `, [newBooking.customerId, newBooking.customerName, newBooking.customerPhone, now]);

                    // Validate routeId exists in routes table
                    let validRouteId = null;
                    if (newBooking.routeId) {
                        const rCheck = await db.pool.query('SELECT id FROM routes WHERE id = $1', [newBooking.routeId]);
                        if (rCheck.rows.length > 0) validRouteId = newBooking.routeId;
                    }

                    // Validate driverId exists in drivers table
                    let validDriverId = null;
                    if (newBooking.driverId) {
                        const dCheck = await db.pool.query('SELECT driver_id FROM drivers WHERE driver_id = $1', [newBooking.driverId]);
                        if (dCheck.rows.length > 0) validDriverId = newBooking.driverId;
                    }

                    await db.pool.query(`
                        INSERT INTO bookings (
                            id, route_id, customer_id, customer_name, driver_id, driver_name,
                            pickup_name, dropoff_name, pickup_lat, pickup_lon, dropoff_lat, dropoff_lon,
                            total_fare, seats_booked, status, created_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                        ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status
                    `, [
                        bookingId, validRouteId, newBooking.customerId, newBooking.customerName,
                        validDriverId, newBooking.driverName, newBooking.pickupLocation,
                        newBooking.dropoffLocation, newBooking.pickupLat, newBooking.pickupLon,
                        newBooking.dropoffLat, newBooking.dropoffLon, totalFare, seats, 'Confirmed', now
                    ]);
                } catch (e) {
                    console.error('[Server] PG Booking insert error:', e);
                }
            }

            db.addAuditLog('SeatBooked', 'Customer', newBooking.customerId, {
                bookingId,
                driverName: newBooking.driverName,
                route: `${newBooking.pickupLocation} ➔ ${newBooking.dropoffLocation}`,
                seats,
                totalFare
            });

            db.saveStateSnapshot();

            return sendJson({
                success: true,
                message: 'تم حجز مقعدك بنجاح! تم إشعار الكابتن وسيتم التواصل معك لتأكيد موعد الانطلاق.',
                booking: newBooking
            });
        }

        if (pathname === '/api/bookings' && method === 'GET') {
            return sendJson(db.memoryState.bookings || []);
        }

        if (pathname === '/api/routing/route') {
            return sendJson({
                success: true,
                distanceMeters: 8500,
                durationSeconds: 900,
                geometry: [[31.9961, 44.3168], [32.0321, 44.3725]]
            });
        }

        if (pathname === '/api/routing/search-address') {
            return sendJson({
                success: true,
                locations: [
                    { name: "ساحة ثورة العشرين", lat: 31.9961, lon: 44.3168 },
                    { name: "جامعة الكوفة", lat: 32.0321, lon: 44.3725 },
                    { name: "مطار النجف الأشرف الدولي", lat: 31.9897, lon: 44.4042 },
                    { name: "مرقد الإمام علي (ع)", lat: 31.9957, lon: 44.3143 }
                ]
            });
        }

        if (pathname === '/api/pricing/estimate') {
            return sendJson({
                success: true,
                baseFare: 2500,
                distanceFare: 3400,
                totalFare: 5900,
                currency: "IQD"
            });
        }

        if (pathname === '/api/ads/vacancies') {
            if (method === 'GET') {
                return sendJson(db.memoryState.vacancyAds || []);
            }
            if (method === 'POST') {
                const body = await parseJsonBody(req);
                const newAd = {
                    id: 'ad-' + Math.random().toString(36).substr(2, 8),
                    driverId: body.driverId || 'drv-sample',
                    driverName: body.driverName || 'كابتن توصيله',
                    driverPhone: body.driverPhone || '07801234567',
                    vehicleModel: body.vehicleModel || 'تويوتا كورولا',
                    plateNumber: body.plateNumber || 'النجف 1029',
                    rating: 4.9,
                    fromLocation: body.fromLocation || 'مركز النجف',
                    toLocation: body.toLocation || 'الكوفة',
                    departureDate: body.departureDate || 'اليوم',
                    departureTime: body.departureTime || '08:00 ص',
                    availableSeats: body.availableSeats || 3,
                    totalSeats: body.totalSeats || 4,
                    pricePerSeatIqd: body.pricePerSeatIqd || 3000,
                    notes: body.notes || '',
                    status: 'Open',
                    createdAt: new Date().toISOString()
                };
                db.memoryState.vacancyAds = db.memoryState.vacancyAds || [];
                db.memoryState.vacancyAds.unshift(newAd);
                db.saveStateSnapshot();
                return sendJson(newAd);
            }
        }

        if (pathname.startsWith('/uploads/')) {
            const uploadFile = path.join(config.uploadsDir, pathname.replace(/^\/uploads\//, ''));
            if (fs.existsSync(uploadFile)) {
                return serveCompressedFile(uploadFile, req, res);
            }
            res.writeHead(404);
            return res.end('File not found');
        }

        // ---------------------------------------------------------------------
        // 5. FLUTTER WEB APP SERVING (/app, /app/*, /)
        // ---------------------------------------------------------------------
        const hostHeader = (req.headers.host || '').toLowerCase();
        const isTawseelaDomain = hostHeader.includes('tawseelaiq.app');

        const isAppPath = pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/');
        const isRootOrAppOnTawseela = isTawseelaDomain && (pathname === '/' || !pathname.startsWith('/dashboard'));

        if (isAppPath || isRootOrAppOnTawseela) {
            let rel = pathname;
            if (pathname.startsWith('/app/')) {
                rel = pathname.replace(/^\/app\//, '');
            } else if (pathname === '/app') {
                rel = 'index.html';
            } else if (isTawseelaDomain && pathname.startsWith('/')) {
                rel = pathname.replace(/^\//, '');
            }

            if (!rel || rel === '') rel = 'index.html';

            const candidates = [
                path.join(config.flutterWebDir, rel),
                path.join(__dirname, '..', '..', 'apps', 'taxi_wisam_flutter', 'build', 'web', rel),
                path.join('/var/www/taxi-wisam/build/web', rel),
                path.join(__dirname, '..', '..', 'build', 'web', rel)
            ];

            let target = candidates.find(c => fs.existsSync(c));
            if (target && fs.statSync(target).isDirectory()) {
                const subIndex = path.join(target, 'index.html');
                if (fs.existsSync(subIndex)) target = subIndex;
            }

            // SPA Fallback
            if (!target || !fs.existsSync(target)) {
                const indexFallbacks = [
                    path.join(config.flutterWebDir, 'index.html'),
                    path.join(__dirname, '..', '..', 'apps', 'taxi_wisam_flutter', 'build', 'web', 'index.html'),
                    path.join('/var/www/taxi-wisam/build/web', 'index.html'),
                    path.join(__dirname, '..', '..', 'build', 'web', 'index.html')
                ];
                target = indexFallbacks.find(c => fs.existsSync(c));
            }

            if (target && fs.existsSync(target)) {
                return serveCompressedFile(target, req, res);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('تطبيق الويب قيد التجهيز...');
            }
        }

        // ---------------------------------------------------------------------
        // 6. DASHBOARD UI STATIC SERVING (/dashboard, /dashboard/*)
        // ---------------------------------------------------------------------
        if (pathname === '/dashboard') {
            res.writeHead(301, { 'Location': '/dashboard/' });
            return res.end();
        }

        let dashPath = pathname;
        if (dashPath === '/' || dashPath === '/dashboard/') {
            dashPath = 'index.html';
        } else {
            dashPath = dashPath.replace(/^\/dashboard\//, '');
        }

        let dashFile = path.join(config.dashboardDir, dashPath);
        if (!fs.existsSync(dashFile) || fs.statSync(dashFile).isDirectory()) {
            dashFile = path.join(config.dashboardDir, 'index.html');
        }

        return serveCompressedFile(dashFile, req, res);
    });

    server.listen(config.port, () => {
        console.log(`\n========================================================`);
        console.log(`🚖 Taxi-Wisam Unified Web Server (PostgreSQL Engine)`);
        console.log(`🔗 Port:          ${config.port}`);
        console.log(`🔗 Web App:       http://localhost:${config.port}/app/`);
        console.log(`🔗 Dashboard:     http://localhost:${config.port}/dashboard/index.html`);
        console.log(`========================================================\n`);
    });
}

if (require.main === module) {
    startServer().catch(err => {
        console.error('Fatal server boot error:', err);
        process.exit(1);
    });
}

module.exports = { startServer };
