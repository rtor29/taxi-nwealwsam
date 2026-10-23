'use strict';
const https = require('https');
const config = require('../../config');
const db = require('../../db');
const redisManager = require('../redis/redisClient');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || config.telegram?.botToken || '8904440367:AAEBLFy5DK-eM_MDqiLwQYgHIi-h-tjvyfU';
if (!BOT_TOKEN) { console.error('[TelegramBot] TELEGRAM_BOT_TOKEN env var is required!'); }
const ADMIN_CHAT_ID = '391762837';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const REQUIRED_CHANNEL = process.env.TELEGRAM_CHANNEL || config.telegram?.channel || '@tawseelaiq';
const REQUIRED_GROUP = process.env.TELEGRAM_GROUP || config.telegram?.group || '@tawseelaiqc';
const BOT_USERNAME = '@tawseela_najaf_bot';
const GROQ_API_KEY = process.env.GROQ_API_KEY || config.telegram?.groqApiKey || '';

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
const _tgBannedUsers = new Set();   // permanently blocked chatIds
const _tgSuspiciousLog = [];        // log of suspicious activity

// Restore persisted banned users
try {
    if (db.memoryState && Array.isArray(db.memoryState.bannedTelegramUsers)) {
        db.memoryState.bannedTelegramUsers.forEach(id => _tgBannedUsers.add(String(id)));
    }
} catch (_) {}

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
        try {
            if (db.memoryState) {
                if (!db.memoryState.bannedTelegramUsers) db.memoryState.bannedTelegramUsers = [];
                if (!db.memoryState.bannedTelegramUsers.includes(cid)) {
                    db.memoryState.bannedTelegramUsers.push(cid);
                    db.saveStateSnapshot();
                }
            }
        } catch (_) {}
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
    const maskedChatId = String(chatId).length > 4 ? `${String(chatId).slice(0, 3)}****` : '****';
    console.log(`[TelegramBot] Dispatching message to chatId: ${maskedChatId}`);
    return tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });
}

function editMessageText(chatId, messageId, text, opts = {}) {
    const maskedChatId = String(chatId).length > 4 ? `${String(chatId).slice(0, 3)}****` : '****';
    console.log(`[TelegramBot] Editing message ${messageId} for chatId: ${maskedChatId}`);
    return tgRequest('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...opts });
}

function sendKeyboard(chatId, text, buttons) {
    return sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: buttons }
    });
}

// --- Mandatory Subscription Enforcement ---
async function checkUserSubscription(userId) {
    if (String(userId) === ADMIN_CHAT_ID) {
        return { subscribed: true, inChannel: true, inGroup: true };
    }

    const validStatuses = ['creator', 'administrator', 'member', 'restricted'];

    try {
        const [chRes, grpRes] = await Promise.all([
            tgRequest('getChatMember', { chat_id: REQUIRED_CHANNEL, user_id: userId }),
            tgRequest('getChatMember', { chat_id: REQUIRED_GROUP, user_id: userId })
        ]);

        const inChannel = chRes && chRes.ok && chRes.result && validStatuses.includes(chRes.result.status);
        const inGroup = grpRes && grpRes.ok && grpRes.result && validStatuses.includes(grpRes.result.status);

        return {
            subscribed: Boolean(inChannel && inGroup),
            inChannel: Boolean(inChannel),
            inGroup: Boolean(inGroup)
        };
    } catch (err) {
        console.warn('[TelegramBot] Subscription check error:', err.message);
        // Fallback: If bot lacks admin rights or error occurred, allow access defensively
        return { subscribed: true, inChannel: true, inGroup: true, fallback: true };
    }
}

async function sendSubscriptionGateMessage(chatId) {
    const text = `أهلاً بك في منصة توصيلة 🚖\nلإكمال استخدام البوت واستلام إشعارات المشاوير والخدمات، يرجى أولاً الانضمام إلى منصاتنا الرسمية:`;
    const keyboard = [
        [
            { text: '📢 القناة الرسمية لتوصيلة', url: 'https://t.me/tawseelaiq' }
        ],
        [
            { text: '💬 كروب المحادثة والدعم', url: 'https://t.me/tawseelaiqc' }
        ],
        [
            { text: 'تأكيد الاشتراك والمتابعة 🔄', callback_data: 'check_subscription' }
        ]
    ];
    return sendKeyboard(chatId, text, keyboard);
}

// --- Anti-Link & Anti-Promotion Engine for Group (@tawseelaiqc) ---
function containsUnauthorizedLink(text) {
    if (!text || typeof text !== 'string') return false;

    // Detect URLs, Telegram links, or mentions
    const linkRegex = /(https?:\/\/[^\s]+|t\.me\/[^\s]+|telegram\.me\/[^\s]+|@[a-zA-Z0-9_]+)/gi;
    const matches = text.match(linkRegex);
    if (!matches || matches.length === 0) return false;

    for (const match of matches) {
        const lower = match.toLowerCase();
        const isWhitelisted =
            lower.includes('tawseelaiq.app') ||
            lower.includes('t.me/tawseelaiq') ||
            lower.includes('t.me/tawseelaiqc') ||
            lower.includes('t.me/tawseela_najaf_bot') ||
            lower === '@tawseelaiq' ||
            lower === '@tawseelaiqc' ||
            lower === '@tawseela_najaf_bot';

        if (!isWhitelisted) {
            return true;
        }
    }
    return false;
}

// --- Group Moderation: Anti-link and Zero-Token Welcome ---
async function handleGroupModeration(msg) {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const from = msg.from || {};
    const text = msg.text || msg.caption || '';

    // 1. Anti-link & Anti-promotion enforcement
    if (containsUnauthorizedLink(text)) {
        try {
            await tgRequest('deleteMessage', { chat_id: chatId, message_id: messageId });
            const userName = from.first_name || from.username || 'العضو';
            const warnRes = await sendMessage(
                chatId,
                `عذراً يا ${userName} ⚠️\nيُمنع نشر الروابط أو الإعلانات الترويجية داخل الكروب للحفاظ على أمان وخصوصية الأعضاء 🚖.`
            );
            if (warnRes?.result?.message_id) {
                setTimeout(() => {
                    tgRequest('deleteMessage', { chat_id: chatId, message_id: warnRes.result.message_id }).catch(() => {});
                }, 12000);
            }
        } catch (e) {
            console.warn('[TelegramBot] Anti-link deletion error:', e.message);
        }
        return true;
    }

    // 2. Zero-Token Welcome System (New Members)
    if (msg.new_chat_members && msg.new_chat_members.length > 0) {
        for (const newMember of msg.new_chat_members) {
            if (newMember.is_bot) continue;
            const name = newMember.first_name || newMember.username || 'عزيزنا';
            const welcomeText = `أهلاً وسهلاً بك ${name} في كروب توصيلة الرسمي 🚖\nهنا يمكنك الاستفسار عن خدمات التاكسي والخطوط الدائمية في النجف الأشرف.\nللتسجيل وطلب تكسي: https://tawseelaiq.app\nنتمنى لك رحلات آمنة ومريحة!`;
            sendMessage(chatId, welcomeText).catch(() => {});
        }
        try {
            tgRequest('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
        } catch (_) {}
        return true;
    }

    // 3. Delete Left Chat Member service notification
    if (msg.left_chat_member) {
        try {
            tgRequest('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
        } catch (_) {}
        return true;
    }

    return false;
}

// --- Groq AI Customer Support Engine ---
async function askGroqAI(userPrompt) {
    if (!GROQ_API_KEY) {
        return 'عذراً، محرك الذكاء الاصطناعي غير متصل حالياً. يمكنك استخدام التطبيق عبر الرابط: https://tawseelaiq.app 🚖';
    }

    const systemPrompt = `أنت المساعد الذكي الرسمي الحصري لمنظومة وتطبيق «توصيلة» (Tawseela IQ) للنقل الذكي في محافظة النجف الأشرف والعراق.
مهمتك تقديم الدعم الفني والإجابة عن استفسارات المستخدمين والركاب والكباتن بلغة عربية عراقية/فصحى ودودة وواضحة وموجزة ومباشرة.

معلومات المنظومة والخدمات:
1. حجز تكسي فوري: عبر تطبيق الويب https://tawseelaiq.app باختيار نقطة الانطلاق والوصول وتأكيد الطلب.
2. حجز خط دائمي (باصات وستاركس): للجامعات (مثل جامعة الكوفة) والموظفين عبر تبويب "خط دائمي" في التطبيق.
3. تسجيل الركاب: يتم برقم الهاتف العراقي واستلام رمز التحقق (OTP) السريع عبر التيليجرام أو الواتساب.
4. تسجيل الكباتن (السائقين): عبر بوابة https://tawseelaiq.app/captain-login أو زر "سجل كابتن" في التطبيق مع رفع المستمسكات (إجازة السوق، البطاقة الوطنية، صور السيارة).
5. التسعيرة القياسية المعتمدة (معايير بلي):
   - فتح العداد: 1,000 دينار عراقي
   - سعر الكيلومتر: 500 دينار عراقي
   - سعر الدقيقة: 100 دينار عراقي
   - الحد الأدنى للرحلة: 3,000 دينار عراقي
   - رسوم الإلغاء: 1,500 دينار عراقي
   - التقريب: يتم تقريب الأجرة صعوداً لأقرب 250 دينار عراقي دائماً.

قواعد صارمة:
- إذا سألك المستخدم عن أي موضوع عام خارج نطاق تطبيق وخدمات توصيلة (مثل: سياسة، برمجة، طب، دين، أو مواضيع عامة)، يجب أن ترفض بلباقة وحزم بالصيغة التالية نصاً:
"أنا المساعد الذكي المخصص لمنظومة «توصيلة» فقط 🚖. يسعدني مساعدتك في كل ما يخص حجز الرحلات، التسجيل، أو الأسعار في تطبيقنا!"
- اجعل إجاباتك دقيقة، مفيدة ومباشرة دون إطالة غير مبررة ولا تتجاوز فقرتين.`;

    const requestBody = JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.6,
        max_tokens: 350
    });

    return new Promise((resolve) => {
        const options = {
            hostname: 'api.groq.com',
            port: 443,
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody)
            },
            timeout: 10000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const reply = parsed?.choices?.[0]?.message?.content;
                    if (reply) {
                        resolve(reply.trim());
                    } else {
                        resolve('يسعدنا خدمتك عبر تطبيق «توصيلة» 🚖. يمكنك حجز الرحلات مباشرة عبر: https://tawseelaiq.app');
                    }
                } catch (_) {
                    resolve('أهلاً بك في توصيلة 🚖. يرجى زيارة https://tawseelaiq.app لطلب مشوارك.');
                }
            });
        });

        req.on('error', (err) => {
            console.warn('[Groq AI Error]:', err.message);
            resolve('أهلاً بك في توصيلة 🚖. يمكنك حجز مشوارك أو التسجيل مباشرة من: https://tawseelaiq.app');
        });

        req.on('timeout', () => {
            req.destroy();
            resolve('أهلاً بك في توصيلة 🚖. يمكنك حجز مشوارك مباشرة عبر: https://tawseelaiq.app');
        });

        req.write(requestBody);
        req.end();
    });
}

// --- Banned Users Management ---
function getBannedUsers() {
    const list = [];
    for (const cid of _tgBannedUsers) {
        const lastLog = _tgSuspiciousLog.slice().reverse().find(l => l.chatId === cid);
        list.push({
            chatId: cid,
            type: 'telegram_user',
            reason: lastLog?.reason || 'flood_or_violation',
            snippet: lastLog?.text || 'محاولات مفرطة أو اختراق',
            bannedAt: lastLog?.time || new Date().toISOString()
        });
    }
    return list;
}

function unbanUser(chatId) {
    const cid = String(chatId);
    _tgBannedUsers.delete(cid);
    _tgFloodMap.delete(cid);
    _tgRateMap.delete(cid);
    try {
        if (db.memoryState && Array.isArray(db.memoryState.bannedTelegramUsers)) {
            db.memoryState.bannedTelegramUsers = db.memoryState.bannedTelegramUsers.filter(x => String(x) !== cid);
            db.saveStateSnapshot();
        }
    } catch (_) {}
    return true;
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

// --- Normalize Iraqi Phone (Unified Helper) ---
function normalizeIraqiPhone(raw) {
    if (!raw) return { cleanPhone: '', intlPhone: '', displayPhone: '' };
    const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
    let str = String(raw).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d));
    let digits = str.replace(/[^0-9]/g, '');
    if (digits.startsWith('00964')) digits = digits.substring(5);
    else if (digits.startsWith('964')) digits = digits.substring(3);
    
    if (digits.length === 10 && digits.startsWith('7')) {
        digits = '0' + digits;
    }
    const cleanPhone = digits;
    const intlPhone = digits.startsWith('0') ? '+964' + digits.substring(1) : '+964' + digits;
    const displayPhone = cleanPhone || String(raw).trim();
    return { cleanPhone, intlPhone, displayPhone };
}

// --- Prompt User for Phone Number (Contact Request Button + Manual Typing) ---
async function promptUserForPhone(chatId) {
    userStates.set(chatId, { step: 'awaiting_phone' });
    const promptText = `أهلاً بك في منصة توصيلة 🚖\nيرجى إرسال رقم هاتفك لتأكيد حسابك وتفعيل استلام الإشعارات اللحظية.`;
    return tgRequest('sendMessage', {
        chat_id: chatId,
        text: promptText,
        reply_markup: {
            keyboard: [
                [{ text: '📱 مشاركة رقم هاتفي', request_contact: true }]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
}

// --- Link User / Driver by Phone (Deep Link / Auto-Link & Role Routing) ---
async function linkUserByPhone(chatId, rawPhone, user) {
    if (!chatId || !rawPhone) return false;
    const { cleanPhone, intlPhone, displayPhone } = normalizeIraqiPhone(rawPhone);
    if (!cleanPhone || cleanPhone.length < 8) {
        await sendMessage(chatId, '⚠️ يرجى إرسال رقم هاتف عراقي صالح (مثال: 07701234567)');
        return false;
    }

    const tgUsername = user?.username ? `@${user.username}` : '';
    const shortDigits = cleanPhone.length >= 9 ? cleanPhone.slice(-9) : cleanPhone;

    const phoneMatches = (p) => {
        if (!p) return false;
        const norm = normalizeIraqiPhone(p).cleanPhone;
        if (norm === cleanPhone) return true;
        if (shortDigits && norm.endsWith(shortDigits)) return true;
        return false;
    };

    // 1. الحالة الأولى: مسجل مسبقاً في الداش بورد كسائق (Driver)
    let driver = (db.memoryState.drivers || []).find(d => phoneMatches(d.phoneNumber) || phoneMatches(d.phone));
    if (!driver && db.isPostgresConnected && db.pool) {
        try {
            const pgDrv = await db.pool.query(
                `SELECT * FROM drivers 
                 WHERE phone_number = $1 OR phone_number = $2 
                    OR phone_number LIKE '%' || $3
                 LIMIT 1`,
                [cleanPhone, intlPhone, shortDigits]
            );
            if (pgDrv.rows && pgDrv.rows.length > 0) {
                const row = pgDrv.rows[0];
                driver = (db.memoryState.drivers || []).find(d => d.driverId === row.driver_id) || {
                    driverId: row.driver_id,
                    fullName: row.full_name,
                    phoneNumber: row.phone_number
                };
                if (!db.memoryState.drivers.some(d => d.driverId === driver.driverId)) {
                    db.memoryState.drivers.unshift(driver);
                }
            }
        } catch (e) {
            console.warn('[TelegramBot] PG driver lookup error:', e.message);
        }
    }

    if (driver) {
        const driverName = driver.fullName || 'كابتن';
        driver.telegramChatId = String(chatId);
        driver.telegram_chat_id = String(chatId);
        driver.telegramUsername = tgUsername;
        driver.telegram_username = tgUsername;
        driver.telegramLinkedAt = new Date().toISOString();
        driver.telegram_linked_at = driver.telegramLinkedAt;
        db.saveStateSnapshot();
        db.persistTelegramChatId('Driver', driver.driverId, chatId, tgUsername).catch(() => {});

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(
                    `UPDATE drivers 
                     SET telegram_chat_id = $1, telegram_username = $2, telegram_linked_at = NOW() 
                     WHERE phone_number = $3 OR phone_number = $4 OR driver_id = $5`,
                    [String(chatId), tgUsername, cleanPhone, intlPhone, driver.driverId]
                );
            } catch (_) {}
        }

        // مسح كيبورد الأزرار السفلية وإرسال رسالة الترحيب الخاصة بالسائق
        await tgRequest('sendMessage', {
            chat_id: chatId,
            text: `أهلاً وسهلاً بك كابتن ${driverName}! 🚖\n\nتم تأكيد وتفعيل حسابك بنجاح ✅\nمعرف حسابك مثبت الآن في لوحة التحكم، وستصلك إشعارات المشاوير الجديدة مباشرة هنا.`,
            reply_markup: { remove_keyboard: true }
        });

        const token = 'jwt_driver_' + driver.driverId;
        const returnUrl = `https://tawseelaiq.app/?role=Driver&phone=${encodeURIComponent(cleanPhone)}&login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(driver.driverId)}&fullName=${encodeURIComponent(driverName)}`;

        await sendKeyboard(chatId,
            `اضغط أدناه لفتح واجهة الكابتن:`,
            [
                [{ text: 'فتح واجهة الكابتن 🚖', url: returnUrl }]
            ]
        );
        userStates.delete(chatId);
        return true;
    }

    // 2. الحالة الثانية: مسجل كراكب (Customer)
    let customer = (db.memoryState.customers || []).find(c => phoneMatches(c.phoneNumber) || phoneMatches(c.phone));
    if (!customer && db.isPostgresConnected && db.pool) {
        try {
            const pgCust = await db.pool.query(
                `SELECT * FROM customers 
                 WHERE phone_number = $1 OR phone_number = $2 
                    OR phone_number LIKE '%' || $3
                 LIMIT 1`,
                [cleanPhone, intlPhone, shortDigits]
            );
            if (pgCust.rows && pgCust.rows.length > 0) {
                const row = pgCust.rows[0];
                customer = (db.memoryState.customers || []).find(c => c.customerId === row.customer_id) || {
                    customerId: row.customer_id,
                    fullName: row.full_name,
                    phoneNumber: row.phone_number
                };
                if (!db.memoryState.customers.some(c => c.customerId === customer.customerId)) {
                    db.memoryState.customers.unshift(customer);
                }
            }
        } catch (e) {
            console.warn('[TelegramBot] PG customer lookup error:', e.message);
        }
    }

    if (customer) {
        const customerName = customer.fullName || 'الراكب';
        customer.telegramChatId = String(chatId);
        customer.telegram_chat_id = String(chatId);
        customer.telegramUsername = tgUsername;
        customer.telegram_username = tgUsername;
        customer.telegramLinkedAt = new Date().toISOString();
        customer.telegram_linked_at = customer.telegramLinkedAt;
        db.saveStateSnapshot();
        db.persistTelegramChatId('Customer', customer.customerId, chatId, tgUsername).catch(() => {});

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(
                    `UPDATE customers 
                     SET telegram_chat_id = $1, telegram_username = $2, telegram_linked_at = NOW() 
                     WHERE phone_number = $3 OR phone_number = $4 OR customer_id = $5`,
                    [String(chatId), tgUsername, cleanPhone, intlPhone, customer.customerId]
                );
            } catch (_) {}
        }

        await tgRequest('sendMessage', {
            chat_id: chatId,
            text: `أهلاً وسهلاً بك ${customerName}! 🚖\n\nتم تأكيد وربط حسابك بنجاح ✅\nمعرف حسابك مسجل بالنظام، وستصلك رسائل فورية بتفاصيل رحلاتك ووصول الكابتن لموقعك.`,
            reply_markup: { remove_keyboard: true }
        });

        const token = 'jwt_customer_' + customer.customerId;
        const returnUrl = `https://tawseelaiq.app/?role=Customer&phone=${encodeURIComponent(cleanPhone)}&login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(customer.customerId)}&fullName=${encodeURIComponent(customerName)}`;

        await sendKeyboard(chatId,
            `اضغط أدناه لفتح تطبيق توصيلة للركاب:`,
            [
                [{ text: 'فتح تطبيق توصيلة للركاب 🚖', url: returnUrl }]
            ]
        );
        userStates.delete(chatId);
        return true;
    }

    // 3. الحالة الثالثة: غير مسجل في النظام إطلاقاً
    userStates.delete(chatId);
    await tgRequest('sendMessage', {
        chat_id: chatId,
        text: `عذراً، رقم الهاتف (${displayPhone}) غير مسجل بعد في منصة توصيلة ⚠️\n\n• إذا كنت راكباً: يمكنك الدخول للتطبيق وتسجيل حساب جديد فوراً عبر الرابط أدناه.\n• إذا كنت كابتناً: يرجى مراجعة إدارة توصيلة لتسجيل وتفعيل حسابك أولاً.`,
        reply_markup: { remove_keyboard: true }
    });

    await sendKeyboard(chatId,
        `للتسجيل كراكب جديد اضغط أدناه:`,
        [
            [{ text: 'تسجيل حساب راكب جديد 📲', url: 'https://tawseelaiq.app/login' }]
        ]
    );
    return false;
}

// --- Bot Command Handlers ---
async function handleStart(chatId, user) {
    if (!db.memoryState.botSubscribers) db.memoryState.botSubscribers = [];
    if (!db.memoryState.botSubscribers.includes(String(chatId))) { 
        db.memoryState.botSubscribers.push(String(chatId)); 
        db.saveStateSnapshot(); 
    }

    userStates.delete(chatId);

    // 1. التحقق الإلزامي من الاشتراك في القناة والكروب
    if (String(chatId) !== ADMIN_CHAT_ID) {
        const sub = await checkUserSubscription(user?.id || chatId);
        if (!sub.subscribed) {
            return sendSubscriptionGateMessage(chatId);
        }
    }

    // 2. التحقق مما إذا كان المستخدم مسجلاً بالفعل كسائق
    let driver = (db.memoryState.drivers || []).find(d => String(d.telegramChatId) === String(chatId));
    if (!driver && db.isPostgresConnected && db.pool) {
        try {
            const pgDrv = await db.pool.query('SELECT * FROM drivers WHERE telegram_chat_id = $1 LIMIT 1', [String(chatId)]);
            if (pgDrv.rows && pgDrv.rows.length > 0) {
                const r = pgDrv.rows[0];
                driver = {
                    driverId: r.driver_id,
                    fullName: r.full_name,
                    phoneNumber: r.phone_number,
                    telegramChatId: r.telegram_chat_id,
                    telegramUsername: r.telegram_username,
                    telegramLinkedAt: r.telegram_linked_at
                };
            }
        } catch (_) {}
    }

    if (driver) {
        const driverName = driver.fullName || 'كابتن';
        const cleanPhone = normalizeIraqiPhone(driver.phoneNumber).cleanPhone;
        const token = 'jwt_driver_' + driver.driverId;
        const driverUrl = `https://tawseelaiq.app/?role=Driver&phone=${encodeURIComponent(cleanPhone)}&login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(driver.driverId)}&fullName=${encodeURIComponent(driverName)}`;

        await tgRequest('sendMessage', {
            chat_id: chatId,
            text: `أهلاً وسهلاً بك كابتن ${driverName}! 🚖\n\nتم تأكيد وتفعيل حسابك بنجاح ✅\nمعرف حسابك مثبت الآن في لوحة التحكم، وستصلك إشعارات المشاوير الجديدة مباشرة هنا.`,
            reply_markup: { remove_keyboard: true }
        });

        return sendKeyboard(chatId,
            `اضغط أدناه لفتح واجهة الكابتن:`,
            [
                [{ text: 'فتح واجهة الكابتن 🚖', url: driverUrl }],
                [{ text: '🔄 ربط أو تغيير رقم الهاتف', callback_data: 'prompt_phone' }]
            ]
        );
    }

    // 3. التحقق مما إذا كان المستخدم مسجلاً بالفعل كراكب
    let customer = (db.memoryState.customers || []).find(c => String(c.telegramChatId) === String(chatId));
    if (!customer && db.isPostgresConnected && db.pool) {
        try {
            const pgCust = await db.pool.query('SELECT * FROM customers WHERE telegram_chat_id = $1 LIMIT 1', [String(chatId)]);
            if (pgCust.rows && pgCust.rows.length > 0) {
                const r = pgCust.rows[0];
                customer = {
                    customerId: r.customer_id,
                    fullName: r.full_name,
                    phoneNumber: r.phone_number,
                    telegramChatId: r.telegram_chat_id,
                    telegramUsername: r.telegram_username,
                    telegramLinkedAt: r.telegram_linked_at
                };
            }
        } catch (_) {}
    }

    if (customer) {
        const customerName = customer.fullName || 'الراكب';
        const cleanPhone = normalizeIraqiPhone(customer.phoneNumber).cleanPhone;
        const token = 'jwt_customer_' + customer.customerId;
        const customerUrl = `https://tawseelaiq.app/?role=Customer&phone=${encodeURIComponent(cleanPhone)}&login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(customer.customerId)}&fullName=${encodeURIComponent(customerName)}`;

        await tgRequest('sendMessage', {
            chat_id: chatId,
            text: `أهلاً وسهلاً بك ${customerName}! 🚖\n\nتم تأكيد وربط حسابك بنجاح ✅\nمعرف حسابك مسجل بالنظام، وستصلك رسائل فورية بتفاصيل رحلاتك ووصول الكابتن لموقعك.`,
            reply_markup: { remove_keyboard: true }
        });

        return sendKeyboard(chatId,
            `اضغط أدناه لفتح تطبيق توصيلة للركاب:`,
            [
                [{ text: 'فتح تطبيق توصيلة للركاب 🚖', url: customerUrl }],
                [{ text: '🔄 ربط أو تغيير رقم الهاتف', callback_data: 'prompt_phone' }]
            ]
        );
    }

    // 4. المستخدم غير مرتبط: نطلب منه إرسال رقم الهاتف مع زر مشاركة جهة الاتصال
    return promptUserForPhone(chatId);
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

// --- Handle Booking Decision from Captain via Bot Inline Buttons ---
async function handleBookingDecisionCallback(chatId, data, user, queryId, messageId = null) {
    const isAccept = data.startsWith('bk_accept_');
    const bookingId = data.replace(isAccept ? 'bk_accept_' : 'bk_reject_', '').trim();
    
    // 1. Idempotency Lock via Redis: double-click prevention
    const lockKey = `tg:cb:${bookingId}:${chatId}`;
    const lockAcquired = await redisManager.acquireTelegramNotificationLock(lockKey, 30);
    if (!lockAcquired) {
        if (queryId) {
            await tgRequest('answerCallbackQuery', {
                callback_query_id: queryId,
                text: '⚠️ جارٍ معالجة هذا الطلب بالفعل...',
                show_alert: false
            }).catch(() => {});
        }
        return;
    }

    // 2. Fetch booking from Memory / PostgreSQL
    let booking = (db.memoryState.bookings || []).find(b => (b.id === bookingId || b.bookingId === bookingId));
    if (!booking && db.isPostgresConnected && db.pool) {
        try {
            const pgRes = await db.pool.query('SELECT * FROM bookings WHERE id = $1 LIMIT 1', [bookingId]);
            if (pgRes.rows && pgRes.rows.length > 0) {
                const r = pgRes.rows[0];
                booking = {
                    id: r.id,
                    bookingId: r.id,
                    routeId: r.route_id,
                    driverId: r.driver_id,
                    driverName: r.driver_name,
                    driverPhone: r.driver_phone,
                    customerId: r.customer_id,
                    customerName: r.customer_name,
                    customerPhone: r.customer_phone,
                    pickupLocation: r.pickup_name || '',
                    dropoffLocation: r.dropoff_name || '',
                    seatsBooked: r.seats_booked || 1,
                    status: r.status,
                    createdAt: r.created_at
                };
            }
        } catch (err) {
            console.error('[TelegramBot] Fetch booking error:', err.message);
        }
    }

    if (!booking) {
        if (queryId) {
            await tgRequest('answerCallbackQuery', {
                callback_query_id: queryId,
                text: 'لم يعد الطلب متاحاً',
                show_alert: true
            }).catch(() => {});
        }
        if (messageId) {
            await editMessageText(chatId, messageId, '⚠️ <i>لم يعد طلب الحجز متاحاً</i>', { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        }
        return;
    }

    // 3. RLS Check: Sender chatId must match assigned captain\'s telegramChatId or Admin
    const assignedChatId = await findDriverTelegramChatId(booking.driverId, booking.driverPhone);
    const isAdmin = String(chatId) === String(ADMIN_CHAT_ID);
    const isOwner = assignedChatId && String(chatId) === String(assignedChatId);
    if (!isOwner && !isAdmin) {
        if (queryId) {
            await tgRequest('answerCallbackQuery', {
                callback_query_id: queryId,
                text: '🚫 غير مصرح: هذا الحجز مخصص لكابتن آخر (RLS)',
                show_alert: true
            }).catch(() => {});
        }
        return;
    }

    // 4. State Machine Check: only Pending can be accepted or declined
    const curStatus = String(booking.status || 'Pending').toLowerCase();
    if (curStatus !== 'pending') {
        const stAr = (curStatus === 'confirmed' || curStatus === 'accepted') ? 'تم قبوله مسبقاً' : ((curStatus === 'declined' || curStatus === 'rejected') ? 'تم رفضه مسبقاً' : 'ملغي أو غير متاح');
        if (queryId) {
            await tgRequest('answerCallbackQuery', {
                callback_query_id: queryId,
                text: `⚠️ لم يعد الطلب متاحاً (${stAr})`,
                show_alert: true
            }).catch(() => {});
        }
        if (messageId) {
            await editMessageText(chatId, messageId, `⚠️ <i>طلب الحجز غير متاح (${stAr})</i>`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        }
        return;
    }

    // 5. Execute action via shared adminController
    const adminController = require('../admin/adminController');
    const authUser = { id: booking.driverId, role: 'Driver', phone: booking.driverPhone };

    if (isAccept) {
        const result = await adminController.acceptBooking(bookingId, booking.driverId, authUser);
        if (result.success) {
            if (queryId) {
                await tgRequest('answerCallbackQuery', {
                    callback_query_id: queryId,
                    text: '✅ قبلت الحجز بنجاح',
                    show_alert: false
                }).catch(() => {});
            }
            if (messageId) {
                const editedText = `✅ <b>قبلت الحجز ✅</b>\n\n` +
                    `👤 <b>الراكب:</b> ${booking.customerName || 'راكب'}\n` +
                    `📍 <b>المسار:</b> ${booking.pickupLocation || ''} ➔ ${booking.dropoffLocation || ''}\n` +
                    `💺 <b>المقاعد:</b> ${booking.seatsBooked || 1}\n` +
                    `📞 <b>هاتف الراكب:</b> <code>${booking.customerPhone || 'غير متوفر'}</code>\n\n` +
                    `<i>تم تأكيد المقعد وإشعار الراكب بتفاصيلك.</i>`;
                await editMessageText(chatId, messageId, editedText, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
            }
        } else {
            if (queryId) {
                await tgRequest('answerCallbackQuery', {
                    callback_query_id: queryId,
                    text: result.error || 'تعذر قبول الحجز',
                    show_alert: true
                }).catch(() => {});
            }
            if (messageId) {
                await editMessageText(chatId, messageId, `⚠️ <i>تعذر قبول الحجز: ${result.error || ''}</i>`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
            }
        }
    } else {
        const result = await adminController.declineBooking(bookingId, 'المقاعد مكتملة', booking.driverId, authUser);
        if (result.success) {
            if (queryId) {
                await tgRequest('answerCallbackQuery', {
                    callback_query_id: queryId,
                    text: '❌ رفضت الطلب',
                    show_alert: false
                }).catch(() => {});
            }
            if (messageId) {
                const editedText = `❌ <b>رفضت الطلب ❌</b>\n\n` +
                    `👤 <b>الراكب:</b> ${booking.customerName || 'راكب'}\n` +
                    `📍 <b>المسار:</b> ${booking.pickupLocation || ''} ➔ ${booking.dropoffLocation || ''}\n` +
                    `<i>تم تحديث الحالة وإشعار الراكب.</i>`;
                await editMessageText(chatId, messageId, editedText, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
            }
        } else {
            if (queryId) {
                await tgRequest('answerCallbackQuery', {
                    callback_query_id: queryId,
                    text: result.error || 'تعذر رفض الحجز',
                    show_alert: true
                }).catch(() => {});
            }
            if (messageId) {
                await editMessageText(chatId, messageId, `⚠️ <i>تعذر رفض الحجز: ${result.error || ''}</i>`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
            }
        }
    }
}

async function handleCallback(chatId, data, user, queryId, messageId = null) {
    if (!db.memoryState.botSubscribers) db.memoryState.botSubscribers = [];
    if (!db.memoryState.botSubscribers.includes(String(chatId))) { db.memoryState.botSubscribers.push(String(chatId)); db.saveStateSnapshot(); }

    if (data.startsWith('bk_accept_') || data.startsWith('bk_reject_')) {
        await handleBookingDecisionCallback(chatId, data, user, queryId, messageId);
        return;
    }

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
        case 'check_subscription': {
            const userId = (user && user.id) || chatId;
            const sub = await checkUserSubscription(userId);
            if (sub.subscribed) {
                if (queryId) {
                    await tgRequest('answerCallbackQuery', {
                        callback_query_id: queryId,
                        text: '✅ تم التحقق من اشتراكك بنجاح! مرحباً بك في توصيلة 🚖',
                        show_alert: false
                    }).catch(() => {});
                }
                await sendMessage(chatId, '✅ <b>تم التحقق بنجاح!</b> شكراً لانضمامك لمنصات «توصيلة» الرسمية 🚖.');
                if (state.pendingRegPhone) {
                    const phoneToLink = state.pendingRegPhone;
                    userStates.delete(chatId);
                    await linkUserByPhone(chatId, phoneToLink, user);
                } else {
                    await handleStart(chatId, user);
                }
            } else {
                if (queryId) {
                    await tgRequest('answerCallbackQuery', {
                        callback_query_id: queryId,
                        text: '⚠️ لم يتم التحقق من انضمامك بعد! يرجى الاشتراك في القناة والكروب أولاً.',
                        show_alert: true
                    }).catch(() => {});
                }
                await sendSubscriptionGateMessage(chatId);
            }
            break;
        }

        case 'prompt_phone': {
            if (queryId) {
                await tgRequest('answerCallbackQuery', {
                    callback_query_id: queryId
                }).catch(() => {});
            }
            await promptUserForPhone(chatId);
            break;
        }

        case 'reg_passenger':
            userStates.delete(chatId);
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: '🚶 <b>تسجيل حساب راكب جديد:</b>\n\nيمكنك إنشاء حسابك مباشرة من خلال تطبيق الويب بكل سهولة وأمان:',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'تسجيل حساب راكب جديد 📲', url: 'https://tawseelaiq.app/login' }]
                    ]
                }
            });
            break;

        case 'reg_driver':
            userStates.delete(chatId);
            await tgRequest('sendMessage', {
                chat_id: chatId,
                text: '🚕 <b>تنويه هام لكباتن توصيلة:</b>\n\nيُحظر التسجيل الذاتي للسائقين عبر التطبيق؛ يتم إنشاء وتفعيل حسابات السائقين <b>حصراً من قِبل إدارة المنظومة</b>.\n\nللانضمام لأسطول كباتن توصيلة، يرجى مراجعة إدارة المنظومة أو التواصل مع الدعم الفني.',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📞 التواصل مع الدعم الإداري', callback_data: 'contact_admin' }]
                    ]
                }
            });
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
    const digits = (text || '').replace(/[^0-9]/g, '');

    // إذا كان المستخدم في مرحلة إرسال الهاتف أو أرسل رقماً يحتوي على 7 أرقام على الأقل
    if (digits.length >= 7 || (state && (state.step === 'awaiting_phone' || state.step === 'login_phone' || state.step === 'passenger_phone' || state.step === 'driver_phone'))) {
        await linkUserByPhone(chatId, text, user);
        return;
    }

    if (!state) {
        if (!text) return;
        // General text query in private chat: Ask Groq AI
        const aiAnswer = await askGroqAI(text);
        await sendKeyboard(chatId, aiAnswer, [
            [{ text: '🚖 فتح تطبيق توصيلة (WebApp)', web_app: { url: 'https://tawseelaiq.app' } }],
            [{ text: '📋 القائمة الرئيسية للخدمات', callback_data: 'help' }]
        ]);
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

        default: {
            const aiAnswer = await askGroqAI(text);
            await sendKeyboard(chatId, aiAnswer, [
                [{ text: '🚖 فتح تطبيق توصيلة (WebApp)', web_app: { url: 'https://tawseelaiq.app' } }],
                [{ text: '📋 القائمة الرئيسية للخدمات', callback_data: 'help' }]
            ]);
            break;
        }
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
            '🎉 <b>تم تفعيل حسابك كسائق!</b>\n\n🚗 يمكنك الآن الدخول للتطبيق وبدء العمل ومشاركة موقعك المباشر:',
            [
                [{ text: '🚗 الدخول للتطبيق وبدء العمل', url: 'https://tawseelaiq.app/?role=Driver' }]
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

                            if (cbData !== 'check_subscription' && !cbData.startsWith('bk_accept_') && !cbData.startsWith('bk_reject_')) {
                                await tgRequest('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
                            }
                            await handleCallback(chatId, cbData, cb.from, cb.id, cb.message?.message_id);
                        }
                    } else if (update.message) {
                        const msg = update.message;
                        const chatId = msg.chat?.id;
                        if (!chatId) continue;

                        // 1. Group / Supergroup moderation & AI support
                        if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
                            const handled = await handleGroupModeration(msg);
                            if (handled) continue;

                            const text = msg.text || msg.caption || '';
                            const isMentioned = text.includes(BOT_USERNAME) ||
                                (msg.entities && msg.entities.some(e => e.type === 'mention' && text.substring(e.offset, e.offset + e.length) === BOT_USERNAME));
                            const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from &&
                                (msg.reply_to_message.from.username === 'tawseela_najaf_bot' || msg.reply_to_message.from.is_bot);

                            if (isMentioned || isReplyToBot) {
                                const cleanPrompt = text.replace(new RegExp(BOT_USERNAME, 'gi'), '').trim();
                                if (cleanPrompt) {
                                    const reply = await askGroqAI(cleanPrompt);
                                    await sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });
                                }
                            }
                            continue;
                        }

                        // Block non-private chats from personal bot flow
                        if (msg.chat.type !== 'private') continue;

                        let rawText = '';
                        if (msg.contact && msg.contact.phone_number) {
                            rawText = String(msg.contact.phone_number).trim();
                        } else {
                            rawText = (msg.text || '').trim();
                        }
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

                        // Check if command is deep link registration
                        const isRegDeepLink = text.startsWith('/start reg_') || text.startsWith('/start%20reg_') || /^\/start\s+(?:reg_)?([0-9+]+)/i.test(text);

                        // Mandatory Subscription Gate for private chat (Admin is exempted)
                        if (String(chatId) !== ADMIN_CHAT_ID) {
                            const sub = await checkUserSubscription(msg.from?.id || chatId);
                            if (!sub.subscribed) {
                                if (isRegDeepLink) {
                                    const rawPhone = text.replace(/^\/start(?:%20|\s+)(?:reg_)?/i, '').trim();
                                    userStates.set(chatId, { pendingRegPhone: rawPhone });
                                } else if (msg.contact && msg.contact.phone_number) {
                                    userStates.set(chatId, { pendingRegPhone: msg.contact.phone_number });
                                }
                                await sendSubscriptionGateMessage(chatId);
                                continue;
                            }
                        }

                        // Commands & Direct Inputs
                        if (msg.contact && msg.contact.phone_number) {
                            await linkUserByPhone(chatId, msg.contact.phone_number, msg.from);
                        }
                        else if (isRegDeepLink) {
                            const rawPhone = text.replace(/^\/start(?:%20|\s+)(?:reg_)?/i, '').trim();
                            await linkUserByPhone(chatId, rawPhone, msg.from);
                        }
                        else if (text === '/start' || text.startsWith('/start ')) {
                            await handleStart(chatId, msg.from);
                        }
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
        if (!global._tgPollErrorCount) global._tgPollErrorCount = 0;
        global._tgPollErrorCount++;
        if (global._tgPollErrorCount <= 2 || global._tgPollErrorCount % 20 === 0) {
            console.error('[TelegramBot] Poll error:', e.message);
        }
        const delay = global._tgPollErrorCount > 3 ? 30000 : 3000;
        if (pollingActive) setTimeout(poll, delay);
        return;
    }
    global._tgPollErrorCount = 0;
    if (pollingActive) setTimeout(poll, 1000);
}

function startBot() {
    if (process.env.TELEGRAM_BOT_ENABLED === 'false' || !BOT_TOKEN || pollingActive) return;
    pollingActive = true;
    console.log('[TelegramBot] Started polling...');
    // Delete webhook first (and drop any pending updates to clear stale loops)
    tgRequest('deleteWebhook', { drop_pending_updates: true }).then(() => {
        poll();
    }).catch(() => { poll(); });
}

function stopBot() {
    pollingActive = false;
    console.log('[TelegramBot] Stopped.');
}

// Admin message from dashboard
async function sendAdminNotification(text) {
    try {
        const res = await sendMessage(ADMIN_CHAT_ID, text);
        return res;
    } catch (err) {
        console.error('[TelegramBot] sendAdminNotification error:', err.message);
        return { ok: false, error: err.message };
    }
}

// Send message to a specific user by chatId
async function notifyUser(chatId, text) {
    try {
        const res = await sendMessage(chatId, text);
        return res;
    } catch (err) {
        console.error('[TelegramBot] notifyUser error:', err.message);
        return { ok: false, error: err.message };
    }
}

// Broadcast message with target selector (channel, group, subscribers, all)
async function broadcastNotification(text, target = 'subscribers') {
    let sentCount = 0;
    let failedCount = 0;
    const cleanText = (text || '').replace(/<[^>]*>?/gm, '').trim();
    if (!cleanText) return { success: false, error: 'نص الإشعار فارغ' };
    const formattedMsg = `📢 إشعار رسمي من إدارة توصيلة 🚖:\n\n${cleanText}`;

    // 1. Send to Official Channel
    if (target === 'channel' || target === 'all') {
        try {
            const res = await sendMessage(REQUIRED_CHANNEL, formattedMsg, { parse_mode: '' });
            if (res && res.ok) sentCount++;
            else failedCount++;
        } catch (_) {
            failedCount++;
        }
    }

    // 2. Send to Discussion Group
    if (target === 'group' || target === 'all') {
        try {
            const res = await sendMessage(REQUIRED_GROUP, formattedMsg, { parse_mode: '' });
            if (res && res.ok) sentCount++;
            else failedCount++;
        } catch (_) {
            failedCount++;
        }
    }

    // 3. Send to Subscribers / Registered Users
    if (target === 'subscribers' || target === 'all') {
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

        for (const chatId of recipients) {
            try {
                const res = await sendMessage(chatId, formattedMsg, { parse_mode: '' });
                if (res && res.ok) sentCount++;
                else failedCount++;
            } catch (e) {
                failedCount++;
            }
        }
    }

    return { success: true, sentCount, failedCount, target };
}

// ===================================================================
// --- TRIP LIFECYCLE NOTIFICATIONS & DEDUPLICATION (MULTI-WORKER) ---
// ===================================================================

// Helper: Resolve Customer Telegram Chat ID from ride object or DB
async function findCustomerTelegramChatId(ride) {
    if (!ride) return null;
    if (ride.telegramChatId) return String(ride.telegramChatId);
    if (ride.customerTelegramChatId) return String(ride.customerTelegramChatId);
    if (ride.customerChatId) return String(ride.customerChatId);

    const custPhone = String(ride.customerPhone || ride.phone || '').trim();
    const cleanDigits = custPhone.replace(/[^0-9]/g, '');
    const cleanPhone = cleanDigits.replace(/^0+/, '');
    const customerId = ride.customerId;

    // 1. Search in-memory state customers
    const customers = db.memoryState?.customers || [];
    let cust = customers.find(c => {
        if (customerId && (c.customerId === customerId || c.id === customerId)) return true;
        if (cleanPhone) {
            const p = String(c.phoneNumber || c.phone || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
            if (p && (p === cleanPhone || p.endsWith(cleanPhone) || cleanPhone.endsWith(p))) return true;
        }
        return false;
    });

    if (cust && cust.telegramChatId) {
        return String(cust.telegramChatId);
    }

    // 2. Search PostgreSQL database if connected
    if (db.isPostgresConnected && db.pool) {
        try {
            if (customerId) {
                const res = await db.pool.query('SELECT telegram_chat_id FROM customers WHERE customer_id = $1 LIMIT 1', [customerId]);
                if (res.rows.length > 0 && res.rows[0].telegram_chat_id) {
                    return String(res.rows[0].telegram_chat_id);
                }
            }
            if (cleanPhone) {
                const res = await db.pool.query('SELECT telegram_chat_id FROM customers WHERE phone_number LIKE $1 LIMIT 1', [`%${cleanPhone.slice(-10)}%`]);
                if (res.rows.length > 0 && res.rows[0].telegram_chat_id) {
                    return String(res.rows[0].telegram_chat_id);
                }
            }
        } catch (err) {
            console.warn('[TelegramBot] findCustomerTelegramChatId DB query error:', err.message);
        }
    }

    return null;
}

// Helper: Resolve Driver Telegram Chat ID from driver ID, phone, or DB
async function findDriverTelegramChatId(driverId, phone) {
    if (!driverId && !phone) return null;
    const cleanDigits = String(phone || '').replace(/[^0-9]/g, '');
    const cleanPhone = cleanDigits.replace(/^0+/, '');

    // 1. Search in-memory state drivers
    const drivers = db.memoryState?.drivers || [];
    const drv = drivers.find(d => {
        if (driverId && (d.driverId === driverId || d.id === driverId)) return true;
        if (cleanPhone && d.phoneNumber) {
            const p = String(d.phoneNumber).replace(/[^0-9]/g, '').replace(/^0+/, '');
            if (p && (p === cleanPhone || p.endsWith(cleanPhone) || cleanPhone.endsWith(p))) return true;
        }
        return false;
    });

    if (drv && (drv.telegramChatId || drv.telegram_chat_id)) {
        return String(drv.telegramChatId || drv.telegram_chat_id);
    }

    // 2. Search PostgreSQL database
    if (db.isPostgresConnected && db.pool) {
        try {
            if (driverId) {
                const res = await db.pool.query('SELECT telegram_chat_id FROM drivers WHERE driver_id = $1 LIMIT 1', [driverId]);
                if (res.rows.length > 0 && res.rows[0].telegram_chat_id) {
                    return String(res.rows[0].telegram_chat_id);
                }
            }
            if (cleanPhone) {
                const res = await db.pool.query('SELECT telegram_chat_id FROM drivers WHERE phone_number LIKE $1 LIMIT 1', [`%${cleanPhone.slice(-10)}%`]);
                if (res.rows.length > 0 && res.rows[0].telegram_chat_id) {
                    return String(res.rows[0].telegram_chat_id);
                }
            }
        } catch (err) {
            console.warn('[TelegramBot] findDriverTelegramChatId DB error:', err.message);
        }
    }

    return null;
}

// Stage 0: Captain Ride Offer (Incoming Request Dispatch)
async function notifyCaptainRideOffer(driverId, ride, timeoutSeconds = 20) {
    if (!ride || !driverId) return { success: false, error: 'missing_params' };
    try {
        const chatId = await findDriverTelegramChatId(driverId, ride.driverPhone || ride.assignedDriverPhone);
        if (!chatId) return { success: false, reason: 'no_chat_id' };

        const lockKey = `${ride.id}:OFFER:${chatId}`;
        const lockAcquired = await redisManager.acquireTelegramNotificationLock(lockKey, timeoutSeconds + 15);
        if (!lockAcquired) {
            console.log(`[TelegramBot] Duplicate offer notification skipped for ride ${ride.id} to driver ${driverId}`);
            return { success: false, reason: 'deduplicated' };
        }

        const rawFare = ride.fare || ride.estimatedFare || 3000;
        const balyFare = Math.max(3000, Math.ceil(Number(rawFare) / 250) * 250).toLocaleString('en-US');
        const etaMins = Math.max(1, Math.round(Number(ride.etaToPassengerMinutes || ride.etaMinutes || 3)));
        const etaDistKm = (Number(ride.etaToPassengerDistanceKm || ride.driverDistanceKm || 1.2)).toFixed(1);
        const tripDistKm = (Number(ride.distanceKm || ride.estimatedDistanceKm || 5.0)).toFixed(1);
        const tripDurMins = Math.max(1, Math.round(Number(ride.durationMinutes || ride.estimatedDurationMinutes || 12)));

        const pickupNeighborhood = ride.pickupNeighborhood || ride.pickupArea || (ride.pickupName ? ride.pickupName.split('،')[0].split(',')[0].trim() : 'موقع الراكب');
        const dropoffNeighborhood = ride.dropoffNeighborhood || ride.dropoffArea || (ride.dropoffName ? ride.dropoffName.split('،')[0].split(',')[0].trim() : 'الوجهة المحددة');

        let extraInfo = '';
        if (ride.isRoundTrip || ride.tripType === 'ROUND_TRIP') {
            extraInfo = '\n🔄 <b>نوع المشوار:</b> ذهاب وإياب';
        }

        const msg = `🔔 <b>طلب مشوار تكسي جديد!</b>\n\n` +
            `💰 <b>الأجرة:</b> ${balyFare} د.ع\n` +
            `📍 <b>منطقة الانطلاق:</b> ${pickupNeighborhood}\n` +
            `🏁 <b>الوجهة:</b> ${dropoffNeighborhood}${extraInfo}\n` +
            `⏱️ <b>الوصول المقدّر للراكب:</b> ~${etaMins} دقيقة (${etaDistKm} كم)\n` +
            `🛣️ <b>مسافة المشوار:</b> ${tripDistKm} كم (~${tripDurMins} دقيقة)\n\n` +
            `⏳ <b>مهلة الرد:</b> ${timeoutSeconds} ثانية`;

        const deepLink = `https://tawseelaiq.app/drive?ride=${encodeURIComponent(ride.id)}`;
        const buttons = [
            [{ text: '🚖 فتح الطلب في التطبيق', url: deepLink }]
        ];

        const res = await sendKeyboard(chatId, msg, buttons);
        if (res && res.ok && res.result?.message_id) {
            await redisManager.saveRideOfferMessage(ride.id, driverId, chatId, res.result.message_id);
            console.log(`[TelegramBot] Captain ride offer sent for ride ${ride.id} to driver ${driverId} (msg_id: ${res.result.message_id})`);
            return { success: true, messageId: res.result.message_id };
        }
        return { success: Boolean(res?.ok) };
    } catch (err) {
        console.error('[TelegramBot] notifyCaptainRideOffer error:', err.message);
        return { success: false, error: err.message };
    }
}

// Stage 1: Trip Accepted by Captain
async function notifyTripAccepted(ride) {
    if (!ride) return { success: false, reason: 'no_ride' };
    const results = { customer: false, driver: false, candidatesEdited: 0 };

    // 1. Notify Customer (with distributed lock)
    try {
        const custChatId = await findCustomerTelegramChatId(ride);
        if (custChatId) {
            const lockAcquired = await redisManager.acquireTelegramNotificationLock(`${ride.id}:ACCEPTED:${custChatId}`, 86400);
            if (lockAcquired) {
                const driverName = ride.assignedDriverName || 'كابتن توصيلة';
                const driverCar = ride.assignedDriverVehicle || 'سيارة معتمدة';
                const driverPlate = ride.assignedDriverPlate || 'خصوصي النجف';
                const rawFare = ride.fare || ride.estimatedFare || 3000;
                const balyFare = Math.max(3000, Math.ceil(Number(rawFare) / 250) * 250).toLocaleString('en-US');
                const etaMins = Math.max(1, Math.round(Number(ride.etaToPassengerMinutes || ride.etaMinutes || 4)));

                const msg = `✅ <b>تم قبول طلبك! كابتنك في الطريق إليك.</b>\n\n` +
                    `🧑‍✈️ <b>الكابتن:</b> ${driverName}\n` +
                    `🚗 <b>السيارة:</b> ${driverCar} — اللوحة ${driverPlate}\n` +
                    `⏱️ <b>الوصول المتوقع:</b> خلال ~${etaMins} دقائق\n` +
                    `💰 <b>الأجرة التقديرية:</b> ${balyFare} د.ع`;

                const trackLink = `https://tawseelaiq.app/?ride=${encodeURIComponent(ride.id)}`;
                const buttons = [
                    [{ text: '📍 تتبّع السيارة على الخريطة', url: trackLink }]
                ];
                await sendKeyboard(custChatId, msg, buttons);
                results.customer = true;
            }
        }
    } catch (err) {
        console.error('[TelegramBot] notifyTripAccepted Customer error:', err.message);
    }

    // 2. Notify Accepted Driver (with distributed lock)
    try {
        const drvId = ride.assignedDriverId || ride.acceptedDriverId;
        const drvChatId = await findDriverTelegramChatId(drvId, ride.assignedDriverPhone);
        if (drvChatId) {
            const lockAcquired = await redisManager.acquireTelegramNotificationLock(`${ride.id}:ACCEPTED:${drvChatId}`, 86400);
            if (lockAcquired) {
                const msg = `✅ <b>تم تأكيد قبول المشوار!</b>\n\n` +
                    `توجه الآن إلى نقطة الانطلاق لملاقاة الراكب 📍\n` +
                    `يمكنك التواصل مع الراكب عبر الاتصال أو الواتساب أو الدردشة من داخل التطبيق.`;

                const driveLink = `https://tawseelaiq.app/drive?ride=${encodeURIComponent(ride.id)}`;
                const buttons = [
                    [{ text: '🧭 فتح شاشة الرحلة والملاحة', url: driveLink }]
                ];
                await sendKeyboard(drvChatId, msg, buttons);
                results.driver = true;
            }
        }
    } catch (err) {
        console.error('[TelegramBot] notifyTripAccepted Driver error:', err.message);
    }

    // 3. Edit messages for other candidate drivers (remove active button and mark as taken)
    try {
        const offers = await redisManager.getRideOfferMessages(ride.id);
        const acceptedDrvId = String(ride.assignedDriverId || ride.acceptedDriverId || '');
        for (const offer of offers) {
            if (String(offer.driverId) !== acceptedDrvId && offer.chatId && offer.messageId) {
                await editMessageText(
                    offer.chatId,
                    offer.messageId,
                    `عذراً، تم قبول المشوار #${ride.id} من كابتن آخر 🚖\nنتمنى لك التوفيق في المشاوير القادمة!`
                ).catch(() => {});
                results.candidatesEdited++;
            }
        }
    } catch (err) {
        console.warn('[TelegramBot] Edit candidate offers error:', err.message);
    }

    return { success: true, ...results };
}

// Stage 2: Captain Arrived at Pickup Location
async function notifyDriverArrived(ride) {
    try {
        const chatId = await findCustomerTelegramChatId(ride);
        if (!chatId) return { success: false, reason: 'no_chat_id' };

        const lockAcquired = await redisManager.acquireTelegramNotificationLock(`${ride.id}:ARRIVED:${chatId}`, 86400);
        if (!lockAcquired) return { success: false, reason: 'deduplicated' };

        const driverName = ride.assignedDriverName || 'الكابتن';
        const driverCar = ride.assignedDriverVehicle || 'المركبة';

        const msg = `🚕 <b>وصل الكابتن وهو بانتظارك عند نقطة الانطلاق!</b>\n\n` +
            `الكابتن: <b>${driverName}</b> (${driverCar})\n` +
            `يرجى التوجه إلى السيارة لبدء الرحلة ✨`;

        await sendMessage(chatId, msg);
        return { success: true };
    } catch (err) {
        console.error('[TelegramBot] notifyDriverArrived error:', err.message);
        return { success: false, error: err.message };
    }
}

// Stage 3: Trip Started (In Progress to Destination)
async function notifyTripStarted(ride) {
    try {
        const chatId = await findCustomerTelegramChatId(ride);
        if (!chatId) return { success: false, reason: 'no_chat_id' };

        const lockAcquired = await redisManager.acquireTelegramNotificationLock(`${ride.id}:IN_TRIP:${chatId}`, 86400);
        if (!lockAcquired) return { success: false, reason: 'deduplicated' };

        const driverName = ride.assignedDriverName || 'الكابتن';
        const destination = ride.dropoffNeighborhood || ride.dropoffName || 'الوجهة المحددة';

        const msg = `🚗 <b>بدأت رحلتك الآن إلى وجهتك!</b>\n\n` +
            `الكابتن <b>${driverName}</b> في الطريق إلى: <b>${destination}</b>.\n` +
            `نتمنى لك رحلة آمنة ومريحة مع توصيلة! ✨`;

        await sendMessage(chatId, msg);
        return { success: true };
    } catch (err) {
        console.error('[TelegramBot] notifyTripStarted error:', err.message);
        return { success: false, error: err.message };
    }
}

// Stage 4: Trip Completed & Fare Collected (ONLY when Captain clicks "استلمت الأجرة")
async function notifyTripCompleted(ride, fareInput) {
    try {
        const rawFare = fareInput !== undefined && fareInput !== null
            ? fareInput
            : (ride.finalFare || ride.fare || ride.estimatedFare || 3000);
        const finalFareNum = Math.max(3000, Math.ceil(Number(rawFare || 3000) / 250) * 250);
        const formattedFare = finalFareNum.toLocaleString('en-US');

        const isRound = Boolean(ride.isRoundTrip || ride.tripType === 'ROUND_TRIP');
        let breakdownMsg = '';
        if (isRound) {
            const leg1 = Number(ride.leg1Fare || (ride.fare ? Math.round(Number(ride.fare) / 2) : 0));
            const waitFee = Number(ride.waitFee || 0);
            const leg2 = Math.max(0, finalFareNum - leg1 - waitFee);
            breakdownMsg = `\n🔄 <b>نوع الرحلة:</b> ذهاب وإياب\n` +
                           `📊 <b>تفاصيل الكروة:</b> ذهاب (${leg1.toLocaleString('en-US')} د.ع) + انتظار (${waitFee.toLocaleString('en-US')} د.ع) + عودة (${leg2.toLocaleString('en-US')} د.ع)`;
        }

        // 1. Rider message
        const custChatId = await findCustomerTelegramChatId(ride);
        if (custChatId) {
            const lockAcquired = await redisManager.acquireTelegramNotificationLock(`${ride.id}:COMPLETED:${custChatId}`, 86400);
            if (lockAcquired) {
                const msg = `🏁 <b>تم الوصول إلى وجهتك 🎉 الحمد لله على سلامتك!</b>\n\n` +
                    `💰 <b>المبلغ المستلم:</b> ${formattedFare} دينار عراقي${breakdownMsg}\n\n` +
                    `نتمنى لك يوماً سعيداً، ويسعدنا تقييمك للكابتن عبر التطبيق ⭐`;
                await sendMessage(custChatId, msg);
            }
        }

        // 2. Admin message
        const adminLock = await redisManager.acquireTelegramNotificationLock(`${ride.id}:COMPLETED:ADMIN`, 86400);
        if (adminLock) {
            const adminMsg = `🏁 <b>اكتمل المشوار (#${ride.id}) بنجاح ✅</b>\n\n` +
                `👤 <b>الراكب:</b> ${ride.customerName || 'عميل'}\n` +
                `🧑‍✈️ <b>الكابتن:</b> ${ride.assignedDriverName || 'كابتن'}\n` +
                `💰 <b>الأجرة النهائية:</b> ${formattedFare} د.ع${breakdownMsg}`;
            await sendMessage(ADMIN_CHAT_ID, adminMsg).catch(() => {});
        }

        return { success: true, fare: finalFareNum };
    } catch (err) {
        console.error('[TelegramBot] notifyTripCompleted error:', err.message);
        return { success: false, error: err.message };
    }
}

// Stage 5: Ride Cancelled (By Rider or Captain)
async function notifyRideCancelled(ride, reason = 'إلغاء من قبل المستخدم', cancelledBy = 'rider', cancelFee = 0) {
    if (!ride) return { success: false, reason: 'no_ride' };
    const isRiderCancel = String(cancelledBy).toLowerCase() === 'rider' || String(cancelledBy).toLowerCase() === 'customer';

    try {
        if (isRiderCancel) {
            // Cancelled by Passenger -> Notify assigned captain if exists
            const drvId = ride.assignedDriverId || ride.acceptedDriverId;
            if (drvId) {
                const drvChatId = await findDriverTelegramChatId(drvId, ride.assignedDriverPhone);
                if (drvChatId) {
                    const lockAcquired = await redisManager.acquireTelegramNotificationLock(`${ride.id}:CANCELLED:${drvChatId}`, 86400);
                    if (lockAcquired) {
                        const msg = `⚠️ <b>تم إلغاء الرحلة من الراكب.</b>\n\n` +
                            `السبب: <b>${reason}</b>\n\n` +
                            `أصبحت متاحاً الآن لاستقبال طلبات جديدة 🚖`;
                        await sendMessage(drvChatId, msg);
                    }
                }
            }

            // Edit candidate offer messages
            const offers = await redisManager.getRideOfferMessages(ride.id);
            for (const offer of offers) {
                if (offer.chatId && offer.messageId) {
                    await editMessageText(
                        offer.chatId,
                        offer.messageId,
                        `⚠️ أُلغي طلب المشوار #${ride.id} من قبل الراكب.`
                    ).catch(() => {});
                }
            }
        } else {
            // Cancelled by Driver -> Notify passenger
            const custChatId = await findCustomerTelegramChatId(ride);
            if (custChatId) {
                const lockAcquired = await redisManager.acquireTelegramNotificationLock(`${ride.id}:CANCELLED:${custChatId}`, 86400);
                if (lockAcquired) {
                    const msg = `⚠️ <b>اعتذر الكابتن عن الرحلة.</b>\n\n` +
                        `السبب: <b>${reason}</b>\n\n` +
                        `نبحث لك عن كابتن بديل مناسب حالياً ⏳`;
                    await sendMessage(custChatId, msg);
                }
            }
        }

        // Notify Admin of Cancellation
        const adminLock = await redisManager.acquireTelegramNotificationLock(`${ride.id}:CANCELLED:ADMIN`, 86400);
        if (adminLock) {
            const feeStr = cancelFee > 0 ? `\n💰 <b>رسوم الإلغاء:</b> ${Number(cancelFee).toLocaleString('en-US')} د.ع` : '';
            const adminMsg = `⚠️ <b>إلغاء مشوار (#${ride.id})</b>\n\n` +
                `👤 <b>الجهة الملغية:</b> ${isRiderCancel ? 'الراكب' : 'الكابتن'}\n` +
                `📝 <b>السبب:</b> ${reason}${feeStr}`;
            await sendMessage(ADMIN_CHAT_ID, adminMsg).catch(() => {});
        }

        await redisManager.clearRideOfferMessages(ride.id);
        return { success: true };
    } catch (err) {
        console.error('[TelegramBot] notifyRideCancelled error:', err.message);
        return { success: false, error: err.message };
    }
}

// --- COMMUTE BOOKING NOTIFICATIONS (BATCH 4) ---
// ===============================================

// 1. Notify Captain of New Commute Booking Request (Phone masked / hidden until accepted)
async function notifyBookingRequestToCaptain(booking, route = null) {
    if (!booking) return { ok: false, error: 'no_booking' };
    const bId = booking.id || booking.bookingId;

    try {
        const captainChatId = await findDriverTelegramChatId(booking.driverId, booking.driverPhone);
        if (!captainChatId) {
            const maskedDrvId = String(booking.driverId || '').slice(0, 4) + '****';
            console.log(`[TelegramBot] Captain (${maskedDrvId}) not linked to Telegram (chatId null)`);
        } else {
            const lockKey = `booking:${bId}:request:${captainChatId}`;
            const lockAcquired = await redisManager.acquireTelegramNotificationLock(lockKey, 86400);
            if (lockAcquired) {
                const depTime = (route && route.departureTime) || booking.departureTime || 'موعد الدوام الرسمي';
                const seats = booking.seatsBooked || 1;
                const msg = `🚖 <b>طلب حجز جديد في الخط الدائم</b>\n\n` +
                    `👤 <b>اسم الراكب:</b> ${booking.customerName || 'راكب'}\n` +
                    `📍 <b>العنوان / الانطلاق:</b> ${booking.pickupLocation || ''}\n` +
                    `🎯 <b>الوجهة:</b> ${booking.dropoffLocation || ''}\n` +
                    `🛣 <b>المسار:</b> ${booking.pickupLocation || ''} ➔ ${booking.dropoffLocation || ''}\n` +
                    `⏰ <b>الموعد:</b> ${depTime}\n` +
                    `💺 <b>عدد المقاعد المطلوبة:</b> ${seats}\n\n` +
                    `<i>يرجى قبول أو رفض الطلب:</i>`;
                const buttons = [
                    [
                        { text: 'قبول ✅', callback_data: `bk_accept_${bId}` },
                        { text: 'رفض ❌', callback_data: `bk_reject_${bId}` }
                    ]
                ];
                await sendKeyboard(captainChatId, msg, buttons).catch(err => {
                    console.warn('[TelegramBot] sendKeyboard to captain error:', err.message);
                });
            }
        }

        // Admin notification copy (without buttons)
        if (ADMIN_CHAT_ID) {
            const adminLockKey = `booking:${bId}:request:admin`;
            const adminAcquired = await redisManager.acquireTelegramNotificationLock(adminLockKey, 86400);
            if (adminAcquired) {
                const adminMsg = `📢 <b>إشعار حجز جديد (نسخة إدارة)</b>\n\n` +
                    `👤 <b>الراكب:</b> ${booking.customerName || 'راكب'}\n` +
                    `🚖 <b>الكابتن المعين:</b> ${booking.driverName || 'كابتن'}\n` +
                    `🛣 <b>المسار:</b> ${booking.pickupLocation || ''} ➔ ${booking.dropoffLocation || ''}\n` +
                    `💺 <b>المقاعد:</b> ${booking.seatsBooked || 1}\n` +
                    `الحالة: قيد الانتظار (Pending)`;
                await sendMessage(ADMIN_CHAT_ID, adminMsg).catch(() => {});
            }
        }

        return { ok: true };
    } catch (err) {
        console.error('[TelegramBot] notifyBookingRequestToCaptain error:', err.message);
        return { ok: false, error: err.message };
    }
}

// 2. Notify Rider when Booking Accepted by Captain (reveals captain info + WhatsApp link)
async function notifyBookingAcceptedToRider(booking) {
    if (!booking) return { ok: false, error: 'no_booking' };
    const bId = booking.id || booking.bookingId;

    try {
        const custChatId = await findCustomerTelegramChatId(booking);
        if (!custChatId) {
            const maskedCustId = String(booking.customerId || '').slice(0, 4) + '****';
            console.log(`[TelegramBot] Passenger (${maskedCustId}) not linked to Telegram (chatId null)`);
            return { ok: false, error: 'passenger_not_linked' };
        }

        const lockKey = `booking:${bId}:accepted:${custChatId}`;
        const lockAcquired = await redisManager.acquireTelegramNotificationLock(lockKey, 86400);
        if (!lockAcquired) {
            return { ok: true, deduplicated: true };
        }

        // Find captain vehicle info and contact
        let drv = (db.memoryState.drivers || []).find(d => d.driverId === booking.driverId || d.phoneNumber === booking.driverPhone);
        if (!drv && db.isPostgresConnected && db.pool) {
            try {
                const dRes = await db.pool.query('SELECT * FROM drivers WHERE driver_id = $1 LIMIT 1', [booking.driverId]);
                if (dRes.rows && dRes.rows.length > 0) {
                    drv = dRes.rows[0];
                }
            } catch (_) {}
        }

        const vMake = drv?.vehicle_make || drv?.vehicleMake || 'تويوتا';
        const vModel = drv?.vehicle_model || drv?.vehicleModel || 'كورولا';
        const vColor = drv?.vehicle_color || drv?.vehicleColor || 'أبيض';
        const carInfo = `${vMake} ${vModel}${vColor ? ` (${vColor})` : ''}`.trim();
        const drvName = booking.driverName || drv?.full_name || drv?.fullName || 'الكابتن';
        const drvPhone = booking.driverPhone || drv?.phone_number || drv?.phoneNumber || '';

        const rawPhone = String(drvPhone).replace(/[^0-9]/g, '');
        const waNum = rawPhone.startsWith('0') ? '964' + rawPhone.slice(1) : (rawPhone.startsWith('964') ? rawPhone : '964' + rawPhone);
        const waUrl = `https://wa.me/${waNum}`;

        const msg = `✅ <b>تم قبول حجزك في الخط الدائم!</b>\n\n` +
            `🚖 <b>الكابتن:</b> ${drvName}\n` +
            `🚗 <b>السيارة:</b> ${carInfo}\n` +
            `📍 <b>المسار:</b> ${booking.pickupLocation || ''} ➔ ${booking.dropoffLocation || ''}\n` +
            `📞 <b>رقم اتصال الكابتن:</b> <code>${drvPhone}</code>\n\n` +
            `<i>يمكنك التواصل مع الكابتن مباشرة عبر الاتصال أو الواتساب أدناه لتنسيق موعد الانطلاق:</i>`;

        const buttons = [
            [{ text: '💬 تواصل عبر واتساب', url: waUrl }]
        ];

        const sendRes = await sendKeyboard(custChatId, msg, buttons).catch(err => {
            console.warn('[TelegramBot] sendKeyboard to rider error:', err.message);
            return { ok: false, error: err.message };
        });

        return sendRes || { ok: true };
    } catch (err) {
        console.error('[TelegramBot] notifyBookingAcceptedToRider error:', err.message);
        return { ok: false, error: err.message };
    }
}

// 3. Notify Rider when Booking Declined / Rejected by Captain
async function notifyBookingDeclinedToRider(booking, reason = null) {
    if (!booking) return { ok: false, error: 'no_booking' };
    const bId = booking.id || booking.bookingId;

    try {
        const custChatId = await findCustomerTelegramChatId(booking);
        if (!custChatId) {
            const maskedCustId = String(booking.customerId || '').slice(0, 4) + '****';
            console.log(`[TelegramBot] Passenger (${maskedCustId}) not linked to Telegram (chatId null)`);
            return { ok: false, error: 'passenger_not_linked' };
        }

        const lockKey = `booking:${bId}:declined:${custChatId}`;
        const lockAcquired = await redisManager.acquireTelegramNotificationLock(lockKey, 86400);
        if (!lockAcquired) {
            return { ok: true, deduplicated: true };
        }

        const drvName = booking.driverName || 'الكابتن';
        const displayReason = reason || 'المقاعد مكتملة';

        const msg = `❌ <b>تحديث بشأن طلب الحجز</b>\n\n` +
            `نعتذر، لم يقبل الكابتن (${drvName}) طلبك في الخط الدائم.\n` +
            `📝 <b>السبب:</b> ${displayReason}\n\n` +
            `يمكنك اختيار كابتن وخط بديل في أي وقت عبر التطبيق 🚖.`;

        const sendRes = await sendMessage(custChatId, msg).catch(err => {
            console.warn('[TelegramBot] sendMessage to rider error:', err.message);
            return { ok: false, error: err.message };
        });

        return sendRes || { ok: true };
    } catch (err) {
        console.error('[TelegramBot] notifyBookingDeclinedToRider error:', err.message);
        return { ok: false, error: err.message };
    }
}

module.exports = {
    startBot,
    stopBot,
    sendAdminNotification,
    broadcastNotification,
    notifyUser,
    sendMessage,
    editMessageText,
    askGroqAI,
    checkUserSubscription,
    getBannedUsers,
    unbanUser,
    findCustomerTelegramChatId,
    findDriverTelegramChatId,
    notifyCaptainRideOffer,
    notifyTripAccepted,
    notifyDriverArrived,
    notifyTripStarted,
    notifyTripCompleted,
    notifyRideCancelled,
    notifyBookingRequestToCaptain,
    notifyBookingAcceptedToRider,
    notifyBookingDeclinedToRider,
    handleBookingDecisionCallback
};

