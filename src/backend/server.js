const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const config = require('./config');
const db = require('./db');
const authController = require('./modules/auth/authController');
const adminController = require('./modules/admin/adminController');
const whatsappService = require('./modules/whatsapp/whatsappService');
const telegramBot = require('./modules/telegram/telegramBot');

// ---[ Rate Limiter: in-memory, per IP ]---
const _rateLimitMap = new Map(); // ip -> { count, resetAt }
function _rateLimit(key, maxRequests = 60, windowMs = 60000) {
    const now = Date.now();
    let entry = _rateLimitMap.get(key);
    if (!entry || now > entry.resetAt) {
        entry = { count: 1, resetAt: now + windowMs };
        _rateLimitMap.set(key, entry);
        return false;
    }
    entry.count++;
    return entry.count > maxRequests;
}

// Dedicated namespaced rate limiters
function _authRateLimit(ip) { 
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return false;
    return _rateLimit(`auth:${ip}`, 30, 60000); 
}

function _otpRateLimit(phone, ip) {
    const cleanP = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanP && _rateLimit(`otp_phone:${cleanP}`, 6, 600000)) {
        return true;
    }
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        if (_rateLimit(`otp_ip:${ip}`, 30, 600000)) return true;
    }
    return false;
}

// Cleanup every 5 min to prevent memory leak
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _rateLimitMap) { if (now > v.resetAt) _rateLimitMap.delete(k); }
}, 300000);

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

function sanitizeObject(obj) {
    if (typeof obj === 'string') {
        return obj.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
    } else if (Array.isArray(obj)) {
        return obj.map(sanitizeObject);
    } else if (obj !== null && typeof obj === 'object') {
        const newObj = {};
        for (const key in obj) {
            newObj[key] = sanitizeObject(obj[key]);
        }
        return newObj;
    }
    return obj;
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
                const parsed = body ? JSON.parse(body) : {};
                resolve(sanitizeObject(parsed));
            } catch (e) {
                resolve({});
            }
        });
    });
}

async function startServer() {
    // 1. Initialize PostgreSQL & Database state
    await db.init();
    try { telegramBot.startBot(); } catch(e) { console.error('[TelegramBot] Start error:', e.message); }

    const server = http.createServer(async (req, res) => {
        // ---[ Security Headers ]---
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

        // Set default CORS (restricted to known origins in production)
        const allowedOrigins = ['https://tawseelaiq.app', 'https://www.tawseelaiq.app', 'http://localhost:5050', 'http://173.212.206.86'];
        const reqOrigin = req.headers['origin'] || '';
        if (allowedOrigins.includes(reqOrigin) || !reqOrigin) {
            res.setHeader('Access-Control-Allow-Origin', reqOrigin || '*');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            return res.end();
        }

        // ---[ Global Rate Limit: 300 req/min per IP ]---
        const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (clientIp && clientIp !== '127.0.0.1' && clientIp !== '::1' && clientIp !== '::ffff:127.0.0.1') {
            if (_rateLimit(`req:${clientIp}`, 300, 60000)) {
                res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
                return res.end(JSON.stringify({ success: false, error: 'Too Many Requests - حاول بعد دقيقة' }));
            }
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
        // 0. HEALTH CHECK & SEO / AGENTIC FILES
        // ---------------------------------------------------------------------
        if (pathname === '/robots.txt') {
            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'public, max-age=86400'
            });
            return res.end('User-agent: *\nAllow: /\n');
        }

        if (pathname === '/llms.txt') {
            const llmsContent = `# منصة توصيلة (Tawseela IQ)
منصة حجز وتنظيم رحلات التوصيل اليومية والخطوط المنتظمة في محافظة النجف الأشرف.

## الخدمات المتاحة
- حجز رحلات يومية واشتراكات شهرية للركاب والطلاب والموظفين
- ربط مباشر بين السائقين المعتمدين والركاب
- تتبع وملاحة ذكية في النجف الأشرف
- تحقق فوري وأمان عالي عبر واتساب

## الروابط الرسمية
- الموقع الرسمي: https://tawseelaiq.app/
- بوابة الكباتن: https://tawseelaiq.app/captain-login
- لوحة التحكم: https://tawseelaiq.app/dashboard/
`;
            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'public, max-age=86400'
            });
            return res.end(llmsContent);
        }

        if (pathname === '/ai-catalog.json' || pathname === '/.well-known/ai-plugin.json') {
            const catalog = {
                schema_version: "v1",
                name_for_human: "منصة توصيلة",
                name_for_model: "tawseela_iq",
                description_for_human: "خدمة حجز وتنظيم رحلات التوصيل اليومية والسائقين في النجف الأشرف بسهولة وأمان.",
                description_for_model: "Platform for booking and organizing daily taxi routes, driver matching, and rides in Najaf, Iraq.",
                auth: { type: "none" },
                api: { type: "openapi", url: "https://tawseelaiq.app/api/health" },
                logo_url: "https://tawseelaiq.app/favicon.png",
                contact_email: "support@tawseelaiq.app",
                legal_info_url: "https://tawseelaiq.app/"
            };
            return sendJson(catalog, 200);
        }

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

        // ---------------------------------------------------------------------
        // Meta WhatsApp Cloud API Webhook Verification & Events
        // ---------------------------------------------------------------------
        if (pathname === '/api/webhook/whatsapp' || 
            pathname === '/webhook/whatsapp' || 
            pathname === '/api/webhook' ||
            pathname.startsWith('/api/webhook/whatsapp') ||
            pathname.startsWith('/webhook/whatsapp')) {

            if (method === 'GET') {
                const mode = parsedUrl.searchParams.get('hub.mode');
                const token = parsedUrl.searchParams.get('hub.verify_token');
                const challenge = parsedUrl.searchParams.get('hub.challenge');

                if (mode === 'subscribe' && (token === 'Musaonline33' || pathname.endsWith('/Musaonline33') || token === whatsappService.verifyToken)) {
                    console.log('[MetaWebhook] WhatsApp webhook verified successfully ✅');
                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                    return res.end(challenge || '');
                } else {
                    console.warn('[MetaWebhook] Verification failed. Token mismatch or bad mode:', { mode, token, pathname });
                    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                    return res.end('Verification token mismatch');
                }
            }

            if (method === 'POST') {
                try {
                    const body = await parseJsonBody(req);
                    console.log('[MetaWebhook] Received WhatsApp event:', JSON.stringify(body).slice(0, 150));
                    whatsappService.handleIncomingWebhook(body);
                } catch (e) {
                    console.error('[MetaWebhook] Error processing incoming webhook:', e.message);
                }
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('EVENT_RECEIVED');
            }
        }

        // WhatsApp OTP Endpoints for Registration (Web & Flutter App Aliases)
        if ((pathname === '/api/auth/send-whatsapp-otp' || pathname === '/auth/send-whatsapp-otp' || pathname === '/api/auth/send-otp' || pathname === '/auth/send-otp') && method === 'POST') {
            const body = await parseJsonBody(req);
            const phoneNumber = (body.phoneNumber || body.phone || '').trim();
            if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.length > 30) {
                return sendJson({ success: false, error: 'رقم الهاتف مطلوب' }, 400);
            }

            if (_otpRateLimit(phoneNumber, clientIp)) {
                res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
                return res.end(JSON.stringify({ success: false, error: 'تم إرسال عدة رسائل لهذا الرقم مؤخراً. يرجى الانتظار بضع دقائق.' }));
            }

            const parsed = whatsappService.parseIraqiPhone(phoneNumber);
            if (!parsed) {
                return sendJson({ success: false, error: 'يرجى إدخال رقم هاتف عراقي صالح (مثال: 07801234567 أو 07701234567)' }, 400);
            }

            const cleanPhone = (p) => {
                const pr = whatsappService.parseIraqiPhone(p);
                return pr ? pr.clean : '';
            };

            const existsInDrivers = (db.memoryState.drivers || []).some(d => cleanPhone(d.phoneNumber) === parsed.clean);
            const existsInCustomers = (db.memoryState.customers || []).some(c => cleanPhone(c.phoneNumber) === parsed.clean);
            if (existsInDrivers || existsInCustomers) {
                return sendJson({
                    success: false,
                    duplicate: true,
                    error: 'هذا الرقم مسجل بالفعل في المنصة، يمكنك الانتقال لتسجيل الدخول مباشرة.'
                }, 400);
            }

            const result = await whatsappService.sendOtp(phoneNumber);
            if (!result.success) {
                return sendJson({
                    success: false,
                    error: result.error || 'تعذر إرسال رمز التحقق عبر واتساب، يرجى المحاولة لاحقاً'
                }, 400);
            }

            return sendJson({
                success: true,
                message: 'تم إرسال رمز التحقق عبر واتساب بنجاح',
                phone: result.phone,
                normalized: result.normalized,
                otpDisplayUrl: `https://tawseelaiq.app/otp?phone=${result.phone}`
            });
        }

        if ((pathname === '/api/auth/verify-whatsapp-otp' || pathname === '/auth/verify-whatsapp-otp' || pathname === '/api/auth/verify-otp' || pathname === '/auth/verify-otp') && method === 'POST') {
            const body = await parseJsonBody(req);
            const phoneNumber = (body.phoneNumber || body.phone || '').trim();
            const code = (body.code || body.otp || '').trim();
            if (!phoneNumber || !code) {
                return sendJson({ success: false, error: 'رقم الهاتف ورمز التحقق مطلوبان' }, 400);
            }
            const verification = whatsappService.verifyOtp(phoneNumber, code);
            if (!verification.valid) {
                return sendJson({ success: false, error: verification.error }, 400);
            }
            return sendJson({ success: true, message: 'تم التحقق من الرمز بنجاح' });
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
            // Strict rate limit: 10 login attempts per IP per minute
            if (_authRateLimit(clientIp)) {
                res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
                return res.end(JSON.stringify({ success: false, error: 'محاولات كثيرة جداً. انتظر دقيقة قبل المحاولة مجدداً.' }));
            }

            const body = await parseJsonBody(req);
            // Cap inputs to prevent DoS via oversized payloads
            const identifier = (body.identifier || body.email || body.phoneNumber || '').toString().slice(0, 120).trim().toLowerCase();
            const password = body.password ? String(body.password).slice(0, 200) : '';
            const requestedRole = (body.role || '').toString().slice(0, 20) || null;
            const isGoogleAuth = !!body.isGoogleAuth;

            // Admin auth — requires password verification
            if (identifier === 'admin@taxiwisam.com' || identifier === 'admin') {
                const crypto = require('crypto');
                const adminPass = config.adminPassword || '1122';
                const cleanAdminPass = String(password).trim();
                const adminHash = crypto.createHash('sha256').update(adminPass).digest('hex');
                const attemptHash = crypto.createHash('sha256').update(cleanAdminPass).digest('hex');
                if (!password || (cleanAdminPass !== adminPass && attemptHash !== adminHash)) {
                    return sendJson({ success: false, error: 'كلمة مرور المدير غير صحيحة.' }, 401);
                }
                const adminToken = 'jwt_admin_' + crypto.randomBytes(16).toString('hex');
                return sendJson({
                    success: true,
                    token: adminToken,
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
                            plainPassword: row.plain_password || null,
                            passwordHash: row.password_hash || null,
                            status: row.status,
                            isVerified: row.is_verified,
                            isBlocked: row.is_blocked
                        };
                        if (!driver.passwordHash && !driver.plainPassword) {
                            try {
                                const uRes = await db.pool.query('SELECT password_hash, plain_password FROM users WHERE id = $1 LIMIT 1', [driver.driverId]);
                                if (uRes.rows && uRes.rows.length > 0) {
                                    driver.passwordHash = uRes.rows[0].password_hash || null;
                                    driver.plainPassword = uRes.rows[0].plain_password || null;
                                }
                            } catch (_) {}
                        }
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
                            plainPassword: row.plain_password || null,
                            passwordHash: row.password_hash || null,
                            isActive: row.is_active,
                            isBlocked: row.is_blocked,
                            ratingAverage: parseFloat(row.rating_average || 5.0),
                            totalBookings: row.total_bookings || 0
                        };
                        if (!customer.passwordHash && !customer.plainPassword) {
                            try {
                                const uRes = await db.pool.query('SELECT password_hash, plain_password FROM users WHERE id = $1 LIMIT 1', [customer.customerId]);
                                if (uRes.rows && uRes.rows.length > 0) {
                                    customer.passwordHash = uRes.rows[0].password_hash || null;
                                    customer.plainPassword = uRes.rows[0].plain_password || null;
                                }
                            } catch (_) {}
                        }
                        if (!db.memoryState.customers.some(c => c.customerId === customer.customerId)) {
                            db.memoryState.customers.unshift(customer);
                        }
                    }
                } catch (pgErr) {
                    console.error('[Auth] PG customer lookup error:', pgErr.message);
                }
            }

            const crypto = require('crypto');
            const cleanPass = String(password || '').trim();
            const hashedAttempt1 = crypto.createHash('sha256').update(String(password || '')).digest('hex');
            const hashedAttempt2 = crypto.createHash('sha256').update(cleanPass).digest('hex');

            let user = null;
            let userRole = null;

            if (requestedRole === 'Driver' || requestedRole === 'driver') {
                if (!driver) {
                    if (customer) {
                        return sendJson({
                            success: false,
                            roleMismatch: true,
                            error: 'هذا الحساب مسجل كراكب ولا يمكنه الدخول من بوابة الكباتن (السائقين). يرجى تسجيل الدخول من صفحة الركاب.'
                        }, 403);
                    }
                    return sendJson({
                        success: false,
                        notFound: true,
                        error: 'هذا الحساب غير مسجل كسائق في المنصة. يرجى إنشاء حساب كابتن أولاً.'
                    }, 404);
                }
                user = driver;
                userRole = 'Driver';
            } else if (requestedRole === 'Customer' || requestedRole === 'customer') {
                if (!customer) {
                    if (driver) {
                        return sendJson({
                            success: false,
                            roleMismatch: true,
                            error: 'هذا الحساب مسجل كسائق (كابتن) ولا يمكنه الدخول من بوابة الركاب. يرجى تسجيل الدخول من صفحة الكباتن.'
                        }, 403);
                    }
                    return sendJson({
                        success: false,
                        notFound: true,
                        error: 'هذا الحساب غير مسجل كراكب في المنصة. يرجى إنشاء حساب جديد أولاً.'
                    }, 404);
                }
                user = customer;
                userRole = 'Customer';
            } else {
                if (customer && !driver) {
                    user = customer;
                    userRole = 'Customer';
                } else if (driver && !customer) {
                    user = driver;
                    userRole = 'Driver';
                } else if (driver && customer) {
                    user = customer;
                    userRole = 'Customer';
                }
            }

            if (!user) {
                return sendJson({ success: false, notFound: true, error: 'هذا الحساب غير مسجل في المنصة. يرجى إنشاء حساب جديد أولاً.' }, 404);
            }

            // Fresh database sync for status/block if PostgreSQL is connected
            if (db.isPostgresConnected && db.pool) {
                try {
                    const tbl = userRole === 'Driver' ? 'drivers' : 'customers';
                    const col = userRole === 'Driver' ? 'driver_id' : 'customer_id';
                    const freshRes = await db.pool.query(`SELECT is_blocked, ${userRole === 'Driver' ? 'status, is_verified' : 'is_active'} FROM ${tbl} WHERE ${col} = $1 LIMIT 1`, [user.driverId || user.customerId]);
                    if (freshRes.rows && freshRes.rows.length > 0) {
                        const fr = freshRes.rows[0];
                        user.isBlocked = fr.is_blocked;
                        if (userRole === 'Driver') {
                            user.status = fr.status;
                            user.isVerified = fr.is_verified;
                        } else {
                            user.isActive = fr.is_active;
                        }
                    }
                } catch (_) {}
            }

            // Block & Suspension Enforcement
            const isUserBlocked = user.isBlocked === true || 
                                  user.isBlocked === 'true' || 
                                  user.isBlocked === 1 ||
                                  user.status === 'Suspended' || 
                                  user.status === 'Blocked' || 
                                  user.status === 'Rejected' || 
                                  user.isActive === false || 
                                  user.isActive === 'false' || 
                                  user.isActive === 0;

            if (isUserBlocked) {
                const blockMsg = userRole === 'Driver' 
                    ? 'تم حظر أو تعليق حساب الكابتن من قبل إدارة المنصة.' 
                    : 'تم تعليق هذا الحساب من قبل إدارة المنصة.';
                return sendJson({ success: false, isBlocked: true, error: blockMsg }, 403);
            }

            // Strict Password Verification
            if (!isGoogleAuth) {
                if (!password || cleanPass === '') {
                    return sendJson({ success: false, error: 'يرجى إدخال كلمة المرور الخاصة بحسابك للدخول.' }, 400);
                }

                const expectedPlain = user.plainPassword || (user.passwordHash ? null : '123456');
                const expectedHash = user.passwordHash || (expectedPlain ? crypto.createHash('sha256').update(expectedPlain).digest('hex') : null);

                let isMatch = false;
                if (expectedPlain && (cleanPass === expectedPlain || String(password) === expectedPlain)) {
                    isMatch = true;
                } else if (expectedHash && (hashedAttempt1 === expectedHash || hashedAttempt2 === expectedHash || cleanPass === expectedHash)) {
                    isMatch = true;
                } else if (user.plainPassword && (cleanPass === String(user.plainPassword).trim() || String(password) === String(user.plainPassword))) {
                    isMatch = true;
                } else if (user.passwordHash && (hashedAttempt1 === user.passwordHash || hashedAttempt2 === user.passwordHash || cleanPass === user.passwordHash)) {
                    isMatch = true;
                }

                if (!isMatch) {
                    return sendJson({ success: false, error: 'كلمة المرور غير صحيحة! يرجى التأكد من مطابقة كلمة المرور الموجودة في لوحة التحكم والمحاولة مجدداً.' }, 401);
                }
            }

            // Drivers must be approved by admin before accessing web app
            if (userRole === 'Driver') {
                if (user.status === 'Pending' || user.status === 'Unverified' || !user.isVerified) {
                    return sendJson({
                        success: false,
                        pending: true,
                        error: 'حسابك معلّق بانتظار التوثيق من قبل إدارة المنصة. يرجى إرسال المستمسكات عبر الواتساب أو التيليجرام للاعتماد.'
                    }, 403);
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
                    route: user.route || 'النجف الأشرف',
                    address: user.address || user.area || 'النجف الأشرف',
                    status: user.status || 'Active',
                    isVerified: !!user.isVerified,
                    permanentLat: user.permanentLat || null,
                    permanentLon: user.permanentLon || null,
                    permanentLocationName: user.permanentLocationName || '',
                    permanentDropoffLat: user.permanentDropoffLat || null,
                    permanentDropoffLon: user.permanentDropoffLon || null,
                    permanentDropoffName: user.permanentDropoffName || ''
                }
            });
        }

        if (pathname === '/api/auth/register' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { phoneNumber, fullName, role, licenseNumber, password, passwordHash } = body;
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

            // WhatsApp OTP verification if provided
            if (body.otpCode) {
                const otpCheck = whatsappService.verifyOtp(phoneNumber, body.otpCode);
                if (!otpCheck.valid) {
                    return sendJson({ success: false, error: otpCheck.error }, 400);
                }
            }

            if (targetRole === 'Driver') {
                const driverId = 'drv-' + Math.random().toString(36).substr(2, 9);
                const newDriver = {
                    driverId,
                    fullName: fullName || 'كابتن جديد',
                    phoneNumber: phoneNumber || '07800000000',
                    licenseNumber: licenseNumber || 'IRQ-NJF-1000',
                    status: 'Online',
                    isOnline: true,
                    isVerified: true,
                    isBlocked: false,
                    plainPassword: password || null,
                    passwordHash: passwordHash || null,
                    createdAt: now
                };

                const initialDoc = {
                    documentId: 'doc-' + driverId,
                    driverId,
                    documentType: 'DrivingLicense',
                    filePath: '/images/license-placeholder.jpg',
                    fileUrl: '/images/license-placeholder.jpg',
                    status: 'Approved',
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
                            VALUES ($1, $2, $3, $4, 'Online', true, false, $5)
                        `, [driverId, newDriver.fullName, newDriver.phoneNumber, newDriver.licenseNumber, now]);

                        await db.pool.query(`
                            INSERT INTO driver_documents (document_id, driver_id, document_type, file_path, file_url, status, submitted_at)
                            VALUES ($1, $2, $3, $4, $5, 'Approved', $6)
                        `, [initialDoc.documentId, driverId, initialDoc.documentType, initialDoc.filePath, initialDoc.fileUrl, now]);
                    } catch (e) {}
                }

                db.saveStateSnapshot();
                const token = 'jwt_driver_' + driverId;
                return sendJson({
                    success: true,
                    token,
                    user: { id: driverId, fullName: newDriver.fullName, role: 'Driver', status: 'Online', isOnline: true, isVerified: true }
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
            const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
            const token = authHeader.replace(/^Bearer\s+/i, '').trim();
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
                if (driver.isBlocked === true || driver.status === 'Suspended' || driver.status === 'Blocked' || (driver.isVerified === false && driver.status === 'Rejected')) {
                    return sendJson({ success: false, isBlocked: true, error: 'تم حظر أو تعليق حساب الكابتن من قبل إدارة المنصة.' }, 403);
                }
                const driverRoute = db.memoryState.routes.find(r => r.driverId === driver.driverId);
                const routeName = driver.route || (driverRoute ? (driverRoute.name || `${driverRoute.startName} - ${driverRoute.endName}`) : 'النجف الأشرف');
                const routeObj = driverRoute || {
                    id: 'route-' + driver.driverId,
                    routeId: 'route-' + driver.driverId,
                    driverId: driver.driverId,
                    name: routeName,
                    startName: routeName.split('-')[0]?.trim() || routeName,
                    endName: routeName.split('-')[1]?.trim() || routeName,
                    status: 'Active'
                };
                return sendJson({
                    success: true,
                    user: {
                        id: driver.driverId,
                        fullName: driver.fullName,
                        phoneNumber: driver.phoneNumber,
                        email: driver.email,
                        role: 'Driver',
                        route: routeObj,
                        status: driver.status || 'Online',
                        isOnline: driver.status === 'Online' || driver.isOnline === true,
                        isVerified: true,
                        isBlocked: driver.isBlocked || false,
                        vehicleMake: driver.vehicleMake,
                        vehicleModel: driver.vehicleModel,
                        vehiclePlate: driver.vehiclePlate,
                        vehicleYear: driver.vehicleYear,
                        vehicleInfo: `${driver.vehicleMake || 'تويوتا'} (${driver.vehiclePlate || 'النجف'})`
                    }
                });
            }

            let customer = db.memoryState.customers.find(c => c.customerId === id || token.includes(c.customerId));
            if (!customer && db.isPostgresConnected && db.pool) {
                try {
                    const pgCust = await db.pool.query('SELECT * FROM customers WHERE customer_id = $1 LIMIT 1', [id]);
                    if (pgCust.rows && pgCust.rows.length > 0) {
                        const row = pgCust.rows[0];
                        customer = {
                            customerId: row.customer_id,
                            fullName: row.full_name,
                            phoneNumber: row.phone_number,
                            email: row.email,
                            route: row.route,
                            address: row.address,
                            plainPassword: row.plain_password || null,
                            passwordHash: row.password_hash || null,
                            isActive: row.is_active,
                            isBlocked: row.is_blocked
                        };
                        db.memoryState.customers.unshift(customer);
                    }
                } catch (_) {}
            }
            if (customer) {
                if (customer.isBlocked === true || customer.isActive === false) {
                    return sendJson({ success: false, isBlocked: true, error: 'تم تعليق هذا الحساب من قبل إدارة المنصة.' }, 403);
                }
                return sendJson({
                    success: true,
                    user: {
                        id: customer.customerId,
                        fullName: customer.fullName,
                        phoneNumber: customer.phoneNumber,
                        email: customer.email,
                        role: 'Customer',
                        route: customer.route || 'النجف الأشرف',
                        address: customer.address || customer.area || 'النجف الأشرف',
                        status: customer.isActive ? 'Active' : 'Suspended',
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

        // Driver Status Endpoint: POST /api/admin/drivers/:id/status, /api/drivers/:id/status, /drivers/:id/status
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/') || pathname.startsWith('/drivers/')) && pathname.endsWith('/status') && method === 'POST') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            let targetDriver = (db.memoryState.drivers || []).find(d => d.driverId === driverId);
            if (targetDriver) {
                targetDriver.status = body.status;
                targetDriver.isOnline = (body.status === 'Online');
                if (body.status === 'Online') targetDriver.isVerified = true;
            }
            const result = await adminController.setDriverStatus(driverId, body.status, body.reason);
            return sendJson({ success: true, status: body.status, isOnline: body.status === 'Online', ...result });
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
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && method === 'GET' && !pathname.includes('/block') && !pathname.includes('/status') && !pathname.includes('/nearby')) {
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

        // Customer Create: POST /api/admin/customers or /api/customers/create
        if ((pathname === '/api/admin/customers' || pathname === '/api/admin/admin/customers' || pathname === '/api/customers/create' || pathname === '/api/admin/customers/create') && method === 'POST') {
            const body = await parseJsonBody(req);
            const result = await adminController.createCustomer(body);
            return sendJson(result, result.success ? 201 : 400);
        }

        // Customer Block Endpoint: POST /api/admin/customers/:id/block or /api/customers/:id/block
        if ((pathname.startsWith('/api/admin/customers/') || pathname.startsWith('/api/customers/')) && pathname.endsWith('/block') && method === 'POST') {
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
            return sendJson({ success: true, total: result.total, bookings: result.bookings });
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
            const tripType = parsedUrl.searchParams.get('tripType'); // 'short' or 'daily'
            
            const toRad = (deg) => deg * Math.PI / 180;
            const haversine = (lat1, lon1, lat2, lon2) => {
                const R = 6371;
                const dLat = toRad(lat2 - lat1);
                const dLon = toRad(lon2 - lon1);
                const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
                return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            };

            const activeDrivers = (db.memoryState.drivers || [])
                .filter(d => !d.isBlocked && d.status !== 'Pending' && d.status !== 'Rejected' && (d.isVerified === true || d.status === 'Approved' || d.status === 'Active'))
                .filter(d => {
                    if (tripType === 'short') {
                        return d.serviceType === 'ShortTrip' || d.serviceType === 'Both' || !d.serviceType;
                    }
                    if (tripType === 'daily') {
                        return d.serviceType === 'PermanentLine' || d.serviceType === 'Both' || !d.serviceType;
                    }
                    return true;
                })
                .map((d, idx) => {
                    const dLat = d.currentLat ? parseFloat(d.currentLat) : (d.permanentLat ? parseFloat(d.permanentLat) : (lat + (idx % 2 === 0 ? 0.003 * (idx + 1) : -0.003 * (idx + 1))));
                    const dLon = d.currentLon ? parseFloat(d.currentLon) : (d.permanentLon ? parseFloat(d.permanentLon) : (lon + (idx % 2 === 0 ? 0.002 * (idx + 1) : -0.002 * (idx + 1))));
                    const distanceKm = haversine(lat, lon, dLat, dLon);
                    const vMake = d.vehicleMake || (d.vehicle ? d.vehicle.make : 'تويوتا');
                    const vModel = d.vehicleModel || (d.vehicle ? (d.vehicle.model || '') : 'كورولا');
                    const vPlate = d.vehiclePlate || (d.vehicle ? (d.vehicle.plateNumber || d.vehicle.plate) : 'النجف');
                    return {
                        driverId: d.driverId,
                        driverName: d.fullName || 'كابتن توصيله',
                        fullName: d.fullName || 'كابتن توصيله',
                        phone: d.phoneNumber || '07800000000',
                        phoneNumber: d.phoneNumber || '07800000000',
                        rating: d.ratingAverage || 5.0,
                        serviceType: d.serviceType || 'Both',
                        vehicleInfo: `${vMake} ${vModel} (${vPlate})`.trim(),
                        carModel: `${vMake} ${vModel}`.trim(),
                        plateNumber: vPlate,
                        latitude: dLat,
                        longitude: dLon,
                        distanceKm: Math.round(distanceKm * 10) / 10,
                        heading: d.heading || (idx * 45) % 360,
                        status: d.tripStatus || 'Online',
                        speedKmh: d.speedKmh || Math.floor(25 + Math.random() * 30)
                    };
                })
                .sort((a, b) => a.distanceKm - b.distanceKm);

            return sendJson(activeDrivers);
        }

        if (pathname === '/api/fleet/active-drivers') {
            const tripType = parsedUrl.searchParams.get('tripType');
            const activeDrivers = (db.memoryState.drivers || [])
                .filter(d => !d.isBlocked && d.status !== 'Pending' && d.status !== 'Rejected' && (d.isVerified === true || d.status === 'Approved' || d.status === 'Active'))
                .filter(d => {
                    if (tripType === 'short') {
                        return d.serviceType === 'ShortTrip' || d.serviceType === 'Both' || !d.serviceType;
                    }
                    if (tripType === 'daily') {
                        return d.serviceType === 'PermanentLine' || d.serviceType === 'Both' || !d.serviceType;
                    }
                    return true;
                })
                .map(d => ({
                    id: d.driverId,
                    name: d.fullName,
                    phone: d.phoneNumber,
                    serviceType: d.serviceType || 'Both',
                    lat: d.currentLat ? parseFloat(d.currentLat) : 32.025,
                    lon: d.currentLon ? parseFloat(d.currentLon) : 44.33
                }));
            return sendJson({ success: true, drivers: activeDrivers });
        }

        // Driver Service Type Selection (ShortTrip / PermanentLine / Both)
        if (pathname === '/api/driver/service-type' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { driverId, serviceType } = body;
                const validTypes = ['ShortTrip', 'PermanentLine', 'Both'];
                if (!driverId || !validTypes.includes(serviceType)) {
                    return sendJson({ success: false, error: 'driverId and valid serviceType required' }, 400);
                }
                const driver = (db.memoryState.drivers || []).find(d => d.driverId === driverId);
                if (driver) {
                    driver.serviceType = serviceType;
                    db.saveStateSnapshot();
                    try {
                        if (db.query) {
                            await db.query(`UPDATE drivers SET service_type = $1 WHERE driver_id = $2`, [serviceType, driverId]);
                        }
                    } catch (_) {}
                    return sendJson({ success: true, driverId, serviceType: driver.serviceType });
                }
                return sendJson({ success: false, error: 'Driver not found' }, 404);
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
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

        // Driver Bookings (All bookings for this driver: Pending requests & Confirmed passengers)
        if (pathname.startsWith('/api/driver/') && pathname.endsWith('/bookings') && method === 'GET') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            let driverBookings = [];

            const targetDriver = (db.memoryState.drivers || []).find(d => d.driverId === driverId);
            const driverName = targetDriver?.fullName;

            // 1. Fetch bookings from PostgreSQL if connected
            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(`
                        SELECT * FROM bookings 
                        WHERE driver_id = $1 
                           OR (driver_name IS NOT NULL AND LOWER(driver_name) = LOWER($2))
                           OR driver_id = 'drv-sample'
                        ORDER BY created_at DESC
                    `, [driverId, driverName || '']);
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        driverBookings = pgRes.rows.map(r => ({
                            id: r.id,
                            bookingId: r.id,
                            driverId: r.driver_id,
                            customerId: r.customer_id,
                            customerName: r.customer_name || 'راكب',
                            customerPhone: r.customer_phone || '',
                            pickupLocation: r.pickup_name || 'موقع الركوب',
                            dropoffLocation: r.dropoff_name || 'جامعة الكوفة',
                            pickupLat: parseFloat(r.pickup_lat || 31.9961),
                            pickupLon: parseFloat(r.pickup_lon || 44.3168),
                            dropoffLat: parseFloat(r.dropoff_lat || 32.0321),
                            dropoffLon: parseFloat(r.dropoff_lon || 44.3725),
                            seatsBooked: r.seats_booked || 1,
                            status: r.status || 'Pending',
                            totalFare: r.total_fare,
                            createdAt: r.created_at
                        }));
                    }
                } catch (pgErr) {
                    console.error('[Driver] PG bookings fetch error:', pgErr.message);
                }
            }

            // 2. Fetch bookings from memory for this driver
            const memBookings = (db.memoryState.bookings || []).filter(b => 
                b.driverId === driverId || 
                (driverName && b.driverName && b.driverName.trim() === driverName.trim()) ||
                (b.driverId === 'drv-sample')
            );
            for (const mb of memBookings) {
                if (!driverBookings.some(dbk => (dbk.id === mb.id || dbk.bookingId === mb.bookingId))) {
                    driverBookings.push(mb);
                }
            }

            // 3. Customers explicitly assigned to this driver
            const assignedCustomers = (db.memoryState.customers || []).filter(c => 
                c.driverId === driverId || c.assignedDriverId === driverId
            );
            for (const ac of assignedCustomers) {
                if (!driverBookings.some(b => b.customerId === ac.customerId)) {
                    driverBookings.push({
                        id: 'bk-assign-' + ac.customerId,
                        bookingId: 'bk-assign-' + ac.customerId,
                        driverId: driverId,
                        customerId: ac.customerId,
                        customerName: ac.fullName,
                        customerPhone: ac.phoneNumber,
                        pickupLocation: ac.address || ac.route || 'النجف الأشرف',
                        dropoffLocation: ac.route || 'جامعة الكوفة',
                        pickupLat: parseFloat(ac.pickupLat || ac.latitude || 31.9961),
                        pickupLon: parseFloat(ac.pickupLon || ac.longitude || 44.3168),
                        dropoffLat: parseFloat(ac.dropoffLat || 32.0321),
                        dropoffLon: parseFloat(ac.dropoffLon || 44.3725),
                        seatsBooked: 1,
                        status: ac.bookingConfirmed ? 'Confirmed' : 'Pending'
                    });
                }
            }

            return sendJson(driverBookings);
        }

        // Driver Pending Requests (Customer booking requests awaiting driver approval)
        if (pathname.startsWith('/api/driver/') && (pathname.endsWith('/requests') || pathname.endsWith('/pending-bookings') || pathname.endsWith('/pending')) && method === 'GET') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            let pendingBookings = [];

            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(`
                        SELECT * FROM bookings 
                        WHERE (driver_id = $1 OR driver_id IS NULL) AND status = 'Pending'
                        ORDER BY created_at DESC
                    `, [driverId]);
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        pendingBookings = pgRes.rows.map(r => ({
                            id: r.id,
                            bookingId: r.id,
                            driverId: r.driver_id,
                            customerId: r.customer_id,
                            customerName: r.customer_name || 'راكب طالب حجز',
                            customerPhone: r.customer_phone || '',
                            pickupLocation: r.pickup_name || 'موقع الركوب',
                            dropoffLocation: r.dropoff_name || 'جامعة الكوفة',
                            pickupLat: parseFloat(r.pickup_lat || 31.9961),
                            pickupLon: parseFloat(r.pickup_lon || 44.3168),
                            dropoffLat: parseFloat(r.dropoff_lat || 32.0321),
                            dropoffLon: parseFloat(r.dropoff_lon || 44.3725),
                            seatsBooked: r.seats_booked || 1,
                            status: 'Pending',
                            totalFare: r.total_fare,
                            createdAt: r.created_at
                        }));
                    }
                } catch (e) {}
            }

            const memPending = (db.memoryState.bookings || []).filter(b => 
                (b.driverId === driverId || !b.driverId) && b.status === 'Pending'
            );
            for (const mb of memPending) {
                if (!pendingBookings.some(pb => (pb.id === mb.id || pb.bookingId === mb.bookingId))) {
                    pendingBookings.push(mb);
                }
            }

            return sendJson({ success: true, total: pendingBookings.length, requests: pendingBookings, bookings: pendingBookings });
        }

        if (pathname === '/api/matching/find-routes' || pathname === '/api/driver/routes' || pathname === '/api/routes') {
            const activeRoutes = (db.memoryState.routes || [])
                .filter(r => {
                    if (r.status && r.status !== 'Active') return false;
                    const drv = (db.memoryState.drivers || []).find(d => d.driverId === r.driverId);
                    if (drv && (drv.status === 'Pending' || drv.status === 'Rejected' || !drv.isVerified || drv.isBlocked)) return false;
                    return true;
                })
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
        if ((pathname === '/api/customer/book-route' || pathname === '/api/bookings' || pathname === '/bookings') && method === 'POST') {
            const body = await parseJsonBody(req);
            const routeId = body.routeId || body.driverRouteId;
            let targetRoute = (db.memoryState.routes || []).find(r => (r.id === routeId || r.routeId === routeId));
            
            let targetDriver = null;
            if (body.driverId) {
                targetDriver = (db.memoryState.drivers || []).find(d => d.driverId === body.driverId);
            }
            if (!targetDriver && targetRoute) {
                targetDriver = (db.memoryState.drivers || []).find(d => d.driverId === targetRoute.driverId);
            }
            if (!targetDriver && body.driverName) {
                targetDriver = (db.memoryState.drivers || []).find(d => d.fullName && d.fullName.trim() === body.driverName.trim());
            }
            if (!targetDriver && routeId) {
                targetDriver = (db.memoryState.drivers || []).find(d => routeId.includes(d.driverId) || d.driverId.includes(routeId));
            }
            if (!targetRoute && targetDriver) {
                targetRoute = (db.memoryState.routes || []).find(r => r.driverId === targetDriver.driverId);
            }

            const defaultDriver = (db.memoryState.drivers || [])[0];
            const resolvedDriverId = targetDriver ? targetDriver.driverId : (targetRoute ? targetRoute.driverId : (body.driverId || (defaultDriver ? defaultDriver.driverId : 'drv-sample')));
            const resolvedDriverName = targetDriver ? targetDriver.fullName : (targetRoute ? targetRoute.driverName : (body.driverName || (defaultDriver ? defaultDriver.fullName : 'كابتن توصيله')));
            const resolvedDriverPhone = targetDriver ? targetDriver.phoneNumber : (targetRoute ? targetRoute.driverPhone : (body.driverPhone || (defaultDriver ? defaultDriver.phoneNumber : '07801234567')));

            const seats = Math.max(1, parseInt(body.seats || body.seatsBooked || 1, 10));

            // Enforce driver capacity based on active passengers
            const activeBookings = (db.memoryState.bookings || []).filter(b => 
                (b.driverId === resolvedDriverId) && (b.status === 'Confirmed' || b.status === 'Pending')
            );
            const activeBookedSeats = activeBookings.reduce((sum, b) => sum + parseInt(b.seatsBooked || 1, 10), 0);
            const totalCarCapacity = targetRoute?.totalSeats || targetDriver?.availableSeats || 4;

            if (activeBookedSeats >= totalCarCapacity || (targetRoute && targetRoute.availableSeats <= 0) || (targetRoute && targetRoute.availableSeats < seats)) {
                return sendJson({ success: false, error: 'عذراً، العدد عند السائق مكتمل حالياً' }, 400);
            }

            const bookingId = 'bk-' + Math.random().toString(36).substr(2, 9);
            const now = new Date().toISOString();
            const farePerSeat = targetRoute ? parseFloat(targetRoute.fare || 3000) : 3000;
            const totalFare = farePerSeat * seats;

            const newBooking = {
                id: bookingId,
                bookingId: bookingId,
                routeId: routeId || (targetRoute ? (targetRoute.id || targetRoute.routeId) : null),
                driverId: resolvedDriverId,
                driverName: resolvedDriverName,
                driverPhone: resolvedDriverPhone,
                customerId: body.customerId || ('cust-' + Math.random().toString(36).substr(2, 7)),
                customerName: body.customerName || body.fullName || 'راكب توصيله',
                customerPhone: body.customerPhone || body.phoneNumber || '',
                pickupLocation: body.pickupLocation || body.pickup || body.pickupName || (targetRoute ? targetRoute.startName : ''),
                dropoffLocation: body.dropoffLocation || body.destination || body.dropoffName || (targetRoute ? targetRoute.endName : 'جامعة الكوفة'),
                pickupLat: parseFloat(body.pickupLat || (targetRoute ? targetRoute.startLat : 31.9961)),
                pickupLon: parseFloat(body.pickupLon || (targetRoute ? targetRoute.startLon : 44.3168)),
                dropoffLat: parseFloat(body.dropoffLat || (targetRoute ? targetRoute.endLat : 32.0321)),
                dropoffLon: parseFloat(body.dropoffLon || (targetRoute ? targetRoute.endLon : 44.3725)),
                seatsBooked: seats,
                fare: totalFare,
                totalFare: totalFare,
                status: 'Pending',
                seatsDeducted: false,
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
                    if (!validDriverId && newBooking.driverName) {
                        const dnCheck = await db.pool.query('SELECT driver_id FROM drivers WHERE LOWER(full_name) = LOWER($1) LIMIT 1', [newBooking.driverName]);
                        if (dnCheck.rows.length > 0) {
                            validDriverId = dnCheck.rows[0].driver_id;
                            newBooking.driverId = validDriverId;
                        }
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
                        newBooking.dropoffLat, newBooking.dropoffLon, totalFare, seats, 'Pending', now
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
                totalFare,
                status: 'Pending'
            });

            db.saveStateSnapshot();

            return sendJson({
                success: true,
                message: 'تم إرسال طلب الحجز إلى الكابتن بنجاح! بانتظار موافقة الكابتن لتأكيد مقعدك.',
                booking: newBooking
            });
        }

        // Accept Booking by Driver / Admin (Driver approves customer to become passenger)
        const acceptMatch = pathname.match(/^\/?(?:api\/)?(?:driver\/)?bookings\/([^\/]+)\/accept$/i);
        if (acceptMatch && method === 'POST') {
            const bookingId = acceptMatch[1];
            const body = await parseJsonBody(req).catch(() => ({}));
            const result = await adminController.acceptBooking(bookingId, body.driverId);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Decline / Reject Booking by Driver / Admin
        const declineMatch = pathname.match(/^\/?(?:api\/)?(?:driver\/)?bookings\/([^\/]+)\/(?:decline|reject)$/i);
        if (declineMatch && method === 'POST') {
            const bookingId = declineMatch[1];
            const body = await parseJsonBody(req).catch(() => ({}));
            const result = await adminController.declineBooking(bookingId, body.reason || body.declineReason);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Generic Booking Status Update
        const statusMatch = pathname.match(/^\/?(?:api\/)?(?:admin\/|driver\/)?bookings\/([^\/]+)\/status$/i);
        if (statusMatch && method === 'POST') {
            const bookingId = statusMatch[1];
            const body = await parseJsonBody(req).catch(() => ({}));
            const result = await adminController.updateBookingStatus(bookingId, body.status, body.reason);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Driver Request Passenger Cancellation
        const cancelReqMatch = pathname.match(/^\/?(?:api\/)?(?:driver\/)?bookings\/([^\/]+)\/cancel-request$/i);
        if ((cancelReqMatch || pathname === '/api/driver/cancellation-requests') && method === 'POST') {
            const bookingId = cancelReqMatch ? cancelReqMatch[1] : null;
            const body = await parseJsonBody(req).catch(() => ({}));
            if (bookingId && !body.bookingId) body.bookingId = bookingId;
            const result = await adminController.createCancellationRequest(body);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Admin Passenger Cancellation Requests List
        if (pathname === '/api/admin/cancellation-requests' && method === 'GET') {
            const result = await adminController.getCancellationRequests();
            return sendJson(result);
        }

        // Admin Approve Cancellation Request
        const approveCancelMatch = pathname.match(/^\/?(?:api\/)?admin\/cancellation-requests\/([^\/]+)\/approve$/i);
        if (approveCancelMatch && method === 'POST') {
            const requestId = approveCancelMatch[1];
            const result = await adminController.approveCancellation(requestId);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Admin Reject Cancellation Request
        const rejectCancelMatch = pathname.match(/^\/?(?:api\/)?admin\/cancellation-requests\/([^\/]+)\/reject$/i);
        if (rejectCancelMatch && method === 'POST') {
            const requestId = rejectCancelMatch[1];
            const result = await adminController.rejectCancellation(requestId);
            return sendJson(result, result.success ? 200 : 400);
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

        // ===== Dynamic App Config APIs =====
        if (pathname === '/api/admin/app-config' && method === 'GET') {
            if (!db.memoryState.appConfig) {
                db.memoryState.appConfig = {
                    theme: { primaryColor: '#111111', bgColor: '#ffffff', fontFamily: 'Cairo', logoEmoji: '🚕', appName: 'توصيله', footerText: '© 2026 توصيله (Tawseela IQ) · النجف الأشرف' },
                    customButtons: [],
                    ads: [],
                    telegramAdminLink: 'https://t.me/tawseela_iq_bot',
                    whatsappAdminLink: 'https://wa.me/9647706204066',
                    staticTexts: { welcomeTitle: 'منصة توصيله', welcomeSubtitle: 'النجف الأشرف - سجّل دخولك أو أنشئ حسابك', driverPendingMsg: 'حسابك معلّق بانتظار التوثيق. أرسل مستمسكاتك عبر واتساب أو تيليجرام.' },
                    registrationFields: { passenger: ['phone','firstName','lastName','tripType','map','password'], driver: ['phone','fullName','license','vehicle','plate','password'] },
                    onboarding: { enabled: false, screens: [] }
                };
            } else {
                if (!db.memoryState.appConfig.telegramAdminLink) db.memoryState.appConfig.telegramAdminLink = 'https://t.me/tawseela_iq_bot';
                if (!db.memoryState.appConfig.whatsappAdminLink) db.memoryState.appConfig.whatsappAdminLink = 'https://wa.me/9647706204066';
            }
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return sendJson(db.memoryState.appConfig);
        }

        if (pathname === '/api/admin/app-config' && method === 'POST') {
            const body = await parseJsonBody(req);
            if (!db.memoryState.appConfig) db.memoryState.appConfig = {};
            Object.assign(db.memoryState.appConfig, body);
            db.saveStateSnapshot();
            return sendJson({ success: true, message: 'تم تحديث الإعدادات' });
        }

        // Custom Buttons CRUD
        if (pathname === '/api/admin/custom-buttons' && method === 'GET') {
            return sendJson((db.memoryState.appConfig && db.memoryState.appConfig.customButtons) || []);
        }
        if (pathname === '/api/admin/custom-buttons' && (method === 'POST' || method === 'PUT')) {
            const body = await parseJsonBody(req);
            if (!db.memoryState.appConfig) db.memoryState.appConfig = {};
            if (!db.memoryState.appConfig.customButtons) db.memoryState.appConfig.customButtons = [];
            if (body.id) {
                const idx = db.memoryState.appConfig.customButtons.findIndex(b => b.id === body.id);
                if (idx !== -1) {
                    db.memoryState.appConfig.customButtons[idx] = {
                        ...db.memoryState.appConfig.customButtons[idx],
                        label: body.label !== undefined ? body.label : db.memoryState.appConfig.customButtons[idx].label,
                        url: body.url !== undefined ? body.url : db.memoryState.appConfig.customButtons[idx].url,
                        icon: body.icon !== undefined ? body.icon : db.memoryState.appConfig.customButtons[idx].icon,
                        color: body.color !== undefined ? body.color : db.memoryState.appConfig.customButtons[idx].color,
                        visible: body.visible !== undefined ? body.visible : db.memoryState.appConfig.customButtons[idx].visible,
                        updatedAt: new Date().toISOString()
                    };
                    db.saveStateSnapshot();
                    return sendJson({ success: true, button: db.memoryState.appConfig.customButtons[idx] });
                }
            }
            const btn = { id: 'btn-' + Date.now(), label: body.label || '', url: body.url || '', icon: body.icon || '🔗', color: body.color || '#111111', order: body.order || 0, visible: body.visible !== false, target: body.target || '_blank', createdAt: new Date().toISOString() };
            db.memoryState.appConfig.customButtons.push(btn);
            db.saveStateSnapshot();
            return sendJson({ success: true, button: btn });
        }
        if (pathname === '/api/admin/custom-buttons' && method === 'DELETE') {
            const body = await parseJsonBody(req);
            if (db.memoryState.appConfig && db.memoryState.appConfig.customButtons) {
                db.memoryState.appConfig.customButtons = db.memoryState.appConfig.customButtons.filter(b => b.id !== body.id);
                db.saveStateSnapshot();
            }
            return sendJson({ success: true });
        }

        // Ads Management
        if (pathname === '/api/admin/advertisements' && method === 'GET') {
            return sendJson((db.memoryState.appConfig && db.memoryState.appConfig.ads) || []);
        }
        if (pathname === '/api/admin/advertisements' && (method === 'POST' || method === 'PUT')) {
            const body = await parseJsonBody(req);
            if (!db.memoryState.appConfig) db.memoryState.appConfig = {};
            if (!db.memoryState.appConfig.ads) db.memoryState.appConfig.ads = [];
            if (body.id) {
                const idx = db.memoryState.appConfig.ads.findIndex(a => a.id === body.id);
                if (idx !== -1) {
                    db.memoryState.appConfig.ads[idx] = {
                        ...db.memoryState.appConfig.ads[idx],
                        title: body.title !== undefined ? body.title : db.memoryState.appConfig.ads[idx].title,
                        content: body.content !== undefined ? body.content : db.memoryState.appConfig.ads[idx].content,
                        linkUrl: body.linkUrl !== undefined ? body.linkUrl : db.memoryState.appConfig.ads[idx].linkUrl,
                        active: body.active !== undefined ? body.active : db.memoryState.appConfig.ads[idx].active,
                        updatedAt: new Date().toISOString()
                    };
                    db.saveStateSnapshot();
                    return sendJson({ success: true, ad: db.memoryState.appConfig.ads[idx] });
                }
            }
            const ad = { id: 'ad-' + Date.now(), title: body.title || '', content: body.content || '', imageUrl: body.imageUrl || '', linkUrl: body.linkUrl || '', active: body.active !== false, order: body.order || 0, createdAt: new Date().toISOString() };
            db.memoryState.appConfig.ads.push(ad);
            db.saveStateSnapshot();
            return sendJson({ success: true, ad });
        }
        if (pathname === '/api/admin/advertisements' && method === 'DELETE') {
            const body = await parseJsonBody(req);
            if (db.memoryState.appConfig && db.memoryState.appConfig.ads) {
                db.memoryState.appConfig.ads = db.memoryState.appConfig.ads.filter(a => a.id !== body.id);
                db.saveStateSnapshot();
            }
            return sendJson({ success: true });
        }

        // Theme Management
        if (pathname === '/api/admin/theme' && method === 'GET') {
            return sendJson((db.memoryState.appConfig && db.memoryState.appConfig.theme) || {});
        }
        if (pathname === '/api/admin/theme' && method === 'POST') {
            const body = await parseJsonBody(req);
            if (!db.memoryState.appConfig) db.memoryState.appConfig = {};
            db.memoryState.appConfig.theme = { ...(db.memoryState.appConfig.theme || {}), ...body };
            db.saveStateSnapshot();
            return sendJson({ success: true });
        }

        // Onboarding screens
        if (pathname === '/api/admin/onboarding' && method === 'GET') {
            return sendJson((db.memoryState.appConfig && db.memoryState.appConfig.onboarding) || { enabled: false, screens: [] });
        }
        if (pathname === '/api/admin/onboarding' && method === 'POST') {
            const body = await parseJsonBody(req);
            if (!db.memoryState.appConfig) db.memoryState.appConfig = {};
            db.memoryState.appConfig.onboarding = body;
            db.saveStateSnapshot();
            return sendJson({ success: true });
        }

        // Telegram bot admin
        if (pathname === '/api/admin/telegram/notify' && method === 'POST') {
            const body = await parseJsonBody(req);
            const msg = body.message || '';
            let result = { success: true, sentCount: 1 };
            try {
                if (typeof telegramBot.broadcastNotification === 'function') {
                    result = await telegramBot.broadcastNotification(msg);
                } else {
                    await telegramBot.sendAdminNotification(msg);
                }
            } catch(e) {
                console.error('[BroadcastNotification Error]:', e.message);
            }
            return sendJson(result);
        }

        // Registration fields config
        if (pathname === '/api/admin/registration-fields' && method === 'GET') {
            return sendJson((db.memoryState.appConfig && db.memoryState.appConfig.registrationFields) || {});
        }
        if (pathname === '/api/admin/registration-fields' && method === 'POST') {
            const body = await parseJsonBody(req);
            if (!db.memoryState.appConfig) db.memoryState.appConfig = {};
            db.memoryState.appConfig.registrationFields = body;
            db.saveStateSnapshot();
            return sendJson({ success: true });
        }

        // ===== Feature 10: AI Router (model routing based on task complexity) =====
        if (pathname === '/api/ai/route' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { task, tokenBudget } = body;
            const taskStr = (task || '').toLowerCase();
            // Heuristic: complex tasks (analysis, matching, reports) → heavy model; simple (OTP, status) → light
            const heavyKeywords = ['تحليل', 'تقرير', 'مطابقة', 'خوارزمية', 'analysis', 'report', 'matching', 'algorithm', 'forecast', 'complex'];
            const isComplex = heavyKeywords.some(kw => taskStr.includes(kw));
            const model = isComplex ? 'pro' : 'flash';
            const estimatedTokens = isComplex ? Math.min(tokenBudget || 4000, 8000) : Math.min(tokenBudget || 1000, 2000);
            return sendJson({ success: true, recommendedModel: model, estimatedTokens, isComplex });
        }

        // ===== External Booking (WhatsApp / Telegram contact) =====
        if (pathname === '/api/bookings/external' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { passengerId, driverId, channel, passengerPhone, driverPhone, pickup, dropoff } = body;
            if (!channel) return sendJson({ success: false, error: 'channel required' }, 400);
            const bk = {
                bookingId: 'ext-' + Date.now(),
                type: 'external',
                channel: channel || 'whatsapp',
                passengerId: passengerId || '',
                driverId: driverId || '',
                passengerPhone: passengerPhone || '',
                driverPhone: driverPhone || '',
                pickup: pickup || '',
                dropoff: dropoff || '',
                status: 'Confirmed',
                createdAt: new Date().toISOString()
            };
            if (!db.memoryState.externalBookings) db.memoryState.externalBookings = [];
            db.memoryState.externalBookings.unshift(bk);
            if (db.memoryState.externalBookings.length > 500) db.memoryState.externalBookings = db.memoryState.externalBookings.slice(0, 500);
            db.saveStateSnapshot();
            try { telegramBot.sendAdminNotification('📲 حجز خارجي جديد عبر ' + channel + '\\nمن: ' + (passengerPhone || passengerId) + ' إلى سائق: ' + (driverPhone || driverId)); } catch(_) {}
            return sendJson({ success: true, booking: bk });
        }

        if (pathname === '/api/fleet/external-bookings' && method === 'GET') {
            return sendJson({ success: true, bookings: (db.memoryState.externalBookings || []) });
        }

        // ===== Driver sets own route =====
        if (pathname === '/api/driver/set-route' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { driverId, fromText, toText, fromLat, fromLon, toLat, toLon } = body;
            if (!driverId) return sendJson({ success: false, error: 'driverId required' }, 400);
            if (!fromText || !toText || !fromText.trim() || !toText.trim()) {
                return sendJson({ success: false, error: 'يجب تحديد نقطة الانطلاق ونقطة الوصول الفعلية للمسار' }, 400);
            }
            const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
            if (!driver) return sendJson({ success: false, error: 'Driver not found' }, 404);
            driver.activeRoute = {
                fromText: fromText.trim(),
                toText: toText.trim(),
                fromLat: parseFloat(fromLat) || 0,
                fromLon: parseFloat(fromLon) || 0,
                toLat: parseFloat(toLat) || 0,
                toLon: parseFloat(toLon) || 0,
                setAt: new Date().toISOString()
            };
            if (fromLat && fromLon) {
                driver.currentLat = parseFloat(fromLat);
                driver.currentLon = parseFloat(fromLon);
            }
            db.saveStateSnapshot();
            return sendJson({ success: true, route: driver.activeRoute });
        }

        // ===== Get active driver routes for passenger =====
        if (pathname === '/api/driver/active-routes' && method === 'GET') {
            const activeRoutes = (db.memoryState.drivers || [])
                .filter(d => !d.isBlocked && d.status !== 'Pending' && d.status !== 'Rejected' && (d.isVerified || d.status === 'Active' || d.status === 'Approved') && d.activeRoute)
                .map(d => ({
                    driverId: d.driverId,
                    driverName: d.fullName,
                    driverPhone: d.phoneNumber,
                    vehicle: (d.vehicleMake || '') + ' ' + (d.vehiclePlate || ''),
                    route: d.activeRoute,
                    currentLat: d.currentLat || 32.02,
                    currentLon: d.currentLon || 44.32,
                    availableSeats: d.availableSeats || 3
                }));
            return sendJson({ success: true, routes: activeRoutes });
        }

        // ===== Passenger join request =====
        if (pathname === '/api/passenger/join-request' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { passengerId, driverId, pickupLat, pickupLon, dropoffLat, dropoffLon, pickupText, dropoffText } = body;
            if (!passengerId || !driverId) return sendJson({ success: false, error: 'passengerId and driverId required' }, 400);
            if (!db.memoryState.joinRequests) db.memoryState.joinRequests = [];
            const existing = db.memoryState.joinRequests.find(j => j.passengerId === passengerId && j.driverId === driverId && j.status === 'Pending');
            if (existing) return sendJson({ success: true, request: existing, alreadyPending: true });
            const jr = { requestId: 'jr-' + Date.now(), passengerId, driverId, pickupLat: parseFloat(pickupLat)||32.02, pickupLon: parseFloat(pickupLon)||44.32, dropoffLat: parseFloat(dropoffLat)||32.03, dropoffLon: parseFloat(dropoffLon)||44.37, pickupText: pickupText||'', dropoffText: dropoffText||'', status: 'Pending', createdAt: new Date().toISOString() };
            db.memoryState.joinRequests.unshift(jr);
            if (db.memoryState.joinRequests.length > 1000) db.memoryState.joinRequests = db.memoryState.joinRequests.slice(0, 1000);
            db.saveStateSnapshot();
            const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
            const passenger = db.memoryState.customers.find(c => c.userId === passengerId);
            try { telegramBot.sendAdminNotification('🙋 طلب انضمام جديد من راكب: ' + (passenger ? passenger.fullName : passengerId) + ' للسائق: ' + (driver ? driver.fullName : driverId)); } catch(_) {}
            return sendJson({ success: true, request: jr });
        }

        // ===== Driver approves join request (triggers Waze for driver) =====
        if (pathname === '/api/driver/approve-join' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { requestId, driverId } = body;
            if (!db.memoryState.joinRequests) db.memoryState.joinRequests = [];
            const jr = db.memoryState.joinRequests.find(j => j.requestId === requestId);
            if (!jr) return sendJson({ success: false, error: 'Request not found' }, 404);
            jr.status = 'Approved';
            jr.approvedAt = new Date().toISOString();
            db.saveStateSnapshot();
            // Return Waze deep link for driver
            const wazeUrl = 'waze://ul?ll=' + jr.pickupLat + ',' + jr.pickupLon + '&navigate=yes';
            return sendJson({ success: true, request: jr, wazeUrl, pickupLat: jr.pickupLat, pickupLon: jr.pickupLon, pickupText: jr.pickupText });
        }


        // Passenger: Set permanent location
        if (pathname === '/api/passenger/set-permanent-location' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { passengerId, lat, lon, locationName } = body;
            if (!passengerId || !lat || !lon) return sendJson({ success: false, error: 'بيانات ناقصة' });
            const customer = db.memoryState.customers.find(c => c.customerId === passengerId);
            if (!customer) return sendJson({ success: false, error: 'الراكب غير موجود' });
            customer.permanentLat = parseFloat(lat);
            customer.permanentLon = parseFloat(lon);
            customer.permanentLocationName = locationName || '';
            if (body.dropoffLat) customer.permanentDropoffLat = parseFloat(body.dropoffLat);
            if (body.dropoffLon) customer.permanentDropoffLon = parseFloat(body.dropoffLon);
            if (body.dropoffName !== undefined) customer.permanentDropoffName = body.dropoffName || '';
            db.saveStateSnapshot();
            db.persistCustomerPermanentLocation(passengerId, {
                lat: customer.permanentLat, lon: customer.permanentLon, locationName: customer.permanentLocationName,
                dropoffLat: customer.permanentDropoffLat, dropoffLon: customer.permanentDropoffLon, dropoffName: customer.permanentDropoffName
            }).catch(()=>{});
            return sendJson({ success: true, message: 'تم تثبيت الموقع الدائمي بنجاح' });
        }

        // Get passenger permanent location
        if (pathname.startsWith('/api/passenger/permanent-location/') && method === 'GET') {
            const passengerId = pathname.split('/').pop();
            const customer = db.memoryState.customers.find(c => c.customerId === passengerId);
            if (!customer) return sendJson({ success: false });
            return sendJson({
                success: true,
                lat: customer.permanentLat || null,
                lon: customer.permanentLon || null,
                locationName: customer.permanentLocationName || '',
                dropoffLat: customer.permanentDropoffLat || null,
                dropoffLon: customer.permanentDropoffLon || null,
                dropoffName: customer.permanentDropoffName || ''
            });
        }

        // Get driver permanent location
        if (pathname.startsWith('/api/driver/permanent-location/') && method === 'GET') {
            const driverId = pathname.split('/').pop();
            const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
            if (!driver) return sendJson({ success: false });
            return sendJson({
                success: true,
                lat: driver.permanentLat || null,
                lon: driver.permanentLon || null,
                locationName: driver.permanentLocationName || '',
                dropoffLat: driver.permanentDropoffLat || null,
                dropoffLon: driver.permanentDropoffLon || null,
                dropoffName: driver.permanentDropoffName || ''
            });
        }

        // Admin: Set driver permanent location
        if (pathname === '/api/admin/driver/set-permanent-location' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { driverId, lat, lon, locationName } = body;
            if (!driverId || !lat || !lon) return sendJson({ success: false, error: 'بيانات ناقصة' });
            const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
            if (!driver) return sendJson({ success: false, error: 'السائق غير موجود' });
            driver.permanentLat = parseFloat(lat);
            driver.permanentLon = parseFloat(lon);
            driver.permanentLocationName = locationName || '';
            if (body.dropoffLat) driver.permanentDropoffLat = parseFloat(body.dropoffLat);
            if (body.dropoffLon) driver.permanentDropoffLon = parseFloat(body.dropoffLon);
            if (body.dropoffName !== undefined) driver.permanentDropoffName = body.dropoffName || '';
            db.saveStateSnapshot();
            db.persistDriverPermanentLocation(driverId, {
                lat: driver.permanentLat, lon: driver.permanentLon, locationName: driver.permanentLocationName,
                dropoffLat: driver.permanentDropoffLat, dropoffLon: driver.permanentDropoffLon, dropoffName: driver.permanentDropoffName
            }).catch(()=>{});
            return sendJson({ success: true, message: 'تم تثبيت موقع السائق الدائمي' });
        }

        if (pathname === '/api/driver/reject-join' && method === 'POST') {
            const body = await parseJsonBody(req);
            const { requestId } = body;
            if (!db.memoryState.joinRequests) db.memoryState.joinRequests = [];
            const jr = db.memoryState.joinRequests.find(j => j.requestId === requestId);
            if (jr) { jr.status = 'Rejected'; jr.rejectedAt = new Date().toISOString(); db.saveStateSnapshot(); }
            return sendJson({ success: true });
        }

        // Get join requests for a driver
        if (pathname.startsWith('/api/driver/join-requests/') && method === 'GET') {
            const driverId = pathname.split('/').pop();
            const requests = (db.memoryState.joinRequests || []).filter(j => j.driverId === driverId && j.status === 'Pending');
            // For each request, include passenger name but NOT exact pickup location (hidden until approved)
            const safe = requests.map(j => {
                const passenger = db.memoryState.customers.find(c => c.userId === j.passengerId);
                return { requestId: j.requestId, passengerId: j.passengerId, passengerName: passenger ? passenger.fullName : 'راكب', dropoffText: j.dropoffText, status: j.status, createdAt: j.createdAt };
            });
            return sendJson({ success: true, requests: safe });
        }

        // Get passenger's join request status
        if (pathname.startsWith('/api/passenger/join-status/') && method === 'GET') {
            const passengerId = pathname.split('/').pop();
            const request = (db.memoryState.joinRequests || []).find(j => j.passengerId === passengerId && (j.status === 'Pending' || j.status === 'Approved'));
            if (!request) return sendJson({ success: true, status: null });
            const driver = db.memoryState.drivers.find(d => d.driverId === request.driverId);
            const resp = { requestId: request.requestId, driverId: request.driverId, status: request.status, createdAt: request.createdAt };
            if (request.status === 'Approved' && driver) {
                resp.driverPhone = driver.phoneNumber;
                resp.driverName = driver.fullName;
                resp.wazeUrl = 'waze://ul?ll=' + request.pickupLat + ',' + request.pickupLon + '&navigate=yes';
            }
            return sendJson({ success: true, request: resp });
        }

        // Fleet operations log (all bookings + join requests + external)
        if (pathname === '/api/fleet/operations-log' && method === 'GET') {
            const ops = [];
            (db.memoryState.bookings || []).slice(0, 50).forEach(b => ops.push({ type: 'booking', id: b.bookingId || b.id, status: b.status, from: b.pickupAddress || '', to: b.dropoffAddress || '', passengerName: (db.memoryState.customers.find(c=>c.userId===b.passengerId)||{}).fullName || b.passengerId, driverName: (db.memoryState.drivers.find(d=>d.driverId===b.driverId)||{}).fullName || b.driverId, createdAt: b.createdAt || '' }));
            (db.memoryState.externalBookings || []).slice(0, 50).forEach(b => ops.push({ type: 'external', channel: b.channel, id: b.bookingId, status: b.status, passengerPhone: b.passengerPhone, driverPhone: b.driverPhone, from: b.pickup, to: b.dropoff, createdAt: b.createdAt }));
            (db.memoryState.joinRequests || []).slice(0, 50).forEach(j => { const p=db.memoryState.customers.find(c=>c.userId===j.passengerId)||{}; const d=db.memoryState.drivers.find(dr=>dr.driverId===j.driverId)||{}; ops.push({ type: 'join', id: j.requestId, status: j.status, passengerName: p.fullName||j.passengerId, driverName: d.fullName||j.driverId, from: j.pickupText, to: j.dropoffText, createdAt: j.createdAt }); });
            ops.sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
            return sendJson({ success: true, operations: ops.slice(0, 100) });
        }

        if (pathname.startsWith('/uploads/')) {
            const rawRel = pathname.replace(/^\/uploads\//, '').replace(/\.\./g, '').replace(/^\/+/, '');
            const uploadFile = path.join(config.uploadsDir, rawRel);
            if (!uploadFile.startsWith(path.resolve(config.uploadsDir))) {
                res.writeHead(403); return res.end('Forbidden');
            }
            if (fs.existsSync(uploadFile)) {
                return serveCompressedFile(uploadFile, req, res);
            }
            res.writeHead(404);
            return res.end('File not found');
        }

        // ---------------------------------------------------------------------
        // 5. INTERNAL APP VIEW SERVING (/app-view, /app-view/*)
        // ---------------------------------------------------------------------
        if (pathname === '/app-view' || pathname === '/app-view/' || pathname.startsWith('/app-view/')) {
            let rel = pathname.startsWith('/app-view/') ? pathname.replace(/^\/app-view\//, '') : 'index.html';
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
            }
            res.writeHead(404);
            return res.end('Not found');
        }

        // ---------------------------------------------------------------------
        // 5.1 REDIRECT LEGACY /app TO ROOT (Official Website)
        // ---------------------------------------------------------------------
        if (pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/')) {
            res.writeHead(301, { 'Location': '/' });
            return res.end();
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
    return server;
}

if (require.main === module) {
    startServer().catch(err => {
        console.error('Fatal server boot error:', err);
        process.exit(1);
    });
}

module.exports = { startServer };
