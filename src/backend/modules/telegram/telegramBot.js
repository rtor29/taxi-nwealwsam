'use strict';
const https = require('https');
const config = require('../../config');
const db = require('../../db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
if (!BOT_TOKEN) { console.error('[TelegramBot] TELEGRAM_BOT_TOKEN env var is required!'); }
const ADMIN_CHAT_ID = '391762837';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// OTP store for telegram
const telegramOtpStore = new Map();
// User state machine
const userStates = new Map();

// --- Iraq Governorates for Registration Step 2 ---
const IRAQ_GOVERNORATES = [
    { key: 'baghdad', name: 'بغداد' },
    { key: 'najaf', name: 'النجف' },
    { key: 'karbala', name: 'كربلاء' },
    { key: 'basra', name: 'البصرة' },
    { key: 'babil', name: 'بابل' },
    { key: 'erbil', name: 'أربيل' },
    { key: 'sulaymaniyah', name: 'السليمانية' },
    { key: 'kirkuk', name: 'كركوك' },
    { key: 'nineveh', name: 'نينوى' },
    { key: 'anbar', name: 'الأنبار' },
    { key: 'diyala', name: 'ديالى' },
    { key: 'wasit', name: 'واسط' },
    { key: 'saladin', name: 'صلاح الدين' },
    { key: 'dhi_qar', name: 'ذي قار' },
    { key: 'maysan', name: 'ميسان' },
    { key: 'muthanna', name: 'المثنى' },
    { key: 'qadisiyyah', name: 'القادسية' },
    { key: 'duhok', name: 'دهوك' }
];

function getGovernoratesKeyboard(rolePrefix) {
    const rows = [];
    for (let i = 0; i < IRAQ_GOVERNORATES.length; i += 3) {
        const row = IRAQ_GOVERNORATES.slice(i, i + 3).map(g => ({
            text: g.name,
            callback_data: `tgov_${rolePrefix}_${g.key}`
        }));
        rows.push(row);
    }
    return rows;
}

// ===================================================================
// --- SECURITY LAYER: Anti-Spam, Rate Limit, Flood & Bot Protection ---
// ===================================================================
const _tgRateMap = new Map();       // chatId -> { count, resetAt }
const _tgFloodMap = new Map();      // chatId -> { msgs: [], warned }
const _tgBannedUsers = new Set();   // permanently blocked chatIds this session
const _tgSuspiciousLog = [];        // log of suspicious activity

// Cleanup every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _tgRateMap) { if (now > v.resetAt) _tgRateMap.delete(k); }
    for (const [k, v] of _tgFloodMap) {
        v.msgs = v.msgs.filter(t => now - t < 60000);
        if (v.msgs.length === 0) _tgFloodMap.delete(k);
    }
    // Keep only last 200 suspicious logs
    if (_tgSuspiciousLog.length > 200) _tgSuspiciousLog.splice(0, _tgSuspiciousLog.length - 200);
}, 300000);

// Rate limit: max messages per window per user
function _tgRateLimit(chatId, max = 20, windowMs = 60000) {
    const key = String(chatId);
    const now = Date.now();
    let entry = _tgRateMap.get(key);
    if (!entry || now > entry.resetAt) {
        entry = { count: 1, resetAt: now + windowMs };
        _tgRateMap.set(key, entry);
        return false;
    }
    entry.count++;
    return entry.count > max;
}

// Flood detection: too many messages in short burst
function _tgFloodCheck(chatId, maxBurst = 8, burstWindowMs = 10000) {
    const key = String(chatId);
    const now = Date.now();
    let entry = _tgFloodMap.get(key) || { msgs: [], warned: false };
    entry.msgs.push(now);
    entry.msgs = entry.msgs.filter(t => now - t < burstWindowMs);
    _tgFloodMap.set(key, entry);
    return entry.msgs.length > maxBurst;
}

// Suspicious content detection (code injection, bot commands, source code probing)
const SUSPICIOUS_PATTERNS = [
    /\/?(get|show|dump|export|print|cat|type|head|tail)\s*(source|code|config|env|token|secret|password|key|db|database|server|\.js|\.env|\.json)/i,
    /process\.env/i,
    /require\s*\(/i,
    /eval\s*\(/i,
    /exec\s*\(/i,
    /child_process/i,
    /\bfs\b\.\w+/i,
    /SELECT\s+.*\s+FROM/i,
    /DROP\s+TABLE/i,
    /INSERT\s+INTO/i,
    /UPDATE\s+.*\s+SET/i,
    /DELETE\s+FROM/i,
    /UNION\s+SELECT/i,
    /<script/i,
    /javascript:/i,
    /on(error|load|click)\s*=/i,
    /\.\.\//,
    /\/etc\/passwd/i,
    /bot_?token/i,
    /admin_?chat/i,
    /api[_\s]?key/i,
    /database[_\s]?url/i,
    /\{.*\{.*\}\}/,
    /__proto__/,
    /constructor\s*\[/,
];

function _isSuspiciousText(text) {
    if (!text || typeof text !== 'string') return false;
    for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(text)) return true;
    }
    return false;
}

// Sanitize user text input
function _sanitizeTgInput(text) {
    if (!text || typeof text !== 'string') return '';
    // Strip control characters except newline/tab, limit length
    let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    if (clean.length > 500) clean = clean.substring(0, 500);
    return clean;
}

// Master security gate - returns null if OK, or error string if blocked
function _securityGate(chatId, text) {
    const cid = String(chatId);

    // 1. Check permanent ban
    if (_tgBannedUsers.has(cid)) return 'banned';

    // 2. Rate limit (20 msgs/min)
    if (_tgRateLimit(chatId, 20, 60000)) {
        _tgSuspiciousLog.push({ chatId: cid, reason: 'rate_limit', time: new Date().toISOString() });
        return 'rate_limit';
    }

    // 3. Flood detection (8 msgs in 10 sec)
    if (_tgFloodCheck(chatId, 8, 10000)) {
        _tgSuspiciousLog.push({ chatId: cid, reason: 'flood', text: (text || '').substring(0, 80), time: new Date().toISOString() });
        // Auto-ban after flood
        _tgBannedUsers.add(cid);
        return 'flood_ban';
    }

    // 4. Suspicious content / source code probing
    if (_isSuspiciousText(text)) {
        _tgSuspiciousLog.push({ chatId: cid, reason: 'suspicious', text: (text || '').substring(0, 120), time: new Date().toISOString() });
        return 'suspicious';
    }

    return null; // OK
}
// ===================================================================

// --- Telegram API Helpers ---
function tgRequest(method, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body || {});
        const url = new URL(`${API_BASE}/${method}`);
        const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({ ok: false }); } });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function sendMessage(chatId, text, opts = {}) {
    return tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });
}

function sendKeyboard(chatId, text, buttons) {
    return sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: buttons }
    });
}

// --- Direct Local Telegram OTP (VerifyWay Completely Removed) ---
async function sendTelegramOtp(phone, chatId) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    // Normalize phone
    let normalized = String(phone).replace(/[^0-9+]/g, '');
    if (normalized.startsWith('07')) normalized = '+964' + normalized.substring(1);
    else if (normalized.startsWith('7') && normalized.length === 10) normalized = '+964' + normalized;
    else if (!normalized.startsWith('+')) normalized = '+' + normalized;

    telegramOtpStore.set(String(chatId), { code, phone: normalized, expires: Date.now() + 300000 });

    const text = `🔐 رمز التحقق الخاص بك هو: <code>${code}</code>\n\n👆 <i>اضغط على الرمز لنسخه مباشرة</i>\nقم بإرسال هذا الرمز هنا لتأكيد رقمك وإكمال التسجيل:`;
    await sendMessage(chatId, text);
    return { success: true, code, phone: normalized };
}

function verifyTelegramOtp(chatId, code) {
    const entry = telegramOtpStore.get(String(chatId));
    if (!entry) return { valid: false, error: 'لا يوجد رمز مُرسل. أعد طلب الرمز.' };
    if (Date.now() > entry.expires) { telegramOtpStore.delete(String(chatId)); return { valid: false, error: 'انتهت صلاحية الرمز. أعد الطلب.' }; }
    if (entry.code !== String(code).trim()) return { valid: false, error: 'الرمز غير صحيح.' };
    telegramOtpStore.delete(String(chatId));
    return { valid: true, phone: entry.phone };
}

// --- Phone Normalization & Registration Check ---
function normalizePhoneNumber(input) {
    if (!input) return '';
    let s = String(input).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
    s = s.replace(/[^0-9]/g, '');
    if (s.startsWith('00964')) s = s.substring(5);
    else if (s.startsWith('964')) s = s.substring(3);
    if (s.length === 10 && s.startsWith('7')) s = '0' + s;
    return s;
}

async function checkPhoneRegistration(phone) {
    const norm = normalizePhoneNumber(phone);
    if (!norm || norm.length < 8) return null;

    const matchPhone = (stored) => {
        if (!stored) return false;
        const s = normalizePhoneNumber(stored);
        return s === norm || (norm.length >= 7 && s.endsWith(norm.substring(norm.length - 7)));
    };

    const customer = (db.memoryState.customers || []).find(c => matchPhone(c.phoneNumber));
    if (customer) {
        return { isRegistered: true, role: 'Customer', roleAr: 'كراكب', user: customer };
    }

    const driver = (db.memoryState.drivers || []).find(d => matchPhone(d.phoneNumber));
    if (driver) {
        return { isRegistered: true, role: 'Driver', roleAr: 'كسائق', user: driver };
    }

    if (db.isPostgresConnected && db.pool) {
        try {
            const res = await db.pool.query(
                `SELECT role, full_name, phone_number FROM users WHERE phone_number LIKE $1 OR phone_number = $2 LIMIT 1`,
                [`%${norm.substring(norm.length - 7)}`, norm]
            );
            if (res.rows && res.rows.length > 0) {
                const row = res.rows[0];
                const isDriver = (row.role || '').toLowerCase() === 'driver';
                return {
                    isRegistered: true,
                    role: isDriver ? 'Driver' : 'Customer',
                    roleAr: isDriver ? 'كسائق' : 'كراكب',
                    user: row
                };
            }
        } catch (_) {}
    }

    return null;
}

// --- Bot Command Handlers ---
async function handleStart(chatId, user) {
    if (!db.memoryState.botSubscribers) db.memoryState.botSubscribers = [];
    if (!db.memoryState.botSubscribers.includes(String(chatId))) { db.memoryState.botSubscribers.push(String(chatId)); db.saveStateSnapshot(); }

    userStates.delete(chatId);
    const name = (user && user.first_name) ? user.first_name : 'مستخدم';
    
    // Check if user is an already registered customer or driver
    const customer = (db.memoryState.customers || []).find(c => String(c.telegramChatId) === String(chatId));
    const driver = (db.memoryState.drivers || []).find(d => String(d.telegramChatId) === String(chatId));

    if (customer) {
        const token = 'jwt_customer_' + customer.customerId;
        await sendKeyboard(chatId,
            `مرحباً بك <b>${customer.fullName}</b> في بوت توصيله 🚕\n\nيرجى تحديد نوع المشوار المطلوب:\n\n💡 <i>ملاحظة للايفون: إذا فتحت التطبيق ولم يظهر موقعك، اضغط على 🧭 (البوصلة) في الأسفل لفتحه في سفاري.</i>`,
            [
                [
                    { text: '⚡ مشوار قصير', callback_data: 'passenger_trip_short' },
                    { text: '🔄 خط دائم', callback_data: 'passenger_trip_daily' }
                ],
                [{ text: '🗺️ فتح خريطة الخطوط الدائمية (WebApp)', web_app: { url: 'https://tawseelaiq.app/?role=Customer&tripType=daily' } }],
                [{ text: '🚗 فتح التطبيق مباشرة', url: 'https://tawseelaiq.app/?login_token=' + encodeURIComponent(token) + '&userId=' + encodeURIComponent(customer.customerId) + '&role=Customer&fullName=' + encodeURIComponent(customer.fullName) }],
                [{ text: '📞 تواصل مع الإدارة', callback_data: 'contact_admin' }],
                [{ text: '❓ مساعدة', callback_data: 'help' }],
                [{ text: '🚪 تسجيل خروج', callback_data: 'logout' }]
            ]
        );
        return;
    }

    if (driver) {
        const token = 'jwt_driver_' + driver.driverId;
        await sendKeyboard(chatId,
            `مرحباً بك الكابتن <b>${driver.fullName}</b> في بوت توصيله 🚕\n\nيرجى تحديد نوع المشاوير التي ترغب بتقديمها:\n\n💡 <i>ملاحظة للايفون: اضغط على 🧭 (البوصلة) لفتح التطبيق في متصفح سفاري لضمان عمل الـ GPS.</i>`,
            [
                [{ text: '⚡ مشاوير قصيرة', callback_data: 'driver_set_short' }],
                [{ text: '🔄 خطوط دائمة', callback_data: 'driver_set_daily' }],
                [{ text: '🚖 كلاهما (مشاوير قصيرة وخطوط دائمة)', callback_data: 'driver_set_both' }],
                [{ text: '🚗 فتح تطبيق السائق', url: 'https://tawseelaiq.app/?login_token=' + encodeURIComponent(token) + '&userId=' + encodeURIComponent(driver.driverId) + '&role=Driver&fullName=' + encodeURIComponent(driver.fullName) }],
                [{ text: '📞 تواصل مع الإدارة', callback_data: 'contact_admin' }],
                [{ text: '🚪 تسجيل خروج', callback_data: 'logout' }]
            ]
        );
        return;
    }

    const keyboard = [
        [{ text: '🗺️ فتح خريطة الخطوط الدائمية (WebApp)', web_app: { url: 'https://tawseelaiq.app/?role=Customer&tripType=daily' } }],
        [{ text: '🚶 تسجيل راكب', callback_data: 'reg_passenger' }, { text: '🚕 تسجيل سائق', callback_data: 'reg_driver' }],
        [{ text: '🔑 تسجيل دخول', callback_data: 'login' }],
        [{ text: '📞 تواصل مع الإدارة', callback_data: 'contact_admin' }],
        [{ text: '❓ مساعدة', callback_data: 'help' }]
    ];

    await sendKeyboard(chatId,
        `مرحباً <b>${name}</b> في بوت توصيله 🚕\nخدمة النقل الذكي في النجف الأشرف\n\nاختر ما تريد:`,
        keyboard
    );
}

// --- Step 2: Complete Registration By User Location ---
async function completePassengerRegistration(chatId, user, locationInput) {
    const state = userStates.get(chatId) || {};
    const cleanPhone = (state.verifiedPhone || state.phone || '').replace('+964', '0');
    const tgName = (user ? ((user.first_name || '') + ' ' + (user.last_name || '')).trim() : 'راكب توصيله');
    const fullName = state.fullName || tgName || 'راكب توصيله';
    const password = state.password || cleanPhone || '123456';
    const crypto = require('crypto');
    const customerId = 'usr-c-' + Math.random().toString(36).substr(2, 9);
    const now = new Date().toISOString();
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    // Parse location
    let lat = 31.9961;
    let lon = 44.3168;
    let locDisplay = 'الموقع الحالي';
    if (locationInput && typeof locationInput === 'object' && locationInput.latitude) {
        lat = Number(locationInput.latitude);
        lon = Number(locationInput.longitude);
        locDisplay = `موقعي الحالي (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
    } else if (typeof locationInput === 'string' && locationInput.trim() && !locationInput.includes('تخطي')) {
        locDisplay = locationInput.trim();
    }

    // Check duplicate
    const existsCust = (db.memoryState.customers || []).find(c => c.phoneNumber === cleanPhone);
    const existsDrv = (db.memoryState.drivers || []).find(d => d.phoneNumber === cleanPhone);
    if (existsCust || existsDrv) {
        const roleAr = existsCust ? 'كراكب' : 'كسائق';
        await tgRequest('sendMessage', {
            chat_id: chatId,
            text: `⚠️ <b>الرقم (${cleanPhone}) مسجل بالفعل ${roleAr}. يمكنك تسجيل الدخول مباشرة:</b>`,
            parse_mode: 'HTML',
            reply_markup: {
                remove_keyboard: true,
                inline_keyboard: [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }]]
            }
        });
        userStates.delete(chatId);
        return;
    }

    const newCustomer = {
        customerId,
        fullName,
        phoneNumber: cleanPhone,
        email: `${cleanPhone}@tawseelaiq.app`,
        plainPassword: password,
        passwordHash,
        governorate: 'najaf',
        route: locDisplay,
        address: locDisplay,
        pickupLat: lat,
        pickupLon: lon,
        preferredPaymentMethod: 'Cash',
        area: locDisplay,
        ratingAverage: 5.0,
        totalBookings: 0,
        isActive: true,
        isBlocked: false,
        registeredAt: now,
        telegramChatId: String(chatId)
    };

    db.memoryState.customers.unshift(newCustomer);
    db.saveStateSnapshot();
    db.persistNewCustomer(newCustomer).catch(() => {});

    const token = 'jwt_customer_' + customerId;
    const appUrl = `https://tawseelaiq.app/?login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(customerId)}&role=Customer&fullName=${encodeURIComponent(fullName)}&tripType=short`;

    await tgRequest('sendMessage', {
        chat_id: chatId,
        text: `🎉 <b>تم تسجيلك كراكب بنجاح!</b>\n\n` +
            `👤 <b>الاسم:</b> ${fullName}\n` +
            `📱 <b>الهاتف:</b> ${cleanPhone}\n` +
            `📍 <b>الموقع:</b> ${locDisplay}\n\n` +
            `✅ <b>تم حفظ البيانات في لوحة التحكم (Dashboard) وتزامنها مع تطبيق الويب.</b>\n` +
            `اختر نوع مشوارك للمتابعة أو افتح التطبيق مباشرة:`,
        parse_mode: 'HTML',
        reply_markup: {
            remove_keyboard: true,
            inline_keyboard: [
                [
                    { text: '⚡ مشوار قصير', callback_data: 'passenger_trip_short' },
                    { text: '🔄 خط دائم', callback_data: 'passenger_trip_daily' }
                ],
                [{ text: '🚗 فتح تطبيق الويب مباشرة', url: appUrl }]
            ]
        }
    });

    userStates.delete(chatId);
}

async function completeDriverRegistration(chatId, user, locationInput) {
    const state = userStates.get(chatId) || {};
    const cleanPhone = (state.verifiedPhone || state.phone || '').replace('+964', '0');
    const tgName = (user ? ((user.first_name || '') + ' ' + (user.last_name || '')).trim() : 'كابتن توصيله');
    const fullName = state.fullName || tgName || 'كابتن توصيله';
    const password = state.password || cleanPhone || '123456';
    const crypto = require('crypto');
    const driverId = 'drv-t-' + Math.random().toString(36).substr(2, 9);
    const now = new Date().toISOString();
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    // Parse location
    let lat = 31.9961;
    let lon = 44.3168;
    let locDisplay = 'الموقع الحالي';
    if (locationInput && typeof locationInput === 'object' && locationInput.latitude) {
        lat = Number(locationInput.latitude);
        lon = Number(locationInput.longitude);
        locDisplay = `موقعي الحالي (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
    } else if (typeof locationInput === 'string' && locationInput.trim() && !locationInput.includes('تخطي')) {
        locDisplay = locationInput.trim();
    }

    const existsCust = (db.memoryState.customers || []).find(c => c.phoneNumber === cleanPhone);
    const existsDrv = (db.memoryState.drivers || []).find(d => d.phoneNumber === cleanPhone);
    if (existsCust || existsDrv) {
        const roleAr = existsDrv ? 'كسائق' : 'كراكب';
        await tgRequest('sendMessage', {
            chat_id: chatId,
            text: `⚠️ <b>الرقم (${cleanPhone}) مسجل بالفعل ${roleAr}. يمكنك تسجيل الدخول مباشرة:</b>`,
            parse_mode: 'HTML',
            reply_markup: {
                remove_keyboard: true,
                inline_keyboard: [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }]]
            }
        });
        userStates.delete(chatId);
        return;
    }

    const newDriver = {
        driverId,
        fullName,
        phoneNumber: cleanPhone,
        email: `${cleanPhone}@tawseelaiq.app`,
        passwordHash,
        plainPassword: password,
        licenseNumber: 'PENDING',
        vehicle: { make: state.vehicle || 'تويوتا', plateNumber: state.plate || 'خصوصي', year: 2023 },
        governorate: 'najaf',
        route: locDisplay,
        currentLat: lat,
        currentLon: lon,
        status: 'Pending',
        isVerified: false,
        isBlocked: false,
        ratingAverage: 5.0,
        totalTrips: 0,
        registeredAt: now,
        telegramChatId: String(chatId)
    };

    db.memoryState.drivers.unshift(newDriver);

    db.memoryState.verifications.unshift({
        verificationId: 'ver-' + Math.random().toString(36).substr(2, 9),
        driverId,
        driverName: fullName,
        phoneNumber: cleanPhone,
        governorate: locDisplay,
        status: 'Pending',
        submittedAt: now
    });

    db.saveStateSnapshot();
    db.persistNewDriver(newDriver).catch(() => {});

    const cfg = db.memoryState.appConfig || {};
    const waAdminLink = cfg.whatsappAdminLink || 'https://wa.me/9647706204066';
    const tgAdminLink = cfg.telegramAdminLink || 'https://t.me/tawseela_najaf_bot';

    const token = 'jwt_driver_' + driverId;
    const appUrl = `https://tawseelaiq.app/?login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(driverId)}&role=Driver&fullName=${encodeURIComponent(fullName)}`;

    await tgRequest('sendMessage', {
        chat_id: chatId,
        text: `🎉 <b>تم تسجيل بياناتك كسائق بنجاح!</b>\n\n` +
            `👤 <b>الاسم:</b> ${fullName}\n` +
            `📱 <b>الهاتف:</b> ${cleanPhone}\n` +
            `📍 <b>الموقع:</b> ${locDisplay}\n` +
            `🚗 <b>المركبة:</b> ${state.vehicle || 'تويوتا'} (${state.plate || 'خصوصي'})\n\n` +
            `✅ <b>تم حفظ البيانات في لوحة التحكم (Dashboard) وتزامنها مع تطبيق الويب.</b>\n` +
            `⏳ حسابك الآن بانتظار توثيق الإدارة. يرجى إرسال المستمسكات عبر:\n` +
            `📱 واتساب: ${waAdminLink}\n` +
            `💬 تيليجرام: ${tgAdminLink}`,
        parse_mode: 'HTML',
        reply_markup: {
            remove_keyboard: true,
            inline_keyboard: [
                [{ text: '🚗 فتح تطبيق الويب مباشرة', url: appUrl }]
            ]
        }
    });

    // Notify admin with location
    await sendKeyboard(ADMIN_CHAT_ID,
        `🚕 <b>سائق جديد بانتظار التوثيق:</b>\n👤 ${fullName}\n📱 ${cleanPhone}\n📍 ${locDisplay}\n🚗 ${state.vehicle || 'تويوتا'} - ${state.plate || 'خصوصي'}`,
        [[
            { text: '✅ قبول', callback_data: `approve_${driverId}` },
            { text: '❌ رفض', callback_data: `reject_${driverId}` }
        ]]
    );

    userStates.delete(chatId);
}

async function handleCallback(chatId, data, user) {
    if (!db.memoryState.botSubscribers) db.memoryState.botSubscribers = [];
    if (!db.memoryState.botSubscribers.includes(String(chatId))) { db.memoryState.botSubscribers.push(String(chatId)); db.saveStateSnapshot(); }

    const state = userStates.get(chatId) || {};

    // Fallback callbacks for governorates if any old button pressed
    if (data.startsWith('tgov_p_')) {
        const govKey = data.replace('tgov_p_', '');
        const govObj = IRAQ_GOVERNORATES.find(g => g.key === govKey) || { name: 'النجف', key: 'najaf' };
        await completePassengerRegistration(chatId, user, govObj.name);
        return;
    }
    if (data.startsWith('tgov_d_')) {
        const govKey = data.replace('tgov_d_', '');
        const govObj = IRAQ_GOVERNORATES.find(g => g.key === govKey) || { name: 'النجف', key: 'najaf' };
        await completeDriverRegistration(chatId, user, govObj.name);
        return;
    }

    switch (data) {
        case 'reg_passenger':
            userStates.set(chatId, { step: 'passenger_phone', role: 'Customer' });
            await sendKeyboard(chatId,
                '🚶 <b>تسجيل حساب راكب جديد:</b>\n\n' +
                '📱 أرسل رقم هاتفك العراقي (مثال: <code>07701234567</code>)، أو يمكنك التحقق والتسجيل مباشرة عبر تطبيق الويب الموثق بواتساب و Truecaller:',
                [
                    [{ text: '🌐 التسجيل والتحقق في تطبيق الويب', url: 'https://tawseelaiq.app/?role=Customer' }]
                ]
            );
            break;
        case 'reg_driver':
            userStates.set(chatId, { step: 'driver_phone', role: 'Driver' });
            await sendKeyboard(chatId,
                '🚕 <b>تسجيل كابتن (سائق) جديد:</b>\n\n' +
                '📱 أرسل رقم هاتفك العراقي (مثال: <code>07701234567</code>)، أو يمكنك التحقق والتسجيل مباشرة عبر تطبيق الويب الموثق بواتساب و Truecaller:',
                [
                    [{ text: '🌐 التسجيل والتحقق في تطبيق الويب', url: 'https://tawseelaiq.app/?role=Driver' }]
                ]
            );
            break;
        case 'login':
            userStates.set(chatId, { step: 'login_phone' });
            await sendMessage(chatId, '📱 أرسل رقم هاتفك المسجل (مثال: <code>07701234567</code>):');
            break;
        case 'nearby_drivers':
        case 'passenger_trip_short': {
            userStates.set(chatId, { step: 'passenger_trip_short_location' });
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: '📍 <b>للبحث عن السائقين القريبين لمشوار قصير:</b>\n\nيرجى تحديد موقعك الحالي بالضغط على زر "مشاركة موقعي الحالي" أدناه، أو أرسل اسم المنطقة نصياً.',
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: '📍 مشاركة موقعي الحالي', request_location: true }],
                        [{ text: '🔙 إلغاء' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            break;
        }
        case 'passenger_trip_daily': {
            userStates.set(chatId, { step: 'passenger_trip_daily_start' });
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: '🔄 <b>لتثبيت خط دائم والبحث عن الكباتن:</b>\n\n🟢 يرجى تحديد <b>نقطة الانطلاق</b> (شارك موقعك الحالي أو اكتب اسم المنطقة):',
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: '📍 مشاركة موقعي الحالي', request_location: true }],
                        [{ text: '🔙 إلغاء' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            break;
        }
        case 'driver_set_short':
        case 'driver_set_daily':
        case 'driver_set_both': {
            let driver = (db.memoryState.drivers || []).find(d => String(d.telegramChatId) === String(chatId));
            if (!driver && state && state.verifiedPhone) {
                const clean = state.verifiedPhone.replace('+964', '0');
                driver = (db.memoryState.drivers || []).find(d => d.phoneNumber === clean);
                if (driver) { driver.telegramChatId = String(chatId); }
            }
            if (!driver) {
                await sendMessage(chatId, '⚠️ لم يتم العثور على حساب السائق. يرجى تسجيل الدخول أولاً.');
                break;
            }

            let typeName = '';
            let serviceTypeValue = '';
            if (data === 'driver_set_short') {
                driver.serviceType = 'ShortTrip';
                driver.workMode = 'مشوار قصير';
                serviceTypeValue = 'ShortTrip';
                typeName = 'مشاوير قصيرة ⚡';
            } else if (data === 'driver_set_daily') {
                driver.serviceType = 'PermanentLine';
                driver.workMode = 'خط دائمي';
                serviceTypeValue = 'PermanentLine';
                typeName = 'خطوط دائمة 🔄';
            } else {
                driver.serviceType = 'Both';
                driver.workMode = 'مشوار قصير';
                serviceTypeValue = 'Both';
                typeName = 'كلاهما (مشاوير قصيرة وخطوط دائمة) 🚖';
            }
            db.saveStateSnapshot();

            const token = 'jwt_driver_' + driver.driverId;
            const appUrl = `https://tawseelaiq.app/?login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(driver.driverId)}&role=Driver&fullName=${encodeURIComponent(driver.fullName)}&serviceType=${serviceTypeValue}`;

            await sendKeyboard(chatId,
                `✅ <b>تم حفظ خيارك بنجاح!</b>\nنوع الخدمة المعتمد: <b>${typeName}</b>\n\nستصلك إشعارات الطلبات المتوافقة مع خيارك. يمكنك فتح التطبيق والبدء بالعمل:`,
                [
                    [{ text: '🚗 فتح تطبيق السائق', url: appUrl }],
                    [{ text: '⚙️ تغيير نوع الخدمة', callback_data: 'driver_choose_service' }]
                ]
            );
            break;
        }
        case 'driver_choose_service': {
            await sendKeyboard(chatId,
                `🚖 <b>تحديد نوع المشاوير التي تقدمها:</b>\nاختر من الخيارات التالية:`,
                [
                    [{ text: '⚡ مشاوير قصيرة', callback_data: 'driver_set_short' }],
                    [{ text: '🔄 خطوط دائمة', callback_data: 'driver_set_daily' }],
                    [{ text: '🚖 كلاهما (مشاوير قصيرة وخطوط دائمة)', callback_data: 'driver_set_both' }]
                ]
            );
            break;
        }
        case 'logout': {
            let userFound = false;
            let customer = (db.memoryState.customers || []).find(c => String(c.telegramChatId) === String(chatId));
            if (customer) {
                customer.telegramChatId = null;
                userFound = true;
            }
            let driver = (db.memoryState.drivers || []).find(d => String(d.telegramChatId) === String(chatId));
            if (driver) {
                driver.telegramChatId = null;
                userFound = true;
            }
            if (userFound) {
                db.saveStateSnapshot();
                await sendMessage(chatId, '🚪 تم تسجيل الخروج بنجاح. أرسل /start متى ما أردت الدخول مجدداً.');
            } else {
                await sendMessage(chatId, '⚠️ أنت غير مسجل الدخول حالياً.');
            }
            userStates.delete(chatId);
            break;
        }
        case 'contact_admin': {
            const cfg = db.memoryState.appConfig || {};
            const tgLink = cfg.telegramAdminLink || 'https://t.me/tawseela_najaf_bot';
            const waLink = cfg.whatsappAdminLink || 'https://wa.me/9647706204066';
            await sendMessage(chatId, `📞 <b>للتواصل مع إدارة المنصة:</b>\n\n💬 تيليجرام الإدارة: ${tgLink}\n📱 واتساب الإدارة: ${waLink}\n\nأو يمكنك كتابة رسالتك هنا وسنوصلها للإدارة مباشرة.`);
            userStates.set(chatId, { step: 'contact_msg' });
            break;
        }
        case 'help':
            await sendMessage(chatId, '❓ <b>المساعدة</b>\n\n/start - القائمة الرئيسية\n/status - حالة حسابك\n\nللتسجيل اختر الزر المناسب من القائمة.');
            break;
        case 'admin_stats':
            if (String(chatId) === ADMIN_CHAT_ID) await handleAdminStats(chatId);
            break;
        case 'admin_pending':
            if (String(chatId) === ADMIN_CHAT_ID) await handleAdminPending(chatId);
            break;
        case 'admin_security_log':
            if (String(chatId) === ADMIN_CHAT_ID) {
                const last20 = _tgSuspiciousLog.slice(-20);
                if (last20.length === 0) {
                    await sendMessage(chatId, '🛡️ لا توجد سجلات أمنية مشبوهة.');
                } else {
                    let logMsg = '🛡️ <b>آخر 20 حدث أمني:</b>\n\n';
                    last20.forEach((e, i) => {
                        logMsg += `${i+1}. [${e.reason}] ChatID: ${e.chatId}\n   ${(e.text || '-').substring(0, 60)}\n   ${e.time}\n\n`;
                    });
                    logMsg += `\n🚫 محظورون حالياً: ${_tgBannedUsers.size}`;
                    await sendMessage(chatId, logMsg);
                }
            }
            break;
        case 'admin_unban_all':
            if (String(chatId) === ADMIN_CHAT_ID) {
                _tgBannedUsers.clear();
                await sendMessage(chatId, '✅ تم رفع الحظر عن جميع المستخدمين.');
            }
            break;
        default:
            if (data.startsWith('approve_')) {
                if (String(chatId) === ADMIN_CHAT_ID) await handleApproveDriver(chatId, data.replace('approve_', ''));
            } else if (data.startsWith('reject_')) {
                if (String(chatId) === ADMIN_CHAT_ID) await handleRejectDriver(chatId, data.replace('reject_', ''));
            } else if (data.startsWith('book_')) {
                const driverId = data.replace('book_', '');
                let passenger = (db.memoryState.customers || []).find(c => String(c.telegramChatId) === String(chatId));
                const passId = passenger ? passenger.customerId : ('tg_' + chatId);
                const passName = passenger ? passenger.fullName : ((user && (user.first_name || user.username)) || 'راكب تيليجرام');
                const passPhone = passenger ? passenger.phoneNumber : '';

                const bookingResult = await db.executeAtomicBooking({
                    driverId,
                    passengerId: passId,
                    passengerName: passName,
                    passengerPhone: passPhone,
                    platform: 'telegram',
                    seatsToBook: 1
                });

                if (bookingResult.success) {
                    const drv = bookingResult.driver;
                    const waNum = (drv.phoneNumber || '').replace(/[^0-9]/g, '').replace(/^07/, '9647');
                    await tgRequest('sendMessage', {
                        chat_id: chatId,
                        text: `🎉 <b>تم حجز مقعدك بنجاح!</b>\n\n` +
                              `🚖 <b>الكابتن:</b> ${drv.fullName}\n` +
                              `💺 <b>المقاعد المتبقية:</b> ${drv.availableSeats} من أصل ${drv.totalSeats}\n` +
                              `📱 <b>الهاتف:</b> <code>${drv.phoneNumber || 'غير متوفر'}</code>\n` +
                              `🛣️ <b>المسار:</b> ${drv.route || drv.permanentLocationName || 'خط دائمي'}\n\n` +
                              `💬 يمكنك الاتصال بالكابتن أو مراسلته عبر واتساب للتنسيق.`,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                (drv.phoneNumber ? [{ text: '💬 تواصل واتساب', url: `https://wa.me/${waNum}` }] : []),
                                [{ text: '🗺️ فتح خريطة الخطوط الدائمية', web_app: { url: 'https://tawseelaiq.app/?role=Customer&tripType=daily' } }]
                            ].filter(r => r.length > 0)
                        }
                    });

                    // If driver has telegramChatId, notify them
                    if (drv.telegramChatId) {
                        await tgRequest('sendMessage', {
                            chat_id: drv.telegramChatId,
                            text: `🔔 <b>حجز مقعد جديد في خطك الدائمي!</b>\n\n` +
                                  `👤 <b>الراكب:</b> ${passName}\n` +
                                  `📱 <b>الهاتف:</b> ${passPhone || 'عبر تيليجرام'}\n` +
                                  `💺 <b>المقاعد المتبقية لديك:</b> ${drv.availableSeats}/${drv.totalSeats}`,
                            parse_mode: 'HTML'
                        }).catch(() => {});
                    }
                } else {
                    await sendMessage(chatId, `⚠️ <b>تعذر إتمام الحجز:</b>\n${bookingResult.error || 'عذراً، المقاعد اكتملت لدى هذا الكابتن.'}`);
                }
            }
    }
}

async function handleMessage(chatId, text, user, location) {
    if (!db.memoryState.botSubscribers) db.memoryState.botSubscribers = [];
    if (!db.memoryState.botSubscribers.includes(String(chatId))) { db.memoryState.botSubscribers.push(String(chatId)); db.saveStateSnapshot(); }

    const state = userStates.get(chatId);
    if (!state) {
        if (!text) return;
        const digits = text.replace(/[^0-9]/g, '');
        if (digits.length >= 7) {
            const existing = await checkPhoneRegistration(text);
            if (existing) {
                await sendKeyboard(chatId,
                    `⚠️ <b>الرقم مسجل ${existing.roleAr}. استخدم تسجيل الدخول.</b>`,
                    [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }], [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]]
                );
                return;
            } else {
                const cleanPhone = digits.startsWith('964') ? '0' + digits.substring(3) : (digits.startsWith('0') ? digits : '0' + digits);
                const encodedPhone = encodeURIComponent(cleanPhone);
                await sendKeyboard(chatId,
                    `ℹ️ <b>الرقم (${text.trim()}) غير مسجل في النظام.</b>\n\n` +
                    `💡 <i>لا داعي للتحقق هنا في تيليجرام</i>؛ التحقق مفعّل وآمن في تطبيق الويب عبر واتساب و Truecaller.\n\n` +
                    `يرجى فتح التطبيق لتأكيد رقمك وإكمال التسجيل:`,
                    [
                        [{ text: '🚶 تسجيل راكب في تطبيق الويب', url: `https://tawseelaiq.app/?role=Customer&phone=${encodedPhone}` }],
                        [{ text: '🚕 تسجيل سائق في تطبيق الويب', url: `https://tawseelaiq.app/?role=Driver&phone=${encodedPhone}` }],
                        [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]
                    ]
                );
                return;
            }
        }
        await handleStart(chatId, user);
        return;
    }

    switch (state.step) {
        case 'passenger_trip_short_location': {
            if (text === '🔙 إلغاء') {
                userStates.delete(chatId);
                await handleStart(chatId, user);
                return;
            }
            let pLat = 31.9961, pLon = 44.3168;
            if (location && location.latitude) {
                pLat = location.latitude;
                pLon = location.longitude;
            } else if (text) {
                // Approximate coordinates or geocoding could be done here. 
                // For now, we will use default Najaf center if text is provided.
                // Or maybe the user already has saved location?
            }
            
            let passenger = (db.memoryState.customers || []).find(c => String(c.telegramChatId) === String(chatId));
            if (passenger) {
                passenger.currentLat = pLat;
                passenger.currentLon = pLon;
                db.saveStateSnapshot();
            }

            let shortDrivers = (db.memoryState.drivers || []).filter(d =>
                !d.isBlocked && d.status !== 'Pending' && d.status !== 'Rejected' &&
                (d.isVerified === true || d.status === 'Active' || d.status === 'Approved') &&
                (d.workMode === 'مشوار قصير' || d.serviceType === 'ShortTrip' || !d.workMode)
            );

            const toRad = (deg) => deg * Math.PI / 180;
            const haversine = (lat1, lon1, lat2, lon2) => {
                const R = 6371;
                const dLat = toRad(lat2 - lat1);
                const dLon = toRad(lon2 - lon1);
                const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
                return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            };

            const driversWithDist = shortDrivers.map((d, idx) => {
                const dLat = d.currentLat ? parseFloat(d.currentLat) : (d.permanentLat ? parseFloat(d.permanentLat) : (pLat + 0.003 * (idx + 1)));
                const dLon = d.currentLon ? parseFloat(d.currentLon) : (d.permanentLon ? parseFloat(d.permanentLon) : (pLon + 0.002 * (idx + 1)));
                const dist = haversine(pLat, pLon, dLat, dLon);
                const routeInfo = d.route || d.permanentLocationName || 'جاهز للمشاوير القصيرة';
                return { ...d, _dist: dist, routeInfo };
            }).sort((a, b) => a._dist - b._dist);

            const token = passenger ? 'jwt_customer_' + passenger.customerId : '';
            const appUrl = `https://tawseelaiq.app/?login_token=${encodeURIComponent(token)}&role=Customer&tripType=short`;

            // Reset keyboard
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: 'جاري البحث عن السائقين...',
                reply_markup: { remove_keyboard: true }
            });
            userStates.delete(chatId);

            if (driversWithDist.length === 0) {
                await sendKeyboard(chatId,
                    `⚡ <b>تم اختيار: مشوار قصير</b>\n\n🚕 لا يوجد سائقون مسجلون للمشاوير القصيرة بالقرب منك حالياً.`,
                    [
                        [{ text: '🚗 طلب مشوار عبر التطبيق', url: appUrl }],
                        [{ text: '🔄 البحث عن خط دائم', callback_data: 'passenger_trip_daily' }]
                    ]
                );
            } else {
                let msg = `⚡ <b>تم اختيار: مشوار قصير</b>\n📍 <b>السائقون الأقرب لموقعك:</b>\n\n`;
                driversWithDist.slice(0, 8).forEach((d, i) => {
                    const waNum = (d.phoneNumber || '').replace(/[^0-9]/g, '').replace(/^07/, '9647');
                    const distText = ` (${d._dist.toFixed(1)} كم عنك)`;
                    const vMake = d.vehicleMake || (d.vehicle ? d.vehicle.make : 'تويوتا');
                    const vModel = d.vehicleModel || (d.vehicle ? (d.vehicle.model || '') : '');
                    const carInfo = `${vMake} ${vModel}`.trim();
                    msg += `${i+1}. 🚕 <b>${d.fullName}</b>${distText}\n`;
                    msg += `   🚗 المركبة: ${carInfo}\n`;
                    msg += `   📞 الهاتف: <code>${d.phoneNumber || '07800000000'}</code>\n`;
                    msg += `   💬 <a href="https://wa.me/${waNum}">مراسلة واتساب مباشرة</a>\n\n`;
                });
                msg += `💡 يمكنك التواصل مع السائق مباشرة أو فتح التطبيق لتأكيد المشوار.`;

                await sendKeyboard(chatId, msg, [
                    [{ text: '🚗 فتح التطبيق للمشوار القصير', url: appUrl }],
                    [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]
                ]);
            }
            return;
        }

        case 'passenger_trip_daily_start': {
            if (text === '🔙 إلغاء') {
                userStates.delete(chatId);
                await handleStart(chatId, user);
                return;
            }
            let pLat = 31.9961, pLon = 44.3168, startName = text || 'موقعي الحالي';
            if (location && location.latitude) {
                pLat = location.latitude;
                pLon = location.longitude;
                startName = 'موقعي الحالي';
            }
            
            userStates.set(chatId, { step: 'passenger_trip_daily_end', startLat: pLat, startLon: pLon, startName });
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: '🏁 <b>تم تحديد نقطة الانطلاق.</b>\\n\\nيرجى كتابة <b>نقطة الوصول</b> نصياً (مثال: حي الجامعة):',
                parse_mode: 'HTML',
                reply_markup: { remove_keyboard: true }
            });
            return;
        }

        case 'passenger_trip_daily_end': {
            const endName = text || 'نقطة الوصول';
            const startName = state.startName || 'موقعي الحالي';
            
            let passenger = (db.memoryState.customers || []).find(c => String(c.telegramChatId) === String(chatId));
            if (passenger) {
                passenger.permanentLat = state.startLat;
                passenger.permanentLon = state.startLon;
                db.saveStateSnapshot();
            }

            // Perform 3-Tier spatial route matching
            const passengerPoints = [{ lat: state.startLat, lon: state.startLon }];
            const matched = db.matchPassengerRoute(passengerPoints, 5000);
            
            userStates.delete(chatId);
            const token = passenger ? 'jwt_customer_' + passenger.customerId : '';
            const appUrl = `https://tawseelaiq.app/?login_token=${encodeURIComponent(token)}&role=Customer&tripType=daily`;

            if (matched.length === 0) {
                await sendKeyboard(chatId,
                    `🔄 <b>تم تحديد المسار: ${startName} ➔ ${endName}</b>\n\n🚕 لا يوجد سائقون متاحون أو توجد مقاعد شاغرة على هذا المسار حالياً.`,
                    [
                        [{ text: '🗺️ فتح خريطة الخطوط الدائمية وتحديد المسار', web_app: { url: appUrl } }],
                        [{ text: '⚡ البحث عن مشوار قصير', callback_data: 'passenger_trip_short' }]
                    ]
                );
            } else {
                let msg = `🔄 <b>تم تحديد المسار: ${startName} ➔ ${endName}</b>\n\n📍 <b>السائقون الأقرب لمسارك (نظام المطابقة المكانية):</b>\n\n`;
                const buttons = [];

                matched.slice(0, 6).forEach((item, i) => {
                    const d = item.driver;
                    const vMake = d.vehicleMake || (d.vehicle ? d.vehicle.make : 'تويوتا');
                    const vModel = d.vehicleModel || (d.vehicle ? (d.vehicle.model || '') : '');
                    const carInfo = `${vMake} ${vModel}`.trim();
                    const routeInfo = d.route || d.permanentLocationName || 'خط دائمي';
                    const icon = item.tier === 1 ? '🟢' : item.tier === 2 ? '🟣' : '🔴';
                    
                    msg += `${i+1}. ${icon} <b>${d.fullName}</b> (${item.tierName} - ${item.minDistanceMeters}م)\n`;
                    msg += `   🛣️ المسار: <i>${routeInfo}</i>\n`;
                    msg += `   🚗 المركبة: ${carInfo}\n`;
                    msg += `   💺 المقاعد المتاحة: <b>${d.availableSeats}</b> من ${d.totalSeats}\n`;
                    msg += `   📞 الهاتف: <code>${d.phoneNumber || '07800000000'}</code>\n\n`;

                    buttons.push([
                        { text: `⚡ احجز الآن مع ${d.fullName} (${d.availableSeats} مقاعد)`, callback_data: `book_${d.driverId}` }
                    ]);
                });

                buttons.push([{ text: '🗺️ فتح خريطة الخطوط الدائمية (WebApp)', web_app: { url: appUrl } }]);
                buttons.push([{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]);

                msg += `💡 اضغط على زر الحجز أدناه لاقتناص مقعدك فورياً، أو افتح الخريطة لمشاهدة المسار!`;

                await sendKeyboard(chatId, msg, buttons);
            }
            return;
        }

        // --- Passenger Registration ---
        case 'passenger_phone': {
            const clean = normalizePhoneNumber(text);
            const digits = text.replace(/[^0-9]/g, '');
            if (digits.length < 10 || !clean || clean.length < 9) {
                userStates.delete(chatId);
                await sendKeyboard(chatId,
                    `❌ <b>الرقم المدخل (${text.trim()}) غير صحيح أو غير صالح.</b>\n\n` +
                    `يرجى التأكد من كتابة الرقم بشكل صحيح (مثال: <code>07701234567</code>)، أو يمكنك التحقق والتسجيل مباشرة عبر تطبيق الويب الموثق بواتساب:`,
                    [
                        [{ text: '🌐 فتح تطبيق الويب للتحقق والتسجيل', url: 'https://tawseelaiq.app/?role=Customer' }],
                        [{ text: '🔄 إعادة المحاولة في البوت', callback_data: 'reg_passenger' }],
                        [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]
                    ]
                );
                return;
            }
            const existing = await checkPhoneRegistration(text);
            if (existing) {
                userStates.delete(chatId);
                await sendKeyboard(chatId,
                    `⚠️ <b>الرقم مسجل مسبقاً ${existing.roleAr}. استخدم تسجيل الدخول.</b>`,
                    [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }], [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]]
                );
                return;
            }
            userStates.delete(chatId);
            const cleanPhone = digits.startsWith('964') ? '0' + digits.substring(3) : (digits.startsWith('0') ? digits : '0' + digits);
            const encodedPhone = encodeURIComponent(cleanPhone);
            await sendKeyboard(chatId,
                `✅ <b>الرقم (${text.trim()}) متاح للتسجيل:</b>\n\n` +
                `🔐 لحماية وأمان حسابك، التحقق مفعّل في تطبيق الويب عبر واتساب و Truecaller.\n` +
                `اضغط أدناه لفتح التطبيق وتأكيد رقمك بضغطة واحدة وإكمال حسابك:`,
                [
                    [{ text: '🚶 فتح تطبيق الويب وتأكيد الرقم بواتساب', url: `https://tawseelaiq.app/?role=Customer&phone=${encodedPhone}` }],
                    [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]
                ]
            );
            return;
        }
        case 'passenger_otp_sent': {
            const check = verifyTelegramOtp(chatId, text.trim());
            if (!check.valid) { await sendMessage(chatId, '❌ ' + check.error); return; }
            state.verifiedPhone = check.phone;
            state.step = 'passenger_name';
            userStates.set(chatId, state);
            await sendMessage(chatId, '✅ تم التحقق!\nأرسل اسمك الكامل (الاسم واللقب):');
            break;
        }
        case 'passenger_name': {
            state.fullName = text.trim();
            state.step = 'passenger_location';
            userStates.set(chatId, state);
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: '📍 <b>الخطوة 2: تحديد موقعك الحالي:</b>\nاضغط على الزر أدناه لمشاركة موقعك الحالي تلقائياً، أو أرسل اسم منطقتك / عنوانك في رسالة:',
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: '📍 مشاركة موقعي الحالي', request_location: true }],
                        [{ text: 'تخطي وتحديد الموقع تلقائياً في التطبيق' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            break;
        }
        case 'passenger_location': {
            await completePassengerRegistration(chatId, user, location || text);
            break;
        }
        case 'passenger_password': {
            if (text.trim().length >= 4) state.password = text.trim();
            state.step = 'passenger_location';
            userStates.set(chatId, state);
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: '📍 <b>الخطوة 2: تحديد موقعك الحالي:</b>\nاضغط على الزر أدناه لمشاركة موقعك الحالي تلقائياً، أو أرسل اسم منطقتك / عنوانك في رسالة:',
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: '📍 مشاركة موقعي الحالي', request_location: true }],
                        [{ text: 'تخطي وتحديد الموقع تلقائياً في التطبيق' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            break;
        }

        // --- Driver Registration ---
        case 'driver_phone': {
            const clean = normalizePhoneNumber(text);
            const digits = text.replace(/[^0-9]/g, '');
            if (digits.length < 10 || !clean || clean.length < 9) {
                userStates.delete(chatId);
                await sendKeyboard(chatId,
                    `❌ <b>الرقم المدخل (${text.trim()}) غير صحيح أو غير صالح.</b>\n\n` +
                    `يرجى التأكد من كتابة الرقم بشكل صحيح (مثال: <code>07701234567</code>)، أو يمكنك التحقق والتسجيل عبر تطبيق الويب:`,
                    [
                        [{ text: '🌐 فتح تطبيق الويب للتحقق والتسجيل', url: 'https://tawseelaiq.app/?role=Driver' }],
                        [{ text: '🔄 إعادة المحاولة في البوت', callback_data: 'reg_driver' }],
                        [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]
                    ]
                );
                return;
            }
            const existing = await checkPhoneRegistration(text);
            if (existing) {
                userStates.delete(chatId);
                await sendKeyboard(chatId,
                    `⚠️ <b>الرقم مسجل مسبقاً ${existing.roleAr}. استخدم تسجيل الدخول.</b>`,
                    [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }], [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]]
                );
                return;
            }
            userStates.delete(chatId);
            const cleanPhone = digits.startsWith('964') ? '0' + digits.substring(3) : (digits.startsWith('0') ? digits : '0' + digits);
            const encodedPhone = encodeURIComponent(cleanPhone);
            await sendKeyboard(chatId,
                `✅ <b>الرقم (${text.trim()}) متاح لتسجيل الكابتن:</b>\n\n` +
                `🔐 لحماية وتوثيق حسابات السائقين، التحقق مفعّل في تطبيق الويب عبر واتساب و Truecaller.\n` +
                `اضغط أدناه لفتح التطبيق وتأكيد رقمك وإكمال بيانات المركبة:`,
                [
                    [{ text: '🚕 فتح تطبيق الويب وتأكيد الرقم بواتساب', url: `https://tawseelaiq.app/?role=Driver&phone=${encodedPhone}` }],
                    [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]
                ]
            );
            return;
        }
        case 'driver_otp_sent': {
            const check = verifyTelegramOtp(chatId, text.trim());
            if (!check.valid) { await sendMessage(chatId, '❌ ' + check.error); return; }
            state.verifiedPhone = check.phone;
            state.step = 'driver_name';
            userStates.set(chatId, state);
            await sendMessage(chatId, '✅ تم التحقق!\nأرسل اسمك الكامل (الاسم واللقب):');
            break;
        }
        case 'driver_name': {
            state.fullName = text.trim();
            state.step = 'driver_vehicle';
            userStates.set(chatId, state);
            await sendMessage(chatId, '🚗 أرسل نوع وموديل المركبة (مثال: تويوتا كورولا 2021):');
            break;
        }
        case 'driver_vehicle': {
            state.vehicle = text.trim();
            state.step = 'driver_plate';
            userStates.set(chatId, state);
            await sendMessage(chatId, '🔢 أرسل رقم اللوحة:');
            break;
        }
        case 'driver_plate': {
            state.plate = text.trim();
            state.step = 'driver_location';
            userStates.set(chatId, state);
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: '📍 <b>الخطوة 2: تحديد موقعك الحالي:</b>\nاضغط على الزر أدناه لمشاركة موقعك الحالي تلقائياً، أو أرسل اسم منطقتك / عنوانك في رسالة:',
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: '📍 مشاركة موقعي الحالي', request_location: true }],
                        [{ text: 'تخطي وتحديد الموقع تلقائياً في التطبيق' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            break;
        }
        case 'driver_location': {
            await completeDriverRegistration(chatId, user, location || text);
            break;
        }
        case 'driver_password': {
            if (text.trim().length >= 4) state.password = text.trim();
            state.step = 'driver_location';
            userStates.set(chatId, state);
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: '📍 <b>الخطوة 2: تحديد موقعك الحالي:</b>\nاضغط على الزر أدناه لمشاركة موقعك الحالي تلقائياً، أو أرسل اسم منطقتك / عنوانك في رسالة:',
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: [
                        [{ text: '📍 مشاركة موقعي الحالي', request_location: true }],
                        [{ text: 'تخطي وتحديد الموقع تلقائياً في التطبيق' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            break;
        }

        // --- Login ---
        case 'login_phone': {
            const clean = normalizePhoneNumber(text);
            const digits = text.replace(/[^0-9]/g, '');
            if (digits.length < 10 || !clean || clean.length < 9) {
                userStates.delete(chatId);
                await sendKeyboard(chatId,
                    `❌ <b>الرقم المدخل (${text.trim()}) غير صحيح أو غير صالح.</b>\n\n` +
                    `يرجى التأكد من كتابة الرقم بشكل صحيح (مثال: <code>07701234567</code>)، أو يمكنك التحقق والتسجيل عبر تطبيق الويب:`,
                    [
                        [{ text: '🌐 فتح تطبيق الويب للتحقق والتسجيل', url: 'https://tawseelaiq.app/?role=Customer' }],
                        [{ text: '🔄 إعادة المحاولة في البوت', callback_data: 'login' }],
                        [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]
                    ]
                );
                return;
            }
            const existing = await checkPhoneRegistration(text);
            if (!existing) {
                userStates.delete(chatId);
                const cleanPhone = digits.startsWith('964') ? '0' + digits.substring(3) : (digits.startsWith('0') ? digits : '0' + digits);
                const encodedPhone = encodeURIComponent(cleanPhone);
                await sendKeyboard(chatId,
                    `❌ <b>هذا الرقم (${text.trim()}) غير مسجل في النظام.</b>\n\n` +
                    `💡 <i>لا حاجة للتحقق هنا في تيليجرام</i>؛ التحقق مفعّل وآمن في تطبيق الويب عبر واتساب و Truecaller.\n\n` +
                    `يرجى فتح تطبيق الويب للتحقق من رقمك وتوثيق حسابك:`,
                    [
                        [{ text: '🚶 تسجيل راكب في تطبيق الويب', url: `https://tawseelaiq.app/?role=Customer&phone=${encodedPhone}` }],
                        [{ text: '🚕 تسجيل كابتن في تطبيق الويب', url: `https://tawseelaiq.app/?role=Driver&phone=${encodedPhone}` }],
                        [{ text: '🔄 تجربة رقم آخر', callback_data: 'login' }],
                        [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]
                    ]
                );
                return;
            }
            state.phone = text.trim();
            state.step = 'login_otp_sent';
            userStates.set(chatId, state);
            await sendMessage(chatId, `ℹ️ تم العثور على الحساب (${existing.roleAr}). جاري إرسال رمز التحقق...`);
            await sendTelegramOtp(state.phone, chatId);
            break;
        }

        case 'login_otp_sent': {
            const check = verifyTelegramOtp(chatId, text.trim());
            if (!check.valid) { await sendMessage(chatId, '❌ ' + check.error); return; }
            const reg = await checkPhoneRegistration(check.phone);
            const phone = check.phone.replace('+964', '0');
            const customer = (reg && reg.role === 'Customer') ? reg.user : db.memoryState.customers.find(c => c.phoneNumber === phone);
            const driver = (reg && reg.role === 'Driver') ? reg.user : db.memoryState.drivers.find(d => d.phoneNumber === phone);
            if (customer) {
                customer.telegramChatId = String(chatId);
                db.saveStateSnapshot();
                db.persistTelegramChatId('Customer', customer.customerId, chatId).catch(()=>{});
                const token = 'jwt_customer_' + customer.customerId;
                await sendKeyboard(chatId,
                    `✅ <b>تم تسجيل الدخول كراكب بنجاح!</b>\n👤 مرحباً بك: <b>${customer.fullName}</b>\n\nيرجى تحديد نوع المشوار للمتابعة:`,
                    [
                        [
                            { text: '⚡ مشوار قصير', callback_data: 'passenger_trip_short' },
                            { text: '🔄 خط دائم', callback_data: 'passenger_trip_daily' }
                        ],
                        [{ text: '🚗 افتح التطبيق مباشرة', url: 'https://tawseelaiq.app/?login_token=' + encodeURIComponent(token) + '&userId=' + encodeURIComponent(customer.customerId) + '&role=Customer&fullName=' + encodeURIComponent(customer.fullName) }]
                    ]
                );
            } else if (driver) {
                driver.telegramChatId = String(chatId);
                db.saveStateSnapshot();
                db.persistTelegramChatId('Driver', driver.driverId, chatId).catch(()=>{});
                if (driver.status === 'Pending' || !driver.isVerified) {
                    const cfg = db.memoryState.appConfig || {};
                    const tgAdminLink = cfg.telegramAdminLink || 'https://t.me/tawseela_najaf_bot';
                    const waAdminLink = cfg.whatsappAdminLink || 'https://wa.me/9647706204066';
                    await sendMessage(chatId,
                        `⏳ حسابك كسائق لا يزال <b>معلّقاً</b> بانتظار التوثيق من قبل إدارة المنصة.\n\n` +
                        `📋 <b>يرجى إرسال المستمسكات عبر:</b>\n` +
                        `📱 واتساب: ${waAdminLink}\n` +
                        `💬 تيليجرام: ${tgAdminLink}\n\n` +
                        `سيتم التفعيل بعد مراجعة الإدارة في لوحة التحكم.`
                    );
                } else {
                    await sendKeyboard(chatId,
                        `✅ <b>تم تسجيل الدخول كسائق بنجاح!</b>\n👤 مرحباً بك الكابتن: <b>${driver.fullName}</b>\n\nيرجى تحديد نوع المشاوير التي ترغب بتقديمها:`,
                        [
                            [{ text: '⚡ مشاوير قصيرة', callback_data: 'driver_set_short' }],
                            [{ text: '🔄 خطوط دائمة', callback_data: 'driver_set_daily' }],
                            [{ text: '🚖 كلاهما (مشاوير قصيرة وخطوط دائمة)', callback_data: 'driver_set_both' }]
                        ]
                    );
                }
            } else {
                await sendMessage(chatId, '❌ لا يوجد حساب بهذا الرقم. سجّل أولاً عبر /start');
            }
            userStates.delete(chatId);
            break;
        }

        // --- Contact Admin ---
        case 'contact_msg': {
            const userName = user.first_name || 'مجهول';
            await sendMessage(ADMIN_CHAT_ID, `📩 رسالة من مستخدم تيليجرام:\n👤 ${userName} (${chatId})\n\n${text}`);
            await sendMessage(chatId, '✅ تم إرسال رسالتك للإدارة. سنرد عليك قريباً.');
            userStates.delete(chatId);
            break;
        }

        default:
            await handleStart(chatId, user);
    }
}

// --- Admin Commands ---
async function handleAdminStats(chatId) {
    const drivers = db.memoryState.drivers || [];
    const customers = db.memoryState.customers || [];
    const pending = drivers.filter(d => d.status === 'Pending').length;
    const active = drivers.filter(d => d.status === 'Active' || d.status === 'Approved').length;
    await sendMessage(chatId,
        `📊 <b>إحصائيات المنصة</b>\n\n` +
        `👥 الركاب: ${customers.length}\n` +
        `🚕 السائقين: ${drivers.length}\n` +
        `✅ نشط: ${active}\n` +
        `⏳ معلق: ${pending}\n` +
        `📅 التاريخ: ${new Date().toLocaleDateString('ar-IQ')}`
    );
}

async function handleAdminPending(chatId) {
    const pending = (db.memoryState.drivers || []).filter(d => d.status === 'Pending');
    if (pending.length === 0) { await sendMessage(chatId, '✅ لا يوجد سائقين بانتظار التوثيق.'); return; }
    for (const d of pending.slice(0, 10)) {
        await sendKeyboard(chatId,
            `👤 ${d.fullName}\n📱 ${d.phoneNumber}\n🚗 ${d.vehicle?.make || '-'} - ${d.vehicle?.plateNumber || '-'}`,
            [[
                { text: '✅ قبول', callback_data: `approve_${d.driverId}` },
                { text: '❌ رفض', callback_data: `reject_${d.driverId}` }
            ]]
        );
    }
}

async function handleApproveDriver(chatId, driverId) {
    const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
    if (!driver) { await sendMessage(chatId, '❌ السائق غير موجود.'); return; }
    driver.status = 'Active';
    driver.isVerified = true;
    const ver = db.memoryState.verifications.find(v => v.driverId === driverId);
    if (ver) ver.status = 'Approved';
    db.saveStateSnapshot();
    await sendMessage(chatId, `✅ تم تفعيل السائق: ${driver.fullName}`);
    // Notify driver
    if (driver.telegramChatId) {
        await sendKeyboard(driver.telegramChatId,
            '🎉 <b>تم تفعيل حسابك كسائق!</b>\n\n📌 ثبّت موقعك الدائمي على الخريطة ليتمكن الركاب من إيجادك:',
            [
                [{ text: '🗺️ فتح الخريطة لتثبيت موقعك الدائمي 📌', url: 'https://tawseelaiq.app/?login_token=' + encodeURIComponent('jwt_driver_' + driver.driverId) + '&userId=' + encodeURIComponent(driver.driverId) + '&role=Driver&fullName=' + encodeURIComponent(driver.fullName) + '&showMap=1' }],
                [{ text: '🚗 الدخول للتطبيق', url: 'https://tawseelaiq.app/?role=Driver' }]
            ]
        );
    }
}

async function handleRejectDriver(chatId, driverId) {
    const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
    if (!driver) { await sendMessage(chatId, '❌ السائق غير موجود.'); return; }
    driver.status = 'Rejected';
    const ver = db.memoryState.verifications.find(v => v.driverId === driverId);
    if (ver) ver.status = 'Rejected';
    db.saveStateSnapshot();
    await sendMessage(chatId, `❌ تم رفض السائق: ${driver.fullName}`);
    if (driver.telegramChatId) {
        await sendMessage(driver.telegramChatId, '❌ تم رفض طلبك. تواصل مع الإدارة: https://wa.me/9647706204066');
    }
}

// --- Polling Loop ---
let lastUpdateId = 0;
let pollingActive = false;

async function poll() {
    if (!pollingActive) return;
    try {
        const result = await tgRequest('getUpdates', { offset: lastUpdateId + 1, timeout: 30, allowed_updates: ['message', 'callback_query'] });
        if (result.ok && result.result && result.result.length > 0) {
            for (const update of result.result) {
                lastUpdateId = update.update_id;
                try {
                    if (update.callback_query) {
                        const cb = update.callback_query;
                        const chatId = cb.message?.chat?.id;
                        if (chatId) {
                            // --- Security gate for callbacks ---
                            const blocked = _securityGate(chatId, cb.data);
                            if (blocked) {
                                await tgRequest('answerCallbackQuery', { callback_query_id: cb.id });
                                if (blocked === 'flood_ban') {
                                    await sendMessage(chatId, '🚫 تم حظرك مؤقتاً بسبب إرسال رسائل مفرطة.');
                                    sendMessage(ADMIN_CHAT_ID, `⚠️ تم حظر مستخدم (flood): ${chatId}`).catch(()=>{});
                                }
                                continue;
                            }
                            // Validate callback_data format
                            const cbData = _sanitizeTgInput(cb.data);
                            if (!cbData || cbData.length > 100) continue;

                            await tgRequest('answerCallbackQuery', { callback_query_id: cb.id });
                            await handleCallback(chatId, cbData, cb.from);
                        }
                    } else if (update.message) {
                        const msg = update.message;
                        const chatId = msg.chat?.id;
                        if (!chatId) continue;

                        // Block group/supergroup/channel - only private chat allowed
                        if (msg.chat.type !== 'private') continue;

                        const rawText = (msg.text || '').trim();
                        const text = _sanitizeTgInput(rawText);
                        const location = msg.location;

                        // --- Security gate for messages ---
                        const blocked = _securityGate(chatId, text);
                        if (blocked) {
                            if (blocked === 'flood_ban') {
                                await sendMessage(chatId, '🚫 تم حظرك مؤقتاً بسبب إرسال رسائل مفرطة. حاول لاحقاً.');
                                sendMessage(ADMIN_CHAT_ID, `⚠️ تم حظر مستخدم (flood): ${chatId}`).catch(()=>{});
                            } else if (blocked === 'suspicious') {
                                await sendMessage(chatId, '⚠️ تم رفض الرسالة لأسباب أمنية.');
                                sendMessage(ADMIN_CHAT_ID, `🔴 محاولة مشبوهة من ${chatId}: ${text.substring(0, 100)}`).catch(()=>{});
                            } else if (blocked === 'rate_limit') {
                                await sendMessage(chatId, '⏳ أنت ترسل رسائل بسرعة كبيرة. انتظر قليلاً.');
                            }
                            // banned users get no response at all
                            continue;
                        }

                        // Commands
                        if (text === '/start') { await handleStart(chatId, msg.from); }
                        else if (text === '/status') {
                            await sendMessage(chatId, 'ℹ️ استخدم /start لبدء التسجيل أو تسجيل الدخول.');
                        }
                        else if (text === '/admin' && String(chatId) === ADMIN_CHAT_ID) {
                            await sendKeyboard(chatId, '🔧 <b>لوحة الإدارة</b>', [
                                [{ text: '📊 إحصائيات', callback_data: 'admin_stats' }],
                                [{ text: '⏳ سائقين معلقين', callback_data: 'admin_pending' }],
                                [{ text: '🛡️ سجل الأمان', callback_data: 'admin_security_log' }]
                            ]);
                        }
                        else { await handleMessage(chatId, text, msg.from, location); }
                    }
                } catch (e) {
                    console.error('[TelegramBot] Update error:', e.message);
                }
            }
        }
    } catch (e) {
        console.error('[TelegramBot] Poll error:', e.message);
    }
    if (pollingActive) setTimeout(poll, 1000);
}

function startBot() {
    if (pollingActive) return;
    pollingActive = true;
    console.log('[TelegramBot] Started polling...');
    // Delete webhook first (in case one exists)
    tgRequest('deleteWebhook', {}).then(() => {
        poll();
    }).catch(() => { poll(); });
}

function stopBot() {
    pollingActive = false;
    console.log('[TelegramBot] Stopped.');
}

// Admin message from dashboard
async function sendAdminNotification(text) {
    try { await sendMessage(ADMIN_CHAT_ID, text); } catch (_) {}
}

// Send message to a specific user by chatId
async function notifyUser(chatId, text) {
    try { await sendMessage(chatId, text); } catch (_) {}
}

// Broadcast message to all registered users (customers and drivers with telegramChatId + admin)
async function broadcastNotification(text) {
    const recipients = new Set();
    if (ADMIN_CHAT_ID) recipients.add(String(ADMIN_CHAT_ID));
    
    // Add known registered users
    (db.memoryState.customers || []).forEach(c => {
        if (c.telegramChatId) recipients.add(String(c.telegramChatId));
    });
    (db.memoryState.drivers || []).forEach(d => {
        if (d.telegramChatId) recipients.add(String(d.telegramChatId));
    });
    
    // Add all tracked subscribers
    (db.memoryState.botSubscribers || []).forEach(chatId => {
        recipients.add(String(chatId));
    });

    let sentCount = 0;
    let failedCount = 0;
    // Just plain text, no HTML tags (since user said only text)
    // Actually, sending as plain text to avoid parse errors and just be normal text.
    const cleanText = text.replace(/<[^>]*>?/gm, ''); // remove html if any
    const formattedMsg = `📢 إشعار عام من إدارة المنصة:\n\n${cleanText}`;
    
    for (const chatId of recipients) {
        try {
            await sendMessage(chatId, formattedMsg, { parse_mode: '' }); // send as plain text
            sentCount++;
        } catch (e) {
            failedCount++;
        }
    }
    return { success: true, sentCount, failedCount, total: recipients.size };
}

module.exports = { startBot, stopBot, sendAdminNotification, broadcastNotification, notifyUser, sendMessage };
