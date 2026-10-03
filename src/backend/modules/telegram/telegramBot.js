'use strict';
const https = require('https');
const config = require('../../config');
const db = require('../../db');

const BOT_TOKEN = '8317462517:AAH1T0_nE1ErDKrolstrvpTyDV46hVq62R4';
const ADMIN_CHAT_ID = '391762837';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// OTP store for telegram
const telegramOtpStore = new Map();
// User state machine
const userStates = new Map();

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
            `مرحباً بك <b>${customer.fullName}</b> في بوت توصيله 🚕\n\nيرجى تحديد نوع المشوار المطلوب:`,
            [
                [
                    { text: '⚡ مشوار قصير', callback_data: 'passenger_trip_short' },
                    { text: '🔄 خط دائم', callback_data: 'passenger_trip_daily' }
                ],
                [{ text: '🚗 فتح التطبيق مباشرة', url: 'https://tawseelaiq.app/?login_token=' + encodeURIComponent(token) + '&userId=' + encodeURIComponent(customer.customerId) + '&role=Customer&fullName=' + encodeURIComponent(customer.fullName) }],
                [{ text: '📞 تواصل مع الإدارة', callback_data: 'contact_admin' }],
                [{ text: '❓ مساعدة', callback_data: 'help' }]
            ]
        );
        return;
    }

    if (driver) {
        const token = 'jwt_driver_' + driver.driverId;
        await sendKeyboard(chatId,
            `مرحباً بك الكابتن <b>${driver.fullName}</b> في بوت توصيله 🚕\n\nيرجى تحديد نوع المشاوير التي ترغب بتقديمها:`,
            [
                [{ text: '⚡ مشاوير قصيرة', callback_data: 'driver_set_short' }],
                [{ text: '🔄 خطوط دائمة', callback_data: 'driver_set_daily' }],
                [{ text: '🚖 كلاهما (مشاوير قصيرة وخطوط دائمة)', callback_data: 'driver_set_both' }],
                [{ text: '🚗 فتح تطبيق السائق', url: 'https://tawseelaiq.app/?login_token=' + encodeURIComponent(token) + '&userId=' + encodeURIComponent(driver.driverId) + '&role=Driver&fullName=' + encodeURIComponent(driver.fullName) }],
                [{ text: '📞 تواصل مع الإدارة', callback_data: 'contact_admin' }]
            ]
        );
        return;
    }

    const keyboard = [
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

async function handleCallback(chatId, data, user) {
    if (!db.memoryState.botSubscribers) db.memoryState.botSubscribers = [];
    if (!db.memoryState.botSubscribers.includes(String(chatId))) { db.memoryState.botSubscribers.push(String(chatId)); db.saveStateSnapshot(); }

    const state = userStates.get(chatId) || {};

    switch (data) {
        case 'reg_passenger':
            userStates.set(chatId, { step: 'passenger_phone', role: 'Customer' });
            await sendMessage(chatId, '📱 أرسل رقم هاتفك العراقي (مثال: 07701234567):');
            break;
        case 'reg_driver':
            userStates.set(chatId, { step: 'driver_phone', role: 'Driver' });
            await sendMessage(chatId, '📱 أرسل رقم هاتفك العراقي (مثال: 07701234567):');
            break;
        case 'login':
            userStates.set(chatId, { step: 'login_phone' });
            await sendMessage(chatId, '📱 أرسل رقم هاتفك المسجل:');
            break;
        case 'nearby_drivers':
        case 'passenger_trip_short': {
            let passenger = (db.memoryState.customers || []).find(c => String(c.telegramChatId) === String(chatId));
            if (!passenger && state && state.verifiedPhone) {
                const clean = state.verifiedPhone.replace('+964', '0');
                passenger = (db.memoryState.customers || []).find(c => c.phoneNumber === clean);
                if (passenger) { passenger.telegramChatId = String(chatId); db.saveStateSnapshot(); }
            }
            if (!passenger) {
                passenger = (db.memoryState.customers || [])[0] || {
                    customerId: 'usr-c-' + chatId,
                    fullName: (user && user.first_name) ? user.first_name : 'راكب توصيله',
                    phoneNumber: '07700000000'
                };
            }

            const pLat = passenger.permanentLat ? parseFloat(passenger.permanentLat) : (passenger.currentLat ? parseFloat(passenger.currentLat) : 31.9961);
            const pLon = passenger.permanentLon ? parseFloat(passenger.permanentLon) : (passenger.currentLon ? parseFloat(passenger.currentLon) : 44.3168);

            const shortDrivers = (db.memoryState.drivers || []).filter(d =>
                !d.isBlocked && d.status !== 'Pending' && d.status !== 'Rejected' &&
                (d.isVerified === true || d.status === 'Active' || d.status === 'Approved') &&
                (d.serviceType === 'ShortTrip' || d.serviceType === 'Both' || !d.serviceType)
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
                const dLat = d.currentLat ? parseFloat(d.currentLat) : (d.permanentLat ? parseFloat(d.permanentLat) : (pLat + (idx % 2 === 0 ? 0.003 * (idx + 1) : -0.003 * (idx + 1))));
                const dLon = d.currentLon ? parseFloat(d.currentLon) : (d.permanentLon ? parseFloat(d.permanentLon) : (pLon + (idx % 2 === 0 ? 0.002 * (idx + 1) : -0.002 * (idx + 1))));
                const dist = haversine(pLat, pLon, dLat, dLon);
                return { ...d, _dist: dist };
            }).sort((a, b) => a._dist - b._dist);

            const token = 'jwt_customer_' + passenger.customerId;
            const appUrl = `https://tawseelaiq.app/?login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(passenger.customerId)}&role=Customer&fullName=${encodeURIComponent(passenger.fullName)}&tripType=short`;

            if (driversWithDist.length === 0) {
                await sendKeyboard(chatId,
                    `⚡ <b>تم اختيار: مشوار قصير</b>\n\n🚕 لا يوجد سائقون مسجلون للمشاوير القصيرة بالقرب منك حالياً.\nيمكنك طلب المشوار عبر التطبيق وسيتم إشعار الكباتن القريبين فوراً:`,
                    [
                        [{ text: '🚗 حجز مشوار قصير عبر التطبيق', url: appUrl }],
                        [{ text: '🔄 التبديل إلى خط دائم', callback_data: 'passenger_trip_daily' }]
                    ]
                );
            } else {
                let msg = `⚡ <b>تم اختيار: مشوار قصير</b>\n📍 <b>السائقون المسجلون كمشوار قصير والقريبون منك:</b>\n\n`;
                driversWithDist.slice(0, 8).forEach((d, i) => {
                    const waNum = (d.phoneNumber || '').replace(/[^0-9]/g, '').replace(/^07/, '9647');
                    const distText = d._dist ? ` (${d._dist.toFixed(1)} كم)` : '';
                    const vMake = d.vehicleMake || (d.vehicle ? d.vehicle.make : 'تويوتا');
                    const vModel = d.vehicleModel || (d.vehicle ? (d.vehicle.model || '') : 'كورولا');
                    const carInfo = `${vMake} ${vModel}`.trim();
                    msg += `${i+1}. 🚕 <b>${d.fullName}</b>${distText}\n`;
                    msg += `   🚗 المركبة: ${carInfo}\n`;
                    msg += `   📞 الهاتف: <code>${d.phoneNumber || '07800000000'}</code>\n`;
                    msg += `   💬 <a href="https://wa.me/${waNum}">مراسلة واتساب مباشرة</a>\n\n`;
                });
                msg += `💡 يمكنك التواصل مع السائق مباشرة أو فتح التطبيق لتأكيد المشوار.`;

                await sendKeyboard(chatId, msg, [
                    [{ text: '🚗 فتح التطبيق للمشوار القصير', url: appUrl }],
                    [{ text: '🔄 التبديل إلى خط دائم', callback_data: 'passenger_trip_daily' }]
                ]);
            }
            break;
        }
        case 'passenger_trip_daily': {
            let passenger = (db.memoryState.customers || []).find(c => String(c.telegramChatId) === String(chatId));
            if (!passenger && state && state.verifiedPhone) {
                const clean = state.verifiedPhone.replace('+964', '0');
                passenger = (db.memoryState.customers || []).find(c => c.phoneNumber === clean);
                if (passenger) { passenger.telegramChatId = String(chatId); db.saveStateSnapshot(); }
            }
            if (!passenger) {
                await sendMessage(chatId, '⚠️ يرجى تسجيل الدخول أولاً كراكب.');
                break;
            }
            const token = 'jwt_customer_' + passenger.customerId;
            const appUrl = `https://tawseelaiq.app/?login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(passenger.customerId)}&role=Customer&fullName=${encodeURIComponent(passenger.fullName)}&tripType=daily`;

            const dailyDrivers = (db.memoryState.drivers || []).filter(d =>
                !d.isBlocked && d.status !== 'Pending' && d.status !== 'Rejected' &&
                (d.isVerified === true || d.status === 'Active' || d.status === 'Approved') &&
                (d.serviceType === 'PermanentLine' || d.serviceType === 'Both' || !d.serviceType)
            );

            let msg = `🔄 <b>تم اختيار: خط دائم</b>\n\n`;
            msg += `📋 خدمة الخطوط الدائمة تتيح لك تثبيت مسارك اليومي للدوام أو الجامعة مع سائق معتمد.\n\n`;
            if (dailyDrivers.length > 0) {
                msg += `🚖 يتوفر حالياً <b>${dailyDrivers.length}</b> سائق مسجل للخطوط والاشتراكات الدائمة.\n\n`;
            }
            msg += `👇 اضغط أدناه لتثبيت مسارك واختيار الكابتن عبر الخريطة:`;

            await sendKeyboard(chatId, msg, [
                [{ text: '🗺️ فتح التطبيق وتحديد مسار الخط الدائم', url: appUrl }],
                [{ text: '⚡ التبديل إلى مشوار قصير', callback_data: 'passenger_trip_short' }]
            ]);
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
                serviceTypeValue = 'ShortTrip';
                typeName = 'مشاوير قصيرة ⚡';
            } else if (data === 'driver_set_daily') {
                driver.serviceType = 'PermanentLine';
                serviceTypeValue = 'PermanentLine';
                typeName = 'خطوط دائمة 🔄';
            } else {
                driver.serviceType = 'Both';
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
        case 'contact_admin': {
            const cfg = db.memoryState.appConfig || {};
            const tgLink = cfg.telegramAdminLink || 'https://t.me/tawseela_iq_bot';
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
        default:
            if (data.startsWith('approve_')) {
                if (String(chatId) === ADMIN_CHAT_ID) await handleApproveDriver(chatId, data.replace('approve_', ''));
            } else if (data.startsWith('reject_')) {
                if (String(chatId) === ADMIN_CHAT_ID) await handleRejectDriver(chatId, data.replace('reject_', ''));
            }
    }
}

async function handleMessage(chatId, text, user) {
    if (!db.memoryState.botSubscribers) db.memoryState.botSubscribers = [];
    if (!db.memoryState.botSubscribers.includes(String(chatId))) { db.memoryState.botSubscribers.push(String(chatId)); db.saveStateSnapshot(); }

    const state = userStates.get(chatId);
    if (!state) {
        const digits = text.replace(/[^0-9]/g, '');
        if (digits.length >= 10) {
            const existing = await checkPhoneRegistration(text);
            if (existing) {
                await sendKeyboard(chatId,
                    `⚠️ <b>الرقم مسجل ${existing.roleAr}. استخدم تسجيل الدخول.</b>`,
                    [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }], [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]]
                );
                return;
            } else {
                await sendKeyboard(chatId,
                    `ℹ️ الرقم (${text.trim()}) غير مسجل في النظام. اختر نوع الحساب للتسجيل:`,
                    [
                        [{ text: '🚶 تسجيل راكب', callback_data: 'reg_passenger' }, { text: '🚕 تسجيل سائق', callback_data: 'reg_driver' }]
                    ]
                );
                return;
            }
        }
        await handleStart(chatId, user);
        return;
    }

    switch (state.step) {
        // --- Passenger Registration ---
        case 'passenger_phone': {
            const digits = text.replace(/[^0-9]/g, '');
            if (digits.length < 10) { await sendMessage(chatId, '❌ رقم غير صالح. أرسل رقم عراقي (مثال: 07701234567):'); return; }
            const existing = await checkPhoneRegistration(text);
            if (existing) {
                userStates.delete(chatId);
                await sendKeyboard(chatId,
                    `⚠️ <b>الرقم مسجل ${existing.roleAr}. استخدم تسجيل الدخول.</b>`,
                    [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }], [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]]
                );
                return;
            }
            state.phone = text.trim();
            state.step = 'passenger_otp_sent';
            userStates.set(chatId, state);
            await sendTelegramOtp(state.phone, chatId);
            break;
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
            state.step = 'passenger_password';
            userStates.set(chatId, state);
            await sendMessage(chatId, '🔒 أرسل كلمة المرور (4 أحرف على الأقل):');
            break;
        }
        case 'passenger_password': {
            if (text.trim().length < 4) { await sendMessage(chatId, '❌ كلمة المرور قصيرة جداً. 4 أحرف على الأقل:'); return; }
            state.password = text.trim();
            // Register passenger
            const crypto = require('crypto');
            const cleanPhone = state.verifiedPhone.replace('+964', '0');
            const customerId = 'usr-c-' + Math.random().toString(36).substr(2, 9);
            const now = new Date().toISOString();
            const passwordHash = crypto.createHash('sha256').update(state.password).digest('hex');

            // Check duplicate
            const existsCust = db.memoryState.customers.find(c => c.phoneNumber === cleanPhone);
            const existsDrv = db.memoryState.drivers.find(d => d.phoneNumber === cleanPhone);
            if (existsCust || existsDrv) {
                const roleAr = existsCust ? 'كراكب' : 'كسائق';
                await sendKeyboard(chatId,
                    `⚠️ <b>الرقم مسجل ${roleAr}. استخدم تسجيل الدخول.</b>`,
                    [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }]]
                );
                userStates.delete(chatId);
                return;
            }

            const newCustomer = {
                customerId, fullName: state.fullName, phoneNumber: cleanPhone,
                email: `${cleanPhone}@tawseelaiq.app`, plainPassword: state.password,
                passwordHash, route: 'النجف الأشرف', address: 'النجف الأشرف',
                preferredPaymentMethod: 'Cash', area: 'النجف الأشرف',
                ratingAverage: 5.0, totalBookings: 0, isActive: true, isBlocked: false,
                registeredAt: now, telegramChatId: String(chatId)
            };
            db.memoryState.customers.unshift(newCustomer);
            db.saveStateSnapshot();
            db.persistNewCustomer(newCustomer).catch(()=>{});

            await sendKeyboard(chatId,
                `🎉 <b>تم تسجيلك كراكب بنجاح!</b>\n\n📱 الهاتف: ${cleanPhone}\n👤 الاسم: ${state.fullName}\n\nيرجى تحديد نوع المشوار للمتابعة:`,
                [
                    [
                        { text: '⚡ مشوار قصير', callback_data: 'passenger_trip_short' },
                        { text: '🔄 خط دائم', callback_data: 'passenger_trip_daily' }
                    ],
                    [{ text: '🚗 فتح التطبيق مباشرة', url: 'https://tawseelaiq.app/?login_token=' + encodeURIComponent('jwt_customer_' + customerId) + '&userId=' + encodeURIComponent(customerId) + '&role=Customer&fullName=' + encodeURIComponent(state.fullName) }]
                ]
            );
            userStates.delete(chatId);
            break;
        }

        // --- Driver Registration ---
        case 'driver_phone': {
            const digits = text.replace(/[^0-9]/g, '');
            if (digits.length < 10) { await sendMessage(chatId, '❌ رقم غير صالح. أرسل رقم عراقي (مثال: 07701234567):'); return; }
            const existing = await checkPhoneRegistration(text);
            if (existing) {
                userStates.delete(chatId);
                await sendKeyboard(chatId,
                    `⚠️ <b>الرقم مسجل ${existing.roleAr}. استخدم تسجيل الدخول.</b>`,
                    [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }], [{ text: '🔙 القائمة الرئيسية', callback_data: 'help' }]]
                );
                return;
            }
            state.phone = text.trim();
            state.step = 'driver_otp_sent';
            userStates.set(chatId, state);
            await sendTelegramOtp(state.phone, chatId);
            break;
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
            state.step = 'driver_password';
            userStates.set(chatId, state);
            await sendMessage(chatId, '🔒 أرسل كلمة المرور (4 أحرف على الأقل):');
            break;
        }
        case 'driver_password': {
            if (text.trim().length < 4) { await sendMessage(chatId, '❌ كلمة المرور قصيرة. 4 أحرف على الأقل:'); return; }
            state.password = text.trim();
            const crypto = require('crypto');
            const cleanPhone = state.verifiedPhone.replace('+964', '0');
            const driverId = 'drv-t-' + Math.random().toString(36).substr(2, 9);
            const now = new Date().toISOString();
            const passwordHash = crypto.createHash('sha256').update(state.password).digest('hex');

            const existsCust = db.memoryState.customers.find(c => c.phoneNumber === cleanPhone);
            const existsDrv = db.memoryState.drivers.find(d => d.phoneNumber === cleanPhone);
            if (existsCust || existsDrv) {
                const roleAr = existsDrv ? 'كسائق' : 'كراكب';
                await sendKeyboard(chatId,
                    `⚠️ <b>الرقم مسجل ${roleAr}. استخدم تسجيل الدخول.</b>`,
                    [[{ text: '🔑 تسجيل دخول', callback_data: 'login' }]]
                );
                userStates.delete(chatId);
                return;
            }

            const newDriver = {
                driverId, fullName: state.fullName, phoneNumber: cleanPhone,
                email: `${cleanPhone}@tawseelaiq.app`, passwordHash, plainPassword: state.password,
                licenseNumber: 'PENDING', vehicle: { make: state.vehicle, plateNumber: state.plate, year: 2023 },
                status: 'Pending', isVerified: false, isBlocked: false,
                ratingAverage: 5.0, totalTrips: 0, registeredAt: now,
                telegramChatId: String(chatId)
            };
            db.memoryState.drivers.unshift(newDriver);

            db.memoryState.verifications.unshift({
                verificationId: 'ver-' + Math.random().toString(36).substr(2, 9),
                driverId, driverName: state.fullName, phoneNumber: cleanPhone,
                status: 'Pending', submittedAt: now
            });

            db.saveStateSnapshot();
            db.persistNewDriver(newDriver).catch(()=>{});

            const cfg = db.memoryState.appConfig || {};
            const waAdminLink = cfg.whatsappAdminLink || 'https://wa.me/9647706204066';
            const tgAdminLink = cfg.telegramAdminLink || 'https://t.me/tawseela_iq_bot';

            await sendMessage(chatId,
                `🎉 <b>تم تسجيلك كسائق بنجاح!</b>\n\n` +
                `⏳ حسابك <b>معلّق</b> بانتظار التوثيق من قبل إدارة المنصة.\n\n` +
                `📋 <b>الخطوة التالية لتفعيل حسابك:</b>\n` +
                `أرسل المستمسكات (هوية + إجازة سوق + سنوية المركبة) عبر:\n` +
                `📱 واتساب: ${waAdminLink}\n` +
                `💬 تيليجرام: ${tgAdminLink}\n\n` +
                `سيتم إشعارك هنا فور تفعيل حسابك من قبل الإدارة.`
            );

            // Notify admin
            await sendKeyboard(ADMIN_CHAT_ID,
                `🚕 <b>سائق جديد بانتظار التوثيق:</b>\n👤 ${state.fullName}\n📱 ${cleanPhone}\n🚗 ${state.vehicle} - ${state.plate}`,
                [[
                    { text: '✅ قبول', callback_data: `approve_${driverId}` },
                    { text: '❌ رفض', callback_data: `reject_${driverId}` }
                ]]
            );
            userStates.delete(chatId);
            break;
        }

        // --- Login ---
        case 'login_phone': {
            const digits = text.replace(/[^0-9]/g, '');
            if (digits.length < 10) { await sendMessage(chatId, '❌ رقم غير صالح. أرسل رقم عراقي (مثال: 07701234567):'); return; }
            const existing = await checkPhoneRegistration(text);
            if (!existing) {
                userStates.delete(chatId);
                await sendKeyboard(chatId,
                    `❌ <b>هذا الرقم (${text.trim()}) غير مسجل في النظام.</b>\n\nيرجى إنشاء حساب أولاً:`,
                    [
                        [{ text: '🚶 تسجيل راكب', callback_data: 'reg_passenger' }, { text: '🚕 تسجيل سائق', callback_data: 'reg_driver' }]
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
                    const tgAdminLink = cfg.telegramAdminLink || 'https://t.me/tawseela_iq_bot';
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
                            await tgRequest('answerCallbackQuery', { callback_query_id: cb.id });
                            await handleCallback(chatId, cb.data, cb.from);
                        }
                    } else if (update.message && update.message.text) {
                        const msg = update.message;
                        const chatId = msg.chat.id;
                        const text = msg.text.trim();

                        // Commands
                        if (text === '/start') { await handleStart(chatId, msg.from); }
                        else if (text === '/status') {
                            const phone = ''; // Would need stored chat-phone mapping
                            await sendMessage(chatId, 'ℹ️ استخدم /start لبدء التسجيل أو تسجيل الدخول.');
                        }
                        else if (text === '/admin' && String(chatId) === ADMIN_CHAT_ID) {
                            await sendKeyboard(chatId, '🔧 <b>لوحة الإدارة</b>', [
                                [{ text: '📊 إحصائيات', callback_data: 'admin_stats' }],
                                [{ text: '⏳ سائقين معلقين', callback_data: 'admin_pending' }]
                            ]);
                        }
                        else { await handleMessage(chatId, text, msg.from); }
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
