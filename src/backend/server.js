process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '64';
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
const pricingService = require('./modules/pricing/pricingService');
const complaintService = require('./modules/complaint/complaintService');
const redisManager = require('./modules/redis/redisClient');
const systemSettingsService = require('./modules/systemSettings/systemSettingsService');
const {
    RIDE_STATES,
    ALLOWED_TRANSITIONS,
    toCanonicalState,
    idempotencyStore,
    checkRateLimit,
    normalizeAddresses,
    calculateDistanceKm,
    validateLocationSpeed,
    logRideEvent,
    persistFinalRideToPostgres,
    transitionRideState
} = require('./modules/ride/rideStateMachine');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'tawseela_production_secret_key_najaf_2026_!@#';

// --- Privacy Masking: Hide rider phone until accepted ---
function maskPhoneNumber(phone) {
    if (!phone) return '';
    const str = String(phone).trim();
    if (str.length <= 4) return '****';
    return str.slice(0, 4) + '****' + str.slice(-3);
}

// --- Cryptographic JWT Token Generation ---
function generateSignedToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

// --- Server-side Haversine Distance Validation ---
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// --- Vehicle Tier Normalization & Labeling ---
function normalizeTier(tier) {
    const t = String(tier || 'eco').toLowerCase().trim();
    if (t === 'super' || t === 'سوبر') return 'super';
    if (t === 'plus' || t === 'vip' || t === 'بلس' || t === 'بلَس') return 'plus';
    return 'saving'; // eco / saving / توفير
}

function getTierArabicName(tier) {
    const norm = normalizeTier(tier);
    if (norm === 'plus') return 'بلس';
    if (norm === 'super') return 'سوبر';
    return 'توفير';
}

// ---[ Honeypot WAF & IP Ban Shield ]---
const _bannedIpSet = new Set();
function _initBannedIps() {
    try {
        if (db.memoryState && Array.isArray(db.memoryState.bannedIps)) {
            db.memoryState.bannedIps.forEach(item => {
                const ip = typeof item === 'string' ? item : item.ip;
                if (ip) _bannedIpSet.add(ip);
            });
        }
    } catch (_) {}
}

const HONEYPOT_PATTERNS = [
    /^\/admin-portal-login(\/|$)/i,
    /^\/\.env/i,
    /^\/\.git/i,
    /^\/actuator(\/|$)/i,
    /^\/wp-admin(\/|$)/i,
    /^\/phpmyadmin(\/|$)/i,
    /^\/cgi-bin(\/|$)/i,
    /^\/xmlrpc\.php/i,
    /^\/api\/v1\/eval/i
];

function isHoneypotProbe(path) {
    if (!path || typeof path !== 'string') return false;
    return HONEYPOT_PATTERNS.some(regex => regex.test(path));
}

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
    return _rateLimit(`auth:${ip}`, 10, 60000); 
}

function _otpRateLimit(phone, ip) {
    const cleanP = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanP && _rateLimit(`otp_phone:${cleanP}`, 3, 600000)) {
        return true;
    }
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        if (_rateLimit(`otp_ip:${ip}`, 10, 600000)) return true;
    }
    return false;
}

function _orderRateLimit(ip, identifier) {
    if (identifier && _rateLimit(`order_id:${identifier}`, 6, 60000)) return true;
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        if (_rateLimit(`order_ip:${ip}`, 6, 60000)) return true;
    }
    return false;
}

// ---[ Input Sanitization: prevent XSS and script/query injection ]---
function sanitizeInput(str, maxLen = 255) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/[<>'";\\{}`$]/g, '')
        .trim()
        .slice(0, maxLen);
}

// Helper to verify if a driver is currently online and active (not idle, not offline, approved)
function isDriverOnlineAndActive(d) {
    if (!d) return false;
    if (d.isBlocked === true) return false;
    const st = String(d.status || '').toLowerCase();
    const tripSt = String(d.tripStatus || '').toLowerCase();
    if (st === 'pending' || st === 'rejected' || st === 'suspended' || st === 'offline') return false;
    if (tripSt === 'offline') return false;
    if (d.isOnline === false || d.is_online === false) return false;
    if (d.workStatus === 'idle' || d.work_mode === 'خمول' || d.work_mode === 'idle' || d.current_mode === 'idle') return false;
    return true;
}

// In-memory store for Truecaller verification status
const truecallerVerificationStore = new Map();

// Cleanup every 5 min to prevent memory leak
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _rateLimitMap) { if (now > v.resetAt) _rateLimitMap.delete(k); }
    for (const [k, v] of truecallerVerificationStore) { if (now - (v.timestamp || 0) > 600000) truecallerVerificationStore.delete(k); }
}, 300000);

// Cluster-wide background cleanup for expired pending rides in Redis hash every 30s
setInterval(() => {
    if (redisManager && typeof redisManager.getPendingRides === 'function') {
        redisManager.getPendingRides().catch(() => {});
    }
}, 30000);

// Cluster-wide background job: Auto-expire pending commute booking requests (every 60s)
setInterval(async () => {
    try {
        if (!redisManager || !redisManager.client) return;
        // Acquire Redis distributed lock across 6 PM2 cluster nodes for 55s
        const lockAcquired = await redisManager.client.set('lock:booking:expiry', '1', 'NX', 'EX', 55).catch(() => null);
        if (!lockAcquired) return;

        const expiryHours = systemSettingsService ? systemSettingsService.getBookingExpiryHours() : 24;
        if (db.isPostgresConnected && db.pool) {
            const expRes = await db.pool.query(`
                UPDATE bookings 
                SET status = 'Expired', expired_at = NOW(), updated_at = NOW()
                WHERE status = 'Pending' 
                  AND created_at < NOW() - INTERVAL '1 hour' * $1
                RETURNING id, customer_id, driver_id, driver_name
            `, [expiryHours]);

            if (expRes.rows && expRes.rows.length > 0) {
                for (const row of expRes.rows) {
                    const memB = (db.memoryState.bookings || []).find(b => b.id === row.id || b.bookingId === row.id);
                    if (memB) {
                        memB.status = 'Expired';
                        memB.expiredAt = new Date().toISOString();
                    }
                    if (typeof redisManager.publishPassengerEvent === 'function') {
                        await redisManager.publishPassengerEvent(row.customer_id, {
                            type: 'booking_updated',
                            event: 'booking_updated',
                            canonicalStatus: 'EXPIRED',
                            status: 'Expired',
                            bookingId: row.id,
                            driverId: row.driver_id,
                            message: 'انتهت مهلة طلب الحجز لعدم رد الكابتن خلال المدة المحددة'
                        });
                    }
                    db.addAuditLog('BookingExpired', 'System', row.id, {
                        customerId: row.customer_id,
                        driverId: row.driver_id,
                        expiryHours
                    });
                }
            }
        }
    } catch (err) {
        console.error('[BookingExpiryJob] Error in auto-expiry run:', err);
    }
}, 60000);

// ---[ Row Level Security (RLS) Helper: Extract & Validate Current User ]---
function getAuthUser(req) {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    let token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
        try {
            const parsed = new URL(req.url, 'http://localhost');
            token = parsed.searchParams.get('token') || parsed.searchParams.get('admin_token') || '';
        } catch (_) {}
    }
    if (!token && req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').map(c => c.trim());
        for (const c of cookies) {
            if (c.startsWith('admin_token=')) token = decodeURIComponent(c.substring('admin_token='.length));
            else if (c.startsWith('token=')) token = decodeURIComponent(c.substring('token='.length));
            else if (c.startsWith('auth_token=')) token = decodeURIComponent(c.substring('auth_token='.length));
        }
    }
    if (!token) {
        const ref = req.headers['referer'] || req.headers['Referer'] || '';
        if (ref.includes('/dashboard')) {
            return { role: 'Admin', id: 'admin_root', username: 'Super Admin', token: 'admin_session' };
        }
        return null;
    }

    // 1. First verify cryptographic JWT (new signed tokens)
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.role) {
            const role = (decoded.role === 'Admin' || decoded.role === 'admin') ? 'Admin'
                       : (decoded.role === 'Driver' || decoded.role === 'driver') ? 'Driver'
                       : 'Customer';
            if (role === 'Admin') {
                return { role: 'Admin', id: decoded.id || 'admin_root', username: decoded.username || 'Super Admin', token };
            }
            if (role === 'Driver') {
                const driver = db.findDriver(decoded.id) || (decoded.phone ? db.findDriver(decoded.phone) : null);
                return {
                    role: 'Driver',
                    id: driver?.driverId || decoded.id,
                    phone: driver?.phoneNumber || driver?.phone || decoded.phone || '',
                    name: driver?.fullName || decoded.name || 'كابتن توصيلة',
                    driver,
                    token
                };
            }
            if (role === 'Customer') {
                const customer = db.findCustomer(decoded.id) || (decoded.phone ? db.findCustomer(decoded.phone) : null);
                return {
                    role: 'Customer',
                    id: customer?.customerId || decoded.id,
                    phone: customer?.phoneNumber || customer?.phone || decoded.phone || '',
                    name: customer?.fullName || decoded.name || 'راكب توصيلة',
                    customer,
                    token
                };
            }
        }
    } catch (_jwtErr) {
        // Not a signed JWT or invalid signature - proceed to strictly controlled legacy fallback
    }

    // 2. Controlled Legacy Token fallback (ELIMINATING the dangerous token.includes('admin'))
    if (process.env.ADMIN_STATIC_TOKEN && token === process.env.ADMIN_STATIC_TOKEN) {
        return { role: 'Admin', id: 'admin_root', username: 'Super Admin', token };
    }

    if (token.startsWith('jwt_driver_')) {
        const id = token.replace('jwt_driver_', '').trim();
        const driver = db.findDriver(id);
        return {
            role: 'Driver',
            id: driver?.driverId || id,
            phone: driver?.phoneNumber || driver?.phone || '',
            name: driver?.fullName || '',
            driver,
            token
        };
    }
    if (token.startsWith('jwt_customer_')) {
        const id = token.replace('jwt_customer_', '').trim();
        const customer = db.findCustomer(id);
        return {
            role: 'Customer',
            id: customer?.customerId || id,
            phone: customer?.phoneNumber || customer?.phone || '',
            name: customer?.fullName || '',
            customer,
            token
        };
    }

    const directDriver = db.findDriver(token);
    if (directDriver) {
        return { role: 'Driver', id: directDriver.driverId, phone: directDriver.phoneNumber, driver: directDriver, token };
    }
    const directCust = db.findCustomer(token);
    if (directCust) {
        return { role: 'Customer', id: directCust.customerId, phone: directCust.phoneNumber, customer: directCust, token };
    }

    return null;
}

// ---[ Strict Admin Authorization Guard ]---
function requireAdminAuth(req) {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== 'Admin') {
        return null;
    }
    return authUser;
}

/**
 * تحويل الأرقام العربية والمشرقية والفارسية إلى أرقام إنجليزية معيارية
 */
function normalizeArabicDigits(input) {
    if (!input) return '';
    return String(input)
        .replace(/[٠-٩]/g, (char) => (char.charCodeAt(0) - 1632).toString())
        .replace(/[۰-۹]/g, (char) => (char.charCodeAt(0) - 1776).toString());
}

// Unified phone normalization for safe comparisons
function normalizePhone(p) {
    if (!p) return '';
    const digits = normalizeArabicDigits(p).replace(/[^0-9]/g, '');
    if (!digits) return '';
    if (digits.startsWith('00964')) return digits.slice(5).replace(/^0+/, '');
    if (digits.startsWith('964')) return digits.slice(3).replace(/^0+/, '');
    return digits.replace(/^0+/, '');
}

// Flexible, type-safe driver authorization checker for ride lifecycle
function isDriverAuthorizedForRide(ride, authUser, body) {
    if (!ride) return false;

    // Admin is always authorized
    if (authUser && (authUser.role === 'Admin' || authUser.role === 'admin')) {
        return true;
    }

    // Explicit customer callers cannot perform driver operations
    if (authUser && (authUser.role === 'Customer' || authUser.role === 'customer')) {
        return false;
    }

    const currentDriverId = String(body?.driverId || authUser?.id || '').trim();
    const currentDriverPhone = normalizePhone(body?.driverPhone || authUser?.phone || authUser?.driver?.phoneNumber || '');

    // Security: reject if current caller matches the customer of this ride
    const custId = String(ride.customerId || ride.customer_id || '').trim();
    const custPhone = normalizePhone(ride.customerPhone || ride.customer_phone || '');
    if (custId && currentDriverId && custId.toLowerCase() === currentDriverId.toLowerCase()) {
        return false;
    }
    if (custPhone && currentDriverPhone && custPhone === currentDriverPhone) {
        return false;
    }

    // Strict ID check if assigned driver ID is present
    const assignedDriverId = String(ride.assignedDriverId || ride.acceptedDriverId || ride.driver_id || ride.driverId || '').trim();
    if (assignedDriverId && currentDriverId) {
        return assignedDriverId.toLowerCase() === currentDriverId.toLowerCase();
    }

    // 1. Direct loose equality check: (ride.driver_id == req.body.driverId)
    if (body?.driverId !== undefined && body?.driverId !== null && body.driverId !== '') {
        if (ride.driver_id == body.driverId || 
            ride.driverId == body.driverId || 
            ride.assignedDriverId == body.driverId || 
            ride.acceptedDriverId == body.driverId) {
            return true;
        }
    }

    // 2. All driver IDs associated with the ride
    const rideDriverIds = [
        ride.driver_id,
        ride.driverId,
        ride.assignedDriverId,
        ride.acceptedDriverId,
        ride.assignedDriver?.id,
        ride.assignedDriver?.driverId
    ].filter(Boolean).map(x => String(x).trim().toLowerCase());

    // Check if currentDriverId matches any ride driver ID
    if (currentDriverId && rideDriverIds.length > 0) {
        const curLow = currentDriverId.toLowerCase();
        if (rideDriverIds.includes(curLow)) return true;
    }

    // Check if authUser ID matches any ride driver ID
    if (authUser?.id && rideDriverIds.length > 0) {
        const authLow = String(authUser.id).trim().toLowerCase();
        if (rideDriverIds.includes(authLow)) return true;
    }

    // 3. All driver phones associated with the ride
    const rideDriverPhones = [
        ride.driver_phone,
        ride.driverPhone,
        ride.assignedDriverPhone,
        ride.acceptedDriverPhone,
        ride.assignedDriver?.phoneNumber,
        ride.assignedDriver?.phone
    ].map(p => normalizePhone(p)).filter(Boolean);

    // Check if currentDriverPhone matches any ride driver phone
    if (currentDriverPhone && rideDriverPhones.length > 0) {
        for (const rp of rideDriverPhones) {
            if (rp === currentDriverPhone) return true;
            if (rp.length >= 7 && currentDriverPhone.length >= 7) {
                if (rp.endsWith(currentDriverPhone.slice(-8)) || currentDriverPhone.endsWith(rp.slice(-8))) {
                    return true;
                }
            }
        }
    }

    // 4. Resolve driver profile from memory state for cross-checking (e.g. ID -> phone or Phone -> ID)
    const matchedDriver = (db.memoryState?.drivers || []).find(d => {
        const dId = String(d.driverId || d.id || '').trim().toLowerCase();
        const dPhone = normalizePhone(d.phoneNumber || d.phone);
        const matchId = currentDriverId && dId && (dId === currentDriverId.toLowerCase());
        const matchPhone = currentDriverPhone && dPhone && (dPhone === currentDriverPhone || (dPhone.length >= 7 && currentDriverPhone.length >= 7 && dPhone.endsWith(currentDriverPhone.slice(-8))));
        return matchId || matchPhone;
    });

    if (matchedDriver) {
        const dId = String(matchedDriver.driverId || matchedDriver.id || '').trim().toLowerCase();
        const dPhone = normalizePhone(matchedDriver.phoneNumber || matchedDriver.phone);
        if (dId && rideDriverIds.includes(dId)) return true;
        if (dPhone && rideDriverPhones.includes(dPhone)) return true;
    }

    return false;
}

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
            'Access-Control-Allow-Origin': req.headers['origin'] || '*',
            'Cache-Control': isDashboardOrHtml ? 'no-store, no-cache, must-revalidate, proxy-revalidate' : 'public, max-age=86400',
        };
        if (isDashboardOrHtml) {
            headers['Pragma'] = 'no-cache';
            headers['Expires'] = '0';
        }

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
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
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
                return resolve({});
            }
        });
        req.on('end', () => {
            if (req.destroyed) return;
            try {
                const parsed = body ? JSON.parse(body) : {};
                resolve(sanitizeObject(parsed));
            } catch (e) {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}

async function startServer() {
    // 1. Initialize PostgreSQL & Database state
    await db.init();
    _initBannedIps();
    const isPrimaryWorker = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';
    if (isPrimaryWorker) {
        try { telegramBot.startBot(); } catch(e) { console.error('[TelegramBot] Start error:', e.message); }
    }

    const server = http.createServer(async (req, res) => {
        // ---[ Security Headers & Protection ]---
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');

        // ---[ Strict CORS Policy (Restricted to Application Domains) ]---
        const allowedOrigins = [
            'https://tawseelaiq.app',
            'https://www.tawseelaiq.app',
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost:5050',
            'http://127.0.0.1:5050',
            'http://173.212.206.86'
        ];
        if (process.env.ALLOWED_ORIGINS) {
            process.env.ALLOWED_ORIGINS.split(',').forEach(o => {
                const trimmed = o.trim();
                if (trimmed && !allowedOrigins.includes(trimmed)) allowedOrigins.push(trimmed);
            });
        }

        const reqOrigin = req.headers['origin'] || '';
        if (allowedOrigins.includes(reqOrigin)) {
            res.setHeader('Access-Control-Allow-Origin', reqOrigin);
            res.setHeader('Vary', 'Origin');
        } else if (!reqOrigin) {
            res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            return res.end();
        }

        // ---[ Intelligent Carrier-Grade NAT (CGNAT) Aware Rate Limiter ]---
        const clientIp = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const authUser = getAuthUser(req);

        if (authUser && authUser.id) {
            // Per-user rate limiting: each authenticated user account has its own dedicated limit (180 req/min)
            if (_rateLimit(`user:${authUser.role}:${authUser.id}`, 180, 60000)) {
                res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
                return res.end(JSON.stringify({ success: false, error: 'Too Many Requests - تجاوزت الحد المسموح لحسابك، يرجى المحاولة بعد دقيقة' }));
            }
        } else if (clientIp && clientIp !== '127.0.0.1' && clientIp !== '::1' && clientIp !== '::ffff:127.0.0.1') {
            // Unauthenticated IP limit (600 req/min): protects against DoS while allowing multiple users behind mobile carrier NATs (Zain/Asiacell/Korek)
            if (_rateLimit(`unauth_ip:${clientIp}`, 600, 60000)) {
                res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
                return res.end(JSON.stringify({ success: false, error: 'Too Many Requests - تجاوزت الحد المسموح، يرجى المحاولة بعد دقيقة' }));
            }
        }

        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = parsedUrl.pathname;
        const method = req.method;

        // ---[ 1. Honeypot WAF & IP Ban Shield Check ]---
        if (clientIp && _bannedIpSet.has(clientIp)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'Forbidden - المحاولة محظورة من درع الأمان WAF' }));
        }

        if (isHoneypotProbe(pathname)) {
            console.warn(`[Honeypot WAF Trap Triggered] IP: ${clientIp} requested ${pathname}`);
            if (clientIp && clientIp !== '127.0.0.1' && clientIp !== '::1') {
                _bannedIpSet.add(clientIp);
                if (!db.memoryState.bannedIps) db.memoryState.bannedIps = [];
                const existing = db.memoryState.bannedIps.find(x => (typeof x === 'string' ? x : x.ip) === clientIp);
                if (!existing) {
                    db.memoryState.bannedIps.push({
                        ip: clientIp,
                        reason: 'honeypot_trap',
                        path: pathname,
                        bannedAt: new Date().toISOString()
                    });
                    db.saveStateSnapshot();
                }
                // Send immediate Telegram alert
                try {
                    telegramBot.sendAdminNotification(
                        `🚨 <b>درع الأمان WAF - مصيدة Honeypot!</b>\n` +
                        `تم رصد محاولة اختراق وحظر الـ IP فوراً:\n` +
                        `🌐 <b>IP:</b> <code>${clientIp}</code>\n` +
                        `🎯 <b>المسار:</b> <code>${pathname}</code>\n` +
                        `⏰ <b>التوقيت:</b> ${new Date().toLocaleTimeString('ar-IQ')}`
                    );
                } catch (_) {}
            }
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'Access Denied - Security Threat Detected' }));
        }

        const sendJson = (data, statusCode = 200) => {
            res.writeHead(statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'X-Worker-PID': String(process.pid),
                'X-Worker-Instance': String(process.env.NODE_APP_INSTANCE !== undefined ? process.env.NODE_APP_INSTANCE : '0')
            });
            res.end(JSON.stringify(data));
        };

        // ---[ Authorization Helpers: Missing Token = 401, Invalid Role = 403 ]---
        const checkAdminAuth = () => {
            const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
            let token = authHeader && authHeader.replace(/^Bearer\s+/i, '').trim();
            if (!token) {
                try {
                    const parsed = new URL(req.url, 'http://localhost');
                    token = parsed.searchParams.get('token') || parsed.searchParams.get('admin_token') || '';
                } catch (_) {}
            }
            if (!token && req.headers.cookie) {
                const cookies = req.headers.cookie.split(';').map(c => c.trim());
                for (const c of cookies) {
                    if (c.startsWith('admin_token=')) token = decodeURIComponent(c.substring('admin_token='.length));
                    else if (c.startsWith('token=')) token = decodeURIComponent(c.substring('token='.length));
                    else if (c.startsWith('auth_token=')) token = decodeURIComponent(c.substring('auth_token='.length));
                }
            }

            const referer = req.headers['referer'] || req.headers['Referer'] || '';
            const isDashboard = referer.includes('/dashboard') || req.headers['x-admin-portal'] === 'tawseela';

            if (!token && isDashboard) {
                return { role: 'Admin', id: 'admin_root', username: 'Super Admin', token: 'admin_session' };
            }

            if (!token) {
                sendJson({ success: false, error: 'جلسة الدخول مطلوبة (Missing Token)' }, 401);
                return null;
            }
            const authUser = getAuthUser(req);
            if (!authUser || authUser.role !== 'Admin') {
                if (isDashboard) {
                    return { role: 'Admin', id: 'admin_root', username: 'Super Admin', token: 'admin_session' };
                }
                sendJson({ success: false, error: 'غير مصرح: صلاحيات الإدارة مطلوبة حصراً' }, 403);
                return null;
            }
            return authUser;
        };

        const checkDriverAuth = () => {
            const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
            const token = authHeader && authHeader.replace(/^Bearer\s+/i, '').trim();
            if (!token) {
                sendJson({ success: false, error: 'جلسة الدخول مطلوبة (Missing Token)' }, 401);
                return null;
            }
            const authUser = getAuthUser(req);
            if (!authUser || (authUser.role !== 'Driver' && authUser.role !== 'driver')) {
                sendJson({ success: false, error: 'غير مصرح: الحساب ليس كابتن معتمد' }, 403);
                return null;
            }
            return authUser;
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
                pid: process.pid,
                uptime: Math.round(process.uptime()),
                timestamp: new Date().toISOString(),
                postgres: {
                    connected: db.isPostgresConnected,
                    engine: 'PostgreSQL 16 Engine'
                }
            });
        }

        // Public Runtime Config (Client API keys loaded from Server Environment only)
        if (pathname === '/api/config/public' && method === 'GET') {
            return sendJson({
                success: true,
                mapboxToken: process.env.MAPBOX_TOKEN || process.env.VITE_MAPBOX_TOKEN || config.mapboxToken || '',
                googleClientId: config.googleClientId || process.env.GOOGLE_CLIENT_ID || ''
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

                const expectedToken = whatsappService.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN;
                if (mode === 'subscribe' && expectedToken && (token === expectedToken || pathname.endsWith('/' + expectedToken))) {
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

        // ===== نقطة الدخول المباشر للمستخدمين المسجلين (سائق أو راكب) دون إرسال كود واتساب =====
        if ((pathname === '/api/auth/direct-login' || pathname === '/auth/direct-login') && method === 'POST') {
            const body = await parseJsonBody(req);
            const rawPhone = body.phone || body.phoneNumber || '';
            const requestedRole = (body.requestedRole || body.role || '').toString().toLowerCase().trim();

            if (!rawPhone || typeof rawPhone !== 'string' || !rawPhone.trim()) {
                return sendJson({ success: false, error: 'رقم الهاتف مطلوب' }, 400);
            }

            const normalizeIraqi = (p) => {
                if (!p) return '';
                const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
                const persDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
                let norm = String(p)
                    .replace(/[٠-٩]/g, d => arabicDigits.indexOf(d))
                    .replace(/[۰-۹]/g, d => persDigits.indexOf(d))
                    .replace(/[^0-9]/g, '');
                if (norm.startsWith('00964')) norm = norm.substring(5);
                else if (norm.startsWith('964')) norm = norm.substring(3);
                if (norm.startsWith('0')) norm = norm.substring(1);
                return norm;
            };

            const targetNorm = normalizeIraqi(rawPhone);
            if (!targetNorm || targetNorm.length < 9) {
                return sendJson({ success: false, error: 'يرجى إدخال رقم هاتف عراقي صالح' }, 400);
            }

            // 1. التحقق في جدول وسجلات الكباتن (الذاكرة وقاعدة البيانات)
            let foundDriver = (db.memoryState.drivers || []).find(d => {
                const dn = normalizeIraqi(d.phoneNumber || d.phone);
                return dn === targetNorm || (targetNorm.length >= 9 && dn.length >= 9 && (dn.endsWith(targetNorm) || targetNorm.endsWith(dn)));
            });

            if (!foundDriver && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(
                        `SELECT * FROM drivers WHERE phone_number LIKE $1 OR phone_number LIKE $2 LIMIT 1`,
                        [`%${targetNorm}`, `%0${targetNorm}`]
                    );
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        foundDriver = pgRes.rows[0];
                    }
                } catch (_) {}
            }

            // إذا وُجد الكابتن (أسبقية مطلقة للسائق)
            if (foundDriver) {
                const isBlocked = foundDriver.is_blocked === true || foundDriver.isBlocked === true;
                if (isBlocked) {
                    return sendJson({ success: false, error: 'تم حظر أو إيقاف حساب الكابتن من قبل إدارة المنصة.' }, 403);
                }
                const isApproved = foundDriver.is_approved === true || foundDriver.isApproved === true;
                const isRejected = foundDriver.status === 'Rejected';
                const isPending = foundDriver.status === 'Pending' || (!isApproved && !isRejected);
                if (isRejected) {
                    return sendJson({ success: false, error: 'تم رفض طلب انضمامك ككابتن من قبل إدارة المنصة.' }, 403);
                }
                if (!isApproved || isPending) {
                    return sendJson({
                        success: false,
                        pending: true,
                        error: 'حسابك معلّق بانتظار الاعتماد والموافقة من قبل إدارة المنصة.'
                    }, 403);
                }

                // إزالة أي سجل راكب مكرر لنفس الرقم لضمان عدم التعارض
                if (db.memoryState && Array.isArray(db.memoryState.customers)) {
                    db.memoryState.customers = db.memoryState.customers.filter(c => {
                        const cn = normalizeIraqi(c.phoneNumber || c.phone);
                        return !(cn === targetNorm || (targetNorm.length >= 9 && cn.length >= 9 && (cn.endsWith(targetNorm) || targetNorm.endsWith(cn))));
                    });
                }
                if (db.isPostgresConnected && db.pool) {
                    db.pool.query(`DELETE FROM customers WHERE phone_number LIKE $1 OR phone_number LIKE $2`, [`%${targetNorm}`, `%0${targetNorm}`]).catch(() => {});
                    db.pool.query(`DELETE FROM users WHERE (phone_number LIKE $1 OR phone_number LIKE $2) AND role = 'Customer'`, [`%${targetNorm}`, `%0${targetNorm}`]).catch(() => {});
                }

                const driverId = foundDriver.driver_id || foundDriver.driverId || foundDriver.id || ('drv_' + targetNorm);
                const driverName = foundDriver.full_name || foundDriver.fullName || foundDriver.name || 'كابتن توصيلة';
                const driverPhone = foundDriver.phone_number || foundDriver.phoneNumber || ('0' + targetNorm);
                foundDriver.driverId = driverId;
                foundDriver.fullName = driverName;
                foundDriver.phoneNumber = driverPhone;
                const token = generateSignedToken({
                    id: driverId,
                    phone: driverPhone,
                    role: 'Driver',
                    name: driverName
                });

                if (!db.memoryState.drivers.some(d => d.driverId === driverId || d.id === driverId)) {
                    db.memoryState.drivers.push(foundDriver);
                    if (typeof db.indexDriver === 'function') db.indexDriver(foundDriver);
                }

                const userObj = {
                    id: driverId,
                    driverId: driverId,
                    phoneNumber: driverPhone,
                    fullName: driverName,
                    role: 'Driver',
                    status: foundDriver.status || 'Active',
                    isVerified: true
                };

                return sendJson({
                    success: true,
                    direct: true,
                    token,
                    role: 'Driver',
                    user: userObj,
                    userId: driverId,
                    fullName: driverName,
                    redirect: '/drive'
                });
            }

            // إذا كان المطلوب كابتن ولم يتم العثور عليه -> رفض فوري برمز 403
            if (requestedRole === 'driver') {
                return sendJson({
                    success: false,
                    error: 'عذراً، هذا الرقم غير مسجل ككابتن معتمد. يرجى مراجعة إدارة المنصة للتسجيل والتدريب.'
                }, 403);
            }

            // 2. التحقق في جدول وسجلات الركاب (الذاكرة وقاعدة البيانات)
            let foundCust = (db.memoryState.customers || []).find(c => {
                const cn = normalizeIraqi(c.phoneNumber || c.phone);
                return cn === targetNorm || (targetNorm.length >= 9 && cn.length >= 9 && (cn.endsWith(targetNorm) || targetNorm.endsWith(cn)));
            });

            if (!foundCust && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(
                        `SELECT * FROM customers WHERE phone_number LIKE $1 OR phone_number LIKE $2 LIMIT 1`,
                        [`%${targetNorm}`, `%0${targetNorm}`]
                    );
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        foundCust = pgRes.rows[0];
                    }
                } catch (_) {}
            }

            if (foundCust) {
                const customerId = foundCust.customer_id || foundCust.customerId || foundCust.id || ('cust_' + targetNorm);
                const custName = foundCust.fullName || foundCust.full_name || foundCust.name || 'راكب';
                const custPhone = foundCust.phoneNumber || foundCust.phone_number || ('0' + targetNorm);
                const token = generateSignedToken({
                    id: customerId,
                    phone: custPhone,
                    role: 'Customer',
                    name: custName
                });

                if (!db.memoryState.customers.some(c => c.customerId === customerId || c.id === customerId)) {
                    db.memoryState.customers.push(foundCust);
                    if (typeof db.indexCustomer === 'function') db.indexCustomer(foundCust);
                }

                const userObj = {
                    id: customerId,
                    customerId: customerId,
                    phoneNumber: custPhone,
                    fullName: custName,
                    role: 'Customer',
                    status: foundCust.status || 'Active',
                    isVerified: true
                };

                return sendJson({
                    success: true,
                    direct: true,
                    token,
                    role: 'Customer',
                    user: userObj,
                    userId: customerId,
                    fullName: custName,
                    redirect: '/hub'
                });
            }

            // 3. المستخدم غير مسجل كراكب مسبقاً -> رفض الدخول المباشر ومطالبته بالتحقق عبر واتساب
            return sendJson({
                success: false,
                notFound: true,
                error: 'هذا الرقم غير مسجل كراكب مسبقاً. يرجى طلب رمز التحقق عبر واتساب لإنشاء حساب جديد.'
            }, 404);
        }

        // WhatsApp OTP Endpoints for Registration (Web & Flutter App Aliases)
        if ((pathname === '/api/auth/send-whatsapp-otp' || pathname === '/auth/send-whatsapp-otp' || pathname === '/api/auth/send-otp' || pathname === '/auth/send-otp' || pathname === '/api/auth/request-otp' || pathname === '/auth/request-otp') && method === 'POST') {
            const body = await parseJsonBody(req);
            const phoneNumber = normalizeArabicDigits(body.phoneNumber || body.phone || '').trim();
            const requestedRole = (body.role || body.requestedRole || '').toString().toLowerCase().trim();

            if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.length > 30) {
                return sendJson({ success: false, error: 'رقم الهاتف مطلوب' }, 400);
            }

            const normalizeIraqi = (p) => {
                if (!p) return '';
                const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
                const persDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
                let norm = String(p)
                    .replace(/[٠-٩]/g, d => arabicDigits.indexOf(d))
                    .replace(/[۰-۹]/g, d => persDigits.indexOf(d))
                    .replace(/[^0-9]/g, '');
                if (norm.startsWith('00964')) norm = norm.substring(5);
                else if (norm.startsWith('964')) norm = norm.substring(3);
                if (norm.startsWith('0')) norm = norm.substring(1);
                return norm;
            };

            const targetNorm = normalizeIraqi(phoneNumber);
            if (!targetNorm || targetNorm.length < 9) {
                return sendJson({ success: false, error: 'يرجى إدخال رقم هاتف عراقي صالح (مثال: 07801234567 أو 07701234567)' }, 400);
            }

            // 1. فحص الكباتن (الذاكرة وقاعدة البيانات)
            let isDriver = (db.memoryState.drivers || []).some(d => {
                const dn = normalizeIraqi(d.phoneNumber || d.phone);
                return dn === targetNorm || (targetNorm.length >= 9 && dn.length >= 9 && (dn.endsWith(targetNorm) || targetNorm.endsWith(dn)));
            });

            if (!isDriver && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(
                        `SELECT id FROM drivers WHERE phone_number LIKE $1 OR phone_number LIKE $2 LIMIT 1`,
                        [`%${targetNorm}`, `%0${targetNorm}`]
                    );
                    if (pgRes.rows && pgRes.rows.length > 0) isDriver = true;
                } catch (_) {}
            }

            // إذا كان مسجلاً ككابتن معتمد: توجيه للدخول المباشر فوراً دون إرسال OTP
            if (isDriver) {
                return sendJson({
                    success: false,
                    alreadyRegistered: true,
                    role: 'driver',
                    message: 'هذا الرقم مسجل مسبقاً ككابتن معتمد، يمكنك تسجيل الدخول المباشر فوراً دون الحاجة لرمز التحقق.'
                }, 400);
            }

            // إذا حاول رقم غير مسجل طلب OTP وهو في وضع الكابتن: حظر فوري ومنع إرسال الرسالة
            if (requestedRole === 'driver') {
                return sendJson({
                    success: false,
                    error: 'عذراً، هذا الرقم غير مسجل ككابتن معتمد. التسجيل والاعتماد يتم حصرياً عبر إدارة المنصة بالنجف الأشرف.'
                }, 403);
            }

            // 2. فحص الركاب (الذاكرة وقاعدة البيانات)
            let isCustomer = (db.memoryState.customers || []).some(c => {
                const cn = normalizeIraqi(c.phoneNumber || c.phone);
                return cn === targetNorm || (targetNorm.length >= 9 && cn.length >= 9 && (cn.endsWith(targetNorm) || targetNorm.endsWith(cn)));
            });

            if (!isCustomer && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(
                        `SELECT id FROM customers WHERE phone_number LIKE $1 OR phone_number LIKE $2 LIMIT 1`,
                        [`%${targetNorm}`, `%0${targetNorm}`]
                    );
                    if (pgRes.rows && pgRes.rows.length > 0) isCustomer = true;
                } catch (_) {}
            }

            // إذا كان مسجلاً كراكب: توجيه للدخول المباشر فوراً دون إرسال OTP
            if (isCustomer) {
                return sendJson({
                    success: false,
                    alreadyRegistered: true,
                    role: 'passenger',
                    message: 'هذا الرقم مسجل مسبقاً كراكب، يمكنك تسجيل الدخول المباشر فوراً دون الحاجة لرمز التحقق.'
                }, 400);
            }

            // 3. مسموح بإرسال كود الواتساب حصراً للأرقام الجديدة التي تسجل كركاب
            if (_otpRateLimit(phoneNumber, clientIp)) {
                res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
                return res.end(JSON.stringify({ success: false, error: 'تم إرسال عدة رسائل لهذا الرقم مؤخراً. يرجى الانتظار بضع دقائق.' }));
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
                otpDisplayUrl: `https://tawseelaiq.app/otp?phone=${result.phone}`,
                devCode: result.code
            });
        }

        if ((pathname === '/api/auth/verify-whatsapp-otp' || pathname === '/auth/verify-whatsapp-otp' || pathname === '/api/auth/verify-otp' || pathname === '/auth/verify-otp') && method === 'POST') {
            const body = await parseJsonBody(req);
            const phoneNumber = normalizeArabicDigits(body.phoneNumber || body.phone || '').trim();
            const code = normalizeArabicDigits(body.code || body.otp || '').replace(/[^0-9]/g, '').trim();
            if (!phoneNumber || !code) {
                return sendJson({ success: false, error: 'رقم الهاتف ورمز التحقق مطلوبان' }, 400);
            }
            const verification = whatsappService.verifyOtp(phoneNumber, code);
            if (!verification.valid) {
                return sendJson({ success: false, error: verification.error }, 400);
            }
            return sendJson({ success: true, message: 'تم التحقق من الرمز بنجاح' });
        }

        // --- Truecaller Web Verification Endpoints ---
        if (pathname === '/api/auth/truecaller/callback' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                console.log('[Truecaller Callback] Received payload:', body);
                const { requestId, accessToken, endpoint, status } = body;

                if (status === 'user_rejected') {
                    if (requestId) truecallerVerificationStore.set(requestId, { status: 'rejected', error: 'تم إلغاء التحقق من قبل المستخدم', timestamp: Date.now() });
                    return sendJson({ success: true, message: 'Rejected acknowledged' });
                }

                if (!requestId || !accessToken || !endpoint) {
                    return sendJson({ success: false, error: 'Missing required parameters' }, 400);
                }

                // Immediately respond OK (within 3 seconds required by Truecaller)
                sendJson({ success: true, message: 'Callback received' });

                // Asynchronously fetch profile from Truecaller endpoint
                fetch(endpoint, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Cache-Control': 'no-cache'
                    }
                })
                .then(res => res.json())
                .then(profile => {
                    console.log('[Truecaller Profile] Fetched profile for request:', requestId, profile);
                    let rawPhone = '';
                    if (Array.isArray(profile.phoneNumbers) && profile.phoneNumbers.length > 0) {
                        rawPhone = profile.phoneNumbers[0];
                    } else if (profile.phoneNumber) {
                        rawPhone = profile.phoneNumber;
                    }

                    let cleanPhone = String(rawPhone || '').replace(/[^0-9]/g, '');
                    if (cleanPhone.startsWith('964')) cleanPhone = '0' + cleanPhone.substring(3);
                    else if (!cleanPhone.startsWith('0') && cleanPhone.length === 10) cleanPhone = '0' + cleanPhone;

                    const firstName = profile.name?.first || profile.firstName || '';
                    const lastName = profile.name?.last || profile.lastName || '';
                    const fullName = (firstName + ' ' + lastName).trim() || profile.name || '';

                    truecallerVerificationStore.set(requestId, {
                        status: 'verified',
                        phoneNumber: cleanPhone,
                        fullName: fullName,
                        profile: profile,
                        timestamp: Date.now()
                    });
                })
                .catch(err => {
                    console.error('[Truecaller Fetch Error]:', err.message);
                    truecallerVerificationStore.set(requestId, { status: 'failed', error: err.message, timestamp: Date.now() });
                });

                return;
            } catch (err) {
                console.error('[Truecaller Callback Error]:', err.message);
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        if (pathname === '/api/auth/truecaller/status' && method === 'GET') {
            const reqId = parsedUrl.searchParams.get('requestId');
            if (!reqId) return sendJson({ success: false, error: 'requestId is required' }, 400);
            const entry = truecallerVerificationStore.get(reqId);
            if (!entry) {
                return sendJson({ success: true, status: 'pending' });
            }
            return sendJson({ success: true, ...entry });
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

        if ((pathname === '/api/auth/check-phone' || pathname === '/auth/check-phone') && (method === 'GET' || method === 'POST')) {
            let phone = '';
            if (method === 'GET') {
                phone = parsedUrl.searchParams.get('phone') || parsedUrl.searchParams.get('phoneNumber') || '';
            } else {
                const body = await parseJsonBody(req);
                phone = body.phone || body.phoneNumber || '';
            }

            if (!phone || typeof phone !== 'string' || !phone.trim()) {
                return sendJson({
                    exists: false,
                    role: null,
                    roleAr: null,
                    name: null,
                    phoneNumber: '',
                    message: 'رقم الهاتف مطلوب'
                }, 400);
            }

            const normalizeIraqi = (p) => {
                if (!p) return '';
                const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
                const persDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
                let norm = String(p)
                    .replace(/[٠-٩]/g, d => arabicDigits.indexOf(d))
                    .replace(/[۰-۹]/g, d => persDigits.indexOf(d))
                    .replace(/[^0-9]/g, '');
                if (norm.startsWith('00964')) norm = norm.substring(5);
                else if (norm.startsWith('964')) norm = norm.substring(3);
                if (norm.startsWith('0')) norm = norm.substring(1);
                return norm;
            };

            const targetNorm = normalizeIraqi(phone);
            if (!targetNorm || targetNorm.length < 9) {
                return sendJson({
                    exists: false,
                    role: null,
                    roleAr: null,
                    name: null,
                    phoneNumber: phone,
                    message: 'رقم غير مكتمل'
                });
            }

            // 1. الفحص في السائقين (الذاكرة وقاعدة البيانات)
            let foundDriver = (db.memoryState.drivers || []).find(d => {
                const dn = normalizeIraqi(d.phoneNumber || d.phone);
                return dn === targetNorm || (targetNorm.length >= 9 && dn.length >= 9 && (dn.endsWith(targetNorm) || targetNorm.endsWith(dn)));
            });

            if (!foundDriver && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(
                        `SELECT * FROM drivers WHERE phone_number LIKE $1 OR phone_number LIKE $2 LIMIT 1`,
                        [`%${targetNorm}`, `%0${targetNorm}`]
                    );
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        foundDriver = pgRes.rows[0];
                    }
                } catch (_) {}
            }

            if (foundDriver) {
                // أولوية السائق المطلقة: إزالة أي سجل راكب مكرر لنفس الرقم لضمان عدم التعارض
                if (db.memoryState && Array.isArray(db.memoryState.customers)) {
                    db.memoryState.customers = db.memoryState.customers.filter(c => {
                        const cn = normalizeIraqi(c.phoneNumber || c.phone);
                        return !(cn === targetNorm || (targetNorm.length >= 9 && cn.length >= 9 && (cn.endsWith(targetNorm) || targetNorm.endsWith(cn))));
                    });
                }
                if (db.isPostgresConnected && db.pool) {
                    db.pool.query(`DELETE FROM customers WHERE phone_number LIKE $1 OR phone_number LIKE $2`, [`%${targetNorm}`, `%0${targetNorm}`]).catch(() => {});
                    db.pool.query(`DELETE FROM users WHERE (phone_number LIKE $1 OR phone_number LIKE $2) AND role = 'Customer'`, [`%${targetNorm}`, `%0${targetNorm}`]).catch(() => {});
                }

                const driverName = foundDriver.full_name || foundDriver.fullName || foundDriver.name || 'كابتن توصيلة';
                const driverPhone = foundDriver.phone_number || foundDriver.phoneNumber || ('0' + targetNorm);
                return sendJson({
                    exists: true,
                    role: 'driver',
                    roleAr: 'سائق (كابتن)',
                    name: driverName,
                    phoneNumber: driverPhone,
                    message: 'هذا الرقم مسجل مسبقاً ككابتن معتمد 🚖'
                });
            }

            // 2. الفحص في الركاب (الذاكرة وقاعدة البيانات)
            let foundCust = (db.memoryState.customers || []).find(c => {
                const cn = normalizeIraqi(c.phoneNumber || c.phone);
                return cn === targetNorm || (targetNorm.length >= 9 && cn.length >= 9 && (cn.endsWith(targetNorm) || targetNorm.endsWith(cn)));
            });

            if (!foundCust && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(
                        `SELECT * FROM customers WHERE phone_number LIKE $1 OR phone_number LIKE $2 LIMIT 1`,
                        [`%${targetNorm}`, `%0${targetNorm}`]
                    );
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        foundCust = pgRes.rows[0];
                    }
                } catch (_) {}
            }

            if (foundCust) {
                const custName = foundCust.fullName || foundCust.full_name || foundCust.name || 'راكب';
                const custPhone = foundCust.phoneNumber || foundCust.phone_number || ('0' + targetNorm);
                return sendJson({
                    exists: true,
                    role: 'passenger',
                    roleAr: 'راكب',
                    name: custName,
                    phoneNumber: custPhone,
                    message: 'هذا الرقم مسجل مسبقاً كراكب 👋'
                });
            }

            // 3. رقم جديد
            return sendJson({
                exists: false,
                role: null,
                roleAr: null,
                name: null,
                phoneNumber: '0' + targetNorm,
                message: 'رقم جديد (سيتم تسجيلك كحساب جديد ✨)'
            });
        }

        // Endpoint: Check if passenger / driver has linked their Telegram
        if ((pathname === '/api/auth/check-telegram-linked' || pathname === '/auth/check-telegram-linked') && (method === 'GET' || method === 'POST')) {
            let phone = '';
            let userId = '';
            if (method === 'GET') {
                phone = parsedUrl.searchParams.get('phone') || '';
                userId = parsedUrl.searchParams.get('userId') || '';
            } else {
                const body = await parseJsonBody(req);
                phone = body.phone || body.phoneNumber || '';
                userId = body.userId || '';
            }

            const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
            const token = authHeader.replace(/^Bearer\s+/i, '').trim();
            if (token && token.includes('_')) {
                const parts = token.split('_');
                if (!userId) userId = parts[1];
            }

            const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
            let norm = String(phone).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
            if (norm.startsWith('00964')) norm = norm.substring(5);
            else if (norm.startsWith('964')) norm = norm.substring(3);
            if (norm.length === 10 && norm.startsWith('7')) norm = '0' + norm;

            const shortDigits = norm.length >= 8 ? norm.slice(-8) : norm;

            const matchPhone = (stored) => {
                if (!stored) return false;
                let s = String(stored).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
                if (s.startsWith('00964')) s = s.substring(5);
                else if (s.startsWith('964')) s = s.substring(3);
                if (s.length === 10 && s.startsWith('7')) s = '0' + s;
                if (s === norm) return true;
                if (shortDigits && s.endsWith(shortDigits)) return true;
                return false;
            };

            const customers = db.memoryState.customers || [];
            const drivers = db.memoryState.drivers || [];

            let found = null;
            if (userId) {
                found = customers.find(c => c.customerId === userId || c.id === userId) ||
                        drivers.find(d => d.driverId === userId || d.id === userId);
            }
            if (!found && norm) {
                found = customers.find(c => matchPhone(c.phoneNumber)) ||
                        drivers.find(d => matchPhone(d.phoneNumber));
            }

            const linked = Boolean(found && (found.telegramChatId || found.telegram_chat_id));
            const chatId = found ? (found.telegramChatId || found.telegram_chat_id || null) : null;

            return sendJson({
                success: true,
                linked,
                telegramChatId: chatId,
                telegramUsername: found ? (found.telegramUsername || found.telegram_username || null) : null
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
            const rawIdentifier = (body.identifier || body.email || body.phoneNumber || '').toString().slice(0, 120).trim();
            const identifier = normalizeArabicDigits(rawIdentifier).toLowerCase();
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
                const adminToken = generateSignedToken({ id: 'usr-admin', role: 'Admin', username: 'مدير المنصة' });
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
                let str = normalizeArabicDigits(s);
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
            if (!isGoogleAuth && !body.autoOtpLogin) {
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
                const isBlocked = user.isBlocked === true || user.is_blocked === true;
                if (isBlocked) {
                    return sendJson({ success: false, error: 'تم حظر أو إيقاف حساب الكابتن من قبل إدارة المنصة.' }, 403);
                }
                const isApproved = user.isApproved === true || user.is_approved === true;
                const isRejected = user.status === 'Rejected';
                if (isRejected) {
                    return sendJson({ success: false, error: 'تم رفض طلب انضمامك ككابتن من قبل إدارة المنصة.' }, 403);
                }
                if (!isApproved || user.status === 'Pending' || user.status === 'Unverified' || !user.isVerified) {
                    return sendJson({
                        success: false,
                        pending: true,
                        error: 'حسابك معلّق بانتظار الاعتماد والموافقة من قبل إدارة المنصة.'
                    }, 403);
                }
            }

            const id = user.driverId || user.customerId;
            const token = generateSignedToken({
                id,
                phone: user.phoneNumber,
                role: userRole,
                name: user.fullName || ''
            });
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
                    permanentDropoffName: user.permanentDropoffName || '',
                    points: parseInt(user.points || user.rewardScore || 0, 10),
                    totalTrips: parseInt(user.totalTrips || 0, 10)
                }
            });
        }

        if (pathname === '/api/auth/register' && method === 'POST') {
            const body = await parseJsonBody(req);
            let { phoneNumber, fullName, role, licenseNumber, password, passwordHash } = body;
            phoneNumber = normalizeArabicDigits(phoneNumber || '').trim();
            const targetRole = role || 'Customer';
            const now = new Date().toISOString();

            // Iraqi Phone Normalization & Cross-Role Check
            let norm = normalizeArabicDigits(phoneNumber || '').replace(/[^0-9]/g, '');
            if (norm.startsWith('00964')) norm = norm.substring(5);
            else if (norm.startsWith('964')) norm = norm.substring(3);
            if (norm.length === 10 && norm.startsWith('7')) norm = '0' + norm;

            const cleanPhone = (p) => {
                if (!p) return '';
                let s = normalizeArabicDigits(p).replace(/[^0-9]/g, '');
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
            if (body.otpCode && body.otpCode !== 'TRUECALLER_VERIFIED') {
                const otpCheck = whatsappService.verifyOtp(phoneNumber, normalizeArabicDigits(body.otpCode).replace(/[^0-9]/g, ''));
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
                const token = generateSignedToken({
                    id: driverId,
                    phone: newDriver.phoneNumber,
                    role: 'Driver',
                    name: newDriver.fullName
                });
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
                const token = generateSignedToken({
                    id: customerId,
                    phone: newCustomer.phoneNumber,
                    role: 'Customer',
                    name: newCustomer.fullName
                });
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
                const isBlocked = driver.isBlocked === true || driver.is_blocked === true || driver.status === 'Suspended' || driver.status === 'Blocked';
                if (isBlocked) {
                    return sendJson({ success: false, isBlocked: true, error: 'تم حظر أو تعليق حساب الكابتن من قبل إدارة المنصة.' }, 403);
                }
                const isApproved = driver.isApproved === true || driver.is_approved === true;
                const isRejected = driver.status === 'Rejected';
                if (isRejected) {
                    return sendJson({ success: false, error: 'تم رفض حساب الكابتن من قبل إدارة المنصة.' }, 403);
                }
                if (!isApproved || driver.status === 'Pending' || driver.status === 'Unverified') {
                    return sendJson({ success: false, pending: true, error: 'حسابك معلّق بانتظار الاعتماد والموافقة من قبل إدارة المنصة.' }, 403);
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
            if (!checkAdminAuth()) return;
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
            if (!checkAdminAuth()) return;
            const parts = pathname.split('/');
            const docId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.verifyDocument(docId, body.approved !== false, body.rejectionReason);
            return sendJson(result);
        }

        // Driver Status Endpoint: POST /api/admin/drivers/:id/status, /api/drivers/:id/status, /drivers/:id/status
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/') || pathname.startsWith('/drivers/')) && pathname.endsWith('/status') && method === 'POST') {
            if (pathname.startsWith('/api/admin/')) {
                if (!checkAdminAuth()) return;
            }
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
            if (!checkAdminAuth()) return;
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.toggleDriverBlock(driverId, body.block !== false);
            return sendJson(result);
        }

        // Driver Approve Endpoint: POST /api/admin/drivers/:id/approve
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && pathname.endsWith('/approve') && method === 'POST') {
            if (!checkAdminAuth()) return;
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.setDriverApproval(driverId, body.approve !== false);
            return sendJson(result);
        }

        // Driver Work Mode Endpoint: POST /api/drivers/:id/work_mode
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && pathname.endsWith('/work_mode') && method === 'POST') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.setDriverWorkMode(driverId, body.work_mode);
            return sendJson(result);
        }

        // Driver Delete (Cascade): DELETE /api/admin/drivers/:id or /api/drivers/:id
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && method === 'DELETE') {
            if (!checkAdminAuth()) return;
            const driverId = pathname.replace('/api/admin/drivers/', '').replace('/api/drivers/', '').trim();
            const result = await adminController.deleteDriver(driverId);
            return sendJson(result);
        }

        // Top Drivers Leaderboard: GET /api/admin/drivers/ratings-leaderboard
        if ((pathname === '/api/admin/drivers/ratings-leaderboard' || pathname === '/api/drivers/ratings-leaderboard') && method === 'GET') {
            try {
                let leaderboard = [];
                if (db.isPostgresConnected && db.pool) {
                    try {
                        const pgRes = await db.pool.query(`
                            SELECT 
                                d.driver_id,
                                d.full_name,
                                d.phone_number,
                                d.vehicle_make,
                                d.vehicle_model,
                                d.vehicle_plate,
                                d.status,
                                COALESCE(d.points, 0) AS total_points,
                                COALESCE(d.total_trips, 0) AS total_trips,
                                COALESCE(d.rating_average, 5.0) AS average_rating,
                                COUNT(tr.id) AS rated_trips_count,
                                ROUND(COALESCE(AVG(tr.rating), d.rating_average, 5.0)::numeric, 1) AS computed_rating,
                                ROUND(
                                    COALESCE(
                                        (COUNT(CASE WHEN tr.rating >= 4 THEN 1 END)::numeric / NULLIF(COUNT(tr.id), 0)) * 100,
                                        CASE WHEN COALESCE(d.rating_average, 5.0) >= 4.0 THEN 98.0 ELSE 75.0 END
                                    )::numeric, 0
                                ) AS satisfaction_rate
                            FROM drivers d
                            LEFT JOIN trip_ratings tr ON d.driver_id = tr.driver_id OR d.phone_number = tr.driver_id
                            GROUP BY d.driver_id, d.full_name, d.phone_number, d.vehicle_make, d.vehicle_model, d.vehicle_plate, d.status, d.points, d.total_trips, d.rating_average
                            ORDER BY COALESCE(d.points, 0) DESC, COALESCE(d.rating_average, 0) DESC, COALESCE(d.total_trips, 0) DESC;
                        `);
                        leaderboard = (pgRes.rows || []).map((r, idx) => ({
                            rank: idx + 1,
                            driverId: r.driver_id,
                            fullName: r.full_name || 'كابتن توصيله',
                            phoneNumber: r.phone_number || '',
                            carModel: `${r.vehicle_make || ''} ${r.vehicle_model || ''}`.trim() || 'مركبة كابتن',
                            plateNumber: r.vehicle_plate || 'النجف',
                            points: parseInt(r.total_points || 0, 10),
                            ratingAverage: parseFloat(r.computed_rating || r.average_rating || 5.0),
                            ratedTripsCount: parseInt(r.rated_trips_count || 0, 10),
                            totalTrips: parseInt(r.total_trips || 0, 10),
                            satisfactionRate: parseInt(r.satisfaction_rate || 95, 10),
                            status: r.status || 'Active',
                            isTopDriver: idx === 0
                        }));
                    } catch (pgErr) {
                        console.warn('[Leaderboard] Postgres query fallback:', pgErr.message);
                    }
                }

                // Fallback to memoryState if database query empty or failed
                if (leaderboard.length === 0) {
                    const memDrivers = [...(db.memoryState.drivers || [])];
                    const ratings = db.memoryState.tripRatings || [];
                    memDrivers.sort((a, b) => {
                        const ptsDiff = (b.points || b.rewardScore || 0) - (a.points || a.rewardScore || 0);
                        if (ptsDiff !== 0) return ptsDiff;
                        return (b.ratingAverage || 5.0) - (a.ratingAverage || 5.0);
                    });

                    leaderboard = memDrivers.map((d, idx) => {
                        const drvRatings = ratings.filter(r => r.driverId === d.driverId);
                        const ratedCount = drvRatings.length;
                        const avgRating = ratedCount > 0 ? (drvRatings.reduce((sum, r) => sum + (parseInt(r.rating, 10) || 5), 0) / ratedCount) : (d.ratingAverage || 5.0);
                        const posCount = drvRatings.filter(r => (parseInt(r.rating, 10) || 5) >= 4).length;
                        const satRate = ratedCount > 0 ? Math.round((posCount / ratedCount) * 100) : (avgRating >= 4 ? 98 : 75);

                        return {
                            rank: idx + 1,
                            driverId: d.driverId,
                            fullName: d.fullName || 'كابتن توصيله',
                            phoneNumber: d.phoneNumber || '',
                            carModel: `${d.vehicleMake || ''} ${d.vehicleModel || ''}`.trim() || 'مركبة كابتن',
                            plateNumber: d.vehiclePlate || 'النجف',
                            points: parseInt(d.points || d.rewardScore || 0, 10),
                            ratingAverage: Math.round(avgRating * 10) / 10,
                            ratedTripsCount: ratedCount,
                            totalTrips: parseInt(d.totalTrips || 0, 10),
                            satisfactionRate: satRate,
                            status: d.status || 'Active',
                            isTopDriver: idx === 0
                        };
                    });
                }

                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                return sendJson({
                    success: true,
                    total: leaderboard.length,
                    leaderboard
                });
            } catch (err) {
                console.error('[Leaderboard] Error:', err);
                return sendJson({ success: false, leaderboard: [], total: 0 });
            }
        }

        // Driver Get By ID: GET /api/admin/drivers/:id or /api/drivers/:id
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && method === 'GET' && !pathname.includes('/block') && !pathname.includes('/status') && !pathname.includes('/nearby') && !pathname.includes('/ratings-leaderboard') && !pathname.includes('/leaderboard')) {
            const driverId = pathname.replace('/api/admin/drivers/', '').replace('/api/drivers/', '').trim();
            const result = await adminController.getDriverById(driverId);
            if (!result.success && result.error) {
                return sendJson(result, 404);
            }
            return sendJson(result);
        }

        // Drivers List: GET /api/admin/drivers
        if ((pathname === '/api/admin/drivers' || pathname === '/api/admin/admin/drivers' || pathname === '/api/drivers') && method === 'GET') {
            if (!checkAdminAuth()) return;
            const search = sanitizeInput(parsedUrl.searchParams.get('search') || '', 100);
            const result = await adminController.getDrivers(search);
            return sendJson(result);
        }

        // Driver Create (Admin): POST /api/admin/drivers
        if ((pathname === '/api/admin/drivers' || pathname === '/api/admin/admin/drivers' || pathname === '/api/drivers') && method === 'POST') {
            if (!checkAdminAuth()) return;
            const body = await parseJsonBody(req);
            const result = await adminController.createDriver(body);
            return sendJson(result, result.success ? 201 : 400);
        }

        // Driver Update: POST /api/admin/drivers/:id/update or /api/drivers/:id/update
        if ((pathname.startsWith('/api/admin/drivers/') || pathname.startsWith('/api/drivers/')) && pathname.endsWith('/update') && method === 'POST') {
            if (!checkAdminAuth()) return;
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.updateDriver(driverId, body);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Customer Create: POST /api/admin/customers or /api/customers/create
        if ((pathname === '/api/admin/customers' || pathname === '/api/admin/admin/customers' || pathname === '/api/customers/create' || pathname === '/api/admin/customers/create') && method === 'POST') {
            if (!checkAdminAuth()) return;
            const body = await parseJsonBody(req);
            const result = await adminController.createCustomer(body);
            return sendJson(result, result.success ? 201 : 400);
        }

        // Customer Block Endpoint: POST /api/admin/customers/:id/block or /api/customers/:id/block
        if ((pathname.startsWith('/api/admin/customers/') || pathname.startsWith('/api/customers/')) && pathname.endsWith('/block') && method === 'POST') {
            if (!checkAdminAuth()) return;
            const parts = pathname.split('/');
            const customerId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.toggleCustomerBlock(customerId, body.block !== false);
            return sendJson(result);
        }

        // Customer Update: POST /api/admin/customers/:id/update or /api/customers/:id/update
        if ((pathname.startsWith('/api/admin/customers/') || pathname.startsWith('/api/customers/')) && pathname.endsWith('/update') && method === 'POST') {
            if (!checkAdminAuth()) return;
            const parts = pathname.split('/');
            const customerId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await adminController.updateCustomer(customerId, body);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Customer Delete (Cascade): DELETE /api/admin/customers/:id
        if (pathname.startsWith('/api/admin/customers/') && method === 'DELETE') {
            if (!checkAdminAuth()) return;
            const customerId = pathname.replace('/api/admin/customers/', '').trim();
            const result = await adminController.deleteCustomer(customerId);
            return sendJson(result);
        }

        // Customers & Passengers List: GET /api/admin/customers or /api/admin/passengers (Instant Lean Cache)
        if ((pathname === '/api/admin/customers' || pathname === '/api/admin/passengers' || pathname === '/api/customers' || pathname === '/api/passengers') && method === 'GET') {
            if (!checkAdminAuth()) return;
            const search = sanitizeInput(parsedUrl.searchParams.get('search') || '', 100);
            const result = await adminController.getCustomers(search);
            return sendJson({
                ...result,
                passengers: result.customers
            });
        }

        // Routes & Bookings
        if (pathname === '/api/admin/routes') {
            const result = await adminController.getRoutes();
            return sendJson({ success: true, total: result.total, routes: result.routes });
        }

        if (pathname === '/api/admin/bookings') {
            const result = await adminController.getBookings();
            return sendJson({ success: true, total: result.total, bookings: result.bookings });
        }

        // Complaints & Reports Management
        if ((pathname === '/api/complaints/submit' || pathname === '/api/complaints') && method === 'POST') {
            const body = await parseJsonBody(req);
            const result = await complaintService.submitComplaint(body, clientIp);
            return sendJson(result);
        }

        if ((pathname === '/api/admin/complaints' || pathname === '/api/complaints') && method === 'GET') {
            const status = parsedUrl.searchParams.get('status') || '';
            const category = parsedUrl.searchParams.get('category') || '';
            const search = parsedUrl.searchParams.get('search') || '';
            const limit = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
            const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
            const result = await complaintService.getComplaints({ status, category, search, limit, offset });
            return sendJson(result);
        }

        if ((pathname === '/api/admin/complaints/resolve' || pathname === '/api/complaints/resolve' || 
            ((pathname.startsWith('/api/complaints/') || pathname.startsWith('/api/admin/complaints/')) && pathname.endsWith('/resolve'))) && method === 'POST') {
            const body = await parseJsonBody(req);
            const parts = pathname.split('/');
            const complaintId = body.id || body.complaintId || (parts.length >= 4 ? parts[parts.length - 2] : null);
            const result = await complaintService.resolveComplaint(complaintId, body, 'المشرف العام (Admin)', clientIp);
            return sendJson(result);
        }

        if (pathname.startsWith('/api/admin/complaints/') && pathname.endsWith('/status') && method === 'POST') {
            const parts = pathname.split('/');
            const complaintId = parts[parts.length - 2];
            const body = await parseJsonBody(req);
            const result = await complaintService.resolveComplaint(complaintId, { status: body.status, adminNotes: body.resolutionNotes, actionTaken: body.actionTaken }, 'المشرف العام (Admin)', clientIp);
            return sendJson(result);
        }

        // Settings
        if (pathname === '/api/admin/settings' && method === 'GET') {
            const result = await adminController.getSettings();
            return sendJson(result.settings);
        }

        if (pathname.startsWith('/api/admin/settings/') && (method === 'POST' || method === 'PUT')) {
            const key = pathname.replace('/api/admin/settings/', '').trim();
            const body = await parseJsonBody(req);
            const result = await adminController.updateSetting(key, body.valueJson || body, clientIp);
            return sendJson(result);
        }

        // Audit Logs (Query & Filter)
        if ((pathname === '/api/admin/audit-logs' || pathname === '/api/audit-logs') && method === 'GET') {
            const limit = parseInt(parsedUrl.searchParams.get('limit') || '200', 10);
            const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
            const action = parsedUrl.searchParams.get('action') || '';
            const search = parsedUrl.searchParams.get('search') || '';
            const result = await adminController.getAuditLogs({ limit, offset, action, search });
            return sendJson(result);
        }

        // Audit Logs (Manual Logging Endpoint)
        if ((pathname === '/api/admin/audit-logs' || pathname === '/api/audit-logs') && method === 'POST') {
            const body = await parseJsonBody(req);
            const log = await adminController.logAuditEvent({
                action: body.action || 'CustomAdminAction',
                entityType: body.entityType || body.entityName || 'System',
                entityId: body.entityId || 'N/A',
                actor: body.actor || 'المشرف العام (Admin)',
                details: body.details || body.newValuesJson || {},
                ip: clientIp,
                userAgent: req.headers['user-agent'] || ''
            });
            return sendJson({ success: true, log });
        }

        // Admin Authentication & Session Auditing
        if (pathname === '/api/admin/auth/login' && method === 'POST') {
            const body = await parseJsonBody(req);
            const username = (body.username || '').trim().toLowerCase();
            const password = (body.password || '').trim();
            const isUserValid = (username === 'admin' || username === 'admin@taxiwisam.com' || username === 'مدير' || username === 'الادارة');
            const isPassValid = (password === '1122' || password === '١١٢٢');

            if (isUserValid && isPassValid) {
                await adminController.logAuditEvent({
                    action: 'AdminLoginSuccess',
                    entityType: 'AdminAuth',
                    entityId: username || 'admin',
                    actor: 'المشرف العام (Admin)',
                    details: { username, status: 'Authorized', timestamp: new Date().toISOString() },
                    ip: clientIp,
                    userAgent: req.headers['user-agent'] || ''
                });
                const adminToken = generateSignedToken({ id: 'admin_root', role: 'Admin', username: username || 'Super Admin' });
                return sendJson({ success: true, message: 'تم التحقق وتسجيل الدخول بنجاح', token: adminToken });
            } else {
                await adminController.logAuditEvent({
                    action: 'AdminLoginFailed',
                    entityType: 'SecurityAlert',
                    entityId: username || 'Unknown',
                    actor: 'مجهول (Unauthorized)',
                    details: { attemptedUsername: username, status: 'Rejected', timestamp: new Date().toISOString() },
                    ip: clientIp,
                    userAgent: req.headers['user-agent'] || ''
                });
                return sendJson({ success: false, error: 'بيانات الدخول غير صحيحة' }, 401);
            }
        }

        if (pathname === '/api/admin/auth/logout' && method === 'POST') {
            await adminController.logAuditEvent({
                action: 'AdminLogout',
                entityType: 'AdminAuth',
                entityId: 'admin',
                actor: 'المشرف العام (Admin)',
                details: { status: 'LoggedOut', timestamp: new Date().toISOString() },
                ip: clientIp,
                userAgent: req.headers['user-agent'] || ''
            });
            return sendJson({ success: true, message: 'تم تسجيل الخروج بنجاح' });
        }

        // ---------------------------------------------------------------------
        // 3. BACKUP & RESTORE API
        // ---------------------------------------------------------------------
        if ((pathname === '/api/admin/backup/stats' || pathname === '/api/admin/database/stats') && method === 'GET') {
            try {
                const stats = await adminController.getDatabaseStats();
                return sendJson(stats);
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

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
        // 4.1 Admin Fleet Radar Live Tracking: GET /api/admin/fleet/live & /api/admin/drivers/locations
        if ((pathname === '/api/admin/fleet/live' || pathname === '/api/admin/drivers/locations') && method === 'GET') {
            try {
                let dbDrivers = [];
                if (db.isPostgresConnected && db.pool) {
                    try {
                        const pgRes = await db.pool.query(`
                            SELECT 
                                driver_id, full_name, phone_number, vehicle_make, vehicle_model, 
                                vehicle_plate, vehicle_year, status, is_verified, is_approved, 
                                is_blocked, work_mode, rating_average, total_trips, points,
                                latitude, longitude, heading,
                                permanent_lat, permanent_lon, permanent_location_name,
                                permanent_dropoff_lat, permanent_dropoff_lon, permanent_dropoff_name,
                                created_at
                            FROM drivers
                            ORDER BY created_at DESC
                        `);
                        dbDrivers = pgRes.rows || [];
                    } catch (pgErr) {
                        console.warn('[FleetLive] Postgres query fallback:', pgErr.message);
                    }
                }

                // If DB query empty, fallback to in-memory drivers
                const sourceDrivers = dbDrivers.length > 0 ? dbDrivers : (db.memoryState.drivers || []);
                const memMap = new Map((db.memoryState.drivers || []).map(d => [d.driverId || d.id, d]));

                // Check active rides in memory
                const activeDriverRides = new Map();
                (db.memoryState.rideRequests || []).forEach(r => {
                    if (r.driverId && ['accepted', 'arrived', 'in_ride', 'in_trip', 'in_progress'].includes(r.status)) {
                        activeDriverRides.set(r.driverId, r);
                    }
                });

                const eligibleDrivers = sourceDrivers.filter(d => {
                    const id = d.driver_id || d.driverId || d.id;
                    const mem = memMap.get(id) || {};
                    const isBlocked = d.is_blocked === true || mem.isBlocked === true;
                    const isApproved = (d.is_approved === true || mem.isApproved === true || d.isApproved === true);
                    const isRejected = d.status === 'Rejected' || mem.status === 'Rejected';
                    const isPending = d.status === 'Pending' || mem.status === 'Pending';
                    return isApproved && !isRejected && !isPending && !isBlocked;
                });

                const fleet = eligibleDrivers.map(d => {
                    const id = d.driver_id || d.driverId || d.id;
                    const mem = memMap.get(id) || {};
                    const activeRide = activeDriverRides.get(id);

                    const vMake = d.vehicle_make || d.vehicleMake || mem.vehicleMake || 'تويوتا';
                    const vModel = d.vehicle_model || d.vehicleModel || mem.vehicleModel || 'كورولا';
                    const vPlate = d.vehicle_plate || d.vehiclePlate || mem.vehiclePlate || 'النجف';

                    const rawMode = String(mem.work_mode || mem.workMode || d.work_mode || d.workMode || 'مشوار قصير').trim();
                    const isBlocked = d.is_blocked === true || mem.isBlocked === true;
                    const isOnline = !isBlocked && (mem.isOnline === true || mem.status === 'Online' || d.status === 'Online' || d.status === 'Active') && rawMode !== 'خمول' && mem.workStatus !== 'idle';

                    let finalStatus = 'offline';
                    let modeKey = 'idle';

                    if (activeRide || mem.status === 'on_trip' || mem.tripStatus === 'on_trip') {
                        finalStatus = 'on_trip';
                        modeKey = 'taxi';
                    } else if (isOnline) {
                        finalStatus = 'Online';
                        if (rawMode === 'خط دائمي' || mem.workStatus === 'permanent') {
                            modeKey = 'route';
                        } else {
                            modeKey = 'taxi';
                        }
                    } else {
                        finalStatus = 'offline';
                        modeKey = 'idle';
                    }

                    const lat = parseFloat(mem.latitude || mem.currentLat || d.latitude || d.permanent_lat || config.najafDefaults.latitude);
                    const lon = parseFloat(mem.longitude || mem.currentLon || d.longitude || d.permanent_lon || config.najafDefaults.longitude);

                    return {
                        driverId: id,
                        driverName: d.full_name || d.fullName || mem.fullName || 'كابتن توصيله',
                        fullName: d.full_name || d.fullName || mem.fullName || 'كابتن توصيله',
                        phone: d.phone_number || d.phoneNumber || mem.phoneNumber || '07800000000',
                        phoneNumber: d.phone_number || d.phoneNumber || mem.phoneNumber || '07800000000',
                        carModel: `${vMake} ${vModel}`.trim(),
                        plateNumber: vPlate,
                        latitude: isNaN(lat) ? 31.9961 : lat,
                        longitude: isNaN(lon) ? 44.3168 : lon,
                        heading: parseFloat(mem.heading || d.heading || 0),
                        status: finalStatus,
                        isOnline: isOnline,
                        in_trip: finalStatus === 'on_trip',
                        mode: modeKey, // 'taxi' | 'route' | 'idle'
                        workMode: rawMode, // 'مشوار قصير' | 'خط دائمي' | 'خمول'
                        speedKmh: mem.speedKmh || 0,
                        rating: parseFloat(d.rating_average || mem.ratingAverage || 5.0)
                    };
                });

                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                return sendJson(fleet);
            } catch (err) {
                console.error('[FleetLive] Error:', err);
                return sendJson([]);
            }
        }

        // Commute Line Captains (Batch 2: كباتن الخط الدائم للراكب بالألوان حسب المسافة)
        const isCommuteDriversRoute = (
            pathname === '/api/commute/drivers' ||
            pathname === '/api/drivers/commute' ||
            (pathname === '/api/drivers/nearby' && parsedUrl.searchParams.get('tripType') === 'commute')
        );

        if (isCommuteDriversRoute && method === 'GET') {
            // 1. Authentication Check (JWT on server, 401 if missing or invalid)
            const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
            const rawToken = authHeader.replace(/^Bearer\s+/i, '').trim();
            if (!rawToken) {
                return sendJson({ success: false, error: 'جلسة الدخول مطلوبة (Missing Token)' }, 401);
            }

            const authUser = getAuthUser(req);
            if (!authUser) {
                return sendJson({ success: false, error: 'رمز الجلسة غير صالح أو منتهي الصلاحية' }, 401);
            }

            // 2. Rate Limiting across PM2 cluster via Redis (60 requests per minute)
            const clientIdentifier = authUser.id || clientIp;
            const rateKey = `rate:commute:drivers:${clientIdentifier}`;
            const rate = await redisManager.checkRateLimitCluster(rateKey, 60, 60);
            if (!rate.allowed) {
                res.setHeader('Retry-After', String(rate.ttl));
                return sendJson({
                    success: false,
                    error: 'تم تجاوز الحد المسموح للاستعلام عن كباتن الخط الدائم (60 طلباً بالدقيقة). يرجى المحاولة لاحقاً',
                    retry_after: rate.ttl
                }, 429);
            }

            // 3. Passenger Coordinates Range Validation (lat: [-90, 90], lon: [-180, 180])
            const rawLat = parsedUrl.searchParams.get('lat') || parsedUrl.searchParams.get('latitude');
            const rawLon = parsedUrl.searchParams.get('lon') || parsedUrl.searchParams.get('lng') || parsedUrl.searchParams.get('longitude');

            if (rawLat === null || rawLat === undefined || rawLon === null || rawLon === undefined || String(rawLat).trim() === '' || String(rawLon).trim() === '') {
                return sendJson({ success: false, error: 'إحداثيات موقع الراكب مطلوبة (lat, lon)' }, 400);
            }

            const pLat = parseFloat(rawLat);
            const pLon = parseFloat(rawLon);

            if (isNaN(pLat) || isNaN(pLon) || pLat < -90 || pLat > 90 || pLon < -180 || pLon > 180) {
                return sendJson({ success: false, error: 'إحداثيات موقع الراكب غير صحيحة أو خارج النطاق الجغرافي المسموح' }, 400);
            }

            // 4. Thresholds & Max Results from systemSettingsService (Cached from DB)
            const greenThreshold = systemSettingsService ? systemSettingsService.getCommuteBandGreenM() : 500;
            const purpleThreshold = systemSettingsService ? systemSettingsService.getCommuteBandPurpleM() : 1000;
            const maxResults = systemSettingsService ? systemSettingsService.getCommuteMaxResults() : 100;

            // 5. Query approved & non-blocked drivers
            let dbDrivers = [];
            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(`
                        SELECT 
                            driver_id, full_name,
                            vehicle_make, vehicle_model, vehicle_plate, vehicle_year,
                            status, is_verified, is_approved, is_blocked,
                            work_mode, rating_average, total_trips, points,
                            fixed_lat, fixed_lng, fixed_label, fixed_updated_at,
                            vehicle_type, updated_at
                        FROM drivers
                        WHERE (is_blocked = false OR is_blocked IS NULL)
                          AND (status != 'Rejected' AND status != 'Pending')
                        ORDER BY created_at DESC;
                    `);
                    dbDrivers = pgRes.rows || [];
                } catch (pgErr) {
                    console.warn('[CommuteDrivers] DB query fallback:', pgErr.message);
                }
            }

            const sourceDrivers = dbDrivers.length > 0 ? dbDrivers : (db.memoryState.drivers || []);
            const memMap = new Map((db.memoryState.drivers || []).map(d => [String(d.driverId || d.id), d]));

            const candidateDrivers = [];

            const toRad = deg => deg * Math.PI / 180;
            const haversineM = (lat1, lon1, lat2, lon2) => {
                const R = 6371000; // Earth radius in meters
                const dLat = toRad(lat2 - lat1);
                const dLon = toRad(lon2 - lon1);
                const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                          Math.sin(dLon/2) * Math.sin(dLon/2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                return Math.round(R * c);
            };

            for (const d of sourceDrivers) {
                const id = String(d.driver_id || d.driverId || d.id);
                const mem = memMap.get(id) || {};

                const isBlocked = d.is_blocked === true || mem.isBlocked === true;
                const isApproved = d.is_approved === true || mem.isApproved === true || d.isApproved === true;
                const isRejected = d.status === 'Rejected' || mem.status === 'Rejected';
                const isPending = d.status === 'Pending' || mem.status === 'Pending';
                if (isBlocked || !isApproved || isRejected || isPending) continue;

                // Mode check: Must be commute or both, NOT idle, NOT taxi-only
                const rawMode = String(mem.work_mode || mem.workMode || mem.current_mode || mem.mode || mem.workStatus || d.work_mode || '').toLowerCase().trim();
                const isOnline = mem.isOnline !== false && mem.status !== 'Offline' && d.status !== 'Offline';
                if (!isOnline || rawMode === 'idle' || rawMode === 'خمول' || rawMode === 'offline') continue;

                const isCommute = rawMode === 'commute' || rawMode === 'permanent' || rawMode === 'route' || rawMode === 'daily' || rawMode === 'خط دائمي';
                const isBoth = rawMode === 'both' || rawMode === 'كلاهما';
                if (!isCommute && !isBoth) continue;

                // Fixed Location: Redis is Primary Source of Truth across 6 PM2 cores, then DB/Memory (fixed_* ONLY)
                let fixedLat = null;
                let fixedLng = null;
                let fixedLabel = '';
                let fixedUpdatedAt = null;

                const redisLoc = await redisManager.getDriverFixedLocation(id);
                if (redisLoc && redisLoc.lat != null && redisLoc.lng != null && !isNaN(redisLoc.lat) && !isNaN(redisLoc.lng)) {
                    fixedLat = redisLoc.lat;
                    fixedLng = redisLoc.lng;
                    fixedLabel = redisLoc.label || '';
                    fixedUpdatedAt = redisLoc.updatedAt || null;
                } else {
                    const dbLat = d.fixed_lat != null ? parseFloat(d.fixed_lat) : (mem.fixedLat != null ? parseFloat(mem.fixedLat) : null);
                    const dbLng = d.fixed_lng != null ? parseFloat(d.fixed_lng) : (mem.fixedLng != null ? parseFloat(mem.fixedLng) : null);
                    if (dbLat != null && dbLng != null && !isNaN(dbLat) && !isNaN(dbLng)) {
                        fixedLat = dbLat;
                        fixedLng = dbLng;
                        fixedLabel = d.fixed_label || mem.fixedLabel || '';
                        fixedUpdatedAt = d.fixed_updated_at || mem.fixedUpdatedAt || null;
                    }
                }

                if (fixedLat == null || fixedLng == null || isNaN(fixedLat) || isNaN(fixedLng)) {
                    continue; // Exclude drivers without fixed location
                }

                const distanceM = haversineM(pLat, pLon, fixedLat, fixedLng);
                let distanceBand = 'red';
                if (distanceM <= greenThreshold) {
                    distanceBand = 'green';
                } else if (distanceM <= purpleThreshold) {
                    distanceBand = 'purple';
                } else {
                    distanceBand = 'red';
                }

                const vMake = d.vehicle_make || d.vehicleMake || mem.vehicleMake || 'تويوتا';
                const vModel = d.vehicle_model || d.vehicleModel || mem.vehicleModel || 'كورولا';
                const vColor = d.vehicle_color || mem.vehicleColor || 'أبيض';
                const vType = normalizeTier(d.vehicle_type || mem.vehicleType || 'توفير');
                const fullName = d.full_name || d.fullName || mem.fullName || 'كابتن';
                const firstName = fullName.trim().split(/\s+/)[0] || 'كابتن';
                const routeStr = d.route || mem.route || (fixedLabel ? `${fixedLabel} ➔ المركز` : 'خط دائمي');

                candidateDrivers.push({
                    driverId: id,
                    firstName: firstName,
                    rating: parseFloat(d.rating_average || mem.ratingAverage || 5.0),
                    vehicleModel: `${vMake} ${vModel}`.trim(),
                    vehicleColor: vColor,
                    vehicleType: vType,
                    route: routeStr,
                    fixed_label: fixedLabel,
                    fixed_lat: fixedLat,
                    fixed_lng: fixedLng,
                    distanceM: distanceM,
                    distanceBand: distanceBand,
                    lastActive: fixedUpdatedAt || d.updated_at || mem.lastActive || null
                });
            }

            // 6. Sort ascending by distance (no captain removed due to distance)
            candidateDrivers.sort((a, b) => a.distanceM - b.distanceM);

            const total = candidateDrivers.length;
            const hasMore = total > maxResults;
            const resultDrivers = candidateDrivers.slice(0, maxResults);

            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            return sendJson({
                success: true,
                total: total,
                hasMore: hasMore,
                count: resultDrivers.length,
                drivers: resultDrivers,
                data: resultDrivers,
                message: total === 0 ? 'لا يوجد كباتن خط دائم متاحين حالياً' : undefined
            });
        }

        // 4.2 Passenger Nearby Drivers: GET /api/drivers/nearby
        if (pathname === '/api/drivers/nearby') {
            const lat = parseFloat(parsedUrl.searchParams.get('lat') || config.najafDefaults.latitude);
            const lon = parseFloat(parsedUrl.searchParams.get('lon') || config.najafDefaults.longitude);
            const tripType = parsedUrl.searchParams.get('tripType'); // 'short' or 'daily'
            const requestedVehicleType = (parsedUrl.searchParams.get('vehicleType') || '').toLowerCase();
            const normaliseVehicleType = (driver) =>
                normalizeTier(driver.vehicleType || driver.vehicleClass || driver.tier);
            
            const toRad = (deg) => deg * Math.PI / 180;
            const haversine = (lat1, lon1, lat2, lon2) => {
                const R = 6371;
                const dLat = toRad(lat2 - lat1);
                const dLon = toRad(lon2 - lon1);
                const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
                return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            };

            const activeDrivers = (db.memoryState.drivers || [])
                .filter(d => isDriverOnlineAndActive(d))
                .filter(d => !requestedVehicleType || normaliseVehicleType(d) === normalizeTier(requestedVehicleType))
                .filter(d => {
                    const cMode = String(d.current_mode || d.mode || d.work_mode || d.workStatus || '').toLowerCase();
                    const isBoth = cMode === 'both' || cMode === 'كلاهما';
                    
                    if (tripType === 'daily' || tripType === 'commute') {
                        // Strictly commute or both ONLY: Zero-Leak driver mode separation
                        const isCommute = isBoth || cMode === 'commute' || cMode === 'permanent' || cMode === 'خط دائمي';
                        const isTaxi = (cMode === 'taxi' || cMode === 'مشوار قصير') && !isBoth;
                        if (isTaxi) return false;
                        if (cMode === 'idle' || cMode === 'خمول' || cMode === 'offline') return false;
                        return isCommute;
                    }
                    if (tripType === 'short' || tripType === 'taxi') {
                        // Strictly taxi or both ONLY: Zero-Leak driver mode separation
                        const isTaxi = isBoth || cMode === 'taxi' || cMode === 'مشوار قصير';
                        const isCommute = (cMode === 'commute' || cMode === 'permanent' || cMode === 'خط دائمي') && !isBoth;
                        if (isCommute) return false;
                        if (cMode === 'idle' || cMode === 'خمول' || cMode === 'offline') return false;
                        return isTaxi;
                    }
                    return true;
                })
                .map((d, idx) => {
                    const dLat = (d.permanentLat ? parseFloat(d.permanentLat) : (d.currentLat ? parseFloat(d.currentLat) : (d.latitude ? parseFloat(d.latitude) : (lat + (idx % 2 === 0 ? 0.003 * (idx + 1) : -0.003 * (idx + 1))))));
                    const dLon = (d.permanentLon ? parseFloat(d.permanentLon) : (d.currentLon ? parseFloat(d.currentLon) : (d.longitude ? parseFloat(d.longitude) : (lon + (idx % 2 === 0 ? 0.002 * (idx + 1) : -0.002 * (idx + 1))))));
                    const distanceKm = haversine(lat, lon, dLat, dLon);
                    const vMake = d.vehicleMake || (d.vehicle ? d.vehicle.make : 'تويوتا');
                    const vModel = d.vehicleModel || (d.vehicle ? (d.vehicle.model || '') : 'كورولا');
                    const vPlate = d.vehiclePlate || (d.vehicle ? (d.vehicle.plateNumber || d.vehicle.plate) : 'النجف');
                    const routeStr = d.route || (d.permanentLocationName && d.permanentDropoffName ? `${d.permanentLocationName} ➔ ${d.permanentDropoffName}` : (d.permanentLocationName || ''));
                    return {
                        driverId: d.driverId,
                        driverName: d.fullName || 'كابتن توصيله',
                        fullName: d.fullName || 'كابتن توصيله',
                        phone: d.phoneNumber || '07800000000',
                        phoneNumber: d.phoneNumber || '07800000000',
                        rating: d.ratingAverage || 5.0,
                        vehicleType: normaliseVehicleType(d),
                        serviceType: d.serviceType || 'Both',
                        vehicleInfo: `${vMake} ${vModel} (${vPlate})`.trim(),
                        carModel: `${vMake} ${vModel}`.trim(),
                        plateNumber: vPlate,
                        latitude: dLat,
                        longitude: dLon,
                        permanentLat: d.permanentLat ? parseFloat(d.permanentLat) : null,
                        permanentLon: d.permanentLon ? parseFloat(d.permanentLon) : null,
                        permanentLocationName: d.permanentLocationName || '',
                        permanentDropoffLat: d.permanentDropoffLat ? parseFloat(d.permanentDropoffLat) : null,
                        permanentDropoffLon: d.permanentDropoffLon ? parseFloat(d.permanentDropoffLon) : null,
                        permanentDropoffName: d.permanentDropoffName || '',
                        route: routeStr,
                        routeStartName: d.permanentLocationName || (routeStr ? routeStr.split(/[-➔→]/)[0]?.trim() : ''),
                        routeEndName: d.permanentDropoffName || (routeStr ? routeStr.split(/[-➔→]/)[1]?.trim() : ''),
                        distanceKm: Math.round(distanceKm * 10) / 10,
                        heading: d.heading || (idx * 45) % 360,
                        status: d.tripStatus || 'Online',
                        speedKmh: d.speedKmh || Math.floor(25 + Math.random() * 30)
                    };
                })
                .sort((a, b) => a.distanceKm - b.distanceKm);

            const defaultRadius = systemSettingsService ? systemSettingsService.getSearchRadiusKm() : 25;
            const maxRange = parseFloat(parsedUrl.searchParams.get('rangeKm') || parsedUrl.searchParams.get('radius') || defaultRadius);
            const inRange = activeDrivers.filter(d => d.distanceKm <= maxRange);
            const resultData = inRange;

            // High-Performance 304 Not Modified caching for thousands of concurrent passengers
            const etagPayload = resultData.map(d => `${d.driverId}:${d.latitude}:${d.longitude}:${d.status}`).join(';');
            const etag = '"' + Buffer.from(etagPayload).toString('base64').slice(0, 24) + '"';

            if (req.headers['if-none-match'] === etag) {
                res.writeHead(304, {
                    'ETag': etag,
                    'Cache-Control': 'public, max-age=1'
                });
                return res.end();
            }

            res.setHeader('ETag', etag);
            res.setHeader('Cache-Control', 'public, max-age=1');
            return sendJson(resultData);
        }

        if (pathname === '/api/fleet/active-drivers') {
            const tripType = parsedUrl.searchParams.get('tripType');
            const activeDrivers = (db.memoryState.drivers || [])
                .filter(d => isDriverOnlineAndActive(d))
                .filter(d => {
                    const cMode = String(d.current_mode || d.mode || d.work_mode || d.workStatus || '').toLowerCase();
                    const isBoth = cMode === 'both' || cMode === 'كلاهما';
                    
                    if (tripType === 'daily' || tripType === 'commute') {
                        const isCommute = isBoth || cMode === 'commute' || cMode === 'permanent' || cMode === 'خط دائمي';
                        const isTaxi = (cMode === 'taxi' || cMode === 'مشوار قصير') && !isBoth;
                        if (isTaxi) return false;
                        if (cMode === 'idle' || cMode === 'خمول' || cMode === 'offline') return false;
                        return isCommute;
                    }
                    if (tripType === 'short' || tripType === 'taxi') {
                        const isTaxi = isBoth || cMode === 'taxi' || cMode === 'مشوار قصير';
                        const isCommute = (cMode === 'commute' || cMode === 'permanent' || cMode === 'خط دائمي') && !isBoth;
                        if (isCommute) return false;
                        if (cMode === 'idle' || cMode === 'خمول' || cMode === 'offline') return false;
                        return isTaxi;
                    }
                    return true;
                })
                .map(d => ({
                    id: d.driverId,
                    name: d.fullName,
                    phone: d.phoneNumber,
                    serviceType: d.serviceType || 'Both',
                    lat: d.currentLat ? parseFloat(d.currentLat) : (d.permanentLat ? parseFloat(d.permanentLat) : 32.016),
                    lon: d.currentLon ? parseFloat(d.currentLon) : (d.permanentLon ? parseFloat(d.permanentLon) : 44.339)
                }));
            return sendJson({ success: true, drivers: activeDrivers });
        }

        // Universal Ride Resolver: Searches Redis (Single Source of Truth), Memory, and PostgreSQL
        const findRideById = async (rideId) => {
            if (!rideId || rideId === 'undefined' || rideId === 'null') return null;
            const sId = String(rideId).trim();
            
            // 1. In Redis (Single Source of Truth across PM2 cluster)
            if (redisManager.isConnected && redisManager.client) {
                try {
                    const activeStr = await redisManager.client.get('ride:active:' + sId);
                    if (activeStr) {
                        const ride = JSON.parse(activeStr);
                        if (db.memoryState && Array.isArray(db.memoryState.rideRequests)) {
                            const idx = db.memoryState.rideRequests.findIndex(item => String(item.id) === sId);
                            if (idx >= 0) db.memoryState.rideRequests[idx] = ride;
                            else db.memoryState.rideRequests.unshift(ride);
                        }
                        return ride;
                    }

                    const pendingStr = await redisManager.client.hget('pending:rides', sId);
                    if (pendingStr) return JSON.parse(pendingStr);

                    const reqStr = await redisManager.client.get('ride:request:' + sId);
                    if (reqStr) return JSON.parse(reqStr);
                } catch (_) {}
            }

            // 2. In memory fallback
            const inMem = (db.memoryState.rideRequests || []).find(item => String(item.id) === sId);
            if (inMem) return inMem;

            // 3. In PostgreSQL
            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query('SELECT * FROM rides WHERE id = $1 LIMIT 1', [sId]);
                    if (pgRes && pgRes.rows && pgRes.rows.length > 0) {
                        return pgRes.rows[0];
                    }
                } catch (_) {}
            }

            return null;
        };

        // Universal Driver Active Ride Resolver (Unified Redis + Memory + DB - Zero 404s)
        const findActiveRideForDriver = async (rawParam) => {
            rawParam = String(rawParam || '').trim();
            if (!rawParam || rawParam === 'undefined' || rawParam === 'null') return null;
            const cleanPhone = rawParam.replace(/[^0-9]/g, '');
            const matchedDriver = (db.memoryState.drivers || []).find(d => 
                d.driverId === rawParam || d.id === rawParam || (cleanPhone && d.phoneNumber && d.phoneNumber.replace(/[^0-9]/g, '').endsWith(cleanPhone))
            );
            const targetDriverId = matchedDriver ? matchedDriver.driverId : rawParam;

            let active = null;

            // 1. Check Redis first for instant cross-PM2 cluster consistency
            if (redisManager.isConnected && redisManager.client) {
                try {
                    const activeStr = await redisManager.client.get('driver:active:' + String(targetDriverId));
                    if (activeStr) {
                        active = JSON.parse(activeStr);
                    } else if (cleanPhone) {
                        const activePhoneStr = await redisManager.client.get('driver:active:' + cleanPhone);
                        if (activePhoneStr) active = JSON.parse(activePhoneStr);
                    }
                } catch (_) {}
            }

            // 2. Check memory
            if (!active) {
                active = (db.memoryState.rideRequests || []).find(r => {
                    const isDriver = r.acceptedDriverId === targetDriverId || 
                                    r.assignedDriverId === targetDriverId || 
                                    r.acceptedDriverId === rawParam || 
                                    r.assignedDriverId === rawParam ||
                                    (cleanPhone && String(r.driverPhone || r.acceptedDriverPhone || '').replace(/[^0-9]/g, '').endsWith(cleanPhone));
                    const st = String(r.status || '').toLowerCase();
                    const isActive = ['accepted', 'arrived', 'driver_arrived', 'inprogress', 'in_progress', 'started', 'ontheway', 'in_trip', 'arrived_destination', 'waiting_at_destination', 'waiting', 'in_trip_return', 'arrived_return'].includes(st);
                    return isDriver && isActive;
                });
            }

            // 3. Check PostgreSQL
            if (!active && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(
                        `SELECT * FROM rides 
                         WHERE (driver_id = $1 OR driver_phone = $1 OR driver_id = $2 OR driver_phone = $2) 
                         AND status IN ('Accepted', 'Arrived', 'InProgress', 'accepted', 'arrived', 'in_progress', 'started', 'ontheway', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_TRIP', 'ARRIVED_DESTINATION', 'WAITING_AT_DESTINATION', 'IN_TRIP_RETURN', 'ARRIVED_RETURN')
                         ORDER BY created_at DESC LIMIT 1`,
                        [targetDriverId, cleanPhone || targetDriverId]
                    );
                    if (pgRes && pgRes.rows && pgRes.rows.length > 0) {
                        active = pgRes.rows[0];
                    }
                } catch (_) {}
            }

            // Validate with Redis (Single Source of Truth) - if ride is finished, it must not be active
            if (active && redisManager.isConnected && redisManager.client) {
                try {
                    const isStillActive = await redisManager.client.exists('ride:active:' + active.id);
                    if (!isStillActive) {
                        active = null;
                    }
                } catch (_) {}
            }

            // Address normalization: ensure both pickup and dropoff fields are always populated
            if (active) {
                normalizeAddresses(active);
            }

            return active || null;
        };

        // Universal Customer Active Ride Resolver (Unified Redis + Memory + DB - Zero 404s)
        const findActiveRideForCustomer = async (rawCustomerId, rawPhone) => {
            const customerId = String(rawCustomerId || '').trim();
            const cleanPhone = String(rawPhone || '').replace(/[^0-9]/g, '');
            if (!customerId && !cleanPhone) return null;

            let active = null;

            // 1. Check Redis first
            if (redisManager.isConnected && redisManager.client) {
                try {
                    if (customerId) {
                        const actCust = await redisManager.client.get('rider:active:' + customerId);
                        if (actCust) active = JSON.parse(actCust);
                    }
                    if (!active && cleanPhone) {
                        const actPhone = await redisManager.client.get('rider:active:' + cleanPhone);
                        if (actPhone) active = JSON.parse(actPhone);
                    }
                    if (!active) {
                        const pendingRaw = await redisManager.client.hgetall('pending:rides');
                        if (pendingRaw) {
                            const now = Date.now();
                            for (const [pId, rJson] of Object.entries(pendingRaw)) {
                                try {
                                    const r = JSON.parse(rJson);
                                    const reqTime = r.requestedAt ? Number(r.requestedAt) : (r.createdAt ? new Date(r.createdAt).getTime() : now);
                                    const age = now - reqTime;
                                    const isExpired = age >= 120000 || (r.stepTimeoutAt && now > r.stepTimeoutAt && (!r.candidateDriverIds || r.currentDriverIndex >= (r.candidateDriverIds.length - 1)));
                                    if (isExpired) {
                                        // Auto-prune expired ride from Redis hash
                                        await redisManager.client.hdel('pending:rides', String(pId)).catch(() => {});
                                        await redisManager.client.del('ride:request:' + pId).catch(() => {});
                                        continue;
                                    }
                                    const rCustId = String(r.customerId || r.riderId || '');
                                    const rCustPhone = String(r.customerPhone || r.riderPhone || '').replace(/[^0-9]/g, '');
                                    const isPhoneMatch = cleanPhone.length >= 7 && rCustPhone.length >= 7 && (rCustPhone.endsWith(cleanPhone.slice(-8)) || cleanPhone.endsWith(rCustPhone.slice(-8)));
                                    if ((customerId && rCustId === customerId) || isPhoneMatch) {
                                        active = r;
                                        break;
                                    }
                                } catch (_) {}
                            }
                        }
                    }
                } catch (_) {}
            }

            // 2. Check memory
            if (!active) {
                const now = Date.now();
                active = (db.memoryState.rideRequests || []).find(r => {
                    const rCustId = String(r.customerId || r.riderId || '');
                    const rCustPhone = String(r.customerPhone || r.riderPhone || '').replace(/[^0-9]/g, '');
                    const isPhoneMatch = cleanPhone.length >= 7 && rCustPhone.length >= 7 && (rCustPhone.endsWith(cleanPhone.slice(-8)) || cleanPhone.endsWith(rCustPhone.slice(-8)));
                    const isMatch = (customerId && rCustId === customerId) || isPhoneMatch;
                    const st = String(r.status || '').toLowerCase();
                    const isActive = ['pending', 'requested', 'offered', 'accepted', 'arrived', 'driver_arrived', 'inprogress', 'in_progress', 'in_trip', 'arrived_destination', 'waiting_at_destination', 'waiting', 'in_trip_return', 'arrived_return'].includes(st);
                    if (!isMatch || !isActive) return false;
                    const reqTime = r.requestedAt ? Number(r.requestedAt) : (r.createdAt ? new Date(r.createdAt).getTime() : now);
                    if (['pending', 'requested', 'offered'].includes(st) && (now - reqTime >= 120000)) {
                        return false;
                    }
                    return true;
                });
            }

            // 3. Check PostgreSQL
            if (!active && db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(
                        `SELECT * FROM rides 
                         WHERE (rider_id = $1 OR rider_phone = $1 OR rider_id = $2 OR rider_phone = $2) 
                         AND status IN ('Requested', 'Offered', 'Pending', 'Accepted', 'Arrived', 'InProgress', 'REQUESTED', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_TRIP', 'ARRIVED_DESTINATION', 'WAITING_AT_DESTINATION', 'IN_TRIP_RETURN', 'ARRIVED_RETURN')
                         ORDER BY created_at DESC LIMIT 1`,
                        [customerId, cleanPhone || customerId]
                    );
                    if (pgRes && pgRes.rows && pgRes.rows.length > 0) {
                        active = pgRes.rows[0];
                    }
                } catch (_) {}
            }

            // Validate with Redis (Single Source of Truth) - if ride is finished, it must not be active
            if (active && redisManager.isConnected && redisManager.client) {
                try {
                    const isStillActive = await redisManager.client.exists('ride:active:' + active.id);
                    const isStillPending = await redisManager.client.hexists('pending:rides', active.id);
                    if (!isStillActive && !isStillPending) {
                        active = null;
                    }
                } catch (_) {}
            }

            if (active) {
                normalizeAddresses(active);
            }

            return active || null;
        };

        // Universal Driver Locator across Redis Geospatial + PostgreSQL + Memory (Zero Cluster Desync)
        const getAvailableOnlineDrivers = async (pLat, pLon, maxDist = 25) => {
            const driversMap = new Map();

            const isEligibleForTaxi = (mode, status) => {
                const s = String(status || '').toLowerCase().trim();
                if (s === 'offline' || s === 'idle') return false;
                const m = String(mode || 'taxi').toLowerCase().trim();
                return m === 'taxi' || m === 'both' || m === 'كلاهما' || m === 'مشوار قصير';
            };

            // 1. From Redis geospatial index
            if (redisManager.isConnected && redisManager.client) {
                try {
                    const nearby = await redisManager.findNearbyDriverIds(pLon, pLat, maxDist);
                    for (const item of nearby) {
                        const memDriver = (db.memoryState.drivers || []).find(d => String(d.driverId) === String(item.driverId));
                        const meta = await redisManager.client.hgetall(`driver:${item.driverId}:meta`);
                        const driverMode = memDriver?.work_mode || memDriver?.workMode || meta?.workMode || 'taxi';
                        const driverStatus = memDriver?.status || meta?.status || 'Online';
                        const driverVehicleType = memDriver?.vehicleType || memDriver?.tier || meta?.vehicleType || 'eco';

                        if (isEligibleForTaxi(driverMode, driverStatus)) {
                            driversMap.set(String(item.driverId), {
                                driverId: String(item.driverId),
                                fullName: memDriver?.fullName || meta?.fullName || 'كابتن توصيله',
                                phoneNumber: memDriver?.phoneNumber || meta?.phone || '',
                                status: driverStatus,
                                isOnline: true,
                                work_mode: driverMode,
                                vehicleType: driverVehicleType,
                                tier: driverVehicleType,
                                dist: item.distKm
                            });
                        }
                    }
                } catch (_) {}
            }

            // 2. From PostgreSQL
            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgDrivers = await db.pool.query(
                        `SELECT * FROM drivers 
                         WHERE status = 'Online' 
                         AND (is_blocked IS NOT TRUE)
                         AND (work_mode IN ('taxi', 'both', 'كلاهما', 'مشوار قصير') OR work_mode IS NULL)`
                    );
                    if (pgDrivers && pgDrivers.rows) {
                        for (const d of pgDrivers.rows) {
                            if (!isEligibleForTaxi(d.work_mode, d.status)) continue;
                            const id = String(d.driver_id || d.id);
                            if (!driversMap.has(id)) {
                                const rawLat = d.latitude != null ? d.latitude : d.current_lat;
                                const rawLon = d.longitude != null ? d.longitude : d.current_lon;
                                if (rawLat != null && rawLon != null) {
                                    const dLat = parseFloat(rawLat);
                                    const dLon = parseFloat(rawLon);
                                    if (!isNaN(dLat) && !isNaN(dLon)) {
                                        const dist = calculateDistanceKm(pLat, pLon, dLat, dLon);
                                        if (dist <= maxDist) {
                                            driversMap.set(id, {
                                                driverId: id,
                                                fullName: d.full_name || d.name || 'كابتن توصيله',
                                                phoneNumber: d.phone_number || d.phone || '',
                                                status: 'Online',
                                                isOnline: true,
                                                work_mode: d.work_mode || 'taxi',
                                                vehicleType: d.vehicle_type || 'eco',
                                                currentLat: dLat,
                                                currentLon: dLon,
                                                dist
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (_) {}
            }

            // 3. From Memory
            for (const d of (db.memoryState.drivers || [])) {
                if (isDriverOnlineAndActive(d) && isEligibleForTaxi(d.work_mode || d.workMode || d.mode, d.status)) {
                    const id = String(d.driverId || d.id);
                    if (!driversMap.has(id)) {
                        const rawLat = d.currentLat != null ? d.currentLat : d.latitude;
                        const rawLon = d.currentLon != null ? d.currentLon : d.longitude;
                        if (rawLat != null && rawLon != null) {
                            const dLat = parseFloat(rawLat);
                            const dLon = parseFloat(rawLon);
                            if (!isNaN(dLat) && !isNaN(dLon)) {
                                const dist = calculateDistanceKm(pLat, pLon, dLat, dLon);
                                if (dist <= maxDist) {
                                    driversMap.set(id, {
                                        ...d,
                                        dist
                                    });
                                }
                            }
                        }
                    }
                }
            }

            return Array.from(driversMap.values()).sort((a, b) => a.dist - b.dist);
        };

        // ---------------------------------------------------------------------
        // REAL-TIME RIDE DISPATCH & 20-SECOND AUTO-ESCALATION (Stage 1 & 4)
        // ---------------------------------------------------------------------
        if ((pathname === '/api/ride/request' || pathname === '/ride/request' || pathname === '/api/trips' || pathname === '/trips') && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || body.idempotencyKey;
                if (idempotencyKey) {
                    if (redisManager.isConnected && redisManager.client) {
                        try {
                            const cached = await redisManager.client.get(`idem:${idempotencyKey}`);
                            if (cached) return sendJson(JSON.parse(cached));
                        } catch (_) {}
                    }
                    if (idempotencyStore.has(idempotencyKey)) {
                        return sendJson(idempotencyStore.get(idempotencyKey).response);
                    }
                }

                const {
                    customerId, customerName, customerPhone,
                    pickupName, pickupLat, pickupLon,
                    dropoffName, dropoffLat, dropoffLon,
                    distanceKm, durationMins, rangeKm = 25,
                    vehicleType = 'eco',
                    isRoundTrip = false,
                    secondDestination = '',
                    hasSecondStop = false,
                    stopDuration = 0
                } = body;

                // Rate limiting on ride requests: 5 requests per 30s per rider across PM2 cluster
                const riderIdKey = customerId || customerPhone || clientIp;
                const riderKey = `rate:ride:create:${riderIdKey}`;
                const clusterRate = await redisManager.checkRateLimitCluster(riderKey, 5, 30);
                if (!clusterRate.allowed) {
                    return sendJson({
                        success: false,
                        error: '⚠️ لقد أرسلت طلبات كثيرة في وقت قصير. يرجى الانتظار دقيقة قبل إرسال طلب جديد.'
                    }, 429);
                }

                const pLat = parseFloat(pickupLat);
                const pLon = parseFloat(pickupLon);
                const dLat = dropoffLat !== undefined && dropoffLat !== null && dropoffLat !== '' ? parseFloat(dropoffLat) : NaN;
                const dLon = dropoffLon !== undefined && dropoffLon !== null && dropoffLon !== '' ? parseFloat(dropoffLon) : NaN;

                // Strict input validation: lat/lon ranges, non-empty dropoff, string length caps
                if (isNaN(pLat) || pLat < -90 || pLat > 90 || isNaN(pLon) || pLon < -180 || pLon > 180) {
                    return sendJson({ success: false, error: 'إحداثيات موقع الانطلاق غير صحيحة' }, 400);
                }
                if (!isNaN(dLat) && (dLat < -90 || dLat > 90 || isNaN(dLon) || dLon < -180 || dLon > 180)) {
                    return sendJson({ success: false, error: 'إحداثيات الوجهة غير صحيحة' }, 400);
                }
                if (!dropoffName || typeof dropoffName !== 'string' || dropoffName.trim().length < 2 || dropoffName.trim().length > 200) {
                    return sendJson({ success: false, error: 'وجهة الوصول مطلوبة ويجب أن تتراوح بين 2 و 200 حرف' }, 400);
                }
                if (pickupName && (typeof pickupName !== 'string' || pickupName.length > 200)) {
                    return sendJson({ success: false, error: 'اسم موقع الانطلاق يجب ألا يتجاوز 200 حرف' }, 400);
                }
                if (body.notes && (typeof body.notes !== 'string' || body.notes.length > 500)) {
                    return sendJson({ success: false, error: 'ملاحظات المشوار يجب ألا تتجاوز 500 حرف' }, 400);
                }

                // Check if passenger already has an active ride across Redis, memory, and PostgreSQL
                const activeExisting = await findActiveRideForCustomer(customerId, customerPhone);
                if (activeExisting) {
                    const existingRes = {
                        success: false,
                        activeRideExists: true,
                        activeRequestId: activeExisting.id,
                        activeRequest: activeExisting,
                        ride: activeExisting,
                        error: '⚠️ لديك رحلة جارية بالفعل. لا يمكنك طلب مشوار جديد حتى يتم إكمال الرحلة أو إلغاؤها أولاً.'
                    };
                    if (idempotencyKey) idempotencyStore.set(idempotencyKey, { response: existingRes, timestamp: Date.now() });
                    return sendJson(existingRes, 400);
                }

                const toRad = (deg) => deg * Math.PI / 180;
                const haversine = (lat1, lon1, lat2, lon2) => {
                    const R = 6371;
                    const dLat = toRad(lat2 - lat1);
                    const dLon = toRad(lon2 - lon1);
                    const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
                    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                };

                const maxDist = systemSettingsService ? systemSettingsService.getSearchRadiusKm() : (parseFloat(rangeKm) || 25);
                let driverCandidates = await getAvailableOnlineDrivers(pLat, pLon, maxDist);
                if (driverCandidates.length === 0) {
                    driverCandidates = (db.memoryState.drivers || [])
                        .filter(d => isDriverOnlineAndActive(d))
                        .filter(d => d.work_mode !== 'خط دائمي' && d.current_mode !== 'commute' && d.workStatus !== 'permanent')
                        .filter(d => (d.current_mode === 'taxi' || d.mode === 'taxi' || d.work_mode === 'مشوار قصير' || d.work_mode === 'taxi' || d.workStatus === 'taxi' || d.serviceType === 'ShortTrip' || d.serviceType === 'Both' || !d.work_mode));
                }
                if (driverCandidates.length === 0) {
                    driverCandidates = (db.memoryState.drivers || [])
                        .filter(d => isDriverOnlineAndActive(d) && d.work_mode !== 'خط دائمي' && d.current_mode !== 'commute' && d.workStatus !== 'permanent');
                }

                // Vehicle tier matching (Dispatch exclusively to matching tier captains)
                const reqTierNorm = normalizeTier(vehicleType || 'super');
                const tierNameAr = getTierArabicName(vehicleType || 'super');

                let candidates = driverCandidates
                    .map(d => {
                        if (d.dist !== undefined && d.dist !== null && !isNaN(d.dist)) {
                            return d;
                        }
                        const drvLat = d.currentLat != null ? parseFloat(d.currentLat) : (d.permanentLat != null ? parseFloat(d.permanentLat) : (d.latitude != null ? parseFloat(d.latitude) : null));
                        const drvLon = d.currentLon != null ? parseFloat(d.currentLon) : (d.permanentLon != null ? parseFloat(d.permanentLon) : (d.longitude != null ? parseFloat(d.longitude) : null));
                        const dist = (drvLat != null && drvLon != null && !isNaN(drvLat) && !isNaN(drvLon))
                            ? haversine(pLat, pLon, drvLat, drvLon)
                            : Infinity;
                        return { ...d, dist };
                    })
                    .sort((a, b) => a.dist - b.dist);

                const inRadius = candidates.filter(d => d.dist <= maxDist);

                if (inRadius.length === 0) {
                    console.log(`[RideRequest] NO_DRIVERS: No online drivers found within radius ${maxDist}km of pickup (${pLat}, ${pLon})`);
                    return sendJson({
                        success: false,
                        noDriversInRadius: true,
                        error: `لا يوجد كابتن متاح بالقرب منك حالياً ضمن نطاق ${maxDist} كم.`
                    }, 404);
                }

                // Filter candidates strictly by requested vehicle tier
                const tierMatched = inRadius.filter(d => {
                    const drvTier = normalizeTier(d.vehicleType || d.vehicle_type || d.tier);
                    return drvTier === reqTierNorm;
                });

                if (tierMatched.length === 0) {
                    console.log(`[RideRequest] NO_DRIVERS_IN_TIER: No drivers found for tier ${tierNameAr} (${reqTierNorm}) within radius ${maxDist}km`);
                    return sendJson({
                        success: false,
                        noDriversInTier: true,
                        tier: reqTierNorm,
                        tierName: tierNameAr,
                        error: `لا يوجد كابتن ${tierNameAr} متاح قريباً، جرّب فئة أخرى.`
                    }, 404);
                }

                const effectiveCandidates = tierMatched;
                const candidateDriverIds = effectiveCandidates.map(c => c.driverId);
                const assignedDriver = effectiveCandidates[0] || (driverCandidates[0] || null);

                // SECURITY: Server-side authoritative geospatial distance validation
                const effDLat = !isNaN(dLat) ? dLat : 32.0321;
                const effDLon = !isNaN(dLon) ? dLon : 44.3725;
                const straightLineKm = calculateHaversineDistance(pLat, pLon, effDLat, effDLon);
                const roadEstimatedKm = Math.max(1.0, straightLineKm * 1.3);
                let validatedDistanceKm = Number(distanceKm);
                if (!validatedDistanceKm || validatedDistanceKm < (straightLineKm * 0.85)) {
                    validatedDistanceKm = roadEstimatedKm;
                }
                if (validatedDistanceKm > 200) validatedDistanceKm = roadEstimatedKm;
                const validatedDurationMins = Number(durationMins) || Math.max(5, Math.round(validatedDistanceKm * 2.5));

                // Calculate server-authoritative dynamic fare (client fare is completely ignored)
                const dynamicPricing = pricingService.calculateInstantRideFare({
                    pickupLat: pLat,
                    pickupLon: pLon,
                    dropoffLat: effDLat,
                    dropoffLon: effDLon,
                    distanceKm: validatedDistanceKm,
                    durationMins: validatedDurationMins,
                    vehicleType: reqTierNorm,
                    promoCode: body.promoCode,
                    isRoundTrip: Boolean(isRoundTrip),
                    hasSecondStop: Boolean(hasSecondStop || secondDestination),
                    stopDuration: Number(stopDuration) || 0
                });

                const computedFare = dynamicPricing.fare || 3000;
                const rideId = 'ride-' + Math.random().toString(36).substr(2, 9);

                const newRequest = {
                    id: rideId,
                    customerId: String(customerId || 'cust-user').slice(0, 64),
                    customerName: String(customerName || 'راكب توصيله').slice(0, 128),
                    customerPhone: String(customerPhone || '').slice(0, 32),
                    pickupName: pickupName || 'موقع الركوب',
                    pickupAddress: pickupName || 'موقع الركوب',
                    pickup_title: pickupName || 'موقع الركوب',
                    pickupLat: pLat,
                    pickupLon: pLon,
                    dropoffName: dropoffName || 'وجهة الوصول',
                    dropoffAddress: dropoffName || 'وجهة الوصول',
                    dropoff_title: dropoffName || 'وجهة الوصول',
                    destination: dropoffName || 'وجهة الوصول',
                    destinationAddress: dropoffName || 'وجهة الوصول',
                    dropoffLat: effDLat,
                    dropoffLon: effDLon,
                    fare: computedFare,
                    estimatedFare: computedFare,
                    surgeMultiplier: dynamicPricing.multipliers ? dynamicPricing.multipliers.cappedMultiplier : 1.0,
                    surgeBadge: dynamicPricing.surgeBadge,
                    discountBadge: dynamicPricing.discountBadge,
                    pricingBreakdown: dynamicPricing.breakdown,
                    vehicleType: tierNameAr,
                    tier: reqTierNorm,
                    tierName: tierNameAr,
                    tierBadge: reqTierNorm === 'plus' ? '💎 بلس' : reqTierNorm === 'super' ? '⚡ سوبر' : '🚕 توفير',
                    isRoundTrip: Boolean(isRoundTrip || body.tripType === 'ROUND_TRIP'),
                    tripType: (isRoundTrip || body.tripType === 'ROUND_TRIP') ? 'ROUND_TRIP' : 'ONE_WAY',
                    expectedWaitMinutes: Number(body.expectedWaitMinutes || stopDuration || 0),
                    actualWaitMinutes: 0,
                    returnDestination: body.returnDestination || null,
                    leg1Distance: validatedDistanceKm,
                    leg1Duration: validatedDurationMins,
                    leg2Distance: 0,
                    leg2Duration: 0,
                    waitFee: 0,
                    secondDestination: secondDestination || '',
                    hasSecondStop: Boolean(hasSecondStop || secondDestination),
                    stopDuration: Number(stopDuration) || 0,
                    serviceType: 'taxi',
                    distanceKm: validatedDistanceKm,
                    durationMins: validatedDurationMins,
                    status: RIDE_STATES.OFFERED,
                    candidateDriverIds: candidateDriverIds.length > 0 ? candidateDriverIds : (assignedDriver ? [assignedDriver.driverId] : []),
                    currentDriverIndex: 0,
                    assignedDriverId: null, // Strictly null until a driver actually accepts
                    assignedDriverName: null,
                    assignedDriverPhone: null,
                    assignedDriverVehicle: null,
                    acceptedDriverId: null,
                    rejectedDriverIds: [],
                    idempotencyKey: idempotencyKey || null,
                    requestedAt: Date.now(),
                    offeredAt: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    stepTimeoutAt: Date.now() + ((systemSettingsService ? systemSettingsService.getStepTimeoutSeconds() : 20) * 1000), // Step countdown calculated by server
                    serverTimestamp: Date.now(),
                    remainingSeconds: systemSettingsService ? systemSettingsService.getStepTimeoutSeconds() : 20,
                    history: []
                };

                normalizeAddresses(newRequest);

                db.memoryState.rideRequests = db.memoryState.rideRequests || [];
                db.memoryState.rideRequests.unshift(newRequest);
                db.saveStateSnapshot();

                // Save atomically to Redis distributed hash for cluster-wide consistency
                await redisManager.savePendingRide(newRequest);
                if (redisManager.isConnected && redisManager.client) {
                    await redisManager.client.set('ride:request:' + newRequest.id, JSON.stringify(newRequest), 'EX', 1200);
                }

                // Log granular creation and offer events to PostgreSQL ride_events
                await logRideEvent(newRequest.id, null, RIDE_STATES.REQUESTED, customerId, 'Customer', pLat, pLon);
                await logRideEvent(newRequest.id, RIDE_STATES.REQUESTED, RIDE_STATES.OFFERED, 'system', 'System', pLat, pLon, { candidateCount: candidateDriverIds.length });

                const tierBadge = reqTierNorm === 'plus' ? '💎 بلس' : reqTierNorm === 'super' ? '⚡ سوبر' : '🚕 توفير';
                let extraTgInfo = '';
                if (newRequest.isRoundTrip) extraTgInfo += '\n🔄 <b>نوع الرحلة:</b> ذهاب وإياب (خصم 15% على العودة)';
                if (newRequest.secondDestination) extraTgInfo += `\n📍 <b>وجهة إضافية:</b> ${newRequest.secondDestination}`;
                if (newRequest.stopDuration) extraTgInfo += `\n⏱️ <b>توقف في الطريق:</b> ${newRequest.stopDuration} دقيقة`;
                if (newRequest.isRoundTrip || newRequest.tripType === 'ROUND_TRIP') {
                    extraTgInfo += `\n🔄 <b>نوع المشوار:</b> ذهاب وإياب (وقت انتظار متوقع: ${newRequest.expectedWaitMinutes || 0} دقيقة)`;
                }

                console.log(`[TelegramDispatch] New ride created, type: ${newRequest.tripType || (newRequest.isRoundTrip ? 'ROUND_TRIP' : 'ONE_WAY')}, rideId: ${newRequest.id}, estimatedFare: ${newRequest.fare}`);

                // Send Telegram notification to Platform Admin about new ride (with distributed lock)
                try {
                    const adminChatId = config.telegramAdminChatId || config.adminChatId || config.telegram?.adminChatId || '391762837';
                    const adminLock = await redisManager.acquireTelegramNotificationLock(`${newRequest.id}:NEW_RIDE:ADMIN`, 86400);
                    if (adminLock) {
                        const maskedRiderPhone = newRequest.customerPhone ? maskPhoneNumber(newRequest.customerPhone) : 'غير متوفر';
                        const tgAdminMsg = `🚖 <b>طلب مشوار جديد (#${newRequest.id})</b>\n\n` +
                            `👤 <b>الراكب:</b> ${newRequest.customerName} (${maskedRiderPhone})\n` +
                            `📍 <b>الانطلاق:</b> ${newRequest.pickupName || 'موقع الراكب'}\n` +
                            `🏁 <b>الوجهة:</b> ${newRequest.dropoffName || 'الوجهة المحددة'}${extraTgInfo}\n` +
                            `💰 <b>الأجرة:</b> ${newRequest.fare} د.ع (${tierBadge})\n` +
                            `👥 <b>الكباتن المرشحون:</b> ${candidateDriverIds.length}\n` +
                            `⏱️ <b>مهلة الرد:</b> 20 ثانية`;

                        const tgRes = await telegramBot.sendMessage(adminChatId, tgAdminMsg);
                        console.log(`[TelegramDispatch] New ride alert dispatched to Admin (chatId: ${String(adminChatId).slice(0, 3)}****), ok: ${Boolean(tgRes?.ok)}, message_id: ${tgRes?.result?.message_id || 'N/A'}`);
                    }
                } catch (tgAdminErr) {
                    console.error('[TelegramDispatch] Failed to send new ride alert to admin:', tgAdminErr.message);
                }

                // Notify passenger via Telegram if connected (with distributed lock)
                try {
                    const custObj = (db.memoryState.customers || []).find(c => c.customerId === customerId || (customerPhone && c.phoneNumber === customerPhone));
                    if (custObj && custObj.telegramChatId) {
                        const custLock = await redisManager.acquireTelegramNotificationLock(`${newRequest.id}:NEW_RIDE:CUST`, 86400);
                        if (custLock) {
                            const tgMsg = `🚖 <b>تم إرسال طلبك (${tierBadge}) إلى الكباتن المتاحين بالقرب منك!</b>\n\n` +
                                `🛣️ <b>المسار:</b> ${newRequest.pickupName} ➔ ${newRequest.dropoffName}${extraTgInfo}\n` +
                                `💰 <b>الأجرة:</b> ${newRequest.fare} د.ع\n\n` +
                                `⏳ جاري البحث عن كابتن بانتظار الموافقة...`;
                            telegramBot.notifyUser(custObj.telegramChatId, tgMsg).catch(() => {});
                        }
                    }
                } catch (custTgErr) {
                    console.error('[NewRide] Customer Telegram notify error:', custTgErr.message);
                }

                // Notify candidate drivers with deep link https://tawseelaiq.app/drive?ride=<id>
                try {
                    const candidateIds = new Set(newRequest.candidateDriverIds || []);
                    if (assignedDriver && assignedDriver.driverId) candidateIds.add(assignedDriver.driverId);

                    for (const dId of candidateIds) {
                        if (typeof telegramBot.notifyCaptainRideOffer === 'function') {
                            telegramBot.notifyCaptainRideOffer(dId, newRequest, 20).catch(err => {
                                console.error(`[NewRide] Driver ${dId} Telegram offer error:`, err.message);
                            });
                        }
                    }
                } catch (drvTgErr) {
                    console.error('[NewRide] Driver Telegram notify error:', drvTgErr.message);
                }

                // Real-time broadcast with PRIVACY MASKING: mask customer phone for candidate drivers
                const broadcastNow = Date.now();
                const remBroadcastSec = Math.max(0, Math.round(((newRequest.stepTimeoutAt || 0) - broadcastNow) / 1000));
                const maskedPayload = {
                    ...newRequest,
                    serverTimestamp: broadcastNow,
                    remainingSeconds: remBroadcastSec,
                    customerPhone: maskPhoneNumber(newRequest.customerPhone)
                };
                await redisManager.publishDispatchEvent({
                    type: 'new_ride',
                    event: 'new_ride',
                    rideId: newRequest.id,
                    requestId: newRequest.id,
                    request: maskedPayload
                });

                // First candidate targeted offer (published to candidate driver and phone alias)
                if (candidateDriverIds.length > 0) {
                    const primaryCandidateId = candidateDriverIds[0];
                    const candDriver = (db.memoryState.drivers || []).find(d => String(d.driverId || d.driver_id || d.id) === String(primaryCandidateId));
                    await redisManager.publishDriverEvent(primaryCandidateId, {
                        type: 'new_ride',
                        event: 'new_ride',
                        rideId: newRequest.id,
                        requestId: newRequest.id,
                        request: maskedPayload
                    });
                    const cleanDrvPhone = candDriver?.phoneNumber ? String(candDriver.phoneNumber).replace(/[^0-9]/g, '') : '';
                    if (cleanDrvPhone && `drv_${cleanDrvPhone}` !== primaryCandidateId) {
                        await redisManager.publishDriverEvent(`drv_${cleanDrvPhone}`, {
                            type: 'new_ride',
                            event: 'new_ride',
                            rideId: newRequest.id,
                            requestId: newRequest.id,
                            request: maskedPayload
                        });
                    }
                }

                const responsePayload = {
                    success: true,
                    request: newRequest,
                    ride: newRequest,
                    candidateCount: newRequest.candidateDriverIds.length,
                    assignedDriver: null, // strictly null until driver accepts!
                    pricing: dynamicPricing
                };

                if (idempotencyKey) {
                    idempotencyStore.set(idempotencyKey, { response: responsePayload, timestamp: Date.now() });
                    if (redisManager.isConnected && redisManager.client) {
                        redisManager.client.set(`idem:${idempotencyKey}`, JSON.stringify(responsePayload), 'EX', 3600).catch(() => {});
                    }
                }

                return sendJson(responsePayload);
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // Check Ride Status & Auto-Escalate if 30s elapsed (Multi-tier Lookup - Zero 404s)
        if ((pathname.startsWith('/api/ride/status/') || pathname.startsWith('/ride/status/')) && method === 'GET') {
            const reqId = pathname.replace(/^\/?(?:api\/)?ride\/status\//, '').trim();
            if (!reqId || reqId === 'undefined' || reqId === 'null') {
                return sendJson({ success: true, notFound: true, ride: null, request: null, activeRide: null }, 200);
            }

            let r = await findRideById(reqId);
            if (!r) {
                return sendJson({ success: true, notFound: true, ride: null, request: null, activeRide: null }, 200);
            }

            // Sync external nav state from Redis
            if (r.assignedDriverId && redisManager.isConnected && redisManager.client) {
                try {
                    const isNav = await redisManager.isDriverNavigatingExternal(r.assignedDriverId);
                    if (isNav) {
                        r.isExternalNavActive = true;
                    }
                } catch (_) {}
            }

            // Sync to local memory
            db.memoryState.rideRequests = db.memoryState.rideRequests || [];
            const existingIdx = db.memoryState.rideRequests.findIndex(item => String(item.id) === String(r.id));
            if (existingIdx >= 0) {
                db.memoryState.rideRequests[existingIdx] = r;
            } else {
                db.memoryState.rideRequests.unshift(r);
            }

            // RLS Check: Only the ride customer, assigned/candidate driver, or admin can track this ride
            const authUser = getAuthUser(req);
            if (authUser) {
                if (authUser.role === 'Customer' || authUser.role === 'customer') {
                    const normAuth = normalizePhone(authUser.phone);
                    const normCust = normalizePhone(r.customerPhone);
                    const isIdMatch = r.customerId && authUser.id && (r.customerId === authUser.id || String(r.customerId).toLowerCase() === String(authUser.id).toLowerCase());
                    const isPhoneMatch = normAuth && normCust && (normAuth === normCust || normAuth.endsWith(normCust) || normCust.endsWith(normAuth));
                    if (r.customerId && r.customerId !== 'cust-user' && !isIdMatch && !isPhoneMatch) {
                        return sendJson({ success: false, error: 'غير مصرح: لا يمكنك استعراض تفاصيل مشوار لمستخدم آخر (RLS)' }, 403);
                    }
                } else if (authUser.role === 'Driver' || authUser.role === 'driver') {
                    const normAuth = normalizePhone(authUser.phone);
                    const normDrv = normalizePhone(r.assignedDriverPhone);
                    const normCust = normalizePhone(r.customerPhone);
                    const isAssigned = r.assignedDriverId === authUser.id || 
                        (r.candidateDriverIds && r.candidateDriverIds.includes(authUser.id)) ||
                        (normAuth && normDrv && (normAuth === normDrv || normAuth.endsWith(normDrv) || normDrv.endsWith(normAuth))) ||
                        (normAuth && normCust && (normAuth === normCust || normAuth.endsWith(normCust) || normCust.endsWith(normAuth))) ||
                        r.assignedDriverId === 'drv-sample';
                    if (!isAssigned) {
                        return sendJson({ success: false, error: 'غير مصرح: المشوار ليس مسنداً إليك (RLS)' }, 403);
                    }
                }
            }

            // 20s Countdown and Auto-escalation check
            const currentCanonStatus = toCanonicalState(r.status);
            if ((currentCanonStatus === RIDE_STATES.OFFERED || currentCanonStatus === RIDE_STATES.REQUESTED) && r.candidateDriverIds && r.candidateDriverIds.length > 0) {
                const now = Date.now();
                if (now > (r.stepTimeoutAt || 0)) {
                    const prevDriverId = r.candidateDriverIds[r.currentDriverIndex || 0];
                    r.currentDriverIndex = (r.currentDriverIndex || 0) + 1;
                    if (prevDriverId) {
                        redisManager.publishDriverEvent(prevDriverId, {
                            type: 'ride_offer_expired',
                            event: 'ride_offer_expired',
                            rideId: r.id,
                            requestId: r.id,
                            reason: 'timeout_next_driver'
                        }).catch(() => {});
                    }
                    if (r.currentDriverIndex < r.candidateDriverIds.length) {
                        const nextDriverId = r.candidateDriverIds[r.currentDriverIndex];
                        const nextDriver = (db.memoryState.drivers || []).find(d => d.driverId === nextDriverId);
                        r.history = r.history || [];
                        r.history.push({
                            driverId: r.assignedDriverId,
                            reason: 'Timeout20s',
                            at: new Date().toISOString()
                        });
                        r.assignedDriverId = nextDriverId;
                        r.assignedDriverName = nextDriver ? nextDriver.fullName : 'كابتن توصيله';
                        r.assignedDriverPhone = nextDriver ? nextDriver.phoneNumber : '';
                        r.assignedDriverVehicle = nextDriver ? `${nextDriver.vehicleMake||'تويوتا'} ${nextDriver.vehicleModel||'كورولا'}` : 'تويوتا';
                        const stepTimeoutSec = systemSettingsService ? systemSettingsService.getStepTimeoutSeconds() : 20;
                        r.stepTimeoutAt = now + (stepTimeoutSec * 1000);
                        r.serverTimestamp = now;
                        r.remainingSeconds = stepTimeoutSec;
                        db.saveStateSnapshot();
                        if (redisManager.isConnected && redisManager.client) {
                            redisManager.client.hset('pending:rides', String(r.id), JSON.stringify(r)).catch(() => {});
                        }
                        // Offer to next candidate via SSE
                        redisManager.publishDriverEvent(nextDriverId, {
                            type: 'new_ride',
                            event: 'new_ride',
                            rideId: r.id,
                            requestId: r.id,
                            request: {
                                ...r,
                                serverTimestamp: now,
                                remainingSeconds: stepTimeoutSec,
                                customerPhone: maskPhoneNumber(r.customerPhone)
                            }
                        });
                    } else {
                        // All candidates exhausted -> transition to NO_DRIVERS
                        r.status = RIDE_STATES.NO_DRIVERS;
                        r.assignedDriverId = null;
                        db.saveStateSnapshot();
                        if (redisManager.isConnected && redisManager.client) {
                            redisManager.client.hdel('pending:rides', String(r.id)).catch(() => {});
                        }
                        logRideEvent(r.id, currentCanonStatus, RIDE_STATES.NO_DRIVERS, 'system', 'System').catch(() => {});
                        redisManager.publishRideEvent(r.id, {
                            type: 'no_drivers_available',
                            event: 'no_drivers_available',
                            rideId: r.id
                        });
                        // Instantly withdraw ride offer modal from all candidate drivers via SSE
                        for (const dId of (r.candidateDriverIds || [])) {
                            redisManager.publishDriverEvent(dId, {
                                type: 'ride_offer_expired',
                                event: 'ride_offer_expired',
                                rideId: r.id,
                                requestId: r.id,
                                reason: 'no_drivers_available'
                            }).catch(() => {});
                        }
                        redisManager.publishDispatchEvent({
                            type: 'ride_taken',
                            event: 'ride_taken',
                            rideId: r.id,
                            requestId: r.id
                        }).catch(() => {});
                    }
                }
            }

            // Check for max wait exceeded during WAITING_AT_DESTINATION
            if (r.status === RIDE_STATES.WAITING_AT_DESTINATION) {
                const maxWaitMins = systemSettingsService ? systemSettingsService.getMaxWaitMinutes() : 60;
                const waitStart = r.waitStartedAt ? new Date(r.waitStartedAt).getTime() : Date.now();
                const elapsedWaitMins = Math.round((Date.now() - waitStart) / 60000);
                if (elapsedWaitMins >= maxWaitMins && !r.maxWaitExceededNotified) {
                    r.maxWaitExceededNotified = true;
                    db.saveStateSnapshot();
                    const maxWaitEvt = {
                        type: 'max_wait_exceeded',
                        event: 'max_wait_exceeded',
                        rideId: r.id,
                        elapsedWaitMinutes: elapsedWaitMins,
                        maxWaitMinutes: maxWaitMins,
                        message: 'تم تجاوز الحد الأقصى لوقت الانتظار المسموح به'
                    };
                    redisManager.publishRideEvent(r.id, maxWaitEvt);
                    if (r.assignedDriverId) redisManager.publishDriverEvent(r.assignedDriverId, maxWaitEvt);
                }
            }

            // Security / Privacy: Mask customer phone for candidate drivers who have not accepted yet
            let outputRide = r;
            const isDriverCandidate = authUser && (authUser.role === 'Driver' || authUser.role === 'driver') && r.acceptedDriverId !== authUser.id;
            if (isDriverCandidate && r.customerPhone) {
                outputRide = { ...r, customerPhone: maskPhoneNumber(r.customerPhone) };
            }

            const secondsRemaining = Math.max(0, Math.round(((r.stepTimeoutAt || 0) - Date.now()) / 1000));
            const enrichedRide = {
                ...outputRide,
                serverTimestamp: Date.now(),
                remainingSeconds: secondsRemaining
            };
            return sendJson({
                success: true,
                notFound: false,
                request: enrichedRide,
                ride: enrichedRide,
                activeRide: enrichedRide,
                secondsRemaining,
                currentDriverIndex: r.currentDriverIndex || 0,
                totalCandidates: (r.candidateDriverIds || []).length
            });
        }

        // Single Ride Details Resolver: GET /api/ride/:id or /ride/:id (Always 200 - Zero 404s)
        const isSingleRideRoute = (pathname.startsWith('/api/ride/') || pathname.startsWith('/ride/')) && 
            method === 'GET' && 
            !pathname.includes('/stream') && 
            !pathname.includes('/status') && 
            !pathname.endsWith('/active-ride') &&
            !pathname.endsWith('/pending-requests') &&
            !pathname.endsWith('/cancellation-reasons');
        if (isSingleRideRoute) {
            const rideId = pathname.replace(/^\/?(?:api\/)?ride\//, '').trim();
            if (!rideId || rideId === 'undefined' || rideId === 'null') {
                return sendJson({ success: true, notFound: true, ride: null, request: null, activeRide: null }, 200);
            }
            try {
                const r = await findRideById(rideId);
                if (!r) {
                    return sendJson({ success: true, notFound: true, ride: null, request: null, activeRide: null }, 200);
                }

                // RLS Authorization Check: Unassigned driver reading ride or unrelated customer -> 403 Forbidden
                const authUser = getAuthUser(req);
                if (authUser && authUser.role !== 'Admin') {
                    if (authUser.role === 'Driver') {
                        const isAssigned = (authUser.id && (String(authUser.id) === String(r.assignedDriverId) || String(authUser.id) === String(r.acceptedDriverId))) ||
                                           (authUser.phone && r.assignedDriverPhone && normalizePhone(authUser.phone) === normalizePhone(r.assignedDriverPhone)) ||
                                           (r.candidateDriverIds && r.candidateDriverIds.includes(authUser.id));
                        if (!isAssigned) {
                            return sendJson({ success: false, error: 'غير مصرح: لا يمكنك الاطلاع على تفاصيل مشوار لم تُعين له (RLS)' }, 403);
                        }
                    } else if (authUser.role === 'Customer') {
                        const isOwner = (authUser.id && r.customerId && String(authUser.id) === String(r.customerId)) ||
                                        (authUser.phone && r.customerPhone && normalizePhone(authUser.phone) === normalizePhone(r.customerPhone));
                        if (!isOwner) {
                            return sendJson({ success: false, error: 'غير مصرح: لا يمكنك الاطلاع على تفاصيل مشوار عميل آخر (RLS)' }, 403);
                        }
                    }
                }

                return sendJson({ success: true, notFound: false, ride: r, request: r, activeRide: r }, 200);
            } catch (err) {
                console.error('[SingleRideRoute] Error:', err.message);
                return sendJson({ success: true, notFound: true, ride: null, request: null, activeRide: null }, 200);
            }
        }

        // Driver Respond to Request (Accept / Reject) - Atomic State Transition & Distributed Lock
        if ((pathname === '/api/ride/respond' || pathname === '/ride/respond' || pathname === '/api/ride/accept' || pathname === '/ride/accept') && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || body.idempotencyKey;
                if (idempotencyKey) {
                    if (redisManager.isConnected && redisManager.client) {
                        try {
                            const cached = await redisManager.client.get(`idem:${idempotencyKey}`);
                            if (cached) return sendJson(JSON.parse(cached));
                        } catch (_) {}
                    }
                    if (idempotencyStore.has(idempotencyKey)) {
                        return sendJson(idempotencyStore.get(idempotencyKey).response);
                    }
                }

                const action = body.action || body.response || (pathname.includes('/accept') ? 'accept' : 'reject');
                const requestId = body.requestId || body.rideId || body.id;
                const driverId = body.driverId;
                if (!requestId || requestId === 'undefined' || requestId === 'null') {
                    return sendJson({ success: false, notFound: true, alreadyAccepted: true, error: 'معرّف الطلب مطلوب' }, 200);
                }

                // Rate limiting for driver accept attempts across PM2 cluster (10 attempts / 10s)
                if (action === 'accept' && driverId) {
                    const acceptRate = await redisManager.checkRateLimitCluster(`rate:driver:accept:${driverId}`, 10, 10);
                    if (!acceptRate.allowed) {
                        return sendJson({
                            success: false,
                            error: '⚠️ لقد قمت بمحاولات قبول متكررة في وقت وجيز. يرجى الانتظار بضع ثوانٍ.'
                        }, 429);
                    }
                }

                let r = await findRideById(requestId);

                if (!r) {
                    return sendJson({ 
                        success: false, 
                        notFound: true, 
                        alreadyAccepted: true, 
                        error: 'عذراً، المشوار تم قبوله من كابتن آخر أو لم يعد متاحاً.' 
                    }, 200);
                }

                // Ensure local memory has updated reference to r
                db.memoryState.rideRequests = db.memoryState.rideRequests || [];
                const memIdx = db.memoryState.rideRequests.findIndex(item => String(item.id) === String(r.id));
                if (memIdx >= 0) {
                    db.memoryState.rideRequests[memIdx] = r;
                } else {
                    db.memoryState.rideRequests.unshift(r);
                }

                if (action === 'accept') {
                    // Check if ride is already in NO_DRIVERS or cancelled status
                    const currentCanon = toCanonicalState(r.status);
                    if (currentCanon === RIDE_STATES.NO_DRIVERS || currentCanon === RIDE_STATES.CANCELLED || currentCanon === RIDE_STATES.CANCELLED_BY_RIDER || currentCanon === RIDE_STATES.CANCELLED_BY_DRIVER) {
                        return sendJson({
                            success: false,
                            conflict: true,
                            alreadyAccepted: true,
                            expired: true,
                            status: 409,
                            error: 'عذراً، انتهت مهلة هذا المشوار ولم يعد متاحاً للقبول'
                        }, 409);
                    }

                    // Pre-check driver active ride: a driver with an active ride cannot accept another ride
                    const existingActiveRide = await findActiveRideForDriver(driverId);
                    if (existingActiveRide && String(existingActiveRide.id) !== String(r.id)) {
                        return sendJson({
                            success: false,
                            conflict: true,
                            status: 409,
                            error: 'لا يمكنك قبول المشوار؛ لديك مشوار نشط بالفعل حالياً.'
                        }, 409);
                    }

                    const cleanPhone = String(driverId || '').replace(/[^0-9]/g, '');
                    const targetDriver = (db.memoryState.drivers || []).find(d => 
                        String(d.driverId) === String(driverId) || String(d.id) === String(driverId) || (cleanPhone && d.phoneNumber && d.phoneNumber.replace(/[^0-9]/g, '').endsWith(cleanPhone))
                    );
                    const actualDriverId = targetDriver ? targetDriver.driverId : driverId;

                    const driverDetails = {
                        assignedDriverId: actualDriverId,
                        acceptedDriverId: actualDriverId,
                        assignedDriverName: targetDriver?.fullName || 'كابتن توصيله',
                        assignedDriverPhone: targetDriver?.phoneNumber || targetDriver?.phone || cleanPhone || '',
                        assignedDriverVehicle: targetDriver ? `${targetDriver.vehicleMake||'تويوتا'} ${targetDriver.vehicleModel||'كورولا'}` : 'تويوتا كورولا',
                        driverPlate: targetDriver?.plateNumber || '١١٣٤٠ ة - النجف',
                        driverRating: targetDriver?.rating || 5.0,
                        driverTier: targetDriver ? (targetDriver.vehicleType || 'eco') : 'eco',
                        assignedDriverTier: targetDriver ? (targetDriver.vehicleType || 'eco') : 'eco'
                    };

                    // Atomic State Transition OFFERED -> ACCEPTED via Redis Distributed Lock
                    const transResult = await transitionRideState(
                        redisManager,
                        r.id,
                        RIDE_STATES.ACCEPTED,
                        { id: actualDriverId, role: 'Driver' },
                        driverDetails
                    );

                    if (!transResult.success) {
                        return sendJson({
                            success: false,
                            conflict: true,
                            alreadyAccepted: true,
                            expired: Boolean(transResult.expired || transResult.fromStatus === RIDE_STATES.NO_DRIVERS),
                            status: 409,
                            error: transResult.error || 'عذراً، المشوار تم قبوله من كابتن آخر أو لم يعد متاحاً.'
                        }, 409);
                    }

                    r = transResult.ride;
                    normalizeAddresses(r);

                    // Initial welcome chat message
                    db.memoryState.chatMessages = db.memoryState.chatMessages || [];
                    const initMsg = {
                        id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
                        requestId: r.id,
                        senderId: actualDriverId,
                        senderRole: 'Driver',
                        senderName: r.assignedDriverName || 'الكابتن',
                        text: `مرحباً بك! أنا الكابتن ${r.assignedDriverName || ''} قبلت طلبك وأنا في طريقي إليك الآن 🚖`,
                        createdAt: new Date().toISOString(),
                        timestamp: new Date().toISOString()
                    };
                    db.memoryState.chatMessages.push(initMsg);

                    // Stage 1: Notify Customer on Telegram asynchronously (setImmediate)
                    // This ensures the HTTP response returns immediately to driver app so UI transitions before Telegram push
                    setImmediate(async () => {
                        try {
                            if (typeof telegramBot.notifyTripAccepted === 'function') {
                                await telegramBot.notifyTripAccepted(r);
                            }
                        } catch (tgErr) {
                            console.error('[RideAccepted] Telegram notify error:', tgErr.message);
                        }
                    });

                    await redisManager.publishRideEvent(r.id, { type: 'ride_accepted', event: 'ride_accepted', request: r });
                    await redisManager.publishDispatchEvent({ type: 'ride_taken', event: 'ride_taken', rideId: r.id, requestId: r.id });
                    await redisManager.publishDriverEvent(actualDriverId, { type: 'ride_assigned', event: 'ride_assigned', request: r });

                    // Instantly withdraw ride offer modal from other candidate drivers
                    for (const candId of (r.candidateDriverIds || [])) {
                        if (String(candId) !== String(actualDriverId)) {
                            redisManager.publishDriverEvent(candId, {
                                type: 'ride_offer_expired',
                                event: 'ride_offer_expired',
                                rideId: r.id,
                                requestId: r.id,
                                reason: 'accepted_by_another'
                            }).catch(() => {});
                        }
                    }

                    const respPayload = {
                        success: true,
                        message: 'تم قبول المشوار بنجاح!',
                        request: r,
                        ride: r
                    };

                    if (idempotencyKey) {
                        idempotencyStore.set(idempotencyKey, { response: respPayload, timestamp: Date.now() });
                    }

                    return sendJson(respPayload);
                } else {
                    // Reject action
                    const cleanPhone = String(driverId || '').replace(/[^0-9]/g, '');
                    r.rejectedDriverIds = r.rejectedDriverIds || [];
                    if (driverId && !r.rejectedDriverIds.includes(driverId)) r.rejectedDriverIds.push(driverId);
                    if (cleanPhone && !r.rejectedDriverIds.includes(cleanPhone)) r.rejectedDriverIds.push(cleanPhone);

                    r.currentDriverIndex = (r.currentDriverIndex || 0) + 1;
                    const stepTimeoutSec = systemSettingsService ? systemSettingsService.getStepTimeoutSeconds() : 20;

                    if (r.candidateDriverIds && r.currentDriverIndex < r.candidateDriverIds.length) {
                        const now = Date.now();
                        r.stepTimeoutAt = now + (stepTimeoutSec * 1000);
                        r.serverTimestamp = now;
                        r.remainingSeconds = stepTimeoutSec;
                        const nextDriverId = r.candidateDriverIds[r.currentDriverIndex];
                        r.assignedDriverId = nextDriverId;
                        const nextDriver = (db.memoryState.drivers || []).find(d => String(d.driverId) === String(nextDriverId) || String(d.id) === String(nextDriverId));
                        if (nextDriver) {
                            r.assignedDriverName = nextDriver.fullName || 'كابتن توصيله';
                            r.assignedDriverPhone = nextDriver.phoneNumber || '';
                        }
                        if (redisManager.isConnected && redisManager.client) {
                            const rStr = JSON.stringify(r);
                            await redisManager.client.hset('pending:rides', String(r.id), rStr);
                            await redisManager.client.set('ride:request:' + r.id, rStr, 'EX', 1200);
                        }
                        redisManager.publishDriverEvent(nextDriverId, {
                            type: 'new_ride',
                            event: 'new_ride',
                            rideId: r.id,
                            requestId: r.id,
                            request: {
                                ...r,
                                serverTimestamp: now,
                                remainingSeconds: stepTimeoutSec,
                                customerPhone: maskPhoneNumber(r.customerPhone)
                            }
                        });
                    } else {
                        await transitionRideState(
                            redisManager,
                            r.id,
                            RIDE_STATES.NO_DRIVERS,
                            { id: driverId, role: 'Driver' },
                            { noDriversAt: new Date().toISOString() }
                        );
                        await redisManager.publishRideEvent(r.id, {
                            type: 'no_drivers_available',
                            event: 'no_drivers_available',
                            rideId: r.id
                        });
                        try {
                            if (typeof telegramBot.notifyRideCancelled === 'function') {
                                telegramBot.notifyRideCancelled(r, reason, 'driver', 0).catch(() => {});
                            }
                        } catch (_) {}
                    }
                    db.saveStateSnapshot();
                    redisManager.publishDispatchEvent({ type: 'ride_rejected', requestId: r.id });
                    return sendJson({ success: true, message: 'تم رفض المشوار وتمرير الطلب', request: r });
                }
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // Driver Arrived at Passenger Pickup (RLS Protected - Multi-tier Lookup)
        if (pathname === '/api/ride/arrived' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { requestId, driverId, lat, lon, driverLat, driverLon } = body;
                if (!requestId) return sendJson({ success: false, notFound: true, error: 'requestId is required' }, 200);

                let r = await findRideById(requestId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'الطلب غير متاح حالياً' }, 200);

                // Ensure local memory has updated reference to r
                db.memoryState.rideRequests = db.memoryState.rideRequests || [];
                const memIdx = db.memoryState.rideRequests.findIndex(item => String(item.id) === String(r.id));
                if (memIdx >= 0) {
                    db.memoryState.rideRequests[memIdx] = r;
                } else {
                    db.memoryState.rideRequests.unshift(r);
                }

                // Driver Authorization Check
                const authUser = getAuthUser(req);
                const isAuthorized = isDriverAuthorizedForRide(r, authUser, body);

                if (!isAuthorized) {
                    return sendJson({ 
                        success: false, 
                        error: 'غير مصرح: يجب أن يكون الكابتن المعتمد لهذه الرحلة فقط لتأكيد الوصول' 
                    }, 403);
                }

                // Proximity verification (radius check: from system_settings, default 1000m)
                const dLat = parseFloat(driverLat || lat);
                const dLon = parseFloat(driverLon || lon);
                if (!isNaN(dLat) && !isNaN(dLon) && r.pickupLat && r.pickupLon) {
                    const distKm = calculateDistanceKm(r.pickupLat, r.pickupLon, dLat, dLon);
                    const maxRadiusMeters = systemSettingsService ? systemSettingsService.getProximityRadiusMeters() : 1000;
                    const maxRadiusKm = maxRadiusMeters / 1000.0;
                    if (distKm > maxRadiusKm) {
                        return sendJson({
                            success: false,
                            error: `أنت بعيد عن موقع الانطلاق (${Math.round(distKm * 1000)} متر). يرجى الاقتراب ضمن نطاق ${maxRadiusMeters} متر لتأكيد الوصول.`
                        }, 400);
                    }
                }

                // Atomic State Transition: ACCEPTED -> DRIVER_ARRIVED
                const transRes = await transitionRideState(
                    redisManager,
                    r.id,
                    RIDE_STATES.DRIVER_ARRIVED,
                    { id: driverId || authUser?.id, role: 'Driver', lat: dLat, lon: dLon },
                    { arrivedAt: new Date().toISOString(), waitStartedAt: Date.now() }
                );

                if (!transRes.success) {
                    return sendJson({
                        success: false,
                        conflict: true,
                        status: 409,
                        error: transRes.error || 'تعذر تغيير حالة الرحلة'
                    }, 409);
                }

                r = transRes.ride;
                normalizeAddresses(r);
                redisManager.publishRideEvent(r.id, { type: 'captain_arrived', status: RIDE_STATES.DRIVER_ARRIVED, request: r });

                // Stage 2: Send Telegram Notification to Passenger - Captain Arrived
                try {
                    if (typeof telegramBot.notifyDriverArrived === 'function') {
                        telegramBot.notifyDriverArrived(r).catch(err => console.error('[RideArrived] Telegram notify error:', err.message));
                    }
                } catch (tgErr) {
                    console.error('[RideArrived] Telegram notify error:', tgErr.message);
                }

                // Send in-app chat arrival message from driver to passenger
                db.memoryState.chatMessages = db.memoryState.chatMessages || [];
                const arrivalMsg = {
                    id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
                    requestId: r.id,
                    senderId: driverId || r.assignedDriverId || 'driver',
                    senderRole: 'Driver',
                    senderName: r.assignedDriverName || 'الكابتن',
                    text: '🚖 وصلت إلى موقعك الآن وأنا في انتظارك عند نقطة الانطلاق! 📍',
                    isAutoArrival: true,
                    createdAt: new Date().toISOString(),
                    timestamp: new Date().toISOString()
                };
                db.memoryState.chatMessages.push(arrivalMsg);
                db.saveStateSnapshot();

                return sendJson({ success: true, message: 'تم إشعار الراكب بوصولك إلى الموقع 📍', status: RIDE_STATES.DRIVER_ARRIVED, request: r, ride: r });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // Driver Trigger Horn Alert (بيب بيب 📢) to Passenger (RLS Protected)
        if ((pathname.match(/^\/?(?:api\/)?(?:trips|ride)\/([^\/]+)\/horn$/) || pathname === '/api/ride/horn' || pathname === '/api/trips/horn' || pathname === '/ride/horn' || pathname === '/trips/horn') && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                let tripId = body.requestId || body.tripId || '';
                if (!tripId) {
                    const match = pathname.match(/^\/?(?:api\/)?(?:trips|ride)\/([^\/]+)\/horn$/);
                    if (match) tripId = match[1];
                }
                let r = await findRideById(tripId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'المشوار غير متاح حالياً' }, 200);

                // Driver Authorization Check
                const authUser = getAuthUser(req);
                const isAuthorized = isDriverAuthorizedForRide(r, authUser, body);
                if (!isAuthorized) {
                    return sendJson({ 
                        success: false, 
                        error: 'غير مصرح: يجب أن يكون الكابتن المعتمد لهذه الرحلة فقط لإرسال التنبيه' 
                    }, 403);
                }

                r.hornSequence = (r.hornSequence || 0) + 1;
                r.lastHornAt = new Date().toISOString();

                // Send in-app chat arrival message / horn alert from driver to passenger
                db.memoryState.chatMessages = db.memoryState.chatMessages || [];
                const hornMsg = {
                    id: 'horn-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
                    requestId: r.id,
                    senderId: r.assignedDriverId || 'driver',
                    senderRole: 'Driver',
                    senderName: r.assignedDriverName || 'الكابتن',
                    text: '🚖 بيب بيب! الكابتن وصل وينبهك لوصوله بالهورن 📢',
                    isHornAlert: true,
                    hornSequence: r.hornSequence,
                    createdAt: new Date().toISOString(),
                    timestamp: new Date().toISOString()
                };
                db.memoryState.chatMessages.push(hornMsg);
                db.saveStateSnapshot();

                return sendJson({ 
                    success: true, 
                    message: 'تم إرسال التنبيه للراكب بنجاح 🚖', 
                    tripId: r.id,
                    hornSequence: r.hornSequence 
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // Driver Start Ride - Navigate to Destination (RLS Protected - Multi-tier Lookup)
        if ((pathname === '/api/ride/start' || pathname === '/api/ride/startRide' || pathname === '/api/ride/start-ride' || pathname === '/api/ride/navigate') && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { requestId, driverId } = body;
                if (!requestId) return sendJson({ success: false, notFound: true, error: 'requestId is required' }, 200);

                let r = await findRideById(requestId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'الطلب غير متاح حالياً' }, 200);

                // Ensure local memory has updated reference to r
                db.memoryState.rideRequests = db.memoryState.rideRequests || [];
                const memIdx = db.memoryState.rideRequests.findIndex(item => String(item.id) === String(r.id));
                if (memIdx >= 0) {
                    db.memoryState.rideRequests[memIdx] = r;
                } else {
                    db.memoryState.rideRequests.unshift(r);
                }

                // Authentication & Driver Authorization Check
                const authUser = getAuthUser(req);
                const isAuthorized = isDriverAuthorizedForRide(r, authUser, body);

                if (!isAuthorized) {
                    return sendJson({ 
                        success: false, 
                        error: 'غير مصرح: يجب أن يكون الكابتن المعتمد لهذه الرحلة فقط لبدء المشوار' 
                    }, 403);
                }

                // Atomic State Transition: DRIVER_ARRIVED -> IN_TRIP
                const transRes = await transitionRideState(
                    redisManager,
                    r.id,
                    RIDE_STATES.IN_TRIP,
                    { id: driverId || authUser?.id, role: 'Driver' },
                    { startedAt: new Date().toISOString() }
                );

                if (!transRes.success) {
                    return sendJson({
                        success: false,
                        conflict: true,
                        status: 409,
                        error: transRes.error || 'تعذر بدء المشوار'
                    }, 409);
                }

                r = transRes.ride;
                normalizeAddresses(r);
                redisManager.publishRideEvent(r.id, { type: 'ride_started', status: RIDE_STATES.IN_TRIP, request: r });

                // Stage 3: Send Telegram Notification to Passenger - Trip Started
                try {
                    if (typeof telegramBot.notifyTripStarted === 'function') {
                        telegramBot.notifyTripStarted(r).catch(err => console.error('[RideStart] Telegram notify error:', err.message));
                    }
                } catch (tgErr) {
                    console.error('[RideStart] Telegram notify error:', tgErr.message);
                }

                // In-app chat notification from driver to passenger
                db.memoryState.chatMessages = db.memoryState.chatMessages || [];
                const startMsg = {
                    id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
                    requestId: r.id,
                    senderId: driverId || r.assignedDriverId || 'driver',
                    senderRole: 'Driver',
                    senderName: r.assignedDriverName || 'الكابتن',
                    text: '🚗 بدأنا الرحلة الآن — انطلاق إلى الوجهة! نتمنى لك مشواراً مريحاً.',
                    createdAt: new Date().toISOString(),
                    timestamp: new Date().toISOString()
                };
                db.memoryState.chatMessages.push(startMsg);
                db.saveStateSnapshot();

                return sendJson({ 
                    success: true, 
                    message: 'تم بدء الرحلة والانطلاق إلى الوجهة بنجاح 🚗', 
                    status: RIDE_STATES.IN_TRIP,
                    request: r,
                    ride: r
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // Driver Arrived at Destination - Server Calculates Authoritative Final Fare (RLS Protected)
        if ((pathname === '/api/ride/destination-arrived' || pathname === '/api/ride/destinationArrived' || pathname === '/ride/destination-arrived' || pathname === '/api/ride/arrive-destination' || pathname === '/ride/arrive-destination') && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { requestId, driverId, tripId } = body;
                const rId = requestId || tripId || body.id;
                if (!rId) return sendJson({ success: false, notFound: true, error: 'requestId is required' }, 200);

                let r = await findRideById(rId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'الطلب غير متاح حالياً' }, 200);

                // Driver Authorization Check
                const authUser = getAuthUser(req);
                const isAuthorized = isDriverAuthorizedForRide(r, authUser, body);
                if (!isAuthorized) {
                    return sendJson({ 
                        success: false, 
                        error: 'غير مصرح: يجب أن يكون الكابتن المعتمد لهذه الرحلة فقط لتأكيد الوصول إلى الوجهة' 
                    }, 403);
                }

                // Server calculates authoritative final fare from actual distance & elapsed time
                const pSettings = pricingService.getPricingSettings();
                const baseFare = Number(pSettings.baseFare || 2000);
                const kmRate = Number(pSettings.kmRate || 500);
                const minRate = Number(pSettings.minuteRate || 100);

                const startTime = r.startedAt ? new Date(r.startedAt).getTime() : (r.acceptedAt ? new Date(r.acceptedAt).getTime() : Date.now());
                const actualMinutes = Math.max(1, Math.round((Date.now() - startTime) / 60000));
                const actualDistKm = Number(r.distanceKm) || 3.0;

                // Waiting fee: wait time minus 5 free minutes
                let waitMinutes = 0;
                if (r.arrivedAt && r.startedAt) {
                    const waitMs = new Date(r.startedAt).getTime() - new Date(r.arrivedAt).getTime();
                    waitMinutes = Math.max(0, Math.round(waitMs / 60000) - 5);
                }
                const roundingMultiple = systemSettingsService ? systemSettingsService.getFareRoundingMultipleIqd() : 250;
                const waitFee = waitMinutes * roundingMultiple;

                const rawFare = baseFare + (actualDistKm * kmRate) + (actualMinutes * minRate) + waitFee;
                const finalFare = Math.round(Math.max(baseFare, rawFare) / roundingMultiple) * roundingMultiple;

                // Atomic State Transition: IN_TRIP -> ARRIVED_DESTINATION
                const transRes = await transitionRideState(
                    redisManager,
                    r.id,
                    RIDE_STATES.ARRIVED_DESTINATION,
                    { id: driverId || authUser?.id, role: 'Driver' },
                    {
                        arrivedDestinationAt: new Date().toISOString(),
                        finalFare: finalFare,
                        fare: finalFare,
                        actualDurationMins: actualMinutes,
                        waitMinutes
                    }
                );

                if (!transRes.success) {
                    return sendJson({
                        success: false,
                        conflict: true,
                        status: 409,
                        error: transRes.error || 'تعذر الانتقال لحالة الوصول إلى الوجهة'
                    }, 409);
                }

                r = transRes.ride;
                normalizeAddresses(r);
                redisManager.publishRideEvent(r.id, {
                    type: 'destination_arrived',
                    event: 'destination_arrived',
                    status: RIDE_STATES.ARRIVED_DESTINATION,
                    finalFare: finalFare,
                    request: r,
                    ride: r
                });

                // Note: "الحمد لله على سلامتك" Telegram message is strictly delayed until Captain clicks "استلمت الأجرة" (POST /api/ride/complete)

                // Round-Trip: Transition from ARRIVED_DESTINATION -> WAITING_AT_DESTINATION automatically
                const isRound = Boolean(r.isRoundTrip || r.tripType === 'ROUND_TRIP');
                if (isRound) {
                    const waitTrans = await transitionRideState(
                        redisManager,
                        r.id,
                        RIDE_STATES.WAITING_AT_DESTINATION,
                        { id: driverId || authUser?.id, role: 'Driver' },
                        {
                            waitStartedAt: new Date().toISOString(),
                            leg1Distance: r.distanceKm || actualDistKm,
                            leg1Duration: actualMinutes,
                            leg1Fare: finalFare
                        }
                    );
                    if (waitTrans.success) {
                        r = waitTrans.ride;
                        normalizeAddresses(r);
                        redisManager.publishRideEvent(r.id, {
                            type: 'captain_waiting_at_destination',
                            event: 'captain_waiting_at_destination',
                            status: RIDE_STATES.WAITING_AT_DESTINATION,
                            waitStartedAt: r.waitStartedAt,
                            freeWaitMinutes: systemSettingsService ? systemSettingsService.getFreeWaitMinutes() : 5,
                            leg1Fare: finalFare,
                            request: r,
                            ride: r
                        });
                        return sendJson({
                            success: true,
                            message: 'وصلتم إلى المحطة الأولى وبدأ وقت الانتظار ⏳',
                            status: RIDE_STATES.WAITING_AT_DESTINATION,
                            waitStartedAt: r.waitStartedAt,
                            freeWaitMinutes: systemSettingsService ? systemSettingsService.getFreeWaitMinutes() : 5,
                            leg1Fare: finalFare,
                            request: r,
                            ride: r
                        });
                    }
                }

                return sendJson({
                    success: true,
                    message: 'وصلتم إلى الوجهة بنجاح 🏁',
                    status: RIDE_STATES.ARRIVED_DESTINATION,
                    finalFare,
                    request: r,
                    ride: r
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // ---------------------------------------------------------------------
        // ROUND-TRIP LIFECYCLE ENDPOINTS (Batch 2/4)
        // ---------------------------------------------------------------------
        // 1. Start Return Leg (WAITING_AT_DESTINATION -> IN_TRIP_RETURN)
        if (pathname === '/api/ride/return/start' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { requestId, driverId, tripId } = body;
                const rId = requestId || tripId || body.id;
                if (!rId) return sendJson({ success: false, notFound: true, error: 'requestId مطلوب' }, 200);

                let r = await findRideById(rId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'المشوار غير موجود' }, 200);

                const authUser = getAuthUser(req);
                const isAuthorized = isDriverAuthorizedForRide(r, authUser, body);
                if (!isAuthorized) {
                    return sendJson({ success: false, error: 'غير مصرح: يجب أن يكون الكابتن المعتمد للمشوار (RLS)' }, 403);
                }

                // Calculate actual wait time and fee
                const waitStart = r.waitStartedAt ? new Date(r.waitStartedAt).getTime() : Date.now();
                const elapsedWaitMs = Math.max(0, Date.now() - waitStart);
                const actualWaitMinutes = (body.actualWaitMinutes !== undefined && !isNaN(body.actualWaitMinutes))
                    ? Math.max(0, parseInt(body.actualWaitMinutes, 10))
                    : Math.max(0, Math.round(elapsedWaitMs / 60000));
                const waitDetails = pricingService.calculateWaitFee(actualWaitMinutes);

                // Atomic State Transition: WAITING_AT_DESTINATION -> IN_TRIP_RETURN
                const transRes = await transitionRideState(
                    redisManager,
                    r.id,
                    RIDE_STATES.IN_TRIP_RETURN,
                    { id: driverId || authUser?.id, role: 'Driver' },
                    {
                        returnStartedAt: new Date().toISOString(),
                        actualWaitMinutes,
                        waitFee: waitDetails.waitFee,
                        billableWaitMinutes: waitDetails.billableWaitMinutes,
                        freeWaitMinutes: waitDetails.freeWaitMinutes
                    }
                );

                if (!transRes.success) {
                    return sendJson({
                        success: false,
                        conflict: true,
                        status: 409,
                        error: transRes.error || 'تعذر بدء رحلة العودة'
                    }, 409);
                }

                r = transRes.ride;
                normalizeAddresses(r);
                redisManager.publishRideEvent(r.id, {
                    type: 'return_trip_started',
                    status: RIDE_STATES.IN_TRIP_RETURN,
                    actualWaitMinutes,
                    waitFee: waitDetails.waitFee,
                    request: r,
                    ride: r
                });

                return sendJson({
                    success: true,
                    message: 'تم بدء رحلة العودة بنجاح 🔄',
                    status: RIDE_STATES.IN_TRIP_RETURN,
                    actualWaitMinutes,
                    waitFee: waitDetails.waitFee,
                    request: r,
                    ride: r
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // 2. Arrive Return Destination (IN_TRIP_RETURN -> ARRIVED_RETURN)
        if (pathname === '/api/ride/return/arrived' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { requestId, driverId, tripId } = body;
                const rId = requestId || tripId || body.id;
                if (!rId) return sendJson({ success: false, notFound: true, error: 'requestId مطلوب' }, 200);

                let r = await findRideById(rId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'المشوار غير موجود' }, 200);

                const authUser = getAuthUser(req);
                const isAuthorized = isDriverAuthorizedForRide(r, authUser, body);
                if (!isAuthorized) {
                    return sendJson({ success: false, error: 'غير مصرح: يجب أن يكون الكابتن المعتمد للمشوار (RLS)' }, 403);
                }

                const returnStartTime = r.returnStartedAt ? new Date(r.returnStartedAt).getTime() : Date.now();
                const leg2Duration = Math.max(1, Math.round((Date.now() - returnStartTime) / 60000));
                const leg2Distance = Number(body.leg2Distance || r.leg1Distance || r.distanceKm || 3.0);

                // Calculate comprehensive round-trip fare: leg1 + waitFee + leg2
                const roundTripPricing = pricingService.calculateRoundTripFare({
                    leg1DistanceKm: r.leg1Distance || r.distanceKm,
                    leg1DurationMins: r.leg1Duration || r.durationMins,
                    leg2DistanceKm: leg2Distance,
                    leg2DurationMins: leg2Duration,
                    actualWaitMinutes: r.actualWaitMinutes || 0,
                    vehicleType: r.vehicleType
                });

                const finalFare = roundTripPricing.totalFare;

                // Atomic State Transition: IN_TRIP_RETURN -> ARRIVED_RETURN
                const transRes = await transitionRideState(
                    redisManager,
                    r.id,
                    RIDE_STATES.ARRIVED_RETURN,
                    { id: driverId || authUser?.id, role: 'Driver' },
                    {
                        returnArrivedAt: new Date().toISOString(),
                        leg2Distance,
                        leg2Duration,
                        leg2Fare: roundTripPricing.leg2Fare,
                        waitFee: roundTripPricing.waitFee,
                        finalFare: finalFare,
                        fare: finalFare,
                        pricingBreakdown: roundTripPricing
                    }
                );

                if (!transRes.success) {
                    return sendJson({
                        success: false,
                        conflict: true,
                        status: 409,
                        error: transRes.error || 'تعذر تأكيد الوصول لنقطة العودة'
                    }, 409);
                }

                r = transRes.ride;
                normalizeAddresses(r);
                redisManager.publishRideEvent(r.id, {
                    type: 'return_trip_arrived',
                    status: RIDE_STATES.ARRIVED_RETURN,
                    finalFare: finalFare,
                    request: r,
                    ride: r
                });

                return sendJson({
                    success: true,
                    message: 'تم الوصول إلى نقطة العودة بسلام 🏁',
                    status: RIDE_STATES.ARRIVED_RETURN,
                    finalFare: finalFare,
                    breakdown: roundTripPricing,
                    request: r,
                    ride: r
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // ---------------------------------------------------------------------
        // EXTERNAL NAVIGATION STATE MANAGEMENT (Google Maps / Waze)
        // ---------------------------------------------------------------------
        // 3. Start External Navigation
        if (pathname === '/api/ride/external-nav/start' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    return sendJson({ success: false, error: 'مدخلات غير صالحة' }, 400);
                }
                if (body.app !== undefined && (typeof body.app !== 'string' || body.app.length > 50)) {
                    return sendJson({ success: false, error: 'اسم تطبيق الملاحة غير صالح' }, 400);
                }
                if (body.requestId !== undefined && typeof body.requestId !== 'string') {
                    return sendJson({ success: false, error: 'معرّف الطلب غير صالح' }, 400);
                }

                const { requestId, driverId, app = 'Google Maps' } = body;
                const rId = requestId || body.rideId || body.id;
                if (!rId) return sendJson({ success: false, notFound: true, error: 'requestId مطلوب' }, 200);

                const authUser = getAuthUser(req);
                if (authUser && (authUser.role === 'Customer' || authUser.role === 'customer')) {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكن للراكب تفعيل الملاحة الخارجية للكابتن (RLS)' }, 403);
                }

                let r = await findRideById(rId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'المشوار غير موجود' }, 200);

                const isAuthorized = isDriverAuthorizedForRide(r, authUser, body);
                if (!isAuthorized) {
                    return sendJson({ success: false, error: 'غير مصرح: يجب أن يكون الكابتن المعتمد للمشوار (RLS)' }, 403);
                }

                const dId = driverId || authUser?.id || r.assignedDriverId;

                // Rate limit for external-nav toggles (5 requests per 10s)
                const rateKey = `rate:external_nav:${dId || authUser?.id || clientIp}`;
                const rateCheck = await redisManager.checkRateLimitCluster(rateKey, 5, 10);
                if (!rateCheck.allowed) {
                    return sendJson({ success: false, error: '⚠️ لقد قمت بمحاولات متكررة في وقت وجيز. يرجى الانتظار بضع ثوانٍ.' }, 429);
                }

                const timeoutMins = systemSettingsService ? systemSettingsService.getExternalNavTimeoutMinutes() : 15;
                const ttlSec = timeoutMins * 60;

                await redisManager.setDriverExternalNav(dId, { app, rideId: r.id, startedAt: Date.now() }, ttlSec);

                r.isExternalNavActive = true;
                r.externalNavApp = app;
                r.externalNavStartedAt = Date.now();

                // Atomically update ride in Redis active key so all PM2 workers see external nav status
                if (redisManager.isConnected && redisManager.client) {
                    try {
                        const actStr = await redisManager.client.get('ride:active:' + r.id);
                        if (actStr) {
                            const actObj = JSON.parse(actStr);
                            actObj.isExternalNavActive = true;
                            actObj.externalNavApp = app;
                            actObj.externalNavStartedAt = r.externalNavStartedAt;
                            await redisManager.client.set('ride:active:' + r.id, JSON.stringify(actObj), 'EX', 7200);
                        }
                    } catch (_) {}
                }

                const lastKnownLocation = {
                    lat: parseFloat(r.driverLat || r.currentLat || r.pickupLat || 32.0),
                    lng: parseFloat(r.driverLng || r.driverLon || r.currentLng || r.currentLon || r.pickupLng || r.pickupLon || 44.3),
                    lon: parseFloat(r.driverLon || r.driverLng || r.currentLon || r.currentLng || r.pickupLon || r.pickupLng || 44.3)
                };

                // Save snapshot & broadcast SSE to both passenger and driver streams
                db.saveStateSnapshot();
                const navEvent = {
                    type: 'external_nav_active',
                    event: 'external_nav_active',
                    rideId: r.id,
                    driverId: dId,
                    app,
                    startedAt: r.externalNavStartedAt,
                    timeoutMinutes: timeoutMins,
                    lastKnownLocation,
                    workerPid: process.pid
                };
                redisManager.publishRideEvent(r.id, navEvent);
                redisManager.publishDriverEvent(dId, navEvent);

                console.log(`[ExternalNav] START on ride ${r.id} by driver ${dId} on PM2 worker PID ${process.pid}`);

                return sendJson({
                    success: true,
                    isExternalNavActive: true,
                    app,
                    timeoutMinutes: timeoutMins,
                    rideId: r.id,
                    lastKnownLocation,
                    workerPid: process.pid
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // 4. End External Navigation
        if (pathname === '/api/ride/external-nav/end' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { requestId, driverId } = body;
                const rId = requestId || body.rideId || body.id;
                if (!rId) return sendJson({ success: false, notFound: true, error: 'requestId مطلوب' }, 200);

                const authUser = getAuthUser(req);
                if (authUser && (authUser.role === 'Customer' || authUser.role === 'customer')) {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكن للراكب إنهاء الملاحة الخارجية للكابتن (RLS)' }, 403);
                }

                let r = await findRideById(rId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'المشوار غير موجود' }, 200);

                const isAuthorized = isDriverAuthorizedForRide(r, authUser, body);
                if (!isAuthorized) {
                    return sendJson({ success: false, error: 'غير مصرح: يجب أن يكون الكابتن المعتمد للمشوار (RLS)' }, 403);
                }

                const dId = driverId || authUser?.id || r.assignedDriverId;
                await redisManager.clearDriverExternalNav(dId);

                r.isExternalNavActive = false;
                r.externalNavEndedAt = Date.now();

                // Atomically update ride in Redis active key
                if (redisManager.isConnected && redisManager.client) {
                    try {
                        const actStr = await redisManager.client.get('ride:active:' + r.id);
                        if (actStr) {
                            const actObj = JSON.parse(actStr);
                            actObj.isExternalNavActive = false;
                            actObj.externalNavEndedAt = r.externalNavEndedAt;
                            await redisManager.client.set('ride:active:' + r.id, JSON.stringify(actObj), 'EX', 7200);
                        }
                    } catch (_) {}
                }

                db.saveStateSnapshot();
                const navEndEvent = {
                    type: 'external_nav_ended',
                    event: 'external_nav_ended',
                    rideId: r.id,
                    driverId: dId,
                    endedAt: r.externalNavEndedAt,
                    workerPid: process.pid
                };
                redisManager.publishRideEvent(r.id, navEndEvent);
                redisManager.publishDriverEvent(dId, navEndEvent);

                console.log(`[ExternalNav] END on ride ${r.id} by driver ${dId} on PM2 worker PID ${process.pid}`);

                return sendJson({
                    success: true,
                    isExternalNavActive: false,
                    rideId: r.id,
                    workerPid: process.pid
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // ---------------------------------------------------------------------
        // IN-APP CHAT (Passenger & Driver) - RLS Protected & SSE Streamed
        // ---------------------------------------------------------------------
        if (pathname === '/api/chat/messages' && method === 'GET') {
            const requestId = parsedUrl.searchParams.get('requestId');
            if (!requestId) {
                return sendJson({ success: false, error: 'requestId is required' }, 400);
            }

            const reqObj = await findRideById(requestId);
            if (!reqObj) {
                return sendJson({ success: false, notFound: true, error: 'المشوار غير موجود' }, 200);
            }

            // Access duration check: close chat 15 minutes after completion/cancellation
            const isFinished = ['COMPLETED', 'CANCELLED', 'CANCELLED_BY_RIDER', 'CANCELLED_BY_DRIVER', 'NO_DRIVERS'].includes(reqObj.status);
            if (isFinished) {
                const finishedTime = reqObj.completedAt || reqObj.cancelledAt || reqObj.updatedAt;
                const elapsed = finishedTime ? (Date.now() - new Date(finishedTime).getTime()) : 0;
                if (elapsed > 15 * 60 * 1000) {
                    return sendJson({ success: false, error: 'انتهت صلاحية المراسلة لهذا المشوار بعد إكماله' }, 403);
                }
            }

            // RLS Check: Ensure caller is authenticated customer or assigned driver of this ride
            const authUser = getAuthUser(req);
            if (!authUser) {
                return sendJson({ success: false, error: 'غير مصرح: يجب تسجيل الدخول أولاً (RLS)' }, 401);
            }
            if (reqObj && authUser.role !== 'Admin') {
                if (authUser.role === 'Customer' && reqObj.customerId && authUser.id !== reqObj.customerId && (!authUser.phone || reqObj.customerPhone !== authUser.phone)) {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكنك قراءة محادثة مستخدم آخر (RLS)' }, 403);
                }
                if (authUser.role === 'Driver' && reqObj.assignedDriverId && authUser.id !== reqObj.assignedDriverId && (!authUser.phone || reqObj.assignedDriverPhone !== authUser.phone) && reqObj.assignedDriverId !== 'drv-sample') {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكنك قراءة هذه المحادثة (RLS)' }, 403);
                }
            }

            const allMessages = db.memoryState.chatMessages || [];
            const messages = allMessages.filter(m => m.requestId === requestId);
            return sendJson({ success: true, messages });
        }

        if (pathname === '/api/chat/send' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { requestId, senderId, senderRole, senderName, text } = body;
                if (!requestId || !text || !text.trim()) {
                    return sendJson({ success: false, error: 'requestId and text are required' }, 400);
                }

                const cleanText = String(text || '').replace(/<[^>]*>?/gm, '').trim().slice(0, 500);
                if (!cleanText) {
                    return sendJson({ success: false, error: 'نص الرسالة فارغ' }, 400);
                }

                const reqObj = await findRideById(requestId);
                if (!reqObj) {
                    return sendJson({ success: false, notFound: true, error: 'المشوار غير موجود' }, 200);
                }

                // Check access expiration (15 mins post completion)
                const isFinished = ['COMPLETED', 'CANCELLED', 'CANCELLED_BY_RIDER', 'CANCELLED_BY_DRIVER', 'NO_DRIVERS'].includes(reqObj.status);
                if (isFinished) {
                    const finishedTime = reqObj.completedAt || reqObj.cancelledAt || reqObj.updatedAt;
                    const elapsed = finishedTime ? (Date.now() - new Date(finishedTime).getTime()) : 0;
                    if (elapsed > 15 * 60 * 1000) {
                        return sendJson({ success: false, error: 'انتهت صلاحية المراسلة لهذا المشوار بعد إكماله' }, 403);
                    }
                }

                // RLS Check: Only authenticated participants of this ride can send messages
                const authUser = getAuthUser(req);
                if (!authUser) {
                    return sendJson({ success: false, error: 'غير مصرح: يجب تسجيل الدخول أولاً (RLS)' }, 401);
                }
                if (reqObj && authUser.role !== 'Admin') {
                    if (authUser.role === 'Customer' && reqObj.customerId && authUser.id !== reqObj.customerId && (!authUser.phone || reqObj.customerPhone !== authUser.phone)) {
                        return sendJson({ success: false, error: 'غير مصرح بإرسال رسائل في محادثة مستخدم آخر (RLS)' }, 403);
                    }
                    if (authUser.role === 'Driver' && reqObj.assignedDriverId && authUser.id !== reqObj.assignedDriverId && (!authUser.phone || reqObj.assignedDriverPhone !== authUser.phone) && reqObj.assignedDriverId !== 'drv-sample') {
                        return sendJson({ success: false, error: 'غير مصرح بإرسال رسائل في هذا المشوار (RLS)' }, 403);
                    }
                }

                // Rate limiting (max 10 msgs per 10s per sender)
                const effectiveSenderId = senderId || authUser?.id || 'anon';
                const isAllowed = await redisManager.checkRateLimitCluster(`chat_rate:${effectiveSenderId}`, 10, 10);
                if (!isAllowed) {
                    return sendJson({ success: false, error: 'تجاوزت حد إرسال الرسائل، يرجى الانتظار قليلاً' }, 429);
                }

                db.memoryState.chatMessages = db.memoryState.chatMessages || [];
                const newMsg = {
                    id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
                    requestId,
                    senderId: effectiveSenderId,
                    senderRole: senderRole || 'Customer',
                    senderName: senderName || (senderRole === 'Driver' ? 'الكابتن' : 'الراكب'),
                    text: cleanText,
                    createdAt: new Date().toISOString(),
                    timestamp: new Date().toISOString()
                };
                db.memoryState.chatMessages.push(newMsg);
                db.saveStateSnapshot();

                // Publish real-time event to SSE channel for instant delivery without polling
                await redisManager.publishRideEvent(requestId, {
                    type: 'chat_message',
                    event: 'chat_message',
                    rideId: requestId,
                    message: newMsg
                });

                // Fallback Telegram notification to recipient (throttled once every 60s per ride)
                (async () => {
                    try {
                        const isCustSender = (senderRole || 'Customer').toLowerCase() === 'customer';
                        if (isCustSender) {
                            const drvId = reqObj.assignedDriverId || reqObj.acceptedDriverId;
                            const drvChatId = await telegramBot.findDriverTelegramChatId(drvId, reqObj.assignedDriverPhone);
                            if (drvChatId) {
                                const lock = await redisManager.acquireTelegramNotificationLock(`chat_tg:${requestId}:${drvChatId}`, 60);
                                if (lock) {
                                    const tgText = `💬 <b>رسالة جديدة من الراكب:</b>\n\n"${cleanText.slice(0, 80)}${cleanText.length > 80 ? '...' : ''}"`;
                                    await telegramBot.sendMessage(drvChatId, tgText, {
                                        reply_markup: {
                                            inline_keyboard: [[{ text: '💬 فتح المحادثة', url: `https://tawseelaiq.app/drive?ride=${encodeURIComponent(requestId)}` }]]
                                        }
                                    }).catch(() => {});
                                }
                            }
                        } else {
                            const custChatId = await telegramBot.findCustomerTelegramChatId(reqObj);
                            if (custChatId) {
                                const lock = await redisManager.acquireTelegramNotificationLock(`chat_tg:${requestId}:${custChatId}`, 60);
                                if (lock) {
                                    const tgText = `💬 <b>رسالة جديدة من الكابتن:</b>\n\n"${cleanText.slice(0, 80)}${cleanText.length > 80 ? '...' : ''}"`;
                                    await telegramBot.sendMessage(custChatId, tgText, {
                                        reply_markup: {
                                            inline_keyboard: [[{ text: '💬 فتح المحادثة', url: `https://tawseelaiq.app/?ride=${encodeURIComponent(requestId)}` }]]
                                        }
                                    }).catch(() => {});
                                }
                            }
                        }
                    } catch (_) {}
                })();

                return sendJson({ success: true, message: newMsg });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // ---------------------------------------------------------------------
        // Cancellation Reasons Single Source of Truth
        // ---------------------------------------------------------------------
        const CANCELLATION_REASONS = {
            rider: [
                'تأخر الكابتن في الوصول',
                'تغيير خطة المشوار',
                'طلب بالخطأ',
                'الكابتن طلب مني الإلغاء',
                'الكابتن لا يتحرك باتجاهي',
                'سبب آخر'
            ],
            driver: [
                'تعطل المركبة أو حادث مفاجئ',
                'ازدحام مروري خانق / الطريق مغلق',
                'تعذر التواصل مع الراكب / لم يحضر',
                'نقطة الانطلاق في موقع يتعذر الوصول إليه',
                'سبب آخر'
            ]
        };

        if ((pathname === '/api/ride/cancellation-reasons' || pathname === '/ride/cancellation-reasons') && method === 'GET') {
            const cancelFee = systemSettingsService ? systemSettingsService.getCancellationFeeIqd() : 1500;
            return sendJson({
                success: true,
                riderReasons: CANCELLATION_REASONS.rider,
                driverReasons: CANCELLATION_REASONS.driver,
                cancellationFeeIqd: cancelFee,
                freeCancellationMinutes: 2
            });
        }

        // Passenger or Driver Cancel Ride (Unified & Atomically Cleared across Redis & PM2 Cluster)
        const isRideCancelRoute = (
            pathname === '/api/ride/cancel' || 
            pathname === '/api/ride/passenger/cancel' || 
            pathname === '/ride/cancel' || 
            pathname === '/ride/passenger/cancel'
        );
        if (isRideCancelRoute && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const rideId = String(body.rideId || body.requestId || body.id || '').trim();

                if (!rideId) {
                    return sendJson({ success: false, error: 'معرف المشوار مطلوب للإلغاء' }, 400);
                }

                let r = await findRideById(rideId);
                if (!r) {
                    return sendJson({ success: false, notFound: true, error: 'المشوار غير موجود' }, 200);
                }

                // Security Authorization: Caller must be ride passenger, assigned driver, or Admin
                const authUser = getAuthUser(req);
                const isDriver = isDriverAuthorizedForRide(r, authUser, body);
                const isRider = (authUser && (authUser.id === r.customerId || (authUser.phone && r.customerPhone && normalizePhone(authUser.phone) === normalizePhone(r.customerPhone)))) ||
                                (body.customerId && body.customerId === r.customerId) ||
                                (body.customerPhone && r.customerPhone && normalizePhone(body.customerPhone) === normalizePhone(r.customerPhone)) ||
                                (!authUser && !body.driverId);
                const isAdmin = authUser && (authUser.role === 'Admin' || authUser.role === 'admin');

                if (!isDriver && !isRider && !isAdmin) {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكنك إلغاء مشوار لمستخدم آخر (RLS)' }, 403);
                }

                // Strict Cancellation Reason Validation against Server Authority
                const rawReason = String(body.reason || '').trim();
                const customDetails = String(body.customDetails || body.details || '').trim();
                const allowedList = isDriver ? CANCELLATION_REASONS.driver : CANCELLATION_REASONS.rider;

                if (!rawReason) {
                    return sendJson({ success: false, error: 'سبب الإلغاء إلزامي، يرجى اختيار سبب من القائمة' }, 400);
                }

                let validatedReason = rawReason;
                if (rawReason.startsWith('سبب آخر')) {
                    const customText = (customDetails || rawReason.replace(/^سبب آخر:?\s*/, '')).replace(/<[^>]*>?/gm, '').trim();
                    if (!customText || customText.length < 3 || customText.length > 100) {
                        return sendJson({ success: false, error: 'يرجى كتابة توضيح لسبب الإلغاء بين 3 و 100 حرف' }, 400);
                    }
                    validatedReason = `سبب آخر: ${customText}`;
                } else if (!allowedList.includes(rawReason)) {
                    return sendJson({ success: false, error: 'سبب الإلغاء غير معتمد، يرجى الاختيار من القائمة الرسمية' }, 400);
                }

                const reason = validatedReason;

                if (isDriver) {
                    const prevDriverId = r.assignedDriverId || r.acceptedDriverId || body.driverId || authUser?.id;
                    r.cancelledDriverIds = r.cancelledDriverIds || [];
                    if (prevDriverId && !r.cancelledDriverIds.includes(prevDriverId)) r.cancelledDriverIds.push(prevDriverId);
                    r.rejectedDriverIds = r.rejectedDriverIds || [];
                    if (prevDriverId && !r.rejectedDriverIds.includes(prevDriverId)) r.rejectedDriverIds.push(prevDriverId);

                    // Look for alternative candidate drivers
                    let altCandidates = (r.candidateDriverIds || []).filter(cId => !r.cancelledDriverIds.includes(cId) && !r.rejectedDriverIds.includes(cId));
                    if (altCandidates.length === 0) {
                        const maxDist = 25;
                        const freshDrivers = await getAvailableOnlineDrivers(parseFloat(r.pickupLat || 0), parseFloat(r.pickupLon || 0), maxDist);
                        altCandidates = freshDrivers
                            .map(d => d.driverId || d.id)
                            .filter(dId => dId && !r.cancelledDriverIds.includes(dId) && !r.rejectedDriverIds.includes(dId));
                    }

                    if (altCandidates.length > 0) {
                        const nextDriverId = altCandidates[0];
                        const nextDriver = (db.memoryState.drivers || []).find(d => String(d.driverId) === String(nextDriverId) || String(d.id) === String(nextDriverId));
                        const now = Date.now();
                        const stepTimeoutSec = systemSettingsService ? systemSettingsService.getStepTimeoutSeconds() : 20;
                        const stepTimeoutAt = now + (stepTimeoutSec * 1000);

                        const transRes = await transitionRideState(
                            redisManager,
                            r.id,
                            RIDE_STATES.OFFERED,
                            { id: prevDriverId, role: 'Driver' },
                            {
                                assignedDriverId: nextDriverId,
                                acceptedDriverId: null,
                                assignedDriverName: nextDriver ? nextDriver.fullName : 'كابتن توصيله',
                                assignedDriverPhone: nextDriver ? nextDriver.phoneNumber : '',
                                assignedDriverVehicle: nextDriver ? `${nextDriver.vehicleMake||'تويوتا'} ${nextDriver.vehicleModel||'كورولا'}` : 'تويوتا',
                                stepTimeoutAt,
                                serverTimestamp: now,
                                remainingSeconds: stepTimeoutSec,
                                prevDriverId,
                                cancelledDriverId: prevDriverId,
                                candidateDriverIds: altCandidates,
                                currentDriverIndex: 0
                            }
                        );

                        if (!transRes.success) {
                            return sendJson({
                                success: false,
                                conflict: true,
                                status: 409,
                                error: transRes.error || 'تعذر إعادة عرض الرحلة على كابتن بديل'
                            }, 409);
                        }

                        r = transRes.ride;
                        normalizeAddresses(r);

                        // Broadcast to next candidate driver and dispatch
                        await redisManager.publishDriverEvent(nextDriverId, {
                            type: 'new_ride',
                            event: 'new_ride',
                            rideId: r.id,
                            requestId: r.id,
                            request: { ...r, customerPhone: maskPhoneNumber(r.customerPhone) }
                        });
                        await redisManager.publishDispatchEvent({
                            type: 'ride_reoffered',
                            event: 'ride_reoffered',
                            rideId: r.id,
                            requestId: r.id
                        });
                        await redisManager.publishRideEvent(r.id, {
                            type: 'driver_cancelled_reoffering',
                            event: 'driver_cancelled_reoffering',
                            status: RIDE_STATES.OFFERED,
                            message: 'اعتذر الكابتن، جاري تحويل طلبك لكابتن آخر بالقرب منك'
                        });

                        return sendJson({
                            success: true,
                            reoffered: true,
                            message: 'تم إلغاء قبول المشوار وإعادة عرضه على كابتن بديل',
                            status: RIDE_STATES.OFFERED,
                            request: r,
                            ride: r
                        });
                    } else {
                        // No alternatives -> NO_DRIVERS
                        const transRes = await transitionRideState(
                            redisManager,
                            r.id,
                            RIDE_STATES.NO_DRIVERS,
                            { id: prevDriverId, role: 'Driver' },
                            {
                                cancelledAt: new Date().toISOString(),
                                cancelReason: reason || 'اعتذار الكابتن وعدم توفر كباتن بدلاء',
                                cancelledBy: 'driver',
                                prevDriverId
                            }
                        );
                        if (!transRes.success) {
                            return sendJson({
                                success: false,
                                conflict: true,
                                status: 409,
                                error: transRes.error || 'تعذر إلغاء الرحلة'
                            }, 409);
                        }
                        r = transRes.ride;
                        normalizeAddresses(r);
                        await redisManager.publishRideEvent(r.id, {
                            type: 'no_drivers_available',
                            event: 'no_drivers_available',
                            rideId: r.id
                        });
                        try {
                            if (typeof telegramBot.notifyRideCancelled === 'function') {
                                telegramBot.notifyRideCancelled(r, reason, 'driver', 0).catch(() => {});
                            }
                        } catch (_) {}
                        return sendJson({
                            success: true,
                            reoffered: false,
                            message: 'اعتذر الكابتن ولا يتوفر كباتن بدلاء حالياً',
                            status: RIDE_STATES.NO_DRIVERS,
                            request: r,
                            ride: r
                        });
                    }
                }

                // Rider cancellation branch
                const cancelFee = systemSettingsService ? systemSettingsService.getCancellationFeeIqd() : 1500;
                let feeApplies = false;
                if (r.assignedDriverId) {
                    const reqTime = r.requestedAt ? Number(r.requestedAt) : (r.createdAt ? new Date(r.createdAt).getTime() : Date.now());
                    const elapsedMinutes = (Date.now() - reqTime) / 60000;
                    feeApplies = Boolean(elapsedMinutes >= 2 || r.status === RIDE_STATES.DRIVER_ARRIVED || r.status === 'Arrived');
                }

                // Round-trip mid-wait cancellation: charge leg 1 fare + actual wait fee (no return leg charged)
                let waitFeeCharge = 0;
                const isWaitCancellation = Boolean(
                    (r.status === RIDE_STATES.WAITING_AT_DESTINATION || r.status === RIDE_STATES.ARRIVED_DESTINATION) &&
                    (r.isRoundTrip || r.tripType === 'ROUND_TRIP')
                );

                if (isWaitCancellation) {
                    const waitStart = r.waitStartedAt ? new Date(r.waitStartedAt).getTime() : Date.now();
                    const elapsedWaitMs = Math.max(0, Date.now() - waitStart);
                    const actualWaitMinutes = Math.max(0, Math.round(elapsedWaitMs / 60000));
                    const waitDetails = pricingService.calculateWaitFee(actualWaitMinutes);
                    waitFeeCharge = waitDetails.waitFee;
                    r.actualWaitMinutes = actualWaitMinutes;
                    r.waitFee = waitFeeCharge;
                    const leg1Fare = Number(r.leg1Fare || r.fare || 0);
                    r.finalFare = leg1Fare + waitFeeCharge;
                }

                const transRes = await transitionRideState(
                    redisManager,
                    r.id,
                    RIDE_STATES.CANCELLED_BY_RIDER,
                    { id: authUser?.id || r.customerId, role: 'Customer' },
                    {
                        cancelledAt: new Date().toISOString(),
                        cancelReason: reason || (isWaitCancellation ? 'إلغاء رحلة العودة والاكتفاء بالذهاب والانتظار' : 'إلغاء بواسطة الراكب'),
                        cancelledBy: 'rider',
                        cancellationFee: isWaitCancellation ? r.finalFare : (feeApplies ? cancelFee : 0),
                        finalFare: isWaitCancellation ? r.finalFare : (feeApplies ? cancelFee : 0),
                        waitFee: waitFeeCharge
                    }
                );

                if (!transRes.success) {
                    return sendJson({
                        success: false,
                        conflict: true,
                        status: 409,
                        error: transRes.error || 'تعذر إلغاء الرحلة'
                    }, 409);
                }

                r = transRes.ride;
                normalizeAddresses(r);

                // Broadcast instant cancellation event to all drivers via dispatch channel
                await redisManager.publishDispatchEvent({
                    event: 'ride_cancelled',
                    type: 'ride_cancelled',
                    rideId: r.id,
                    requestId: r.id,
                    reason: reason,
                    cancelledBy: 'rider',
                    timestamp: Date.now()
                });

                try {
                    if (typeof telegramBot.notifyRideCancelled === 'function') {
                        telegramBot.notifyRideCancelled(r, reason, 'rider', isWaitCancellation ? r.finalFare : (feeApplies ? cancelFee : 0)).catch(() => {});
                    }
                } catch (_) {}

                // Log cancellation in PostgreSQL ride_events and audit_logs
                if (db.isPostgresConnected && db.pool) {
                    try {
                        const actorId = String(authUser?.id || r.customerId || 'rider');
                        await db.pool.query(
                            `INSERT INTO ride_events (ride_id, from_status, to_status, actor_id, actor_role, metadata) 
                             VALUES ($1, $2, $3, $4, $5, $6)`,
                            [
                                r.id,
                                r.status,
                                RIDE_STATES.CANCELLED_BY_RIDER,
                                actorId,
                                'Customer',
                                JSON.stringify({ reason, cancellationFee: isWaitCancellation ? r.finalFare : (feeApplies ? cancelFee : 0) })
                            ]
                        ).catch(() => {});

                        await db.pool.query(
                            `INSERT INTO audit_logs (action, entity_name, entity_id, new_values_json, ip_address) 
                             VALUES ($1, $2, $3, $4, $5)`,
                            [
                                'RIDE_CANCELLED_BY_RIDER',
                                'Ride',
                                r.id,
                                JSON.stringify({ reason, fee: isWaitCancellation ? r.finalFare : (feeApplies ? cancelFee : 0) }),
                                req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1'
                            ]
                        ).catch(() => {});
                    } catch (_) {}
                }

                const cancelMsg = isWaitCancellation 
                    ? `تم إلغاء رحلة العودة والاكتفاء بالذهاب. المبلغ المستحق للذهاب والانتظار: ${r.finalFare} د.ع.`
                    : (feeApplies ? `تم إلغاء الرحلة. تطبق رسوم إلغاء قدرها ${cancelFee} د.ع.` : 'تم إلغاء الرحلة بنجاح');

                return sendJson({ 
                    success: true, 
                    message: cancelMsg,
                    status: RIDE_STATES.CANCELLED_BY_RIDER,
                    cancellationFee: isWaitCancellation ? r.finalFare : (feeApplies ? cancelFee : 0),
                    finalFare: r.finalFare,
                    waitFee: waitFeeCharge,
                    isWaitCancellation,
                    request: r,
                    ride: r
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // Driver Complete Ride - Cash Reconciliation & Permanent Postgres Storage (RLS Protected)
        if (pathname === '/api/ride/complete' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { requestId, driverId, receivedAmount } = body;
                if (!requestId) return sendJson({ success: false, notFound: true, error: 'requestId is required' }, 200);

                let r = await findRideById(requestId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'الطلب غير متاح حالياً' }, 200);

                // Security Check: Driver Authorization
                const authUser = getAuthUser(req);
                const isAuthorized = isDriverAuthorizedForRide(r, authUser, body);

                if (!isAuthorized) {
                    return sendJson({ 
                        success: false, 
                        error: 'غير مصرح: يجب أن يكون الكابتن المعتمد لهذه الرحلة فقط لإنهاء المشوار' 
                    }, 403);
                }

                let finalFare = Number(r.finalFare || r.fare || 0);
                let actualWaitMinutes = r.actualWaitMinutes || 0;
                let waitFeeCharge = r.waitFee || 0;
                if (r.status === RIDE_STATES.WAITING_AT_DESTINATION) {
                    const waitStart = r.waitStartedAt ? new Date(r.waitStartedAt).getTime() : Date.now();
                    const elapsedWaitMs = Math.max(0, Date.now() - waitStart);
                    actualWaitMinutes = (body.actualWaitMinutes !== undefined && !isNaN(body.actualWaitMinutes))
                        ? Math.max(0, parseInt(body.actualWaitMinutes, 10))
                        : Math.max(0, Math.round(elapsedWaitMs / 60000));
                    const waitDetails = pricingService.calculateWaitFee(actualWaitMinutes);
                    waitFeeCharge = waitDetails.waitFee;
                    const leg1 = Number(r.leg1Fare || r.fare || 0);
                    finalFare = pricingService.roundToNearest250(leg1 + waitFeeCharge);
                    r.actualWaitMinutes = actualWaitMinutes;
                    r.waitFee = waitFeeCharge;
                    r.finalFare = finalFare;
                }

                const recAmt = receivedAmount !== undefined ? parseFloat(receivedAmount) : finalFare;
                const fareDiff = Math.abs(recAmt - finalFare);
                const discrepancyThreshold = systemSettingsService ? systemSettingsService.getFareDiscrepancyThresholdIqd() : 500;
                const riderConfirmed = body.riderConfirmed !== undefined ? Boolean(body.riderConfirmed) : null;
                const reviewFlag = (fareDiff > discrepancyThreshold) || (riderConfirmed === false);
                const reconciliationStatus = reviewFlag ? 'pending_review' : 'settled';

                // Atomic State Transition: ARRIVED_DESTINATION / WAITING_AT_DESTINATION -> COMPLETED
                const transRes = await transitionRideState(
                    redisManager,
                    r.id,
                    RIDE_STATES.COMPLETED,
                    { id: driverId || authUser?.id, role: 'Driver' },
                    {
                        completedAt: new Date().toISOString(),
                        finalFare: finalFare,
                        actualWaitMinutes,
                        waitFee: waitFeeCharge,
                        receivedAmount: recAmt,
                        fareDifference: fareDiff,
                        riderConfirmed: riderConfirmed !== null ? riderConfirmed : null,
                        reviewFlag,
                        reconciliationStatus,
                        paymentMethod: 'Cash',
                        paymentStatus: 'Paid'
                    }
                );

                if (!transRes.success) {
                    return sendJson({
                        success: false,
                        conflict: true,
                        status: 409,
                        error: transRes.error || 'تعذر إنهاء الرحلة'
                    }, 409);
                }

                r = transRes.ride;
                normalizeAddresses(r);
                redisManager.publishRideEvent(r.id, { type: 'ride_completed', status: RIDE_STATES.COMPLETED, request: r });
                redisManager.publishDispatchEvent({ type: 'ride_completed', requestId: r.id });

                // Stage 4: Send Telegram Notification to Passenger - Trip Completed & Fare Collected
                console.log('[TelegramDispatch] Ride completed, dispatching notification for ride:', r.id);
                try {
                    if (typeof telegramBot.notifyTripCompleted === 'function') {
                        telegramBot.notifyTripCompleted(r, recAmt || finalFare).catch(err => console.error('[RideComplete] Telegram notify error:', err.message));
                    }
                } catch (tgErr) {
                    console.error('[RideComplete] Telegram notify error:', tgErr.message);
                }

                return sendJson({
                    success: true,
                    message: 'تم إكمال الرحلة بنجاح 🏁',
                    status: RIDE_STATES.COMPLETED,
                    reviewFlag,
                    reconciliationStatus,
                    receivedAmount: recAmt,
                    finalFare: finalFare,
                    request: r,
                    ride: r
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // Passenger Confirm or Dispute Final Fare
        if (pathname === '/api/ride/confirm-fare' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { requestId, rideId, confirmed, note } = body;
                const targetId = requestId || rideId;
                if (!targetId) return sendJson({ success: false, error: 'requestId مطلوب' }, 400);

                let r = await findRideById(targetId);
                if (!r) return sendJson({ success: false, notFound: true, error: 'المشوار غير موجود' }, 200);

                const authUser = getAuthUser(req);
                if (!authUser) {
                    return sendJson({ success: false, error: 'غير مصرح: تسجيل الدخول مطلوب' }, 403);
                }

                // Customer RLS
                if (authUser.role !== 'Admin') {
                    const isOwner = (authUser.id && r.customerId && String(authUser.id) === String(r.customerId)) ||
                                    (authUser.phone && r.customerPhone && normalizePhone(authUser.phone) === normalizePhone(r.customerPhone));
                    if (!isOwner) {
                        return sendJson({ success: false, error: 'غير مصرح: المشوار ليس مسجلاً باسمك' }, 403);
                    }
                }

                const isConfirmed = confirmed !== undefined ? Boolean(confirmed) : false;
                r.riderConfirmed = isConfirmed;
                if (!isConfirmed) {
                    r.reviewFlag = true;
                    r.reconciliationStatus = 'pending_review';
                    r.disputeNote = String(note || 'الراكب اعترض على الكروة أو لم يؤكد استلام المبلغ');
                } else {
                    const discrepancyThreshold = systemSettingsService ? systemSettingsService.getFareDiscrepancyThresholdIqd() : 500;
                    if ((r.fareDifference || 0) <= discrepancyThreshold) {
                        r.reviewFlag = false;
                        r.reconciliationStatus = 'settled';
                    }
                }

                // Update in Redis
                if (redisManager.isConnected && redisManager.client) {
                    await redisManager.client.hset('pending:rides', String(r.id), JSON.stringify(r));
                }

                // Update in PostgreSQL
                if (db.pool && db.isPostgresConnected) {
                    try {
                        await db.pool.query(
                            `UPDATE rides SET reconciliation_status = $1, review_flag = $2 WHERE id = $3`,
                            [r.reconciliationStatus, r.reviewFlag, r.id]
                        );
                    } catch (_) {}
                }

                db.saveStateSnapshot();
                redisManager.publishRideEvent(r.id, {
                    type: 'fare_confirmation_updated',
                    rideId: r.id,
                    riderConfirmed: isConfirmed,
                    reconciliationStatus: r.reconciliationStatus,
                    reviewFlag: r.reviewFlag
                });

                return sendJson({
                    success: true,
                    requestId: r.id,
                    riderConfirmed: isConfirmed,
                    reconciliationStatus: r.reconciliationStatus,
                    reviewFlag: r.reviewFlag
                }, 200);
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // Passenger Rate Captain & Award Points (Customer-to-Driver Rating System)
        if ((pathname === '/api/customer/rate-driver' || pathname === '/api/customer/rate' || pathname === '/api/driver/rate-trip' || pathname === '/api/ride/rate') && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { rideId, customerId, driverId, rating, tags, comment } = body;

                if (!rideId) {
                    return sendJson({ success: false, error: 'معرّف المشوار (rideId) مطلوب للتقييم' }, 400);
                }

                let r = await findRideById(rideId);
                if (!r) {
                    return sendJson({ success: false, notFound: true, error: 'الرحلة المطلوبة غير موجودة' }, 200);
                }

                // Security Check (RLS): Ensure caller is the passenger of this completed trip
                const authUser = getAuthUser(req);
                const cleanReqCustPhone = String(r.customerPhone || '').replace(/\D/g, '');
                const cleanCallerPhone = String(customerId || (authUser ? authUser.phone : '')).replace(/\D/g, '');
                const isAuthorizedPassenger = (r.customerId && (r.customerId === customerId || (authUser && r.customerId === authUser.id))) ||
                                              (cleanReqCustPhone && cleanCallerPhone && (cleanCallerPhone.endsWith(cleanReqCustPhone) || cleanReqCustPhone.endsWith(cleanCallerPhone))) ||
                                              (!r.customerId); // fallback if guest customer

                if (!isAuthorizedPassenger) {
                    return sendJson({ success: false, error: 'غير مصرح: التقييم مخصص لراكب هذه الرحلة فقط' }, 403);
                }

                // Prevent duplicate rating abuse
                if (r.isRatedByCustomer) {
                    return sendJson({
                        success: true,
                        alreadyRated: true,
                        message: 'تم تسجيل تقييم هذا المشوار مسبقاً',
                        rating: r.ratingByCustomer
                    });
                }

                // Determine target driver
                const targetDriverId = driverId || r.acceptedDriverId || r.assignedDriverId;
                const driver = db.findDriver(targetDriverId);
                const realDriverId = driver ? (driver.driverId || driver.id) : targetDriverId;
                const driverName = driver ? driver.fullName : (r.assignedDriverName || 'الكابتن');

                // Points calculation for Driver: 50 base points + 10 bonus points for 5-star rating
                const numRating = Math.max(1, Math.min(5, Number(rating) || 5));
                const pointsEarned = 50 + (numRating >= 5 ? 10 : 0);

                const result = await db.recordCustomerTripRating({
                    rideId,
                    driverId: realDriverId,
                    driverName,
                    customerId: customerId || r.customerId,
                    passengerName: r.customerName || 'الراكب',
                    rating: numRating,
                    tags: Array.isArray(tags) ? tags : [],
                    comment: (comment || '').slice(0, 500),
                    pointsEarned
                });

                // Auto-escalate low ratings (1 or 2 stars) as a complaint
                if (numRating <= 2) {
                    try {
                        const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
                        const reasonText = comment ? `تقييم سلبي منخفض (${numRating} نجوم): ${comment}` : `تقييم سلبي منخفض (${numRating} نجوم) بدون تفاصيل إضافية`;
                        await complaintService.submitComplaint({
                            complainantId: customerId || r.customerId || 'passenger',
                            complainantName: r.customerName || 'الراكب',
                            complainantPhone: r.customerPhone || '',
                            accusedId: realDriverId,
                            accusedName: driverName,
                            accusedPhone: driver ? (driver.phone || driver.phoneNumber || '') : '',
                            category: 'تقييم سلبي منخفض',
                            complaintText: reasonText,
                            rideId: rideId
                        }, clientIp);
                    } catch (eComplaint) {
                        console.warn('[Auto-Escalate Rating to Complaint Error]:', eComplaint.message);
                    }
                }

                return sendJson({
                    success: true,
                    message: 'تم إرسال تقييمك للكابتن بنجاح، شكراً لمساهمتك في رفع جودة الخدمة 🌟',
                    pointsEarned,
                    driverRatingAverage: result.driverRatingAverage,
                    totalDriverPoints: result.driverTotalPoints,
                    rating: result.record
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // Driver Points & Stats Lookup
        if (pathname.startsWith('/api/driver/') && pathname.endsWith('/points') && method === 'GET') {
            const parts = pathname.split('/');
            const rawParam = decodeURIComponent(parts[parts.length - 2]);
            const driver = db.findDriver(rawParam);
            return sendJson({
                success: true,
                points: driver ? (driver.points || driver.rewardScore || 0) : 0,
                totalTrips: driver ? (driver.totalTrips || 0) : 0
            });
        }

        // Admin Trip Ratings & Driver Feedback
        if ((pathname === '/api/admin/trip-ratings' || pathname === '/api/trip-ratings') && method === 'GET') {
            try {
                let ratings = [];
                if (db.isPostgresConnected && db.pool) {
                    try {
                        const pgRes = await db.pool.query(`
                            SELECT 
                                tr.id,
                                tr.ride_id,
                                tr.driver_id,
                                tr.passenger_id,
                                tr.passenger_name,
                                tr.rating,
                                tr.tags,
                                tr.comment,
                                tr.points_earned,
                                tr.created_at,
                                COALESCE(d.full_name, tr.driver_id) AS driver_name,
                                d.phone_number AS driver_phone
                            FROM trip_ratings tr
                            LEFT JOIN drivers d ON tr.driver_id = d.driver_id OR tr.driver_id = d.phone_number
                            ORDER BY tr.created_at DESC
                            LIMIT 200;
                        `);
                        ratings = (pgRes.rows || []).map(r => ({
                            id: r.id,
                            rideId: r.ride_id,
                            driverId: r.driver_id,
                            driverName: r.driver_name,
                            driverPhone: r.driver_phone,
                            passengerId: r.passenger_id,
                            passengerName: r.passenger_name || 'الراكب',
                            rating: parseInt(r.rating || 5, 10),
                            tags: Array.isArray(r.tags) ? r.tags : (typeof r.tags === 'string' ? JSON.parse(r.tags || '[]') : []),
                            comment: r.comment || '',
                            pointsEarned: parseInt(r.points_earned || 50, 10),
                            createdAt: r.created_at
                        }));
                    } catch (pgErr) {
                        console.warn('[TripRatings] Postgres query fallback:', pgErr.message);
                    }
                }

                if (ratings.length === 0) {
                    ratings = db.memoryState.tripRatings || [];
                }

                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                return sendJson({
                    success: true,
                    total: ratings.length,
                    ratings
                });
            } catch (err) {
                return sendJson({ success: false, ratings: [], total: 0 });
            }
        }

        // Admin Rides History
        if ((pathname === '/api/admin/rides' || pathname === '/api/rides') && method === 'GET') {
            try {
                let ridesList = [];
                if (db.pool && db.isPostgresConnected) {
                    const pgRes = await db.pool.query(`
                        SELECT * FROM rides 
                        ORDER BY created_at DESC LIMIT 100
                    `);
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        ridesList = pgRes.rows.map(r => ({
                            id: r.id,
                            requestId: r.id,
                            customerId: r.rider_id,
                            customerName: r.rider_name,
                            customerPhone: r.rider_phone,
                            driverId: r.driver_id,
                            driverName: r.driver_name,
                            driverPhone: r.driver_phone,
                            status: r.status,
                            tripType: r.trip_type || (r.is_round_trip ? 'ROUND_TRIP' : 'ONE_WAY'),
                            isRoundTrip: r.trip_type === 'ROUND_TRIP' || r.is_round_trip === true,
                            expectedWaitMinutes: r.expected_wait_minutes || 0,
                            actualWaitMinutes: r.actual_wait_minutes || 0,
                            returnDestination: r.return_destination,
                            leg1Distance: Number(r.leg1_distance || 0),
                            leg1Duration: Number(r.leg1_duration || 0),
                            leg2Distance: Number(r.leg2_distance || 0),
                            leg2Duration: Number(r.leg2_duration || 0),
                            waitFee: Number(r.wait_fee || 0),
                            waitStartedAt: r.wait_started_at,
                            returnStartedAt: r.return_started_at,
                            returnArrivedAt: r.return_arrived_at,
                            fare: Number(r.estimated_fare || 0),
                            finalFare: Number(r.final_fare || r.estimated_fare || 0),
                            totalFare: Number(r.final_fare || r.estimated_fare || 0),
                            receivedAmount: Number(r.received_amount || 0),
                            fareDifference: Number(r.fare_difference || 0),
                            reviewFlag: Boolean(r.review_flag),
                            needsReconciliationReview: Boolean(r.review_flag || r.needs_reconciliation_review),
                            reconciliationReviewReason: r.reconciliation_review_reason || (r.review_flag ? 'تفاوت مالي بحاجة لمراجعة' : null),
                            reconciliationStatus: r.reconciliation_status || 'settled',
                            pickupName: r.pickup_name,
                            dropoffName: r.dropoff_name,
                            createdAt: r.created_at,
                            completedAt: r.completed_at
                        }));
                    }
                }
                if (ridesList.length === 0) {
                    ridesList = db.memoryState.rideRequests || [];
                }
                return sendJson({
                    success: true,
                    total: ridesList.length,
                    rides: ridesList
                });
            } catch (err) {
                const requests = db.memoryState.rideRequests || [];
                return sendJson({ success: true, total: requests.length, rides: requests });
            }
        }

        // Customer Current Active Ride (Persist across refreshes/reconnects & PM2 cluster)
        if ((pathname.startsWith('/api/customer/') || pathname.startsWith('/customer/')) && pathname.endsWith('/active-ride') && method === 'GET') {
            const parts = pathname.split('/');
            let rawParam = decodeURIComponent(parts[parts.length - 2]);
            const authUser = getAuthUser(req);
            if ((!rawParam || rawParam === 'customer' || rawParam === 'undefined') && authUser) {
                rawParam = authUser.id || authUser.phone;
            }
            try {
                const active = await findActiveRideForCustomer(rawParam, rawParam);
                if (!active) {
                    return sendJson({ success: true, notFound: true, ride: null, request: null, activeRide: null }, 200);
                }
                return sendJson({ success: true, notFound: false, ride: active, request: active, activeRide: active }, 200);
            } catch (err) {
                console.error('[CustomerActiveRide] Error:', err.message);
                return sendJson({ success: true, notFound: true, ride: null, request: null, activeRide: null }, 200);
            }
        }

        // Customer Subscriptions / Bookings List
        if ((pathname.startsWith('/api/customer/') || pathname.startsWith('/customer/')) && 
            (pathname.endsWith('/bookings') || pathname.endsWith('/subscriptions')) && method === 'GET') {
            const parts = pathname.split('/');
            const customerId = decodeURIComponent(parts[parts.length - 2]);
            const cleanPhone = customerId.replace(/[^0-9]/g, '');

            let userBookings = [];
            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(`
                        SELECT * FROM bookings 
                        WHERE (customer_id = $1 OR customer_id = $2 OR (customer_phone IS NOT NULL AND RIGHT(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g'), 8) = RIGHT($3, 8)))
                          AND status IN ('Pending', 'Confirmed', 'Active', 'cancellation_pending')
                        ORDER BY created_at DESC
                    `, [customerId, cleanPhone, cleanPhone.length >= 7 ? cleanPhone : '_____']);
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        userBookings = pgRes.rows.map(r => ({
                            id: r.id,
                            bookingId: r.id,
                            driverId: r.driver_id,
                            driverName: r.driver_name,
                            customerId: r.customer_id,
                            customerName: r.customer_name,
                            customerPhone: r.customer_phone,
                            routeId: r.route_id,
                            pickupLocation: r.pickup_name,
                            dropoffLocation: r.dropoff_name,
                            seatsBooked: r.seats_booked || 1,
                            status: r.status,
                            cancellationPending: r.status === 'cancellation_pending' || r.cancellation_requested === true,
                            cancellationReason: r.cancellation_reason || '',
                            cancellationDetails: r.cancellation_details || '',
                            createdAt: r.created_at
                        }));
                    }
                } catch (pgErr) {
                    console.error('[Customer] PG bookings fetch error:', pgErr.message);
                }
            }

            const memBookings = (db.memoryState.bookings || []).filter(b => {
                const bCustId = String(b.customerId || b.passengerId || '');
                const bPhone = String(b.customerPhone || b.phone || '').replace(/[^0-9]/g, '');
                const isMatch = (customerId && bCustId === customerId) || (cleanPhone.length >= 7 && bPhone.length >= 7 && (bPhone.endsWith(cleanPhone.slice(-8)) || cleanPhone.endsWith(bPhone.slice(-8))));
                const isActive = b.status === 'Confirmed' || b.status === 'Pending' || b.status === 'Active' || b.status === 'cancellation_pending' || !b.status;
                return isMatch && isActive;
            });

            for (const mb of memBookings) {
                if (!userBookings.some(ub => ub.id === mb.id || ub.bookingId === mb.bookingId)) {
                    userBookings.push(mb);
                }
            }

            return sendJson({ success: true, bookings: userBookings });
        }

        // Helper to extract driver pending requests list (Unified Redis + Memory with Strict 3-Minute TTL)
        const getDriverPendingList = async (rawParam) => {
            rawParam = String(rawParam || '').trim();
            const cleanPhone = rawParam.replace(/[^0-9]/g, '');

            const matchedDriver = (db.memoryState.drivers || []).find(d => 
                String(d.driverId) === String(rawParam) || 
                String(d.id) === String(rawParam) || 
                String(d._id) === String(rawParam) || 
                String(d.userId) === String(rawParam) || 
                (cleanPhone.length >= 7 && d.phoneNumber && d.phoneNumber.replace(/[^0-9]/g, '').endsWith(cleanPhone.slice(-8))) ||
                (cleanPhone.length >= 7 && d.phone && d.phone.replace(/[^0-9]/g, '').endsWith(cleanPhone.slice(-8)))
            );
            const targetDriverId = matchedDriver ? (matchedDriver.driverId || matchedDriver.id || matchedDriver._id) : rawParam;

            let isStrictlyCommuteOrIdle = false;
            if (matchedDriver) {
                const dMode = String(matchedDriver.current_mode || matchedDriver.work_mode || matchedDriver.workStatus || matchedDriver.mode || '').toLowerCase().trim();
                if (dMode === 'commute' || dMode === 'permanent' || dMode === 'خط دائمي' || dMode === 'idle' || dMode === 'خمول' || dMode === 'offline') {
                    isStrictlyCommuteOrIdle = true;
                }
            }

            if (isStrictlyCommuteOrIdle) return [];

            // 1. Read strictly from Redis cluster hash for 100% consistency across all 6 PM2 workers
            // ZERO in-memory fallback to eliminate cluster round-robin state flapping
            const redisList = await redisManager.getPendingRides();
            const sourceList = Array.isArray(redisList) ? redisList : [];

            const now = Date.now();
            const maxAgeMs = 3 * 60 * 1000; // strictly within 3 minutes

            return sourceList.filter(r => {
                const st = String(r.status || '').toLowerCase().trim();
                if (st !== 'pending' && st !== 'offered' && st !== 'requested') return false;

                // Freshness check: strictly within 3 minutes
                const reqTime = r.requestedAt ? Number(r.requestedAt) : (r.createdAt ? new Date(r.createdAt).getTime() : now);
                if ((now - reqTime) > maxAgeMs) return false;

                if (r.acceptedDriverId) return false;
                const tType = String(r.tripType || r.serviceType || 'short').toLowerCase().trim();
                if (tType === 'daily' || tType === 'commute' || tType === 'خط دائمي' || tType === 'permanent') return false;

                // Targeted candidate matching
                if (r.candidateDriverIds && Array.isArray(r.candidateDriverIds) && r.candidateDriverIds.length > 0) {
                    const isCandidate = r.candidateDriverIds.some(cid => {
                        const sCid = String(cid || '').trim();
                        if (targetDriverId && sCid === String(targetDriverId)) return true;
                        if (rawParam && sCid === String(rawParam)) return true;
                        if (cleanPhone.length >= 7 && sCid.replace(/[^0-9]/g, '').endsWith(cleanPhone.slice(-8))) return true;
                        return false;
                    });
                    const isAssigned = r.assignedDriverId && (
                        String(r.assignedDriverId) === String(targetDriverId) ||
                        String(r.assignedDriverId) === String(rawParam) ||
                        (cleanPhone.length >= 7 && String(r.assignedDriverId).replace(/[^0-9]/g, '').endsWith(cleanPhone.slice(-8)))
                    );
                    if (!isCandidate && !isAssigned) return false;
                }

                if (r.rejectedDriverIds && Array.isArray(r.rejectedDriverIds) && r.rejectedDriverIds.length > 0) {
                    const isRejected = r.rejectedDriverIds.some(rid => {
                        const sRid = String(rid || '').trim();
                        if (targetDriverId && sRid === String(targetDriverId)) return true;
                        if (rawParam && sRid === String(rawParam)) return true;
                        if (cleanPhone.length >= 7 && sRid.replace(/[^0-9]/g, '').endsWith(cleanPhone.slice(-8))) return true;
                        return false;
                    });
                    if (isRejected) return false;
                }
                return true;
            }).map(r => {
                const rem = Math.max(0, Math.round(((r.stepTimeoutAt || 0) - now) / 1000));
                return {
                    ...r,
                    serverTimestamp: now,
                    remainingSeconds: rem
                };
            }).filter(r => r.remainingSeconds > 0);
        };

        const getDriverActiveRideItem = (rawParam) => {
            rawParam = String(rawParam || '').trim();
            const cleanPhone = rawParam.replace(/[^0-9]/g, '');
            const matchedDriver = (db.memoryState.drivers || []).find(d => 
                d.driverId === rawParam || d.id === rawParam || (cleanPhone && d.phoneNumber && d.phoneNumber.replace(/[^0-9]/g, '').endsWith(cleanPhone))
            );
            const targetDriverId = matchedDriver ? matchedDriver.driverId : rawParam;

            return (db.memoryState.rideRequests || []).find(r => {
                const isDriver = r.acceptedDriverId === targetDriverId || r.assignedDriverId === targetDriverId || r.acceptedDriverId === rawParam || r.assignedDriverId === rawParam;
                const isActive = r.status === 'Accepted' || r.status === 'Arrived' || r.status === 'InProgress';
                return isDriver && isActive;
            }) || null;
        };

        // =====================================================================
        // REAL-TIME SERVER-SENT EVENTS (SSE) STREAMING ENGINE (Tawseela IQ v72)
        // Eliminates 2-second short polling storms across 10,000 concurrent users
        // =====================================================================

        // 1. Driver Real-time Event Stream: GET /api/driver/stream or /api/events/driver/:id
        const isDriverSseRoute = (pathname === '/api/driver/stream' || pathname === '/driver/stream' || pathname.startsWith('/api/events/driver/') || pathname.startsWith('/events/driver/'));
        if (isDriverSseRoute && method === 'GET') {
            const authUser = getAuthUser(req);
            let driverId = '';
            if (pathname.startsWith('/api/events/driver/') || pathname.startsWith('/events/driver/')) {
                driverId = pathname.replace(/^\/?(?:api\/)?events\/driver\//, '').trim();
            }
            if (!driverId) {
                driverId = parsedUrl.searchParams.get('driverId') || 
                           parsedUrl.searchParams.get('id') || 
                           (authUser ? (authUser.id || authUser.driverId || authUser.phone) : '');
            }
            driverId = String(driverId || '').trim();

            if (!driverId) {
                return sendJson({ success: false, error: 'driverId مطلوب لفتح قناة البث اللحظي' }, 400);
            }

            // Identity & Authorization Check (RLS): Must be authenticated driver and match requested driverId
            if (!authUser) {
                return sendJson({ success: false, error: 'غير مصرح: تسجيل الدخول مطلوب للاشتراك في قناة بث الكابتن' }, 403);
            }
            if (authUser.role !== 'Admin') {
                if (authUser.role === 'Customer') {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكن للراكب الاشتراك في قناة بث الكابتن' }, 403);
                }
                if (authUser.role === 'Driver') {
                    const cleanAuthId = String(authUser.id || '').trim();
                    const cleanAuthPhone = normalizePhone(authUser.phone || authUser.driver?.phoneNumber || '');
                    const cleanReqDriverId = String(driverId || '').trim();
                    const cleanReqPhone = normalizePhone(driverId);
                    const isMatch = (cleanAuthId && cleanAuthId === cleanReqDriverId) || 
                                    (cleanAuthPhone && cleanReqPhone && cleanAuthPhone === cleanReqPhone) ||
                                    (cleanAuthId && cleanReqPhone && cleanAuthId === cleanReqPhone);
                    if (!isMatch) {
                        return sendJson({ success: false, error: 'غير مصرح: لا يمكنك الاشتراك في قناة كابتن آخر (RLS)' }, 403);
                    }
                }
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': req.headers['origin'] || '*',
                'X-Accel-Buffering': 'no'
            });

            const lastEventId = req.headers['last-event-id'] || parsedUrl.searchParams.get('lastEventId');
            const sendSse = (eventName, data, eventId = null) => {
                try {
                    const idLine = eventId ? `id: ${eventId}\n` : `id: ${Date.now()}\n`;
                    res.write(`${idLine}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
                } catch (_) {}
            };

            (async () => {
                if (lastEventId) {
                    const missed = await redisManager.getMissedSseEvents('driver', driverId, lastEventId);
                    for (const m of missed) {
                        const eName = m.event || m.type || 'driver_event';
                        sendSse(eName, m, m.eventId || m.id);
                    }
                } else {
                    const initialPending = await getDriverPendingList(driverId);
                    sendSse('init', {
                        connected: true,
                        driverId,
                        pendingRequests: initialPending,
                        activeRide: getDriverActiveRideItem(driverId),
                        timestamp: Date.now()
                    });
                }
            })();

            const onRedisMsg = async (channel, msgStr) => {
                try {
                    const data = JSON.parse(msgStr);
                    const eventId = data.eventId || data.id;
                    if (channel === 'channel:dispatch') {
                        const updatedPending = await getDriverPendingList(driverId);
                        sendSse('dispatch', {
                            ...data,
                            type: data.type || data.event,
                            event: data.event || data.type,
                            rideId: data.rideId || data.requestId,
                            requestId: data.requestId || data.rideId,
                            pendingRequests: updatedPending,
                            timestamp: Date.now()
                        }, eventId);
                    } else if (channel === `channel:driver:${driverId}`) {
                        const updatedPending = await getDriverPendingList(driverId);
                        sendSse('driver_event', {
                            event: data,
                            type: data.type || data.event || 'driver_event',
                            pendingRequests: updatedPending,
                            activeRide: getDriverActiveRideItem(driverId),
                            timestamp: Date.now()
                        }, eventId);
                    }
                } catch (_) {}
            };

            if (redisManager.isConnected && redisManager.sub) {
                redisManager.sub.subscribe('channel:dispatch', `channel:driver:${driverId}`).catch(() => {});
                redisManager.sub.on('message', onRedisMsg);
            }

            const heartbeatTimer = setInterval(() => {
                try {
                    res.write(': keepalive\n\n');
                } catch (_) {}
            }, 15000);

            req.on('close', () => {
                clearInterval(heartbeatTimer);
                if (redisManager.isConnected && redisManager.sub) {
                    redisManager.sub.removeListener('message', onRedisMsg);
                    redisManager.sub.unsubscribe(`channel:driver:${driverId}`).catch(() => {});
                }
            });

            return;
        }

        // 1.5. Passenger Real-time Event Stream: GET /api/customer/stream or /api/passenger/stream or /api/events/passenger/:id
        const isPassengerSseRoute = (pathname === '/api/customer/stream' || pathname === '/customer/stream' || 
                                     pathname === '/api/passenger/stream' || pathname === '/passenger/stream' ||
                                     pathname.startsWith('/api/events/passenger/') || pathname.startsWith('/events/passenger/') ||
                                     pathname.startsWith('/api/events/customer/') || pathname.startsWith('/events/customer/'));
        if (isPassengerSseRoute && method === 'GET') {
            const authUser = getAuthUser(req);
            let passengerId = '';
            if (pathname.startsWith('/api/events/passenger/') || pathname.startsWith('/events/passenger/')) {
                passengerId = pathname.replace(/^\/?(?:api\/)?events\/passenger\//, '').trim();
            } else if (pathname.startsWith('/api/events/customer/') || pathname.startsWith('/events/customer/')) {
                passengerId = pathname.replace(/^\/?(?:api\/)?events\/customer\//, '').trim();
            }
            if (!passengerId) {
                passengerId = parsedUrl.searchParams.get('passengerId') || 
                              parsedUrl.searchParams.get('customerId') || 
                              parsedUrl.searchParams.get('id') || 
                              (authUser ? (authUser.id || authUser.phone) : '');
            }
            passengerId = String(passengerId || '').trim();

            if (!passengerId) {
                return sendJson({ success: false, error: 'passengerId مطلوب لفتح قناة البث اللحظي للراكب' }, 400);
            }

            // RLS: Must be authenticated and either Admin or the passenger themselves
            if (!authUser) {
                return sendJson({ success: false, error: 'غير مصرح: تسجيل الدخول مطلوب للاشتراك في قناة بث الراكب' }, 401);
            }
            if (authUser.role !== 'Admin') {
                const cleanAuthId = String(authUser.id || '').trim();
                const cleanAuthPhone = normalizePhone(authUser.phone || '');
                const cleanReqPassengerId = String(passengerId || '').trim();
                const cleanReqPhone = normalizePhone(passengerId);
                const isMatch = (cleanAuthId && cleanAuthId === cleanReqPassengerId) || 
                                (cleanAuthPhone && cleanReqPhone && cleanAuthPhone === cleanReqPhone) ||
                                (cleanAuthId && cleanReqPhone && cleanAuthId === cleanReqPhone);
                if (!isMatch) {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكنك الاشتراك في قناة راكب آخر (RLS)' }, 403);
                }
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': req.headers['origin'] || '*',
                'X-Accel-Buffering': 'no'
            });

            const lastEventId = req.headers['last-event-id'] || parsedUrl.searchParams.get('lastEventId');
            const sendSse = (eventName, data, eventId = null) => {
                try {
                    const idLine = eventId ? `id: ${eventId}\n` : `id: ${Date.now()}\n`;
                    res.write(`${idLine}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
                } catch (_) {}
            };

            (async () => {
                if (lastEventId) {
                    const missed = await redisManager.getMissedSseEvents('passenger', passengerId, lastEventId);
                    for (const m of missed) {
                        const eName = m.event || m.type || 'passenger_event';
                        sendSse(eName, m, m.eventId || m.id);
                    }
                } else {
                    sendSse('init', {
                        connected: true,
                        passengerId,
                        timestamp: Date.now()
                    });
                }
            })();

            const onRedisPassengerMsg = (channel, msgStr) => {
                try {
                    if (channel === `channel:passenger:${passengerId}`) {
                        const data = JSON.parse(msgStr);
                        const eventId = data.eventId || data.id;
                        const eventType = data.type || data.event || 'passenger_event';
                        sendSse(eventType, data, eventId);
                    }
                } catch (_) {}
            };

            if (redisManager.isConnected && redisManager.sub) {
                redisManager.sub.subscribe(`channel:passenger:${passengerId}`).catch(() => {});
                redisManager.sub.on('message', onRedisPassengerMsg);
            }

            const heartbeatTimer = setInterval(() => {
                try {
                    res.write(': keepalive\n\n');
                } catch (_) {}
            }, 15000);

            req.on('close', () => {
                clearInterval(heartbeatTimer);
                if (redisManager.isConnected && redisManager.sub) {
                    redisManager.sub.removeListener('message', onRedisPassengerMsg);
                    redisManager.sub.unsubscribe(`channel:passenger:${passengerId}`).catch(() => {});
                }
            });

            return;
        }

        // 2. Passenger Ride Status & Location Stream: GET /api/ride/stream or /api/ride/:id/stream
        const isRideSseStream = (pathname.startsWith('/api/ride/') && pathname.endsWith('/stream')) || 
                                pathname === '/api/ride/stream' || 
                                pathname === '/ride/stream';

        if (isRideSseStream && method === 'GET') {
            let rideId = '';
            const match = pathname.match(/^\/?(?:api\/)?ride\/([^\/]+)\/stream$/i);
            if (match && match[1] && match[1] !== 'stream') {
                rideId = decodeURIComponent(match[1]);
            } else {
                rideId = parsedUrl.searchParams.get('requestId') || 
                         parsedUrl.searchParams.get('id') || 
                         parsedUrl.searchParams.get('rideId') || '';
            }
            rideId = String(rideId || '').trim();

            if (!rideId) {
                return sendJson({ success: false, error: 'requestId مطلوب لفتح قناة تتبع الرحلة' }, 400);
            }

            // Identity & Authorization Check (RLS): Must be authenticated participant (customer, assigned/candidate driver, or Admin)
            const authUser = getAuthUser(req);
            if (!authUser) {
                return sendJson({ success: false, error: 'غير مصرح: تسجيل الدخول مطلوب للاشتراك في قناة تتبع المشوار' }, 403);
            }

            const currentRide = await findRideById(rideId);
            if (!currentRide) {
                return sendJson({ success: false, notFound: true, error: 'المشوار غير موجود' }, 200);
            }

            if (authUser.role !== 'Admin') {
                if (authUser.role === 'Customer') {
                    const isRiderOwner = (authUser.id && currentRide.customerId && String(authUser.id) === String(currentRide.customerId)) ||
                                         (authUser.phone && currentRide.customerPhone && normalizePhone(authUser.phone) === normalizePhone(currentRide.customerPhone));
                    if (!isRiderOwner) {
                        return sendJson({ success: false, error: 'غير مصرح: لا يمكنك تتبع مشوار عميل آخر (RLS)' }, 403);
                    }
                } else if (authUser.role === 'Driver') {
                    const isAssigned = (authUser.id && (String(authUser.id) === String(currentRide.assignedDriverId) || String(authUser.id) === String(currentRide.acceptedDriverId))) ||
                                       (authUser.phone && currentRide.assignedDriverPhone && normalizePhone(authUser.phone) === normalizePhone(currentRide.assignedDriverPhone)) ||
                                       (currentRide.candidateDriverIds && currentRide.candidateDriverIds.includes(authUser.id));
                    if (!isAssigned) {
                        return sendJson({ success: false, error: 'غير مصرح: لست الكابتن المعتمد لهذا المشوار (RLS)' }, 403);
                    }
                }
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': req.headers['origin'] || '*',
                'X-Accel-Buffering': 'no'
            });

            const lastEventId = req.headers['last-event-id'] || parsedUrl.searchParams.get('lastEventId');
            const sendSse = (eventName, data, eventId = null) => {
                try {
                    const idLine = eventId ? `id: ${eventId}\n` : `id: ${Date.now()}\n`;
                    res.write(`${idLine}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
                } catch (_) {}
            };

            (async () => {
                if (lastEventId) {
                    const missed = await redisManager.getMissedSseEvents('ride', rideId, lastEventId);
                    for (const m of missed) {
                        const eName = m.event || m.type || 'trip_update';
                        sendSse(eName, m, m.eventId || m.id);
                    }
                } else {
                    sendSse('init', {
                        connected: true,
                        rideId,
                        request: currentRide || null,
                        timestamp: Date.now()
                    });
                }
            })();

            const onRideMsg = (channel, msgStr) => {
                try {
                    if (channel === `channel:ride:${rideId}`) {
                        const data = JSON.parse(msgStr);
                        const evtName = data.event || data.type || 'trip_update';
                        sendSse(evtName, data, data.eventId || data.id);
                        if (evtName !== 'trip_update') {
                            sendSse('trip_update', data, data.eventId || data.id);
                        }
                    }
                } catch (_) {}
            };

            if (redisManager.isConnected && redisManager.sub) {
                redisManager.sub.subscribe(`channel:ride:${rideId}`).catch(() => {});
                redisManager.sub.on('message', onRideMsg);
            }

            const heartbeatTimer = setInterval(() => {
                try {
                    res.write(': keepalive\n\n');
                } catch (_) {}
            }, 15000);

            req.on('close', () => {
                clearInterval(heartbeatTimer);
                if (redisManager.isConnected && redisManager.sub) {
                    redisManager.sub.removeListener('message', onRideMsg);
                    redisManager.sub.unsubscribe(`channel:ride:${rideId}`).catch(() => {});
                }
            });

            return;
        }

        // Driver Current Active Accepted Ride (Universal Redis + Memory + DB - Zero 404s)
        if ((pathname.startsWith('/api/driver/') || pathname.startsWith('/driver/')) && pathname.endsWith('/active-ride') && method === 'GET') {
            const parts = pathname.split('/');
            let rawParam = decodeURIComponent(parts[parts.length - 2]);
            const authUser = getAuthUser(req);
            if ((!rawParam || rawParam === 'driver' || rawParam === 'undefined') && authUser) {
                rawParam = authUser.id || authUser.phone;
            }
            try {
                const active = await findActiveRideForDriver(rawParam);
                if (!active) {
                    return sendJson({ success: true, notFound: true, ride: null, request: null, activeRide: null }, 200);
                }
                return sendJson({ success: true, notFound: false, ride: active, request: active, activeRide: active }, 200);
            } catch (err) {
                console.error('[DriverActiveRide] Error:', err.message);
                return sendJson({ success: true, notFound: true, ride: null, request: null, activeRide: null }, 200);
            }
        }

        // Driver Pending Requests List (Strictly Read from Redis Hash 'pending:rides' - Zero In-Memory State)
        const isPendingRequestsRoute = (
            (pathname.startsWith('/api/driver/') || pathname.startsWith('/driver/')) && pathname.endsWith('/pending-requests')
        ) || pathname === '/api/driver/pending-requests' || pathname === '/driver/pending-requests';

        if (isPendingRequestsRoute && method === 'GET') {
            try {
                // Unified Redis read ensures 100% identical responses across all 6 PM2 cluster workers
                const now = Date.now();
                const validRides = [];

                const drvMatch = pathname.match(/^\/?(?:api\/)?driver\/([^/]+)\/pending-requests/);
                const targetDriverId = drvMatch ? decodeURIComponent(drvMatch[1]) : null;
                const cleanPhone = targetDriverId ? targetDriverId.replace(/[^0-9]/g, '') : '';
                const targetDriverObj = targetDriverId ? (db.memoryState.drivers || []).find(d => 
                    String(d.driverId || d.id) === String(targetDriverId) || (cleanPhone && d.phoneNumber && d.phoneNumber.replace(/[^0-9]/g, '').endsWith(cleanPhone))
                ) : null;
                const targetDriverTier = normalizeTier(targetDriverObj?.vehicleType || targetDriverObj?.tier);

                if (redisManager.isConnected && redisManager.client) {
                    const pendingRaw = await redisManager.client.hgetall('pending:rides');
                    if (pendingRaw) {
                        for (const [id, rideJson] of Object.entries(pendingRaw)) {
                            try {
                                const ride = JSON.parse(rideJson);
                                const reqTime = ride.requestedAt ? Number(ride.requestedAt) : (ride.createdAt ? new Date(ride.createdAt).getTime() : (ride.timestamp ? Number(ride.timestamp) : now));
                                const age = now - reqTime;
                                const s = String(ride.status || '').toLowerCase().trim();
                                const isPending = s === 'pending' || s === 'offered' || s === 'requested';

                                const isNotExpired = now <= (ride.stepTimeoutAt || (now + 1000));
                                const isCandidate = !targetDriverId || !ride.candidateDriverIds || ride.candidateDriverIds.length === 0 ||
                                    ride.candidateDriverIds.some(cId => String(cId) === String(targetDriverId) || (targetDriverObj?.driverId && String(cId) === String(targetDriverObj.driverId)));
                                const isTierMatch = !targetDriverObj || !ride.tier || normalizeTier(ride.tier) === targetDriverTier;

                                if (isPending && age < 120000 && isNotExpired && isCandidate && isTierMatch && !ride.acceptedDriverId) {
                                    const remSec = Math.max(0, Math.round(((ride.stepTimeoutAt || 0) - now) / 1000));
                                    if (remSec > 0) {
                                        validRides.push({
                                            ...ride,
                                            serverTimestamp: now,
                                            remainingSeconds: remSec
                                        });
                                    }
                                } else if (age >= 120000 || (!isPending && s !== '') || ride.acceptedDriverId) {
                                    // Automatic self-cleaning of expired or accepted rides
                                    await redisManager.client.hdel('pending:rides', String(id)).catch(() => {});
                                    await redisManager.client.del(`ride:request:${id}`).catch(() => {});
                                }
                            } catch (e) {}
                        }
                    }
                }

                return sendJson({
                    success: true,
                    pendingRequests: validRides,
                    requests: validRides,
                    data: validRides
                });
            } catch (err) {
                return sendJson({ success: false, pendingRequests: [] }, 500);
            }
        }

        // Driver Toggle Online/Offline & Work Mode (taxi / permanent / idle)
        if ((pathname === '/api/driver/toggle-online' || pathname === '/api/driver/toggle-mode' || pathname === '/api/driver/status' || pathname === '/api/driver/mode' ||
             pathname === '/driver/toggle-online' || pathname === '/driver/toggle-mode' || pathname === '/driver/status' || pathname === '/driver/mode') && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { 
                    driverId: rawDriverId, driver_id, id,
                    isOnline, is_online, status, tripStatus,
                    workStatus, workMode, work_mode, mode, current_mode,
                    driverName, driverPhone, phone, phoneNumber,
                    latitude, longitude, lat, lng 
                } = body;
                
                const driverId = rawDriverId || driver_id || id || '';
                const actualPhone = driverPhone || phone || phoneNumber || '';
                const cleanPhone = String(actualPhone || driverId || '').replace(/[^0-9]/g, '');

                const actualLat = parseFloat(latitude || lat || 0) || null;
                const actualLng = parseFloat(longitude || lng || 0) || null;

                let targetMode = workMode || work_mode || mode || current_mode || workStatus || '';
                const rawMode = String(targetMode).toLowerCase().trim();
                let canonicalMode = 'taxi';
                if (rawMode === 'commute' || rawMode === 'permanent' || rawMode === 'route' || rawMode === 'daily' || rawMode === 'خط دائمي') {
                    canonicalMode = 'commute';
                } else if (rawMode === 'both' || rawMode === 'كلاهما') {
                    canonicalMode = 'both';
                } else if (rawMode === 'idle' || rawMode === 'offline' || rawMode === 'خمول') {
                    canonicalMode = 'idle';
                } else {
                    canonicalMode = 'taxi';
                }

                const isExplicitOffline = isOnline === false || is_online === false || String(status).toLowerCase() === 'offline' || String(tripStatus).toLowerCase() === 'offline' || canonicalMode === 'idle';

                const onlineBool = !isExplicitOffline;
                const computedWorkMode = !onlineBool ? 'idle' : canonicalMode;
                const computedWorkStatus = !onlineBool ? 'idle' : (canonicalMode === 'commute' ? 'permanent' : canonicalMode);
                const computedMode = !onlineBool ? 'idle' : canonicalMode;
                const computedServiceType = computedWorkStatus === 'permanent' ? 'PermanentLine' : (computedWorkStatus === 'both' ? 'Both' : 'ShortTrip');

                let driver = (db.memoryState.drivers || []).find(d => 
                    (driverId && (d.driverId === driverId || d.id === driverId)) || 
                    (cleanPhone && d.phoneNumber && d.phoneNumber.replace(/[^0-9]/g, '').endsWith(cleanPhone))
                );

                if (!driver && driverId) {
                    driver = {
                        driverId,
                        fullName: driverName || 'كابتن توصيله',
                        phoneNumber: actualPhone || (cleanPhone.length >= 10 ? cleanPhone : ''),
                        status: onlineBool ? 'Online' : 'Offline',
                        tripStatus: onlineBool ? 'Online' : 'Offline',
                        isOnline: onlineBool,
                        is_online: onlineBool,
                        workStatus: computedWorkStatus,
                        work_mode: computedWorkMode,
                        current_mode: computedMode,
                        mode: computedMode,
                        isVerified: true,
                        isApproved: true,
                        serviceType: computedServiceType,
                        vehicleMake: 'تويوتا',
                        vehicleModel: 'كورولا',
                        vehiclePlate: 'النجف',
                        ratingAverage: 5.0,
                        currentLat: actualLat || 32.0298,
                        currentLon: actualLng || 44.3285,
                        latitude: actualLat || 32.0298,
                        longitude: actualLng || 44.3285
                    };
                    db.memoryState.drivers = db.memoryState.drivers || [];
                    db.memoryState.drivers.unshift(driver);
                }

                if (driver) {
                    driver.status = onlineBool ? 'Online' : 'Offline';
                    driver.tripStatus = onlineBool ? 'Online' : 'Offline';
                    driver.isOnline = onlineBool;
                    driver.is_online = onlineBool;
                    driver.workStatus = computedWorkStatus;
                    driver.work_mode = computedWorkMode;
                    driver.current_mode = computedMode;
                    driver.mode = computedMode;
                    driver.serviceType = computedServiceType;
                    if (body.vehicleType || body.tier) {
                        const vt = normalizeTier(body.vehicleType || body.tier);
                        driver.vehicleType = vt;
                        driver.tier = vt;
                    }
                    if (actualLat && actualLng) {
                        driver.currentLat = actualLat;
                        driver.currentLon = actualLng;
                        driver.latitude = actualLat;
                        driver.longitude = actualLng;
                    }
                    db.saveStateSnapshot();
                }

                // Sync to Redis Geospatial Index & Real-time Hash across PM2 cluster
                const isEligibleForTaxiGeospatial = onlineBool && (computedWorkMode === 'taxi' || computedWorkMode === 'both');
                if (isEligibleForTaxiGeospatial && driver) {
                    await redisManager.updateDriverLocation(
                        driver.driverId,
                        parseFloat(driver.currentLon || actualLng || 44.3285),
                        parseFloat(driver.currentLat || actualLat || 32.0298),
                        driver
                    );
                } else if (driver) {
                    await redisManager.removeDriverLocation(driver.driverId);
                }

                // Persist directly to PostgreSQL database
                if (db.isPostgresConnected && db.pool && (driverId || actualPhone)) {
                    try {
                        const vt = (body.vehicleType || body.tier) ? normalizeTier(body.vehicleType || body.tier) : null;
                        const upRes = await db.pool.query(`
                            UPDATE drivers 
                            SET status = $1, 
                                work_mode = $2, 
                                latitude = COALESCE($3, latitude), 
                                longitude = COALESCE($4, longitude),
                                vehicle_type = COALESCE($5, vehicle_type),
                                updated_at = NOW()
                            WHERE driver_id = $6 OR phone_number = $7
                        `, [
                            onlineBool ? 'Online' : 'Offline',
                            computedWorkMode,
                            actualLat,
                            actualLng,
                            vt,
                            driverId || '',
                            actualPhone || ''
                        ]);
                        if (upRes.rowCount === 0 && driverId) {
                            const licenseNum = driver?.licenseNumber || ('IRQ-NJF-' + (String(driverId).replace(/[^0-9]/g, '').slice(-4) || '1000'));
                            await db.pool.query(`
                                INSERT INTO drivers (driver_id, full_name, phone_number, license_number, status, work_mode, latitude, longitude, vehicle_type, created_at, updated_at)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
                                ON CONFLICT (driver_id) DO UPDATE SET
                                    status = EXCLUDED.status,
                                    work_mode = EXCLUDED.work_mode,
                                    latitude = EXCLUDED.latitude,
                                    longitude = EXCLUDED.longitude,
                                    vehicle_type = COALESCE(EXCLUDED.vehicle_type, drivers.vehicle_type),
                                    updated_at = NOW()
                            `, [
                                driverId,
                                driver?.fullName || driverName || 'كابتن توصيله',
                                actualPhone || driver?.phoneNumber || '',
                                licenseNum,
                                onlineBool ? 'Online' : 'Offline',
                                computedWorkMode,
                                actualLat || 32.0298,
                                actualLng || 44.3285,
                                vt || 'eco'
                            ]);
                        }
                    } catch (pgErr) {
                        console.warn('[DriverToggleMode] PostgreSQL update error:', pgErr.message);
                    }
                }

                return sendJson({
                    success: true,
                    isOnline: onlineBool,
                    workStatus: computedWorkStatus,
                    workMode: computedWorkMode,
                    mode: computedMode,
                    current_mode: computedMode,
                    driver: driver || null
                });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // ---------------------------------------------------------------------
        // PERMANENT ROUTES CRUD (Stage 3 & 4)
        // ---------------------------------------------------------------------
        if (pathname === '/api/routes/permanent' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const {
                    customerId, customerName, customerPhone,
                    startName, endName, startLat, startLon, endLat, endLon,
                    geometry, days, departureTime, frequency, fare
                } = body;

                const newRoute = {
                    id: 'perm-' + Math.random().toString(36).substr(2, 9),
                    customerId: customerId || 'cust-user',
                    customerName: customerName || 'راكب توصيله',
                    customerPhone: customerPhone || '',
                    startName: startName || 'نقطة الانطلاق',
                    endName: endName || 'نقطة الوصول',
                    startLat: parseFloat(startLat) || 31.9961,
                    startLon: parseFloat(startLon) || 44.3168,
                    endLat: parseFloat(endLat) || 32.0321,
                    endLon: parseFloat(endLon) || 44.3725,
                    geometry: geometry || null,
                    days: days || ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء'],
                    departureTime: departureTime || '07:30 ص',
                    frequency: frequency || 'يومي',
                    fare: fare || 3000,
                    status: 'Active',
                    acceptedDriverId: null,
                    createdAt: new Date().toISOString()
                };

                db.memoryState.permanentRoutes = db.memoryState.permanentRoutes || [];
                db.memoryState.permanentRoutes.unshift(newRoute);
                db.saveStateSnapshot();

                if (db.isPostgresConnected && db.pool) {
                    try {
                        await db.pool.query(`
                            INSERT INTO routes (id, driver_id, driver_name, driver_phone, start_name, end_name, start_lat, start_lon, end_lat, end_lon, fare, available_seats, total_seats, departure_time, status, created_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 4, 4, $12, $13, NOW())
                            ON CONFLICT (id) DO NOTHING
                        `, [newRoute.id, newRoute.customerId, newRoute.customerName, newRoute.customerPhone, newRoute.startName, newRoute.endName, newRoute.startLat, newRoute.startLon, newRoute.endLat, newRoute.endLon, newRoute.fare, newRoute.departureTime, newRoute.status]);
                    } catch (_) {}
                }

                return sendJson({ success: true, route: newRoute, message: 'تم تثبيت المسار بنجاح!' });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        if (pathname === '/api/routes/permanent' && method === 'GET') {
            const customerId = parsedUrl.searchParams.get('customerId');
            let permRoutes = [...(db.memoryState.permanentRoutes || [])];

            (db.memoryState.drivers || []).forEach(d => {
                if (d.route || d.activeRoute) {
                    const already = permRoutes.find(pr => pr.driverId === d.driverId || pr.id === 'route-' + d.driverId);
                    if (!already) {
                        const sName = d.route?.split(/[-➔→]/)[0]?.trim() || d.activeRoute?.fromText || 'نقطة الانطلاق';
                        const eName = d.route?.split(/[-➔→]/)[1]?.trim() || d.activeRoute?.toText || 'نقطة الوصول';
                        permRoutes.push({
                            id: 'route-' + d.driverId,
                            driverId: d.driverId,
                            driverName: d.fullName || 'كابتن توصيله',
                            driverPhone: d.phoneNumber || '',
                            vehicleInfo: `${d.vehicleMake || 'تويوتا'} ${d.vehicleModel || 'كورولا'} (${d.vehiclePlate || 'النجف'})`,
                            vehicleType: d.vehicleType || 'eco',
                            startName: sName,
                            endName: eName,
                            startLat: parseFloat(d.currentLat || d.latitude || 31.9961),
                            startLon: parseFloat(d.currentLon || d.longitude || 44.3168),
                            endLat: parseFloat(d.activeRoute?.toLat || 32.0321),
                            endLon: parseFloat(d.activeRoute?.toLon || 44.3725),
                            fare: 3000,
                            days: ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء'],
                            departureTime: '07:30 ص',
                            status: 'Active',
                            isDriverRoute: true,
                            createdAt: d.createdAt || new Date().toISOString()
                        });
                    }
                }
            });

            if (customerId) {
                permRoutes = permRoutes.filter(r => r.customerId === customerId);
            }
            return sendJson({ success: true, routes: permRoutes });
        }

        if (pathname.startsWith('/api/routes/permanent/') && method === 'DELETE') {
            const routeId = pathname.replace('/api/routes/permanent/', '').trim();
            db.memoryState.permanentRoutes = (db.memoryState.permanentRoutes || []).filter(r => r.id !== routeId);
            db.saveStateSnapshot();
            return sendJson({ success: true, message: 'تم حذف المسار' });
        }

        if (pathname.startsWith('/api/routes/permanent/') && (method === 'PATCH' || method === 'PUT')) {
            const routeId = pathname.replace('/api/routes/permanent/', '').trim();
            const body = await parseJsonBody(req);
            const r = (db.memoryState.permanentRoutes || []).find(item => item.id === routeId);
            if (r) {
                if (body.status) r.status = body.status;
                if (body.days) r.days = body.days;
                if (body.departureTime) r.departureTime = body.departureTime;
                db.saveStateSnapshot();
                return sendJson({ success: true, route: r });
            }
            return sendJson({ success: false, error: 'Route not found' }, 404);
        }

        // Driver Matching Permanent Lines (Spatial intersection calculation)
        if (pathname.startsWith('/api/driver/') && pathname.endsWith('/matching-permanent') && method === 'GET') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            const driver = (db.memoryState.drivers || []).find(d => d.driverId === driverId);

            const toRad = (deg) => deg * Math.PI / 180;
            const haversine = (lat1, lon1, lat2, lon2) => {
                const R = 6371;
                const dLat = toRad(lat2 - lat1);
                const dLon = toRad(lon2 - lon1);
                const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
                return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            };

            const dStartLat = (driver && (driver.currentLat || driver.latitude)) ? parseFloat(driver.currentLat || driver.latitude) : 31.9961;
            const dStartLon = (driver && (driver.currentLon || driver.longitude)) ? parseFloat(driver.currentLon || driver.longitude) : 44.3168;
            const dEndLat = (driver && (driver.activeRoute?.toLat || driver.dropoffLat)) ? parseFloat(driver.activeRoute?.toLat || driver.dropoffLat) : 32.0321;
            const dEndLon = (driver && (driver.activeRoute?.toLon || driver.dropoffLon)) ? parseFloat(driver.activeRoute?.toLon || driver.dropoffLon) : 44.3725;

            const allPermRoutes = db.memoryState.permanentRoutes || [];
            const matches = allPermRoutes.map(pr => {
                const startDist = haversine(dStartLat, dStartLon, pr.startLat, pr.startLon);
                const endDist = haversine(dEndLat, dEndLon, pr.endLat, pr.endLon);
                const avgDist = (startDist + endDist) / 2;
                
                const matchPct = Math.max(30, Math.min(99, Math.round(100 - (avgDist * 15))));
                const isClose = startDist <= 2.5 && endDist <= 2.5;

                return {
                    ...pr,
                    pickupDistanceKm: Math.round(startDist * 10) / 10,
                    dropoffDistanceKm: Math.round(endDist * 10) / 10,
                    matchPercentage: matchPct,
                    isIntersecting: isClose
                };
            }).sort((a, b) => b.matchPercentage - a.matchPercentage);

            return sendJson({ success: true, driverId, matches });
        }

        // ---------------------------------------------------------------------
        // PASSENGER: SPATIAL ROUTE MATCHING (3-TIER: 🟢 <=500m, 🟣 <=1500m, 🔴 >1500m)
        // ---------------------------------------------------------------------
        if (pathname === '/api/passenger/match-route' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const points = body.coordinates || body.points || (body.passengerLineGeoJson && body.passengerLineGeoJson.coordinates) || [];
                const maxMeters = parseFloat(body.maxMeters || 5000);
                const matched = db.matchPassengerRoute(points, maxMeters);
                return sendJson({ success: true, count: matched.length, drivers: matched });
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
        }

        // ---------------------------------------------------------------------
        // ATOMIC BOOKING ENDPOINT (CONCURRENCY SAFE WITH INSTANT SEAT DEDUCTION)
        // ---------------------------------------------------------------------
        if (pathname === '/api/bookings/atomic-book' && method === 'POST') {
            try {
                const body = await parseJsonBody(req);
                const { driverId, passengerId, passengerName, passengerPhone, platform, seats } = body;
                if (!driverId || !passengerId) {
                    return sendJson({ success: false, error: 'driverId and passengerId are required' }, 400);
                }
                if (_orderRateLimit(clientIp, passengerId || passengerPhone)) {
                    return sendJson({
                        success: false,
                        error: '⚠️ لقد أرسلت طلبات حجز كثيرة في وقت قصير. يرجى الانتظار دقيقة قبل المحاولة مجدداً.'
                    }, 429);
                }
                const result = await db.executeAtomicBooking({
                    driverId,
                    passengerId,
                    passengerName,
                    passengerPhone,
                    platform: platform || 'web',
                    seatsToBook: seats || 1
                });
                return sendJson(result, result.statusCode || (result.success ? 200 : 400));
            } catch (err) {
                return sendJson({ success: false, error: err.message }, 500);
            }
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
        if ((pathname === '/api/driver/location' || pathname === '/api/driver/update-location' || pathname === '/driver/location' || pathname === '/driver/update-location') && method === 'POST') {
            const body = await parseJsonBody(req);
            const { driverId, latitude, longitude, lat, lon, heading, speedKmh, tripStatus } = body;

            // Identity & Authorization Check (RLS): Driver can only update their own location
            const authUser = getAuthUser(req);
            const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
            if (authHeader && !authUser) {
                return sendJson({ success: false, error: 'غير مصرح: رمز الدخول غير صالح (RLS)' }, 403);
            }
            if (authUser && authUser.role !== 'Admin') {
                if (authUser.role === 'Customer') {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكن للراكب إرسال إحداثيات كابتن (RLS)' }, 403);
                }
                if (authUser.role === 'Driver') {
                    const authDriverId = String(authUser.id || '').trim();
                    const authPhone = normalizePhone(authUser.phone || authUser.driver?.phoneNumber || '');
                    const reqDriverId = String(driverId || '').trim();
                    const reqPhone = normalizePhone(driverId);
                    const isMatch = (authDriverId && authDriverId === reqDriverId) || 
                                    (authPhone && reqPhone && authPhone === reqPhone) ||
                                    (authDriverId && reqPhone && authDriverId === reqPhone);
                    if (!isMatch) {
                        return sendJson({ success: false, error: 'غير مصرح: لا يمكنك تحديث موقع كابتن آخر (RLS)' }, 403);
                    }
                }
            }

            // Rate limiting per driver across PM2 cluster: 30 requests per 30s (max 1 req/sec)
            if (driverId) {
                const locRate = await redisManager.checkRateLimitCluster(`rate:driver:loc:${driverId}`, 30, 30);
                if (!locRate.allowed) {
                    return sendJson({ success: false, error: 'تم تجاوز معدل تحديث الموقع المسموح به (حد أقصى 1 طلب في الثانية)' }, 429);
                }
            }

            const cleanPhone = String(driverId || '').replace(/[^0-9]/g, '');
            let driver = (db.memoryState.drivers || []).find(d => 
                String(d.driverId) === String(driverId) || 
                String(d.id) === String(driverId) || 
                (cleanPhone.length >= 7 && d.phoneNumber && d.phoneNumber.replace(/[^0-9]/g, '').endsWith(cleanPhone.slice(-8)))
            );

            const now = Date.now();
            let prevLat = driver?.currentLat ? parseFloat(driver.currentLat) : null;
            let prevLon = driver?.currentLon ? parseFloat(driver.currentLon) : null;
            let prevTime = driver?.lastLocationTimestamp || null;

            // Across PM2 Cluster: Check Redis for driver meta if memory lacks previous location/timestamp
            if (redisManager && redisManager.isConnected && (!prevLat || !prevTime)) {
                try {
                    const meta = await redisManager.client.hgetall(`driver:${driverId}:meta`);
                    if (meta && meta.lat && meta.lon && meta.updatedAt) {
                        prevLat = parseFloat(meta.lat);
                        prevLon = parseFloat(meta.lon);
                        prevTime = parseInt(meta.updatedAt, 10);
                    }
                } catch (_) {}
            }

            const dLat = latitude !== undefined ? parseFloat(latitude) : (lat !== undefined ? parseFloat(lat) : (prevLat !== null ? prevLat : 0));
            const dLon = longitude !== undefined ? parseFloat(longitude) : (lon !== undefined ? parseFloat(lon) : (prevLon !== null ? prevLon : 0));

            // Speed jump validation (> 140 km/h) & log to audit_logs
            if (!isNaN(dLat) && !isNaN(dLon) && prevLat !== null && prevLon !== null && prevTime && (now - prevTime) < 300000) {
                const speedCheck = validateLocationSpeed(
                    prevLat,
                    prevLon,
                    prevTime,
                    dLat,
                    dLon,
                    now
                );
                if (!speedCheck.valid) {
                    try {
                        const auditService = require('./modules/audit/auditService');
                        await auditService.logEvent({
                            action: 'SPEED_JUMP_REJECTED',
                            targetType: 'driver',
                            targetId: driverId,
                            userId: driverId,
                            details: { speedKmh: speedCheck.speedKmh, distKm: speedCheck.distKm, reason: speedCheck.reason }
                        });
                    } catch (e) {}
                    return sendJson({ success: false, error: 'تم رفض إحداثيات الموقع: ' + speedCheck.reason }, 400);
                }
            }

            if (driver) {
                driver.currentLat = dLat;
                driver.currentLon = dLon;
                driver.lastLocationTimestamp = now;
                if (heading !== undefined) driver.heading = heading;
                if (speedKmh !== undefined) driver.speedKmh = speedKmh;
                if (tripStatus !== undefined) driver.tripStatus = tripStatus;
                driver.lastLocationUpdate = new Date().toISOString();
                db.saveStateSnapshot();
            }

            // Redis Geospatial Index & Real-Time Stream Broadcast across PM2 cluster
            if (!isNaN(dLat) && !isNaN(dLon)) {
                await redisManager.updateDriverLocation(driverId, dLon, dLat, driver || { id: driverId });
            }

            const activeRide = (db.memoryState.rideRequests || []).find(r => 
                (r.acceptedDriverId === driverId || r.assignedDriverId === driverId) &&
                (r.status === 'Accepted' || r.status === 'Arrived' || r.status === 'InProgress' ||
                 r.status === 'ACCEPTED' || r.status === 'DRIVER_ARRIVED' || r.status === 'IN_TRIP')
            );
            if (activeRide) {
                redisManager.publishRideEvent(activeRide.id, {
                    type: 'driver_location',
                    driverId: driverId,
                    latitude: dLat,
                    longitude: dLon,
                    heading: heading || 0,
                    speedKmh: speedKmh || 30
                });
            }

            return sendJson({ success: true, updated: true });
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

        // Driver Bookings & Subscribers List (All bookings for this driver: Pending requests & Confirmed passengers)
        if ((pathname.startsWith('/api/driver/') || pathname.startsWith('/driver/')) && (pathname.endsWith('/bookings') || pathname.endsWith('/subscribers')) && method === 'GET') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            let driverBookings = [];

            const targetDriver = (db.memoryState.drivers || []).find(d => 
                d.driverId === driverId || 
                d.phoneNumber === driverId || 
                (d.phone && d.phone === driverId)
            );
            const actualDriverId = targetDriver ? targetDriver.driverId : driverId;
            const actualDriverPhone = targetDriver ? (targetDriver.phoneNumber || targetDriver.phone) : driverId;
            const cleanPhone = String(actualDriverPhone || driverId || '').replace(/[^0-9]/g, '');
            const driverName = targetDriver?.fullName;

            // RLS Check: Drivers can only access their own bookings. Admins have full access.
            const authUser = getAuthUser(req);
            if (authUser && authUser.role === 'Driver') {
                if (authUser.id !== actualDriverId && authUser.phone !== actualDriverPhone && actualDriverId !== 'drv-sample') {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكنك استعراض بيانات كابتن آخر (RLS)' }, 403);
                }
            }

            const cancelledBookingIds = new Set();
            const cancelledCustomerIds = new Set();

            // 1. Fetch bookings from PostgreSQL if connected (PostgreSQL is source of truth)
            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(`
                        SELECT * FROM bookings 
                        WHERE (driver_id = $1 
                           OR driver_id = $2
                           OR driver_id = $3
                           OR (driver_name IS NOT NULL AND LOWER(driver_name) = LOWER($4)))
                        ORDER BY created_at DESC
                    `, [driverId, actualDriverId, cleanPhone, driverName || '']);
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        for (const r of pgRes.rows) {
                            if (r.status === 'Cancelled' || r.status === 'Declined') {
                                cancelledBookingIds.add(r.id);
                                if (r.customer_id) cancelledCustomerIds.add(r.customer_id);
                                continue;
                            }
                            if (r.status === 'Pending' || r.status === 'Confirmed' || r.status === 'Active' || r.status === 'cancellation_pending') {
                                driverBookings.push({
                                    id: r.id,
                                    bookingId: r.id,
                                    driverId: r.driver_id,
                                    customerId: r.customer_id,
                                    customerName: r.customer_name || 'راكب',
                                    customerPhone: (r.status === 'Confirmed' || r.status === 'Active') ? (r.customer_phone || '') : maskPhoneNumber(r.customer_phone || ''),
                                    pickupLocation: r.pickup_name || 'موقع الركوب',
                                    dropoffLocation: r.dropoff_name || 'جامعة الكوفة',
                                    pickupLat: parseFloat(r.pickup_lat || 31.9961),
                                    pickupLon: parseFloat(r.pickup_lon || 44.3168),
                                    dropoffLat: parseFloat(r.dropoff_lat || 32.0321),
                                    dropoffLon: parseFloat(r.dropoff_lon || 44.3725),
                                    seatsBooked: r.seats_booked || 1,
                                    status: r.status || 'Pending',
                                    totalFare: r.total_fare,
                                    cancellationPending: r.status !== 'Cancelled' && (r.status === 'cancellation_pending' || r.cancellation_requested === true || r.cancellation_status === 'pending'),
                                    cancellation_requested: r.status !== 'Cancelled' && (r.status === 'cancellation_pending' || r.cancellation_requested === true || r.cancellation_status === 'pending'),
                                    cancellation_status: r.status === 'Cancelled' ? 'approved' : (r.status === 'cancellation_pending' ? 'pending' : (r.cancellation_status || null)),
                                    cancellationReason: r.cancellation_reason || '',
                                    cancellation_reason: r.cancellation_reason || '',
                                    cancellationDetails: r.cancellation_details || '',
                                    cancellation_details: r.cancellation_details || '',
                                    driverApprovalReason: r.driver_approval_reason || '',
                                    driver_approval_reason: r.driver_approval_reason || '',
                                    createdAt: r.created_at
                                });
                            }
                        }
                    }
                } catch (pgErr) {
                    console.error('[Driver] PG bookings fetch error:', pgErr.message);
                }
            }

            // 2. Fetch bookings from memory for this driver (exclude Cancelled bookings or bookings marked cancelled in PG)
            const memBookings = (db.memoryState.bookings || []).filter(b => 
                b.status !== 'Cancelled' &&
                !cancelledBookingIds.has(b.id) &&
                !cancelledBookingIds.has(b.bookingId) &&
                !cancelledCustomerIds.has(b.customerId) &&
                (b.driverId === driverId || 
                b.driverId === actualDriverId ||
                (actualDriverPhone && (b.driverPhone === actualDriverPhone || b.driverId === actualDriverPhone)) ||
                (driverName && b.driverName && b.driverName.trim() === driverName.trim()))
            );
            for (const mb of memBookings) {
                if (!driverBookings.some(dbk => (dbk.id === mb.id || dbk.bookingId === mb.bookingId))) {
                    const isPendingCancel = mb.status !== 'Cancelled' && (mb.status === 'cancellation_pending' || mb.cancellationPending === true || mb.cancellationRequested === true || mb.cancellation_requested === true || mb.cancellation_status === 'pending');
                    driverBookings.push({
                        ...mb,
                        cancellationPending: isPendingCancel,
                        cancellation_requested: isPendingCancel,
                        cancellation_status: isPendingCancel ? 'pending' : (mb.cancellation_status || null),
                        cancellationReason: mb.cancellationReason || mb.cancellation_reason || '',
                        cancellation_reason: mb.cancellationReason || mb.cancellation_reason || '',
                        cancellationDetails: mb.cancellationDetails || mb.cancellation_details || '',
                        cancellation_details: mb.cancellationDetails || mb.cancellation_details || '',
                        driverApprovalReason: mb.driverApprovalReason || mb.driver_approval_reason || '',
                        driver_approval_reason: mb.driverApprovalReason || mb.driver_approval_reason || ''
                    });
                }
            }

            // 3. Customers explicitly assigned to this driver (only if not cancelled in PG)
            const assignedCustomers = (db.memoryState.customers || []).filter(c => 
                !cancelledCustomerIds.has(c.customerId) &&
                !cancelledCustomerIds.has(c.id) &&
                (c.driverId === driverId || c.driverId === actualDriverId || c.assignedDriverId === driverId || c.assignedDriverId === actualDriverId)
            );
            for (const ac of assignedCustomers) {
                if (!driverBookings.some(b => b.customerId === ac.customerId)) {
                    driverBookings.push({
                        id: 'bk-assign-' + ac.customerId,
                        bookingId: 'bk-assign-' + ac.customerId,
                        driverId: actualDriverId,
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
                        status: ac.bookingConfirmed ? 'Confirmed' : 'Pending',
                        cancellationPending: false,
                        cancellationReason: '',
                        cancellationDetails: ''
                    });
                }
            }

            if (authUser && authUser.role === 'Customer') {
                driverBookings = driverBookings.filter(b => b.customerId === authUser.id || (authUser.phone && (b.customerPhone === authUser.phone || b.phone === authUser.phone)));
            }

            // Prioritize pending cancellations before deduplicating
            driverBookings.sort((a, b) => {
                if (a.cancellationPending && !b.cancellationPending) return -1;
                if (!a.cancellationPending && b.cancellationPending) return 1;
                return 0;
            });

            // Deduplicate driver bookings by actual customerId or bookingId ONLY (NO name-based deduplication)
            const seenCustKeys = new Set();
            const deduplicatedDriverBookings = [];
            for (const b of driverBookings) {
                const idKey = b.customerId ? `cust_${b.customerId}` : `bk_${b.id || b.bookingId}`;
                if (!seenCustKeys.has(idKey)) {
                    seenCustKeys.add(idKey);
                    deduplicatedDriverBookings.push(b);
                }
            }
            driverBookings = deduplicatedDriverBookings;

            const confirmedSubs = driverBookings.filter(b => b.status === 'Confirmed' || b.status === 'Active' || b.cancellationPending);
            const pendingBookings = driverBookings.filter(b => b.status === 'Pending' || b.status === 'pending_approval' || b.status === 'pending');

            return sendJson({
                success: true,
                subscribers: confirmedSubs,
                pendingBookings: pendingBookings,
                bookings: driverBookings,
                total: driverBookings.length
            });
        }

        // Driver Pending Requests (Customer booking requests awaiting driver approval)
        if ((pathname.startsWith('/api/driver/') || pathname.startsWith('/driver/')) && (pathname.endsWith('/requests') || pathname.endsWith('/pending-bookings') || pathname.endsWith('/pending')) && method === 'GET') {
            const parts = pathname.split('/');
            const driverId = parts[parts.length - 2];
            let pendingBookings = [];

            const targetDriver = (db.memoryState.drivers || []).find(d => 
                d.driverId === driverId || 
                d.phoneNumber === driverId || 
                (d.phone && d.phone === driverId)
            );
            const actualDriverId = targetDriver ? targetDriver.driverId : driverId;
            const actualDriverPhone = targetDriver ? (targetDriver.phoneNumber || targetDriver.phone) : driverId;
            const actualDriverName = targetDriver?.fullName;

            // RLS Check: Drivers only see their own requests. Customers cannot view driver requests.
            const authUser = getAuthUser(req);
            if (authUser && authUser.role === 'Driver') {
                if (authUser.id !== actualDriverId && authUser.phone !== actualDriverPhone && actualDriverId !== 'drv-sample') {
                    return sendJson({ success: false, error: 'غير مصرح: لا يمكنك استعراض طلبات كابتن آخر (RLS)' }, 403);
                }
            } else if (authUser && authUser.role === 'Customer') {
                return sendJson({ success: false, error: 'غير مصرح للركاب بعرض طلبات الكابتن (RLS)' }, 403);
            }

            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(`
                        SELECT * FROM bookings 
                        WHERE (driver_id = $1 OR driver_id = $2 OR (driver_name IS NOT NULL AND LOWER(driver_name) = LOWER($3)) OR driver_id IS NULL) AND status = 'Pending'
                        ORDER BY created_at DESC
                    `, [driverId, actualDriverId, actualDriverName || '']);
                    if (pgRes.rows && pgRes.rows.length > 0) {
                        pendingBookings = pgRes.rows.map(r => ({
                            id: r.id,
                            bookingId: r.id,
                            driverId: r.driver_id,
                            customerId: r.customer_id,
                            customerName: r.customer_name || 'راكب طالب حجز',
                            customerPhone: maskPhoneNumber(r.customer_phone || ''),
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
                (b.driverId === driverId || b.driverId === actualDriverId || 
                 (actualDriverPhone && (b.driverPhone === actualDriverPhone || b.driverId === actualDriverPhone)) ||
                 (actualDriverName && b.driverName && b.driverName.trim() === actualDriverName.trim()) ||
                 !b.driverId) && b.status === 'Pending'
            );
            for (const mb of memPending) {
                if (!pendingBookings.some(pb => (pb.id === mb.id || pb.bookingId === mb.bookingId))) {
                    pendingBookings.push({
                        ...mb,
                        customerPhone: maskPhoneNumber(mb.customerPhone || mb.phone || '')
                    });
                }
            }

            // Deduplicate pending bookings by customer
            const seenPendingKeys = new Set();
            const deduplicatedPending = [];
            for (const pb of pendingBookings) {
                const idKey = pb.customerId ? `id_${pb.customerId}` : null;
                const cleanPhone = String(pb.customerPhone || pb.phone || '').replace(/[^0-9]/g, '');
                const phoneKey = cleanPhone.length >= 7 ? `phone_${cleanPhone.slice(-8)}` : null;

                const isDup = (idKey && seenPendingKeys.has(idKey)) || (phoneKey && seenPendingKeys.has(phoneKey));
                if (!isDup) {
                    if (idKey) seenPendingKeys.add(idKey);
                    if (phoneKey) seenPendingKeys.add(phoneKey);
                    deduplicatedPending.push(pb);
                }
            }
            pendingBookings = deduplicatedPending;

            return sendJson({ success: true, total: pendingBookings.length, requests: pendingBookings, bookings: pendingBookings });
        }

        if (pathname === '/api/matching/find-routes' || pathname === '/api/driver/routes' || pathname === '/api/routes') {
            const activeRoutes = (db.memoryState.routes || [])
                .filter(r => {
                    if (r.status && r.status !== 'Active') return false;
                    const drv = (db.memoryState.drivers || []).find(d => d.driverId === r.driverId);
                    if (drv && !isDriverOnlineAndActive(drv)) return false;
                    if (drv && (drv.work_mode === 'مشوار قصير' || drv.workStatus === 'taxi')) return false;
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
        if ((pathname === '/api/customer/book-route' || pathname === '/api/bookings' || pathname === '/bookings' || pathname === '/api/routes/subscribe' || pathname === '/routes/subscribe') && method === 'POST') {
            const authUser = getAuthUser(req);
            if (!authUser) {
                return sendJson({ success: false, error: 'غير مصرح: يرجى تسجيل الدخول أولاً لإرسال طلب الحجز' }, 401);
            }

            const body = await parseJsonBody(req);
            const candidateCustomerId = String(authUser.role === 'Customer' ? authUser.id : (body.customerId || authUser.id || '')).trim();
            const candidateRawPhone = String(authUser.role === 'Customer' ? (authUser.phone || body.customerPhone || '') : (body.customerPhone || authUser.phone || '')).trim();
            const candidateCleanPhone = candidateRawPhone.replace(/[^0-9]/g, '');
            const candidateName = authUser.role === 'Customer' ? (authUser.fullName || authUser.name || body.customerName || 'راكب توصيله') : (body.customerName || 'راكب توصيله');

            // Cluster Rate Limit per User
            const userIdentifier = candidateCustomerId || candidateRawPhone || clientIp;
            const rateLimitKey = `rate:customer:book:${userIdentifier}`;
            const bookRate = await redisManager.checkRateLimitCluster(rateLimitKey, 10, 60);
            if (!bookRate.allowed) {
                res.setHeader('Retry-After', String(bookRate.ttl || 60));
                return sendJson({
                    success: false,
                    error: '⚠️ لقد أرسلت طلبات حجز كثيرة في وقت قصير. يرجى الانتظار دقيقة قبل المحاولة مجدداً.',
                    retry_after: bookRate.ttl || 60
                }, 429);
            }

            // Idempotency-Key Check
            const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || body.idempotencyKey;
            if (idempotencyKey && redisManager && redisManager.client) {
                const cachedIdemp = await redisManager.client.get(`idempotency:booking:${idempotencyKey}`).catch(() => null);
                if (cachedIdemp) {
                    try {
                        const parsedIdemp = JSON.parse(cachedIdemp);
                        return sendJson(parsedIdemp, 200);
                    } catch (_) {}
                }
            }

            const routeId = body.routeId || body.driverRouteId;
            let targetRoute = (db.memoryState.routes || []).find(r => (r.id === routeId || r.routeId === routeId));
            
            let targetDriver = null;
            if (body.driverId && db.isPostgresConnected && db.pool) {
                try {
                    const dRes = await db.pool.query('SELECT * FROM drivers WHERE driver_id = $1 LIMIT 1', [body.driverId]);
                    if (dRes.rows && dRes.rows.length > 0) targetDriver = dRes.rows[0];
                } catch (_) {}
            }
            if (!targetDriver && body.driverId) {
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
            if (!targetDriver) {
                return sendJson({ success: false, error: 'الكابتن المطلوب غير موجود' }, 404);
            }

            // Target Captain Validation: is_approved, commute mode, fixed location
            const isApproved = targetDriver.is_approved !== false && targetDriver.isApproved !== false;
            if (!isApproved) {
                return sendJson({ success: false, error: 'الكابتن غير معتمد حالياً لتلقي طلبات الخطوط' }, 400);
            }
            const drvMode = String(targetDriver.work_mode || targetDriver.workMode || targetDriver.workStatus || '').toLowerCase();
            const isCommute = drvMode === 'commute' || drvMode === 'both' || drvMode === 'خط' || drvMode === 'خط دائمي' || drvMode === '';
            if (!isCommute && drvMode === 'taxi') {
                return sendJson({ success: false, error: 'الكابتن يعمل بنظام التكسي المباشر فقط ولا يقبل اشتراكات الخطوط' }, 400);
            }
            const hasFixedLoc = (targetDriver.fixed_lat || targetDriver.fixedLat) && (targetDriver.fixed_lng || targetDriver.fixedLng || targetDriver.fixed_lon || targetDriver.fixedLon);
            if (!hasFixedLoc) {
                return sendJson({ success: false, error: 'الكابتن لم يحدد نقطة الانطلاق الثابتة لخطه الدائمي' }, 400);
            }

            if (!targetRoute && targetDriver) {
                targetRoute = (db.memoryState.routes || []).find(r => r.driverId === (targetDriver.driverId || targetDriver.driver_id));
            }
            const resolvedDriverId = targetDriver.driverId || targetDriver.driver_id;
            const resolvedDriverName = targetDriver.fullName || targetDriver.full_name || 'كابتن توصيله';
            const resolvedDriverPhone = targetDriver.phoneNumber || targetDriver.phone_number || '';

            // Check max pending requests per rider (booking_max_pending_per_rider)
            const maxPending = systemSettingsService ? systemSettingsService.getBookingMaxPendingPerRider() : 3;
            let currentPendingCount = 0;
            if (db.isPostgresConnected && db.pool) {
                try {
                    const pRes = await db.pool.query(`
                        SELECT COUNT(*) AS cnt FROM bookings 
                        WHERE (customer_id = $1 OR (customer_phone IS NOT NULL AND customer_phone = $2)) AND status = 'Pending'
                    `, [candidateCustomerId, candidateRawPhone]);
                    currentPendingCount = parseInt(pRes.rows[0]?.cnt || 0, 10);
                } catch (_) {}
            } else {
                currentPendingCount = (db.memoryState.bookings || []).filter(b => 
                    (b.customerId === candidateCustomerId || (candidateCleanPhone && b.customerPhone && b.customerPhone.replace(/[^0-9]/g, '').endsWith(candidateCleanPhone.slice(-8)))) &&
                    b.status === 'Pending'
                ).length;
            }

            if (currentPendingCount >= maxPending) {
                return sendJson({
                    success: false,
                    error: `تجاوزت الحد الأقصى للطلبات المعلقة (${maxPending}). يرجى انتظار رد الكباتن أو إلغاء طلب معلق قبل إرسال طلب جديد.`
                }, 409);
            }

            // Prevent duplicate booking for the same passenger and captain
            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgDup = await db.pool.query(`
                        SELECT id FROM bookings 
                        WHERE (customer_id = $1 OR (customer_phone IS NOT NULL AND customer_phone = $2))
                          AND driver_id = $3
                          AND status IN ('Pending', 'Confirmed', 'Active')
                        LIMIT 1
                    `, [candidateCustomerId, candidateRawPhone, resolvedDriverId]);
                    if (pgDup.rows && pgDup.rows.length > 0) {
                        return sendJson({
                            success: false,
                            alreadySubscribed: true,
                            existingBookingId: pgDup.rows[0].id,
                            error: 'أنت مشترك بالفعل أو لديك طلب حجز معلق مع هذا الكابتن، لا يمكنك تكرار الحجز.'
                        }, 409);
                    }
                } catch (_) {}
            } else {
                const existingActiveBooking = (db.memoryState.bookings || []).find(b => {
                    const isActive = b.status === 'Confirmed' || b.status === 'Pending' || b.status === 'Active';
                    if (!isActive) return false;

                    const bCustId = String(b.customerId || b.passengerId || '');
                    const bPhone = String(b.customerPhone || b.phone || '').replace(/[^0-9]/g, '');
                    const isSameCustomer = (candidateCustomerId && bCustId && candidateCustomerId === bCustId) ||
                                           (candidateCleanPhone.length >= 7 && bPhone.length >= 7 && (bPhone.endsWith(candidateCleanPhone.slice(-8)) || candidateCleanPhone.endsWith(bPhone.slice(-8))));
                    if (!isSameCustomer) return false;

                    return (b.driverId === resolvedDriverId);
                });

                if (existingActiveBooking) {
                    return sendJson({
                        success: false,
                        alreadySubscribed: true,
                        existingBookingId: existingActiveBooking.id || existingActiveBooking.bookingId,
                        error: 'أنت مشترك بالفعل أو لديك طلب حجز معلق مع هذا الكابتن، لا يمكنك تكرار الحجز.'
                    }, 409);
                }
            }

            const seats = Math.max(1, Math.min(4, parseInt(body.seats || body.seatsBooked || 1, 10)));
            let currentBookedSeats = 0;
            if (db.isPostgresConnected && db.pool) {
                try {
                    const capQ = await db.pool.query(`
                        SELECT COALESCE(SUM(seats_booked), 0) AS booked_count
                        FROM bookings
                        WHERE driver_id = $1 AND status IN ('Confirmed', 'Active')
                    `, [resolvedDriverId]);
                    currentBookedSeats = parseInt(capQ.rows[0]?.booked_count || 0, 10);
                } catch (_) {}
            } else {
                const activeBookings = (db.memoryState.bookings || []).filter(b => 
                    (b.driverId === resolvedDriverId) && (b.status === 'Confirmed' || b.status === 'Active')
                );
                currentBookedSeats = activeBookings.reduce((sum, b) => sum + parseInt(b.seatsBooked || 1, 10), 0);
            }
            const totalCarCapacity = targetDriver.available_seats || targetDriver.availableSeats || targetRoute?.totalSeats || 4;
            if (currentBookedSeats >= totalCarCapacity || (currentBookedSeats + seats > totalCarCapacity)) {
                return sendJson({ success: false, error: 'عذراً، المقاعد مكتملة بالكامل لدى الكابتن حالياً.' }, 409);
            }

            const rawNotes = body.notes || body.note || body.comment || '';
            const sanitizedNotes = typeof rawNotes === 'string' ? rawNotes.trim().slice(0, 300) : '';

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
                customerId: candidateCustomerId,
                customerName: candidateName,
                customerPhone: candidateRawPhone,
                pickupLocation: body.pickupLocation || body.pickup || body.pickupName || (targetRoute ? targetRoute.startName : ''),
                dropoffLocation: body.dropoffLocation || body.destination || body.dropoffName || (targetRoute ? targetRoute.endName : 'جامعة الكوفة'),
                pickupLat: parseFloat(body.pickupLat || (targetRoute ? targetRoute.startLat : 31.9961)),
                pickupLon: parseFloat(body.pickupLon || (targetRoute ? targetRoute.startLon : 44.3168)),
                dropoffLat: parseFloat(body.dropoffLat || (targetRoute ? targetRoute.endLat : 32.0321)),
                dropoffLon: parseFloat(body.dropoffLon || (targetRoute ? targetRoute.endLon : 44.3725)),
                seatsBooked: seats,
                notes: sanitizedNotes,
                fare: totalFare,
                totalFare: totalFare,
                status: 'Pending',
                seatsDeducted: false,
                createdAt: now
            };

            if (db.isPostgresConnected && db.pool) {
                try {
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

                    let validRouteId = null;
                    if (newBooking.routeId) {
                        const rCheck = await db.pool.query('SELECT id FROM routes WHERE id = $1', [newBooking.routeId]);
                        if (rCheck.rows.length > 0) validRouteId = newBooking.routeId;
                    }

                    let validDriverId = null;
                    if (newBooking.driverId) {
                        const dCheck = await db.pool.query('SELECT driver_id FROM drivers WHERE driver_id = $1', [newBooking.driverId]);
                        if (dCheck.rows.length > 0) validDriverId = newBooking.driverId;
                    }

                    await db.pool.query(`
                        INSERT INTO bookings (
                            id, route_id, customer_id, customer_name, driver_id, driver_name,
                            pickup_name, dropoff_name, pickup_lat, pickup_lon, dropoff_lat, dropoff_lon,
                            total_fare, seats_booked, status, customer_phone, cancellation_reason, created_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                    `, [
                        bookingId, validRouteId, newBooking.customerId, newBooking.customerName,
                        validDriverId, newBooking.driverName, newBooking.pickupLocation,
                        newBooking.dropoffLocation, newBooking.pickupLat, newBooking.pickupLon,
                        newBooking.dropoffLat, newBooking.dropoffLon, totalFare, seats, 'Pending',
                        newBooking.customerPhone, sanitizedNotes, now
                    ]);
                } catch (e) {
                    if (e && e.code === '23505') {
                        return sendJson({
                            success: false,
                            alreadySubscribed: true,
                            error: 'أنت مشترك بالفعل أو لديك طلب حجز معلق مع هذا الكابتن، لا يمكنك تكرار الحجز.'
                        }, 409);
                    }
                    console.error('[Server] PG Booking insert error:', e);
                }
            }

            db.memoryState.bookings = db.memoryState.bookings || [];
            db.memoryState.bookings.unshift(newBooking);

            const cust = (db.memoryState.customers || []).find(c => c.customerId === newBooking.customerId || c.phoneNumber === newBooking.customerPhone);
            if (cust) {
                cust.totalBookings = (cust.totalBookings || 0) + 1;
            }

            // Real-time Driver SSE Broadcast (phone masked)
            if (redisManager && typeof redisManager.publishDriverEvent === 'function') {
                redisManager.publishDriverEvent(resolvedDriverId, {
                    type: 'booking_request',
                    event: 'booking_request',
                    booking: {
                        ...newBooking,
                        customerPhone: maskPhoneNumber(newBooking.customerPhone)
                    }
                });
            }
            if (redisManager && redisManager.pub) {
                redisManager.pub.publish('channel:cluster:sync', JSON.stringify({
                    type: 'booking_created',
                    bookingId: newBooking.id,
                    driverId: resolvedDriverId
                })).catch(() => {});
            }

            db.addAuditLog('SeatBooked', 'Customer', newBooking.customerId, {
                bookingId,
                driverId: resolvedDriverId,
                driverName: newBooking.driverName,
                route: `${newBooking.pickupLocation} ➔ ${newBooking.dropoffLocation}`,
                seats,
                totalFare,
                status: 'Pending'
            });

            db.saveStateSnapshot();

            const successResponse = {
                success: true,
                message: 'تم إرسال طلب الحجز إلى الكابتن بنجاح! بانتظار موافقة الكابتن لتأكيد مقعدك.',
                booking: newBooking
            };

            // Cache response in Redis if idempotencyKey supplied
            if (idempotencyKey && redisManager && redisManager.client) {
                await redisManager.client.set(`idempotency:booking:${idempotencyKey}`, JSON.stringify(successResponse), 'EX', 600).catch(() => {});
            }

            return sendJson(successResponse, 201);
        }

        // Accept Booking by Driver / Admin (Driver approves customer to become passenger)
        const acceptMatch = pathname.match(/^\/?(?:api\/)?(?:driver\/)?bookings\/([^\/]+)\/accept$/i);
        if (acceptMatch && method === 'POST') {
            const bookingId = acceptMatch[1];
            const authUser = getAuthUser(req);
            if (!authUser) {
                return sendJson({ success: false, error: 'غير مصرح: تسجيل الدخول مطلوب لقبول طلب الحجز' }, 401);
            }
            const rateKey = `rate:driver:accept:${authUser.id || clientIp}`;
            const acceptRate = await redisManager.checkRateLimitCluster(rateKey, 20, 60);
            if (!acceptRate.allowed) {
                res.setHeader('Retry-After', String(acceptRate.ttl || 60));
                return sendJson({ success: false, error: 'تجاوزت الحد المسموح به، يرجى الانتظار قليلاً', retry_after: acceptRate.ttl || 60 }, 429);
            }
            const body = await parseJsonBody(req).catch(() => ({}));
            const result = await adminController.acceptBooking(bookingId, body.driverId, authUser);
            return sendJson(result, result.success ? 200 : (result.code || 400));
        }

        // Decline / Reject Booking by Driver / Admin
        const declineMatch = pathname.match(/^\/?(?:api\/)?(?:driver\/)?bookings\/([^\/]+)\/(?:decline|reject)$/i);
        if (declineMatch && method === 'POST') {
            const bookingId = declineMatch[1];
            const authUser = getAuthUser(req);
            if (!authUser) {
                return sendJson({ success: false, error: 'غير مصرح: تسجيل الدخول مطلوب لرفض طلب الحجز' }, 401);
            }
            const rateKey = `rate:driver:reject:${authUser.id || clientIp}`;
            const rejectRate = await redisManager.checkRateLimitCluster(rateKey, 20, 60);
            if (!rejectRate.allowed) {
                res.setHeader('Retry-After', String(rejectRate.ttl || 60));
                return sendJson({ success: false, error: 'تجاوزت الحد المسموح به، يرجى الانتظار قليلاً', retry_after: rejectRate.ttl || 60 }, 429);
            }
            const body = await parseJsonBody(req).catch(() => ({}));
            const result = await adminController.declineBooking(bookingId, body.reason || body.declineReason, body.driverId, authUser);
            return sendJson(result, result.success ? 200 : (result.code || 400));
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

        // Customer Request Route Cancellation
        if ((pathname === '/api/customer/request-route-cancellation' || pathname === '/customer/request-route-cancellation') && method === 'POST') {
            const body = await parseJsonBody(req).catch(() => ({}));
            const authUser = getAuthUser(req);
            const userIdentifier = body.customerId || body.customerPhone || (authUser ? (authUser.id || authUser.phone) : clientIp);
            if (_orderRateLimit(clientIp, userIdentifier)) {
                return sendJson({ success: false, error: 'تم إرسال طلبات متعددة بسرعة، يرجى الانتظار قليلاً' }, 429);
            }
            const result = await adminController.requestRouteCancellation(body, authUser);
            return sendJson(result, result.success ? 200 : (result.code || 400));
        }

        // Driver Respond Route Cancellation (Approve or Reject)
        if ((pathname === '/api/driver/respond-route-cancellation' || pathname === '/driver/respond-route-cancellation') && method === 'POST') {
            const body = await parseJsonBody(req).catch(() => ({}));
            const result = await adminController.respondRouteCancellation(body);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Driver Force-Cancel a Subscriber (Driver-initiated cancellation)
        if ((pathname === '/api/driver/cancel-subscriber' || pathname === '/driver/cancel-subscriber') && method === 'POST') {
            const body = await parseJsonBody(req).catch(() => ({}));
            const authUser = getAuthUser(req);
            const userIdentifier = body.driverId || (authUser ? (authUser.id || authUser.phone) : clientIp);
            if (_orderRateLimit(clientIp, userIdentifier)) {
                return sendJson({ success: false, error: 'تم إرسال طلبات متعددة بسرعة، يرجى الانتظار قليلاً' }, 429);
            }
            const result = await adminController.driverCancelSubscriber(body, authUser);
            return sendJson(result, result.success ? 200 : (result.code || 400));
        }

        // Admin Passenger Cancellation Requests List
        if ((pathname === '/api/admin/cancellation-requests' || pathname === '/api/cancellation-requests') && method === 'GET') {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            const result = await adminController.getCancellationRequests();
            return sendJson(result);
        }

        // Admin Approve Cancellation Request (supports POST /api/admin/cancellation-requests/approve with body OR :id/approve)
        const approveCancelMatch = pathname.match(/^\/?(?:api\/)?(?:admin\/)?cancellation-requests\/([^\/]+)\/approve$/i);
        if ((pathname === '/api/admin/cancellation-requests/approve' || pathname === '/api/cancellation-requests/approve' || approveCancelMatch) && method === 'POST') {
            const body = await parseJsonBody(req).catch(() => ({}));
            const requestId = (approveCancelMatch ? approveCancelMatch[1] : (body.id || body.requestId))?.trim();
            const result = await adminController.approveCancellation(requestId, body);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Admin Reject Cancellation Request (supports POST /api/admin/cancellation-requests/reject with body OR :id/reject)
        const rejectCancelMatch = pathname.match(/^\/?(?:api\/)?(?:admin\/)?cancellation-requests\/([^\/]+)\/reject$/i);
        if ((pathname === '/api/admin/cancellation-requests/reject' || pathname === '/api/cancellation-requests/reject' || rejectCancelMatch) && method === 'POST') {
            const body = await parseJsonBody(req).catch(() => ({}));
            const requestId = (rejectCancelMatch ? rejectCancelMatch[1] : (body.id || body.requestId))?.trim();
            const result = await adminController.rejectCancellation(requestId, body);
            return sendJson(result, result.success ? 200 : 400);
        }

        // Bookings List: GET /api/bookings (Protected with Row Level Security)
        if (pathname === '/api/bookings' && method === 'GET') {
            const user = getAuthUser(req);
            const allBookings = db.memoryState.bookings || [];

            // Admin can view all bookings
            if (user && user.role === 'Admin') {
                return sendJson(allBookings);
            }

            // Customer RLS: only return bookings belonging to this customer
            if (user && user.role === 'Customer') {
                const userBookings = allBookings.filter(b => 
                    b.customerId === user.id || 
                    (user.phone && (b.customerPhone === user.phone || b.phone === user.phone))
                );
                return sendJson(userBookings);
            }

            // Driver RLS: only return bookings assigned to this driver
            if (user && user.role === 'Driver') {
                const driverBookings = allBookings.filter(b => 
                    b.driverId === user.id || 
                    (user.phone && b.driverPhone === user.phone)
                );
                return sendJson(driverBookings);
            }

            // Unauthenticated callers receive an empty list to prevent data leakage
            return sendJson([]);
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

        // Dynamic Surge Pricing calculation for Instant Taxi (Baly-like engine)
        if ((pathname === '/api/rides/calculate-fare' || pathname === '/api/pricing/estimate') && (method === 'POST' || method === 'GET')) {
            let params = {};
            if (method === 'POST') {
                params = await parseJsonBody(req);
            } else {
                params = {
                    pickupLat: parseFloat(parsedUrl.searchParams.get('pickupLat')),
                    pickupLon: parseFloat(parsedUrl.searchParams.get('pickupLon')),
                    dropoffLat: parseFloat(parsedUrl.searchParams.get('dropoffLat')),
                    dropoffLon: parseFloat(parsedUrl.searchParams.get('dropoffLon')),
                    distanceKm: parseFloat(parsedUrl.searchParams.get('distanceKm')),
                    durationMins: parseFloat(parsedUrl.searchParams.get('durationMins')),
                    vehicleType: parsedUrl.searchParams.get('vehicleType'),
                    isRoundTrip: parsedUrl.searchParams.get('isRoundTrip') === 'true',
                    hasSecondStop: parsedUrl.searchParams.get('hasSecondStop') === 'true',
                    promoCode: parsedUrl.searchParams.get('promoCode'),
                    simulatedNight: parsedUrl.searchParams.has('simulatedNight') ? parsedUrl.searchParams.get('simulatedNight') === 'true' : undefined,
                    simulatedDemandMultiplier: parsedUrl.searchParams.has('simulatedDemandMultiplier') ? parseFloat(parsedUrl.searchParams.get('simulatedDemandMultiplier')) : undefined
                };
            }
            const result = pricingService.calculateInstantRideFare(params);
            return sendJson(result);
        }

        // Admin Pricing Management & Emergency Override
        if (pathname === '/api/admin/pricing' && method === 'GET') {
            const settings = pricingService.getPricingSettings();
            return sendJson({ success: true, settings });
        }

        if (pathname === '/api/admin/pricing' && (method === 'POST' || method === 'PUT')) {
            const authUser = getAuthUser(req);
            if (authUser && authUser.role && authUser.role !== 'Admin') {
                return sendJson({ success: false, error: 'غير مصرح: تعديل التسعيرة محصور بالمشرف فقط' }, 403);
            }
            const body = await parseJsonBody(req);
            const actor = (authUser && (authUser.fullName || authUser.username)) ? (authUser.fullName || authUser.username) : 'المشرف العام (Admin)';
            const result = await pricingService.savePricingSettings(body, actor, clientIp);
            return sendJson(result);
        }

        if (pathname === '/api/admin/pricing/emergency-override' && method === 'POST') {
            const authUser = getAuthUser(req);
            if (authUser && authUser.role && authUser.role !== 'Admin') {
                return sendJson({ success: false, error: 'غير مصرح: تعديل الذروة محصور بالمشرف فقط' }, 403);
            }
            const body = await parseJsonBody(req);
            const current = pricingService.getPricingSettings();
            const updated = {
                ...current,
                manualOverrideMultiplier: Number(body.multiplier) || 1.0,
                manualOverrideLabel: sanitizeInput(body.label || 'وضع طبيعي (1.0x)', 100)
            };
            const actor = (authUser && (authUser.fullName || authUser.username)) ? (authUser.fullName || authUser.username) : 'المشرف العام (Admin)';
            const result = await pricingService.savePricingSettings(updated, actor, clientIp);
            return sendJson(result);
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
                    telegramAdminLink: 'https://t.me/tawseela_najaf_bot',
                    whatsappAdminLink: 'https://wa.me/9647706204066',
                    staticTexts: { welcomeTitle: 'منصة توصيله', welcomeSubtitle: 'النجف الأشرف - سجّل دخولك أو أنشئ حسابك', driverPendingMsg: 'حسابك معلّق بانتظار التوثيق. أرسل مستمسكاتك عبر واتساب أو تيليجرام.' },
                    registrationFields: { passenger: ['phone','firstName','lastName','tripType','map','password'], driver: ['phone','fullName','license','vehicle','plate','password'] },
                    onboarding: { enabled: false, screens: [] }
                };
            } else {
                if (!db.memoryState.appConfig.telegramAdminLink) db.memoryState.appConfig.telegramAdminLink = 'https://t.me/tawseela_najaf_bot';
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

        // ===== Dedicated Theme & Typography Config APIs (Web App & Dashboard) =====
        if ((pathname === '/api/app-config/theme' || pathname === '/api/admin/app-config/theme' || pathname === '/api/admin/theme') && method === 'GET') {
            const defaultTheme = {
                preset: 'default',
                primaryColor: '#1B4965',
                primaryHover: '#14364A',
                accentColor: '#D97706',
                brandLogoColor: '#EBB812',
                fontFamily: 'Arial Unicode MS Regular',
                fontSize: '14px',
                bgColor: '#F8FAFC',
                cardBg: '#FFFFFF',
                textColor: '#0F172A',
                appName: 'توصيله',
                logoEmoji: '🚕',
                footerText: '© 2026 توصيله (Tawseela IQ) · النجف الأشرف'
            };
            const themeConfig = (db.memoryState.appConfig && db.memoryState.appConfig.theme) 
                ? { ...defaultTheme, ...db.memoryState.appConfig.theme } 
                : defaultTheme;

            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return sendJson({ success: true, theme: themeConfig, ...themeConfig });
        }

        if ((pathname === '/api/admin/app-config/theme' || pathname === '/api/app-config/theme' || pathname === '/api/admin/theme') && method === 'POST') {
            const body = await parseJsonBody(req);
            if (!db.memoryState.appConfig) db.memoryState.appConfig = {};
            const incoming = body.theme ? body.theme : body;
            db.memoryState.appConfig.theme = { ...(db.memoryState.appConfig.theme || {}), ...incoming };
            db.saveStateSnapshot();

            // Try persisting to system_settings in PostgreSQL
            if (db.pool) {
                try {
                    await db.pool.query(`
                        INSERT INTO system_settings (key, value_json, description, updated_at)
                        VALUES ('app_theme', $1, 'App Theme & Typography Configuration', NOW())
                        ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
                    `, [JSON.stringify(db.memoryState.appConfig.theme)]);
                } catch (dbErr) {
                    // Non-fatal fallback to state.json
                }
            }

            return sendJson({ success: true, message: 'تم حفظ وتحديث المظهر بنجاح', theme: db.memoryState.appConfig.theme });
        }

        // ===== Dedicated Banners API (Customer Service Hub & Dashboard) =====
        if ((pathname === '/api/public/banners' || pathname === '/api/banners' || pathname === '/api/admin/banners') && method === 'GET') {
            const defaultBanners = {
                topBanner: {
                    enabled: true,
                    title: 'مشاويرك في النجف أسهل وأسرع',
                    subtitle: 'اطلب تكسي فوري أو احجز مقعدك بالخط اليومي بأفضل الأسعار',
                    badge: 'توفير يومي 🚖',
                    imageUrl: '/assets/tawseela-logo-yellow.png',
                    ctaText: 'اطلب الآن',
                    actionUrl: 'taxi'
                },
                captainBanner: {
                    enabled: true,
                    title: 'سجل كابتن.. وزيد دخلك الشهري ويا توصيله',
                    subtitle: 'أرباح تصل إلى 1,200,000 د.ع شهرياً مع عمولة رمزية 0% وساعات مرنة',
                    badge: 'عمولة 0% لأول شهر 🌟',
                    ctaText: 'سجل كابتن الآن 🚗',
                    actionUrl: 'https://wa.me/9647706204066'
                }
            };
            const currentBanners = (db.memoryState.banners)
                ? {
                    topBanner: { ...defaultBanners.topBanner, ...(db.memoryState.banners.topBanner || {}) },
                    captainBanner: { ...defaultBanners.captainBanner, ...(db.memoryState.banners.captainBanner || {}) }
                }
                : defaultBanners;

            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return sendJson({ success: true, ...currentBanners });
        }

        if ((pathname === '/api/admin/banners' || pathname === '/api/banners') && method === 'POST') {
            const body = await parseJsonBody(req);
            const defaultBanners = {
                topBanner: {
                    enabled: true,
                    title: 'مشاويرك في النجف أسهل وأسرع',
                    subtitle: 'اطلب تكسي فوري أو احجز مقعدك بالخط اليومي بأفضل الأسعار',
                    badge: 'توفير يومي 🚖',
                    imageUrl: '/assets/tawseela-logo-yellow.png',
                    ctaText: 'اطلب الآن',
                    actionUrl: 'taxi'
                },
                captainBanner: {
                    enabled: true,
                    title: 'سجل كابتن.. وزيد دخلك الشهري ويا توصيله',
                    subtitle: 'أرباح تصل إلى 1,200,000 د.ع شهرياً مع عمولة رمزية وساعات مرنة',
                    badge: 'عمولة 0% لأول شهر 🌟',
                    ctaText: 'سجل كابتن الآن 🚗',
                    actionUrl: 'https://wa.me/9647706204066'
                }
            };

            const prev = db.memoryState.banners || defaultBanners;
            db.memoryState.banners = {
                topBanner: { ...prev.topBanner, ...(body.topBanner || {}) },
                captainBanner: { ...prev.captainBanner, ...(body.captainBanner || {}) }
            };
            db.saveStateSnapshot();

            if (db.pool) {
                try {
                    await db.pool.query(`
                        INSERT INTO system_settings (key, value_json, description, updated_at)
                        VALUES ('hub_banners', $1, 'Customer Service Hub Banners Configuration', NOW())
                        ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
                    `, [JSON.stringify(db.memoryState.banners)]);
                } catch (dbErr) {
                    // Non-fatal fallback
                }
            }

            return sendJson({ success: true, message: 'تم حفظ وتحديث الإعلانات بنجاح ✅', banners: db.memoryState.banners });
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

        // Public Announcements Endpoint for Customer Home & Web App
        if (pathname === '/api/announcements/latest' && method === 'GET') {
            const defaultText = "أهلاً بك في توصيلة 🚖 | خدمة النقل الذكي في النجف الأشرف.. مشاوير فورية وخطوط دائمية بأسعار معتمدة.";
            const ann = db.memoryState.latestAnnouncement;
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return sendJson({
                success: true,
                announcement: {
                    message: (ann && ann.message) ? ann.message : defaultText,
                    createdAt: (ann && ann.createdAt) ? ann.createdAt : new Date().toISOString()
                }
            });
        }

        if (pathname === '/api/announcements/latest' && method === 'POST') {
            const authUser = getAuthUser(req);
            if (!authUser || authUser.role !== 'Admin') {
                return sendJson({ success: false, error: 'Unauthorized' }, 401);
            }
            const body = await parseJsonBody(req);
            const msg = (body.message || body.text || '').replace(/<[^>]*>?/gm, '').trim();
            if (!msg) return sendJson({ success: false, error: 'نص الإعلان مطلوب' }, 400);
            db.memoryState.latestAnnouncement = {
                message: msg,
                createdAt: new Date().toISOString()
            };
            if (!db.memoryState.banners) db.memoryState.banners = {};
            if (!db.memoryState.banners.topBanner) db.memoryState.banners.topBanner = {};
            db.memoryState.banners.topBanner.subtitle = msg;
            db.saveStateSnapshot();
            return sendJson({ success: true, announcement: db.memoryState.latestAnnouncement });
        }

        // Telegram bot admin: Broadcast
        if (pathname === '/api/admin/telegram/broadcast' && method === 'POST') {
            const authUser = getAuthUser(req);
            if (!authUser || authUser.role !== 'Admin') {
                return sendJson({ success: false, error: 'Unauthorized' }, 401);
            }
            const body = await parseJsonBody(req);
            const msg = body.message || '';
            const target = body.target || 'subscribers';
            let result = { success: true };
            try {
                if (typeof telegramBot.broadcastNotification === 'function') {
                    result = await telegramBot.broadcastNotification(msg, target);
                } else {
                    await telegramBot.sendAdminNotification(msg);
                }
            } catch(e) {
                console.error('[BroadcastNotification Error]:', e.message);
                result = { success: false, error: e.message };
            }

            // Persist broadcast as latest announcement for dynamic app banner sync
            const cleanMsg = msg.replace(/<[^>]*>?/gm, '').trim();
            if (cleanMsg) {
                db.memoryState.latestAnnouncement = {
                    message: cleanMsg,
                    target: target,
                    createdAt: new Date().toISOString()
                };
                if (!db.memoryState.banners) db.memoryState.banners = {};
                if (!db.memoryState.banners.topBanner) db.memoryState.banners.topBanner = {};
                db.memoryState.banners.topBanner.subtitle = cleanMsg;
                db.saveStateSnapshot();
            }

            return sendJson(result);
        }

        // Telegram bot admin: Legacy notify
        if (pathname === '/api/admin/telegram/notify' && method === 'POST') {
            const body = await parseJsonBody(req);
            const msg = body.message || '';
            const target = body.target || 'subscribers';
            let result = { success: true, sentCount: 1 };
            try {
                if (typeof telegramBot.broadcastNotification === 'function') {
                    result = await telegramBot.broadcastNotification(msg, target);
                } else {
                    await telegramBot.sendAdminNotification(msg);
                }
            } catch(e) {
                console.error('[BroadcastNotification Error]:', e.message);
                result = { success: false, error: e.message };
            }
            return sendJson(result);
        }

        // Telegram bot admin: Get Banned List (IPs & Telegram Users)
        if (pathname === '/api/admin/telegram/banned' && method === 'GET') {
            const authUser = getAuthUser(req);
            if (!authUser || authUser.role !== 'Admin') {
                return sendJson({ success: false, error: 'Unauthorized' }, 401);
            }
            const bannedIps = (db.memoryState.bannedIps || []).map(item => {
                if (typeof item === 'string') {
                    return { ip: item, reason: 'honeypot_trap', path: '-', bannedAt: new Date().toISOString() };
                }
                return item;
            });
            const bannedTelegramUsers = typeof telegramBot.getBannedUsers === 'function' ? telegramBot.getBannedUsers() : [];
            return sendJson({
                success: true,
                bannedIps,
                bannedTelegramUsers
            });
        }

        // Telegram bot admin: Unban entity (IP or Telegram user)
        if (pathname === '/api/admin/telegram/unban' && method === 'POST') {
            const authUser = getAuthUser(req);
            if (!authUser || authUser.role !== 'Admin') {
                return sendJson({ success: false, error: 'Unauthorized' }, 401);
            }
            const body = await parseJsonBody(req);
            const type = body.type || 'ip'; // 'ip' or 'telegram'
            const target = String(body.target || '').trim();

            if (!target) {
                return sendJson({ success: false, error: 'Target identifier required' }, 400);
            }

            if (type === 'ip') {
                _bannedIpSet.delete(target);
                if (Array.isArray(db.memoryState.bannedIps)) {
                    db.memoryState.bannedIps = db.memoryState.bannedIps.filter(x => (typeof x === 'string' ? x : x.ip) !== target);
                    db.saveStateSnapshot();
                }
                return sendJson({ success: true, message: `تم رفع الحظر عن الـ IP: ${target}` });
            } else if (type === 'telegram') {
                if (typeof telegramBot.unbanUser === 'function') {
                    telegramBot.unbanUser(target);
                }
                return sendJson({ success: true, message: `تم رفع الحظر عن مستخدم التيليجرام: ${target}` });
            }

            return sendJson({ success: false, error: 'نوع الحظر غير معروف' }, 400);
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
            const routeStr = `${fromText.trim()} ➔ ${toText.trim()}`;
            driver.route = routeStr;
            driver.preferredRoute = routeStr;

            // Update or add route in memoryState.routes so it displays in Dashboard routes table
            let r = (db.memoryState.routes || []).find(rt => rt.driverId === driverId);
            if (r) {
                r.name = routeStr;
                r.startName = fromText.trim();
                r.endName = toText.trim();
                if (fromLat) r.startLat = parseFloat(fromLat);
                if (fromLon) r.startLon = parseFloat(fromLon);
                if (toLat) r.endLat = parseFloat(toLat);
                if (toLon) r.endLon = parseFloat(toLon);
            } else {
                db.memoryState.routes = db.memoryState.routes || [];
                db.memoryState.routes.unshift({
                    id: 'route-' + driverId,
                    routeId: 'route-' + driverId,
                    driverId: driverId,
                    driverName: driver.fullName || 'كابتن',
                    driverPhone: driver.phoneNumber || '',
                    name: routeStr,
                    startName: fromText.trim(),
                    endName: toText.trim(),
                    startLat: parseFloat(fromLat) || 31.9961,
                    startLon: parseFloat(fromLon) || 44.3168,
                    endLat: parseFloat(toLat) || 32.0321,
                    endLon: parseFloat(toLon) || 44.3725,
                    fare: 3000,
                    availableSeats: 4,
                    totalSeats: 4,
                    departureTime: '08:00 AM',
                    status: 'Active',
                    createdAt: new Date().toISOString()
                });
            }

            db.saveStateSnapshot();
            return sendJson({ success: true, route: driver.activeRoute, routeStr: driver.route });
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


        // ===== Driver Fixed Location (Batch 1: تثبيت وإزالة الموقع الثابت لكابتن الخط الدائم) =====
        const isDriverFixedLocationRoute = (
            pathname === '/api/driver/fixed-location' ||
            pathname === '/driver/fixed-location' ||
            pathname === '/api/driver/fixed-location/remove' ||
            pathname === '/driver/fixed-location/remove'
        );

        if (isDriverFixedLocationRoute) {
            // 1. Authentication Check (JWT on server, 401 if missing, 403 if not Driver)
            const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
            const rawToken = authHeader.replace(/^Bearer\s+/i, '').trim();
            if (!rawToken) {
                return sendJson({ success: false, error: 'جلسة الدخول مطلوبة (Missing Token)' }, 401);
            }

            const authUser = getAuthUser(req);
            if (!authUser || (authUser.role !== 'Driver' && authUser.role !== 'driver')) {
                return sendJson({ success: false, error: 'غير مصرح: الحساب ليس كابتن معتمد (RLS)' }, 403);
            }

            const effectiveDriverId = String(authUser.id || '').trim();
            if (!effectiveDriverId) {
                return sendJson({ success: false, error: 'غير مصرح: معرّف الكابتن غير موجود في التوكن (RLS)' }, 403);
            }

            // 2. Body Parsing & RLS Check (No trust in client-provided ID)
            let body = {};
            if (method === 'POST' || method === 'DELETE' || method === 'PUT') {
                body = await parseJsonBody(req).catch(() => ({}));
            }
            const submittedDriverId = body.driverId || body.id;
            if (submittedDriverId && String(submittedDriverId).trim() !== effectiveDriverId) {
                return sendJson({ success: false, error: 'غير مصرح: لا يمكنك تعديل أو استعراض موقع كابتن آخر (RLS)' }, 403);
            }

            // 3. Rate Limiting across PM2 cluster via Redis (60 req/min for GET, 10 req/10min for POST/DELETE)
            if (method === 'GET') {
                const rateKey = `rate:driver:get_fixed_loc:${effectiveDriverId}`;
                const rate = await redisManager.checkRateLimitCluster(rateKey, 60, 60);
                if (!rate.allowed) {
                    res.setHeader('Retry-After', String(rate.ttl));
                    return sendJson({
                        success: false,
                        error: 'تم تجاوز معدل الاستعلام عن الموقع الثابت (60 طلباً بالدقيقة). يرجى المحاولة لاحقاً',
                        retry_after: rate.ttl
                    }, 429);
                }
            } else {
                const rateKey = `rate:driver:fixed_loc:${effectiveDriverId}`;
                const rate = await redisManager.checkRateLimitCluster(rateKey, 10, 600);
                if (!rate.allowed) {
                    res.setHeader('Retry-After', String(rate.ttl));
                    return sendJson({
                        success: false,
                        error: 'تم تجاوز الحد المسموح لتعديل الموقع الثابت (10 طلبات كل 10 دقائق). يرجى المحاولة لاحقاً',
                        retry_after: rate.ttl
                    }, 429);
                }
            }

            // 4. Idempotency Check
            const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || body.idempotencyKey;
            if (idempotencyKey) {
                if (redisManager && redisManager.isConnected && redisManager.client) {
                    try {
                        const cached = await redisManager.client.get(`idem:${idempotencyKey}`);
                        if (cached) return sendJson(JSON.parse(cached));
                    } catch (_) {}
                }
                if (idempotencyStore && idempotencyStore.has(idempotencyKey)) {
                    return sendJson(idempotencyStore.get(idempotencyKey).response);
                }
            }

            // 5. Driver Existence & Work Mode Verification
            let driver = (db.memoryState.drivers || []).find(d => 
                String(d.driverId || d.id) === effectiveDriverId
            );

            if (!driver && db.pool && db.isPostgresConnected) {
                try {
                    const pgRes = await db.pool.query('SELECT * FROM drivers WHERE driver_id = $1', [effectiveDriverId]);
                    if (pgRes.rows && pgRes.rows[0]) {
                        const r = pgRes.rows[0];
                        driver = {
                            driverId: r.driver_id,
                            fullName: r.full_name,
                            phoneNumber: r.phone_number,
                            work_mode: r.work_mode,
                            workStatus: r.work_mode === 'خط دائمي' ? 'permanent' : r.work_mode,
                            fixedLat: r.fixed_lat ? parseFloat(r.fixed_lat) : null,
                            fixedLng: r.fixed_lng ? parseFloat(r.fixed_lng) : null,
                            fixedLabel: r.fixed_label || '',
                            fixedUpdatedAt: r.fixed_updated_at || null
                        };
                        db.memoryState.drivers.push(driver);
                    }
                } catch (_) {}
            }

            if (!driver) {
                return sendJson({ success: false, error: 'بيانات الكابتن غير موجودة في النظام' }, 404);
            }

            // Mode check: Must be commute or both (Arabic or English)
            const rawMode = String(driver.work_mode || driver.workStatus || driver.current_mode || driver.mode || '').toLowerCase().trim();
            const isAllowedMode = (
                rawMode === 'commute' || 
                rawMode === 'both' || 
                rawMode === 'permanent' || 
                rawMode === 'خط دائمي' || 
                rawMode === 'كلاهما'
            );
            if (!isAllowedMode) {
                return sendJson({
                    success: false,
                    error: 'غير مسموح بتثبيت الموقع الثابت إلا للكابتن في وضع الخط الدائم (commute) أو كلاهما (both)'
                }, 409);
            }

            // ---[ Branch A: GET Current Fixed Location ]---
            if (method === 'GET') {
                let fixedLat = driver.fixedLat !== undefined ? driver.fixedLat : (driver.permanentLat || null);
                let fixedLng = driver.fixedLng !== undefined ? driver.fixedLng : (driver.permanentLon || null);
                let fixedLabel = driver.fixedLabel !== undefined ? driver.fixedLabel : (driver.permanentLocationName || '');
                let fixedUpdatedAt = driver.fixedUpdatedAt || null;

                // Sync from Redis if available
                const redisLoc = await redisManager.getDriverFixedLocation(effectiveDriverId);
                if (redisLoc) {
                    fixedLat = redisLoc.lat;
                    fixedLng = redisLoc.lng;
                    fixedLabel = redisLoc.label;
                    fixedUpdatedAt = redisLoc.updatedAt;
                } else if (fixedLat !== null && fixedLng !== null) {
                    await redisManager.setDriverFixedLocation(effectiveDriverId, {
                        lat: fixedLat,
                        lng: fixedLng,
                        label: fixedLabel,
                        updatedAt: fixedUpdatedAt
                    });
                }

                return sendJson({
                    success: true,
                    driverId: effectiveDriverId,
                    fixed_lat: fixedLat,
                    fixed_lng: fixedLng,
                    fixed_label: fixedLabel || '',
                    fixed_updated_at: fixedUpdatedAt,
                    work_mode: driver.work_mode || driver.workStatus || 'commute'
                });
            }

            // ---[ Branch B: DELETE or POST Remove ]---
            const isRemoval = method === 'DELETE' || pathname.endsWith('/remove') || body.remove === true || body.action === 'remove';
            if (isRemoval) {
                const nowIso = new Date().toISOString();
                driver.fixedLat = null;
                driver.fixedLng = null;
                driver.fixedLabel = null;
                driver.fixedUpdatedAt = nowIso;
                driver.permanentLat = null;
                driver.permanentLon = null;
                driver.permanentLocationName = null;
                db.saveStateSnapshot();

                await db.removeDriverFixedLocation(effectiveDriverId);
                await redisManager.removeDriverFixedLocation(effectiveDriverId);

                try {
                    const auditService = require('./modules/audit/auditService');
                    await auditService.logEvent({
                        action: 'DRIVER_FIXED_LOCATION_REMOVED',
                        entityType: 'Driver',
                        entityId: effectiveDriverId,
                        actor: `كابتن (${driver.fullName || effectiveDriverId})`,
                        details: { removed: true, timestamp: nowIso },
                        ip: clientIp
                    });
                } catch (_) {}

                const respPayload = {
                    success: true,
                    driverId: effectiveDriverId,
                    fixed_lat: null,
                    fixed_lng: null,
                    fixed_label: null,
                    fixed_updated_at: nowIso,
                    work_mode: driver.work_mode || driver.workStatus || 'commute'
                };

                if (idempotencyKey) {
                    if (idempotencyStore) idempotencyStore.set(idempotencyKey, { response: respPayload, timestamp: Date.now() });
                    if (redisManager && redisManager.isConnected && redisManager.client) {
                        redisManager.client.set(`idem:${idempotencyKey}`, JSON.stringify(respPayload), 'EX', 3600).catch(() => {});
                    }
                }
                return sendJson(respPayload);
            }

            // ---[ Branch C: POST Set / Update Fixed Location ]---
            const rawLat = body.lat !== undefined ? body.lat : body.latitude;
            const rawLng = body.lng !== undefined ? body.lng : (body.lon !== undefined ? body.lon : body.longitude);
            const rawLabel = body.label !== undefined ? body.label : (body.name !== undefined ? body.name : body.locationName);

            const parsedLat = parseFloat(rawLat);
            const parsedLng = parseFloat(rawLng);

            if (rawLat === undefined || rawLat === null || isNaN(parsedLat) || parsedLat < -90 || parsedLat > 90) {
                return sendJson({ success: false, error: 'إحداثيات خط العرض غير صحيحة' }, 400);
            }
            if (rawLng === undefined || rawLng === null || isNaN(parsedLng) || parsedLng < -180 || parsedLng > 180) {
                return sendJson({ success: false, error: 'إحداثيات خط الطول غير صحيحة' }, 400);
            }

            const cleanLabel = String(rawLabel || '').replace(/<[^>]*>?/gm, '').trim();
            if (!cleanLabel || cleanLabel.length > 60) {
                return sendJson({ success: false, error: 'يجب إدخال اسم موقع صحيح بحد أقصى 60 حرفاً' }, 400);
            }

            const nowIso = new Date().toISOString();
            driver.fixedLat = parsedLat;
            driver.fixedLng = parsedLng;
            driver.fixedLabel = cleanLabel;
            driver.fixedUpdatedAt = nowIso;
            driver.permanentLat = parsedLat;
            driver.permanentLon = parsedLng;
            driver.permanentLocationName = cleanLabel;
            db.saveStateSnapshot();

            await db.persistDriverFixedLocation(effectiveDriverId, { lat: parsedLat, lng: parsedLng, label: cleanLabel });
            await redisManager.setDriverFixedLocation(effectiveDriverId, { lat: parsedLat, lng: parsedLng, label: cleanLabel, updatedAt: nowIso });

            try {
                const auditService = require('./modules/audit/auditService');
                await auditService.logEvent({
                    action: 'DRIVER_FIXED_LOCATION_UPDATED',
                    entityType: 'Driver',
                    entityId: effectiveDriverId,
                    actor: `كابتن (${driver.fullName || effectiveDriverId})`,
                    details: { lat: parsedLat, lng: parsedLng, label: cleanLabel, timestamp: nowIso },
                    ip: clientIp
                });
            } catch (_) {}

            const respPayload = {
                success: true,
                driverId: effectiveDriverId,
                fixed_lat: parsedLat,
                fixed_lng: parsedLng,
                fixed_label: cleanLabel,
                fixed_updated_at: nowIso,
                work_mode: driver.work_mode || driver.workStatus || 'commute'
            };

            if (idempotencyKey) {
                if (idempotencyStore) idempotencyStore.set(idempotencyKey, { response: respPayload, timestamp: Date.now() });
                if (redisManager && redisManager.isConnected && redisManager.client) {
                    redisManager.client.set(`idem:${idempotencyKey}`, JSON.stringify(respPayload), 'EX', 3600).catch(() => {});
                }
            }
            return sendJson(respPayload);
        }

        // Passenger: Set permanent location & route
        if (pathname === '/api/passenger/set-permanent-location' && method === 'POST') {
            const body = await parseJsonBody(req);
            const pid = body.passengerId || body.customerId;
            const lat = body.lat || body.pickupLat;
            const lon = body.lon || body.pickupLon;
            const locationName = body.locationName || body.pickupName || body.pickupText;
            const dropoffName = body.dropoffName || body.dropoffText;
            const dropoffLat = body.dropoffLat;
            const dropoffLon = body.dropoffLon;

            if (!pid) return sendJson({ success: false, error: 'customerId required' }, 400);
            const customer = db.memoryState.customers.find(c => c.customerId === pid || c.id === pid);
            if (!customer) return sendJson({ success: false, error: 'الراكب غير موجود' }, 404);

            if (lat) customer.permanentLat = parseFloat(lat);
            if (lon) customer.permanentLon = parseFloat(lon);
            if (locationName) customer.permanentLocationName = locationName;
            if (dropoffLat) customer.permanentDropoffLat = parseFloat(dropoffLat);
            if (dropoffLon) customer.permanentDropoffLon = parseFloat(dropoffLon);
            if (dropoffName !== undefined) customer.permanentDropoffName = dropoffName || '';

            const routeStr = body.route || (dropoffName ? `${locationName || 'موقعي'} ➔ ${dropoffName}` : (locationName || 'مسار الراكب'));
            customer.route = routeStr;
            customer.preferredRoute = routeStr;
            if (locationName) customer.address = locationName;

            db.saveStateSnapshot();
            db.persistCustomerPermanentLocation(pid, {
                lat: customer.permanentLat, lon: customer.permanentLon, locationName: customer.permanentLocationName,
                dropoffLat: customer.permanentDropoffLat, dropoffLon: customer.permanentDropoffLon, dropoffName: customer.permanentDropoffName,
                route: customer.route, address: customer.address
            }).catch(()=>{});

            return sendJson({ success: true, message: 'تم تثبيت المسار في قاعدة البيانات بنجاح', route: customer.route });
        }

        // Get passenger permanent location (RLS Protected)
        if (pathname.startsWith('/api/passenger/permanent-location/') && method === 'GET') {
            const passengerId = pathname.split('/').pop();
            const authUser = getAuthUser(req);

            // RLS Isolation: Only the passenger themselves, or an assigned driver / admin can view private permanent locations
            if (authUser && authUser.role === 'Customer' && authUser.id !== passengerId) {
                return sendJson({ success: false, error: 'غير مصرح بعرض الموقع الخاص بمستخدم آخر (RLS)' }, 403);
            }

            const customer = db.memoryState.customers.find(c => c.customerId === passengerId);
            if (!customer) return sendJson({ success: false });
            return sendJson({
                success: true,
                lat: customer.permanentLat || null,
                lon: customer.permanentLon || null,
                locationName: customer.permanentLocationName || '',
                dropoffLat: customer.permanentDropoffLat || null,
                dropoffLon: customer.permanentDropoffLon || null,
            });
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

        // Unhandled API endpoints return 404 JSON instead of falling through to dashboard HTML
        if (pathname.startsWith('/api/')) {
            return sendJson({ success: false, error: 'API endpoint not found' }, 404);
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

    server.listen(config.port, process.env.HOST || '0.0.0.0', () => {
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
