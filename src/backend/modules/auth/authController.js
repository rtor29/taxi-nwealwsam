const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const db = require('../../db');
const config = require('../../config');

function saveBase64Image(base64Data, filename) {
    if (!base64Data || typeof base64Data !== 'string') return null;
    try {
        const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        const dataBuffer = matches ? Buffer.from(matches[2], 'base64') : Buffer.from(base64Data, 'base64');
        const filePath = path.join(config.uploadsDir, filename);
        fs.writeFileSync(filePath, dataBuffer);
        return `/uploads/${filename}`;
    } catch (e) {
        console.warn('[AuthController] Error saving base64 image:', e.message);
        return null;
    }
}

class AuthController {
    /**
     * Resolves Google user profile from id_token or access_token
     */
    async resolveGoogleProfile({ idToken, accessToken }) {
        if (idToken) {
            try {
                const parts = idToken.split('.');
                if (parts.length === 3) {
                    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
                    const parsed = JSON.parse(payload);
                    if (parsed.email) {
                        return {
                            sub: parsed.sub,
                            email: parsed.email,
                            name: parsed.name || parsed.given_name || parsed.email.split('@')[0],
                            picture: parsed.picture || ''
                        };
                    }
                }
            } catch (_) {}
        }

        if (accessToken) {
            return new Promise((resolve, reject) => {
                https.get(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${accessToken}`, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.email) {
                                resolve({
                                    sub: parsed.sub,
                                    email: parsed.email,
                                    name: parsed.name || parsed.email.split('@')[0],
                                    picture: parsed.picture || ''
                                });
                            } else {
                                resolve(null);
                            }
                        } catch (e) {
                            reject(e);
                        }
                    });
                }).on('error', reject);
            });
        }

        return null;
    }

    /**
     * Initiates Google OAuth redirect
     */
    handleGoogleRedirect(req, res) {
        const rawHost = req.headers['x-forwarded-host'] || req.headers.host || '173.212.206.86.nip.io';
        const reqHost = rawHost.split(':')[0].toLowerCase();
        const isTawseela = reqHost.includes('tawseelaiq.app');
        const redirectUri = isTawseela
            ? 'https://tawseelaiq.app/api/auth/google/callback'
            : 'http://173.212.206.86.nip.io/api/auth/google/callback';

        const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${querystring.stringify({
            client_id: config.googleClientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid email profile',
            access_type: 'online',
            prompt: 'select_account'
        })}`;

        res.writeHead(302, { 'Location': googleAuthUrl });
        res.end();
    }

    /**
     * Handles Google OAuth Callback
     */
    async handleGoogleCallback(req, res, url) {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error || !code) {
            console.error('[GoogleAuth] Callback error:', error || 'No code provided');
            return this.renderAuthErrorHtml(res, error ? `تم إلغاء تسجيل الدخول: ${error}` : 'لم يتم استلام رمز المصادقة من Google.');
        }

        try {
            const rawHost = req.headers['x-forwarded-host'] || req.headers.host || '173.212.206.86.nip.io';
            const reqHost = rawHost.split(':')[0].toLowerCase();
            const isTawseela = reqHost.includes('tawseelaiq.app');
            const redirectUri = isTawseela
                ? 'https://tawseelaiq.app/api/auth/google/callback'
                : 'http://173.212.206.86.nip.io/api/auth/google/callback';

            const postData = querystring.stringify({
                code,
                client_id: config.googleClientId,
                client_secret: config.googleClientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            });

            const tokenReq = https.request({
                hostname: 'oauth2.googleapis.com',
                port: 443,
                path: '/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (tokenRes) => {
                let raw = '';
                tokenRes.on('data', chunk => raw += chunk);
                tokenRes.on('end', async () => {
                    try {
                        const tokenData = JSON.parse(raw);
                        if (!tokenData.id_token && !tokenData.access_token) {
                            return this.renderAuthErrorHtml(res, 'فشل تبادل رمز التفويض مع Google.');
                        }

                        const profile = await this.resolveGoogleProfile({
                            idToken: tokenData.id_token,
                            accessToken: tokenData.access_token
                        });

                        if (!profile || !profile.email) {
                            return this.renderAuthErrorHtml(res, 'لم يتم العثور على بريد إلكتروني في حساب Google.');
                        }

                        const emailLower = profile.email.toLowerCase();

                        // 1. Check if user already exists as Driver
                        const driver = db.memoryState.drivers.find(d =>
                            (d.email && d.email.toLowerCase() === emailLower) ||
                            (d.googleId && d.googleId === profile.sub)
                        );

                        if (driver) {
                            if (!driver.googleId) {
                                driver.googleId = profile.sub;
                                db.saveStateSnapshot();
                            }
                            const token = 'jwt_driver_' + driver.driverId;
                            return this.renderAuthSuccessHtml(res, token, driver.driverId, 'Driver', driver.fullName, driver.status, reqHost);
                        }

                        // 2. Check if user already exists as Customer
                        const customer = db.memoryState.customers.find(c =>
                            (c.email && c.email.toLowerCase() === emailLower) ||
                            (c.googleId && c.googleId === profile.sub)
                        );

                        if (customer) {
                            if (!customer.googleId) {
                                customer.googleId = profile.sub;
                                db.saveStateSnapshot();
                            }
                            const token = 'jwt_customer_' + customer.customerId;
                            return this.renderAuthSuccessHtml(res, token, customer.customerId, 'Customer', customer.fullName, 'Active', reqHost);
                        }

                        // 3. NEW USER: Auto-register as Customer and log in smoothly
                        const newCustId = 'usr-c-' + Math.random().toString(36).substr(2, 9);
                        const newCust = {
                            customerId: newCustId,
                            fullName: profile.name || emailLower.split('@')[0],
                            email: emailLower,
                            phoneNumber: '',
                            route: 'النجف الأشرف',
                            address: 'النجف الأشرف',
                            googleId: profile.sub,
                            preferredPaymentMethod: 'Cash',
                            area: 'النجف الأشرف',
                            ratingAverage: 5.0,
                            totalBookings: 0,
                            isActive: true,
                            isBlocked: false,
                            registeredAt: new Date().toISOString()
                        };
                        db.memoryState.customers.unshift(newCust);
                        db.saveStateSnapshot();
                        const token = 'jwt_customer_' + newCustId;
                        return this.renderAuthSuccessHtml(res, token, newCustId, 'Customer', newCust.fullName, 'Active', reqHost);

                    } catch (err) {
                        console.error('[GoogleAuth] Error in callback handler:', err);
                        return this.renderAuthErrorHtml(res, 'حدث خطأ أثناء معالجة بيانات الحساب.');
                    }
                });
            });

            tokenReq.on('error', (err) => {
                console.error('[GoogleAuth] Token request error:', err);
                return this.renderAuthErrorHtml(res, 'تعذر الاتصال بخوادم Google.');
            });

            tokenReq.write(postData);
            tokenReq.end();
        } catch (e) {
            console.error('[GoogleAuth] Callback error:', e);
            res.writeHead(302, { 'Location': '/?error=exception' });
            res.end();
        }
    }

    /**
     * Renders the main portal - clean white/black design
     */
    renderMainPortalHtml(res, preselectedRole = 'Driver', reqHost) {
        const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="منصة توصيلة - خدمة حجز وتنظيم رحلات التوصيل اليومية والسائقين في النجف الأشرف.">
    <title>توصيله | التسجيل والدخول</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" rel="stylesheet" media="print" onload="this.media='all'">
    <script src="https://cdn.tailwindcss.com" defer></script>
    <style>
        *{box-sizing:border-box}
        body{font-family:'Cairo',sans-serif;background:#ffffff;color:#111111;margin:0;padding:0;min-height:100vh;overflow-x:hidden}
        .card{background:#ffffff;border:1.5px solid #e5e7eb;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,0.07)}
        .tab-active{background:#111111;color:#ffffff;border-color:#111111}
        .tab-inactive{background:#f3f4f6;color:#6b7280;border-color:#e5e7eb}
        .tab-inactive:hover{background:#e5e7eb;color:#111111}
        .btn-primary{background:#111111;color:#ffffff;border:none;border-radius:12px;padding:14px;font-family:'Cairo',sans-serif;font-weight:900;font-size:15px;cursor:pointer;width:100%;transition:background .2s}
        .btn-primary:hover{background:#333333}
        .btn-primary:disabled{background:#9ca3af;cursor:not-allowed}
        .btn-secondary{background:#f3f4f6;color:#111111;border:1.5px solid #e5e7eb;border-radius:12px;padding:12px;font-family:'Cairo',sans-serif;font-weight:700;font-size:13px;cursor:pointer;width:100%;transition:background .2s}
        .btn-secondary:hover{background:#e5e7eb}
        .btn-small{background:#f3f4f6;color:#374151;border:1.5px solid #d1d5db;border-radius:10px;padding:8px 14px;font-family:'Cairo',sans-serif;font-weight:700;font-size:12px;cursor:pointer;transition:background .2s;white-space:nowrap}
        .btn-small:hover{background:#e5e7eb}
        .inp{width:100%;border:1.5px solid #d1d5db;border-radius:12px;padding:13px 14px;font-family:'Cairo',sans-serif;font-size:14px;color:#111111;background:#fafafa;outline:none;transition:border .2s}
        .inp:focus{border-color:#111111;background:#ffffff}
        .inp::placeholder{color:#9ca3af}
        .label{display:block;font-size:13px;font-weight:700;color:#374151;margin-bottom:6px}
        .alert-error{background:#fef2f2;border:1.5px solid #fecaca;border-radius:10px;padding:10px 14px;font-size:13px;font-weight:700;color:#b91c1c;display:none}
        .badge-green{background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;display:none;align-items:center;gap:8px}
        .trip-card{border:2px solid #e5e7eb;border-radius:14px;padding:18px 16px;cursor:pointer;transition:all .2s;background:#fafafa;text-align:center}
        .trip-card:hover{border-color:#111111;background:#f9f9f9}
        .trip-card.selected{border-color:#111111;background:#111111;color:#ffffff}
        .trip-card.selected .trip-icon{filter:invert(1)}
        .map-mode-btn{border:1.5px solid #d1d5db;border-radius:10px;padding:9px 12px;font-size:12px;font-weight:700;font-family:'Cairo',sans-serif;cursor:pointer;display:flex;align-items:center;gap:6px;background:#f9fafb;color:#374151;transition:all .2s;flex:1;justify-content:center}
        .map-mode-btn.active-pickup{background:#f0fdf4;border-color:#16a34a;color:#15803d}
        .map-mode-btn.active-dropoff{background:#fef2f2;border-color:#dc2626;color:#b91c1c}
        .search-result-item{padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #f3f4f6;color:#111111;display:flex;align-items:center;gap:8px}
        .search-result-item:hover{background:#f3f4f6}
        .sub-toggle{display:flex;background:#f3f4f6;border-radius:10px;padding:3px;gap:3px;margin-bottom:16px}
        .sub-btn{flex:1;padding:9px;font-size:13px;font-weight:700;font-family:'Cairo',sans-serif;border:none;border-radius:8px;cursor:pointer;transition:all .2s}
        .sub-btn.on{background:#111111;color:#ffffff}
        .sub-btn.off{background:transparent;color:#6b7280}
        .sub-btn.off:hover{color:#111111}
        ::placeholder{color:#9ca3af;opacity:1}
    </style>

    <script>
        window.forcePurgeAndReload = async function() {
            try {
                if ('serviceWorker' in navigator) {
                    var regs = await navigator.serviceWorker.getRegistrations();
                    for (var r of regs) await r.unregister();
                }
                if ('caches' in window) {
                    var keys = await caches.keys();
                    for (var k of keys) await caches.delete(k);
                }
            } catch(_) {}
            try { sessionStorage.clear(); } catch(_) {}
            window.location.replace(window.location.origin + window.location.pathname);
        };
        window.normalizeArabicDigits = function(str) {
            if (!str) return '';
            return String(str)
                .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
                .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
        };
    </script>
</head>
<body>

    <!-- App view iframe (shown after login) -->
    <div id="app-view-container" style="display:none;position:fixed;inset:0;width:100vw;height:100vh;z-index:999999;background:#1a1a2e">
        <iframe id="app-frame" style="width:100%;height:100%;border:none" allow="geolocation *; microphone *; camera *" title="تطبيق توصيلة"></iframe>
    </div>

    <!-- Trip type selection (shown after login, before opening app) -->
    <div id="trip-type-modal" style="display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.5);align-items:center;justify-content:center">
        <div class="card" style="max-width:380px;width:92%;margin:0 auto;padding:28px 20px">
            <div style="text-align:center;margin-bottom:20px">
                <div style="font-size:32px;margin-bottom:8px">🚕</div>
                <h2 style="font-size:18px;font-weight:900;margin:0 0 4px;color:#111">اختر نوع الرحلة</h2>
                <p style="font-size:13px;color:#6b7280;margin:0">حدد ما يناسبك قبل فتح التطبيق</p>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
                <div class="trip-card" id="trip-short" onclick="selectTripType('short')">
                    <div style="font-size:28px;margin-bottom:8px">⚡</div>
                    <div style="font-size:14px;font-weight:900;margin-bottom:4px">مشوار قصير</div>
                    <div style="font-size:12px;color:#6b7280">رحلة فورية من نقطة لأخرى</div>
                </div>
                <div class="trip-card" id="trip-daily" onclick="selectTripType('daily')">
                    <div style="font-size:28px;margin-bottom:8px">🔄</div>
                    <div style="font-size:14px;font-weight:900;margin-bottom:4px">خط دائمي</div>
                    <div style="font-size:12px;color:#6b7280">اشتراك يومي على مسار ثابت</div>
                </div>
            </div>
            <button class="btn-primary" id="btn-open-app" onclick="confirmTripTypeAndOpen()" disabled style="opacity:0.5">
                متابعة وفتح التطبيق
            </button>
        </div>
    </div>

    <!-- Floating refresh button -->
    <div style="position:fixed;bottom:16px;left:16px;z-index:9999">
        <button onclick="forcePurgeAndReload()" style="background:#fff;border:1.5px solid #d1d5db;border-radius:999px;padding:10px 16px;font-size:12px;font-weight:700;font-family:'Cairo',sans-serif;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
            <span>🔄</span><span>تحديث</span>
        </button>
    </div>

    <!-- Main Content -->
    <main style="max-width:480px;width:100%;margin:0 auto;padding:24px 16px 40px">

        <!-- Logo & Title -->
        <header style="text-align:center;padding:20px 0 24px">
            <div style="font-size:40px;margin-bottom:10px">🚕</div>
            <h1 style="font-size:22px;font-weight:900;margin:0 0 6px;color:#111">منصة توصيله</h1>
            <p style="font-size:13px;color:#6b7280;margin:0">النجف الأشرف - سجّل دخولك أو أنشئ حسابك</p>
        </header>

        <!-- Role Tabs -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px">
            <button id="tab-btn-customer" type="button" onclick="switchRole('Customer')"
                    style="padding:13px;border-radius:12px;font-family:'Cairo',sans-serif;font-size:14px;font-weight:900;cursor:pointer;border:2px solid;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px"
                    class="${preselectedRole === 'Customer' ? 'tab-active' : 'tab-inactive'}" aria-selected="${preselectedRole === 'Customer'}">
                <i class="fa-solid fa-user" aria-hidden="true"></i> راكب
            </button>
            <button id="tab-btn-driver" type="button" onclick="switchRole('Driver')"
                    style="padding:13px;border-radius:12px;font-family:'Cairo',sans-serif;font-size:14px;font-weight:900;cursor:pointer;border:2px solid;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px"
                    class="${preselectedRole === 'Driver' ? 'tab-active' : 'tab-inactive'}" aria-selected="${preselectedRole === 'Driver'}">
                <i class="fa-solid fa-taxi" aria-hidden="true"></i> سائق
            </button>
        </div>

        <!-- Logged-in card -->
        <div id="user-logged-in-box" class="card" style="display:none;padding:20px;margin-bottom:16px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <div style="display:flex;align-items:center;gap:10px">
                    <div id="logged-user-avatar" style="width:44px;height:44px;border-radius:12px;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:22px">🚕</div>
                    <div>
                        <div id="logged-user-name" style="font-size:15px;font-weight:900;color:#111"></div>
                        <div id="logged-user-role" style="font-size:12px;color:#6b7280;font-weight:700"></div>
                    </div>
                </div>
                <button type="button" onclick="handleLogout()" style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:10px;padding:8px 14px;font-size:12px;font-weight:700;font-family:'Cairo',sans-serif;cursor:pointer" aria-label="تسجيل الخروج">
                    خروج <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
                </button>
            </div>
            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between">
                <span style="font-size:12px;font-weight:700;color:#6b7280">الحالة:</span>
                <span style="font-size:12px;font-weight:900;color:#15803d">✅ نشط ومعتمد</span>
            </div>
        </div>

        <!-- ===== PASSENGER SECTION ===== -->
        <section id="customer-section" style="display:${preselectedRole === 'Driver' ? 'none' : 'block'}">
            <div class="card" style="padding:20px">

                <!-- Sub-mode toggle -->
                <div class="sub-toggle">
                    <button id="sub-btn-cust-reg" type="button" class="sub-btn on" onclick="switchPassengerMode('register')">تسجيل جديد</button>
                    <button id="sub-btn-cust-login" type="button" class="sub-btn off" onclick="switchPassengerMode('login')">لديك حساب؟ دخول</button>
                </div>

                <!-- Alert -->
                <div id="cust-reg-alert" class="alert-error" role="alert"></div>

                <!-- REGISTER FORM -->
                <form id="cust-register-form" onsubmit="handleCustomerRegister(event)">

                    <!-- Step 1: Phone + OTP -->
                    <div style="border:1.5px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:16px">
                        <div style="font-size:12px;font-weight:700;color:#111;margin-bottom:12px;display:flex;align-items:center;gap:6px">
                            <span style="background:#111;color:#fff;border-radius:999px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:11px">1</span>
                            تأكيد رقم الهاتف عبر واتساب
                        </div>
                        <div style="display:flex;gap:8px;margin-bottom:10px">
                            <div style="background:#f3f4f6;border:1.5px solid #e5e7eb;border-radius:10px;padding:13px 12px;font-size:13px;font-weight:900;color:#374151;white-space:nowrap">🇮🇶 +964</div>
                            <div style="position:relative;flex:1">
                                <i class="fa-brands fa-whatsapp" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);color:#16a34a;font-size:16px" aria-hidden="true"></i>
                                <input type="tel" id="cust-reg-phone" class="inp" style="padding-right:38px" placeholder="07706204066" dir="ltr" aria-label="رقم الهاتف" oninput="this.value=normalizeArabicDigits(this.value)">
                            </div>
                        </div>
                        <div id="cust-send-otp-wrap">
                            <button type="button" id="btn-send-whatsapp-otp" onclick="handleSendWhatsappOtp(false)" class="btn-primary" aria-label="إرسال رمز واتساب">
                                <i class="fa-brands fa-whatsapp" aria-hidden="true"></i> إرسال رمز التحقق عبر واتساب
                            </button>
                        </div>
                        <div id="cust-otp-box" style="display:none;margin-top:12px;border-top:1px solid #e5e7eb;padding-top:12px">
                            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px 12px;font-size:12px;font-weight:700;color:#15803d;margin-bottom:10px;display:flex;align-items:center;gap:8px">
                                <i class="fa-brands fa-whatsapp" aria-hidden="true"></i> تحقق من واتساب للرمز
                            </div>
                            <input type="text" id="cust-reg-otp" class="inp" maxlength="6" placeholder="- - - - - -" dir="ltr" style="text-align:center;letter-spacing:8px;font-size:20px;font-weight:900" oninput="this.value=normalizeArabicDigits(this.value)" aria-label="رمز التحقق">
                            <div style="display:flex;gap:8px;margin-top:10px">
                                <button type="button" id="btn-verify-whatsapp-otp" onclick="handleVerifyWhatsappOtp()" class="btn-primary" style="flex:1" aria-label="تأكيد الرمز">تأكيد الرمز ✅</button>
                                <button type="button" id="btn-resend-whatsapp-otp" onclick="handleSendWhatsappOtp(true)" class="btn-small" aria-label="إعادة إرسال">إعادة إرسال</button>
                            </div>
                        </div>
                        <div id="cust-verified-badge" class="badge-green" style="margin-top:10px;justify-content:space-between">
                            <span><i class="fa-solid fa-circle-check" aria-hidden="true"></i> تم تأكيد رقم الهاتف ✅</span>
                            <button type="button" onclick="resetPhoneVerification()" style="background:none;border:none;font-size:12px;color:#6b7280;cursor:pointer;font-family:'Cairo',sans-serif" aria-label="تغيير الرقم">تغيير</button>
                        </div>
                    </div>

                    <!-- Step 2: Personal Info (unlocked after OTP) -->
                    <div id="cust-details-section" style="display:none">
                        <div style="font-size:12px;font-weight:700;color:#111;margin-bottom:12px;display:flex;align-items:center;gap:6px">
                            <span style="background:#111;color:#fff;border-radius:999px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:11px">2</span>
                            بيانات الحساب
                        </div>

                        <!-- First & Last Name -->
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
                            <div>
                                <label for="cust-reg-firstname" class="label">الاسم <span style="color:#dc2626">*</span></label>
                                <input type="text" id="cust-reg-firstname" class="inp" placeholder="مثال: حيدر" aria-label="الاسم الأول">
                            </div>
                            <div>
                                <label for="cust-reg-lastname" class="label">اللقب <span style="color:#dc2626">*</span></label>
                                <input type="text" id="cust-reg-lastname" class="inp" placeholder="مثال: العلي" aria-label="اللقب">
                            </div>
                        </div>

                        <!-- Route selection (short trip vs daily) -->
                        <div style="margin-bottom:12px">
                            <label class="label" style="margin-bottom:10px">نوع الخدمة المطلوبة <span style="color:#dc2626">*</span></label>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                                <div class="trip-card" id="reg-trip-short" onclick="selectRegTripType('short')">
                                    <div style="font-size:22px;margin-bottom:6px">⚡</div>
                                    <div style="font-size:13px;font-weight:900">مشوار قصير</div>
                                    <div style="font-size:11px;color:#6b7280;margin-top:2px">رحلة فورية</div>
                                </div>
                                <div class="trip-card" id="reg-trip-daily" onclick="selectRegTripType('daily')">
                                    <div style="font-size:22px;margin-bottom:6px">🔄</div>
                                    <div style="font-size:13px;font-weight:900">خط دائمي</div>
                                    <div style="font-size:11px;color:#6b7280;margin-top:2px">اشتراك يومي</div>
                                </div>
                            </div>
                        </div>

                        <!-- Map section -->
                        <div style="border:1.5px solid #e5e7eb;border-radius:12px;padding:14px;margin-bottom:12px">
                            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                                <span style="font-size:13px;font-weight:700">📍 نقاط الرحلة على الخريطة</span>
                                <button type="button" id="btn-cust-gps" onclick="getCurrentGpsLocation()" class="btn-small" aria-label="موقعي الحالي">
                                    <i class="fa-solid fa-crosshairs" aria-hidden="true"></i> موقعي
                                </button>
                            </div>
                            <div style="display:flex;gap:8px;margin-bottom:10px">
                                <button type="button" id="btn-mode-pickup" onclick="setMapPinMode('pickup')" class="map-mode-btn active-pickup" aria-label="نقطة الانطلاق">
                                    <span style="width:10px;height:10px;border-radius:50%;background:#16a34a;display:inline-block"></span> انطلاق
                                </button>
                                <button type="button" id="btn-mode-dropoff" onclick="setMapPinMode('dropoff')" class="map-mode-btn" aria-label="نقطة الوصول">
                                    <span style="width:10px;height:10px;border-radius:50%;background:#dc2626;display:inline-block"></span> وصول
                                </button>
                            </div>
                            <div style="position:relative;margin-bottom:10px">
                                <input type="text" id="cust-map-search" class="inp" placeholder="ابحث عن موقع في النجف..." aria-label="البحث عن موقع">
                                <div id="cust-search-results" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:50;background:#fff;border:1.5px solid #e5e7eb;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.1);max-height:200px;overflow-y:auto;margin-top:4px"></div>
                            </div>
                            <div id="passenger-map" style="height:210px;width:100%;border-radius:10px;border:1.5px solid #e5e7eb" role="region" aria-label="خريطة تحديد الموقع"></div>

                            <!-- Pickup / Dropoff address display -->
                            <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
                                <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 10px;font-size:11px">
                                    <div style="font-weight:700;color:#15803d;margin-bottom:2px">🟢 نقطة الانطلاق</div>
                                    <div id="pickup-addr-display" style="color:#374151;font-size:11px">النجف الأشرف</div>
                                </div>
                                <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;font-size:11px">
                                    <div style="font-weight:700;color:#b91c1c;margin-bottom:2px">🔴 نقطة الوصول</div>
                                    <div id="dropoff-addr-display" style="color:#374151;font-size:11px">النجف الأشرف</div>
                                </div>
                            </div>
                        </div>

                        <!-- Hidden coords -->
                        <input type="hidden" id="cust-pickup-lat" value="32.0200">
                        <input type="hidden" id="cust-pickup-lon" value="44.3200">
                        <input type="hidden" id="cust-dropoff-lat" value="32.0321">
                        <input type="hidden" id="cust-dropoff-lon" value="44.3725">

                        <!-- Route / Address (auto-filled from map, editable) -->
                        <div style="margin-bottom:12px">
                            <label for="cust-reg-address" class="label">عنوان الانطلاق بالتفصيل</label>
                            <input type="text" id="cust-reg-address" class="inp" placeholder="مثال: النجف - حي الجامعة" aria-label="عنوان الانطلاق">
                        </div>
                        <div style="margin-bottom:12px">
                            <label for="cust-reg-route" class="label">عنوان الوصول بالتفصيل</label>
                            <input type="text" id="cust-reg-route" class="inp" placeholder="مثال: جامعة الكوفة" aria-label="عنوان الوصول">
                        </div>

                        <!-- Password -->
                        <div style="margin-bottom:16px">
                            <label for="cust-reg-password" class="label">كلمة المرور <span style="color:#dc2626">*</span></label>
                            <div style="position:relative">
                                <input type="password" id="cust-reg-password" class="inp" style="padding-left:44px" minlength="4" placeholder="••••••••" aria-label="كلمة المرور">
                                <button type="button" onclick="togglePasswordVisibility('cust-reg-password','eye-cust-reg-pwd')" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#9ca3af" aria-label="إظهار/إخفاء">
                                    <i id="eye-cust-reg-pwd" class="fa-solid fa-eye" aria-hidden="true"></i>
                                </button>
                            </div>
                        </div>

                        <button type="submit" id="btn-cust-reg-submit" class="btn-primary" aria-label="إكمال التسجيل">
                            <i class="fa-solid fa-user-plus" aria-hidden="true"></i> إكمال تسجيل الحساب
                        </button>
                    </div>
                </form>

                <!-- LOGIN FORM -->
                <form id="cust-login-form" onsubmit="handleCustomerLogin(event)" style="display:none">
                    <div style="margin-bottom:14px">
                        <label for="cust-login-identifier" class="label">رقم الهاتف <span style="color:#dc2626">*</span></label>
                        <input type="text" id="cust-login-identifier" class="inp" placeholder="07701234567" dir="ltr" aria-label="رقم الهاتف" oninput="this.value=normalizeArabicDigits(this.value)">
                    </div>
                    <div style="margin-bottom:16px">
                        <label for="cust-login-password" class="label">كلمة المرور <span style="color:#dc2626">*</span></label>
                        <div style="position:relative">
                            <input type="password" id="cust-login-password" class="inp" style="padding-left:44px" placeholder="••••••••" aria-label="كلمة المرور">
                            <button type="button" onclick="togglePasswordVisibility('cust-login-password','eye-cust-log-pwd')" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#9ca3af" aria-label="إظهار/إخفاء">
                                <i id="eye-cust-log-pwd" class="fa-solid fa-eye" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>
                    <button type="submit" id="btn-cust-login-submit" class="btn-primary" aria-label="تسجيل الدخول">
                        <i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i> دخول
                    </button>
                    <div style="text-align:center;margin-top:12px">
                        <a href="https://wa.me/9647706204066" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:#6b7280;font-weight:700">نسيت كلمة المرور؟ (واتساب)</a>
                    </div>
                </form>
            </div>
        </section>

        <!-- ===== DRIVER SECTION ===== -->
        <section id="driver-section" style="display:${preselectedRole === 'Driver' ? 'block' : 'none'}">
            <div class="card" style="padding:20px">

                <!-- Sub-mode toggle -->
                <div class="sub-toggle">
                    <button id="sub-btn-driver-reg" type="button" class="sub-btn on" onclick="switchDriverMode('register')">تسجيل سائق جديد</button>
                    <button id="sub-btn-driver-login" type="button" class="sub-btn off" onclick="switchDriverMode('login')">لديك حساب؟ دخول</button>
                </div>

                <div id="driver-reg-alert" class="alert-error" role="alert"></div>

                <!-- DRIVER REGISTER FORM -->
                <form id="driver-register-form" onsubmit="handleDriverRegister(event)">
                    <!-- Step 1: OTP -->
                    <div style="border:1.5px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:16px">
                        <div style="font-size:12px;font-weight:700;color:#111;margin-bottom:12px;display:flex;align-items:center;gap:6px">
                            <span style="background:#111;color:#fff;border-radius:999px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:11px">1</span>
                            تأكيد رقم الهاتف عبر واتساب
                        </div>
                        <div style="display:flex;gap:8px;margin-bottom:10px">
                            <div style="background:#f3f4f6;border:1.5px solid #e5e7eb;border-radius:10px;padding:13px 12px;font-size:13px;font-weight:900;color:#374151;white-space:nowrap">🇮🇶 +964</div>
                            <div style="position:relative;flex:1">
                                <i class="fa-brands fa-whatsapp" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);color:#16a34a;font-size:16px" aria-hidden="true"></i>
                                <input type="tel" id="driver-reg-phone" class="inp" style="padding-right:38px" placeholder="07706204066" dir="ltr" aria-label="رقم الهاتف" oninput="this.value=normalizeArabicDigits(this.value)">
                            </div>
                        </div>
                        <div id="driver-send-otp-wrap">
                            <button type="button" id="btn-send-driver-otp" onclick="handleSendDriverWhatsappOtp(false)" class="btn-primary" aria-label="إرسال رمز واتساب">
                                <i class="fa-brands fa-whatsapp" aria-hidden="true"></i> إرسال رمز التحقق
                            </button>
                        </div>
                        <div id="driver-otp-box" style="display:none;margin-top:12px;border-top:1px solid #e5e7eb;padding-top:12px">
                            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px 12px;font-size:12px;font-weight:700;color:#15803d;margin-bottom:10px;display:flex;align-items:center;gap:8px">
                                <i class="fa-brands fa-whatsapp" aria-hidden="true"></i> تحقق من واتساب للرمز
                            </div>
                            <input type="text" id="driver-reg-otp" class="inp" maxlength="6" placeholder="- - - - - -" dir="ltr" style="text-align:center;letter-spacing:8px;font-size:20px;font-weight:900" oninput="this.value=normalizeArabicDigits(this.value)" aria-label="رمز التحقق">
                            <div style="display:flex;gap:8px;margin-top:10px">
                                <button type="button" id="btn-verify-driver-otp" onclick="handleVerifyDriverWhatsappOtp()" class="btn-primary" style="flex:1" aria-label="تأكيد الرمز">تأكيد الرمز ✅</button>
                                <button type="button" id="btn-resend-driver-otp" onclick="handleSendDriverWhatsappOtp(true)" class="btn-small" aria-label="إعادة إرسال">إعادة إرسال</button>
                            </div>
                        </div>
                        <div id="driver-verified-badge" class="badge-green" style="margin-top:10px;justify-content:space-between">
                            <span><i class="fa-solid fa-circle-check" aria-hidden="true"></i> تم تأكيد رقم الهاتف ✅</span>
                            <button type="button" onclick="resetDriverPhoneVerification()" style="background:none;border:none;font-size:12px;color:#6b7280;cursor:pointer;font-family:'Cairo',sans-serif" aria-label="تغيير الرقم">تغيير</button>
                        </div>
                    </div>

                    <!-- Step 2: Driver details (unlocked after OTP) -->
                    <div id="driver-details-section" style="display:none">
                        <div style="font-size:12px;font-weight:700;color:#111;margin-bottom:12px;display:flex;align-items:center;gap:6px">
                            <span style="background:#111;color:#fff;border-radius:999px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:11px">2</span>
                            بيانات الكابتن
                        </div>
                        <div style="margin-bottom:12px">
                            <label for="driver-reg-name" class="label">الاسم الكامل <span style="color:#dc2626">*</span></label>
                            <input type="text" id="driver-reg-name" required class="inp" placeholder="مثال: علي محمد حسن" aria-label="الاسم الكامل للسائق">
                        </div>
                        <div style="margin-bottom:12px">
                            <label for="driver-reg-license" class="label">رقم إجازة السوق <span style="color:#dc2626">*</span></label>
                            <input type="text" id="driver-reg-license" required class="inp" placeholder="مثال: IQ-NJF-4819" aria-label="رقم إجازة السوق">
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
                            <div>
                                <label for="driver-reg-vehicle" class="label">نوع المركبة</label>
                                <input type="text" id="driver-reg-vehicle" class="inp" placeholder="تويوتا كورولا" aria-label="نوع المركبة">
                            </div>
                            <div>
                                <label for="driver-reg-plate" class="label">رقم اللوحة</label>
                                <input type="text" id="driver-reg-plate" class="inp" placeholder="النجف 12345 أ" aria-label="رقم اللوحة">
                            </div>
                        </div>
                        <div style="margin-bottom:16px">
                            <label for="driver-reg-password" class="label">كلمة المرور <span style="color:#dc2626">*</span></label>
                            <div style="position:relative">
                                <input type="password" id="driver-reg-password" required class="inp" style="padding-left:44px" minlength="4" placeholder="••••••••" aria-label="كلمة المرور">
                                <button type="button" onclick="togglePasswordVisibility('driver-reg-password','eye-drv-reg-pwd')" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#9ca3af" aria-label="إظهار/إخفاء">
                                    <i id="eye-drv-reg-pwd" class="fa-solid fa-eye" aria-hidden="true"></i>
                                </button>
                            </div>
                        </div>
                        <button type="submit" id="btn-driver-reg-submit" class="btn-primary" aria-label="إكمال تسجيل السائق">
                            <i class="fa-solid fa-taxi" aria-hidden="true"></i> إكمال تسجيل حساب السائق
                        </button>
                    </div>
                </form>

                <!-- DRIVER LOGIN FORM -->
                <form id="driver-login-form" onsubmit="handleCaptainLogin(event)" style="display:none">
                    <div style="margin-bottom:14px">
                        <label for="login-driver-identifier" class="label">رقم الهاتف <span style="color:#dc2626">*</span></label>
                        <input type="text" id="login-driver-identifier" required class="inp" placeholder="07706204066" dir="ltr" aria-label="رقم الهاتف" oninput="this.value=normalizeArabicDigits(this.value)">
                    </div>
                    <div style="margin-bottom:16px">
                        <label for="login-driver-password" class="label">كلمة المرور <span style="color:#dc2626">*</span></label>
                        <div style="position:relative">
                            <input type="password" id="login-driver-password" required class="inp" style="padding-left:44px" placeholder="••••••••" aria-label="كلمة المرور">
                            <button type="button" onclick="togglePasswordVisibility('login-driver-password','eye-login-drv-pwd')" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#9ca3af" aria-label="إظهار/إخفاء">
                                <i id="eye-login-drv-pwd" class="fa-solid fa-eye" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>
                    <button type="submit" id="btn-login-driver-submit" class="btn-primary" aria-label="دخول السائق">
                        <i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i> دخول
                    </button>
                </form>
            </div>
        </section>

        <!-- Loading -->
        <div id="loading" style="display:none;text-align:center;padding:20px" role="status" aria-live="polite">
            <div style="width:32px;height:32px;border:3px solid #e5e7eb;border-top-color:#111;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 8px"></div>
            <p id="loading-text" style="font-size:13px;color:#6b7280;font-weight:700">جاري المعالجة...</p>
        </div>

        <footer style="text-align:center;margin-top:28px;font-size:12px;color:#9ca3af">
            © 2026 توصيله (Tawseela IQ) · النجف الأشرف
        </footer>
    </main>

    <style>
        @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
    </style>

    <script>
        // ===== Mapbox Lazy Loader =====
        window.loadMapboxDynamically = function() {
            return new Promise(function(resolve) {
                if (window.mapboxgl) return resolve();
                var css = document.createElement('link');
                css.rel = 'stylesheet';
                css.href = 'https://api.mapbox.com/mapbox-gl-js/v3.2.0/mapbox-gl.css';
                document.head.appendChild(css);
                var s = document.createElement('script');
                s.src = 'https://api.mapbox.com/mapbox-gl-js/v3.2.0/mapbox-gl.js';
                s.onload = function() {
                    var r = document.createElement('script');
                    r.src = 'https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js';
                    r.onload = r.onerror = function(){ resolve(); };
                    document.head.appendChild(r);
                };
                s.onerror = function(){ resolve(); };
                document.head.appendChild(s);
            });
        };

        function persistSession(data) {
            try {
                localStorage.setItem('auth_token', data.token);
                localStorage.setItem('user_id', data.userId);
                localStorage.setItem('user_role', data.role);
                localStorage.setItem('user_fullname', data.fullName || 'مستخدم توصيله');
                localStorage.setItem('driver_status', (data.user && data.user.status) || data.status || 'Active');
                localStorage.setItem('flutter.auth_token', JSON.stringify(data.token));
                localStorage.setItem('flutter.user_id', JSON.stringify(data.userId));
                localStorage.setItem('flutter.user_role', JSON.stringify(data.role));
                localStorage.setItem('flutter.user_fullname', JSON.stringify(data.fullName || 'مستخدم توصيله'));
                localStorage.setItem('flutter.driver_status', JSON.stringify((data.user && data.user.status) || data.status || 'Active'));
            } catch (_) {}
        }

        // ===== Role tabs =====
        window.currentRole = '${preselectedRole}';
        window.switchRole = function(role) {
            window.currentRole = role;
            var btnDrv = document.getElementById('tab-btn-driver');
            var btnCust = document.getElementById('tab-btn-customer');
            var boxDrv = document.getElementById('driver-section');
            var boxCust = document.getElementById('customer-section');
            if (!btnDrv || !btnCust) return;
            if (role === 'Driver') {
                btnDrv.className = 'tab-active';
                btnCust.className = 'tab-inactive';
                btnDrv.setAttribute('aria-selected','true');
                btnCust.setAttribute('aria-selected','false');
                if(boxDrv) boxDrv.style.display='block';
                if(boxCust) boxCust.style.display='none';
            } else {
                btnCust.className = 'tab-active';
                btnDrv.className = 'tab-inactive';
                btnCust.setAttribute('aria-selected','true');
                btnDrv.setAttribute('aria-selected','false');
                if(boxCust) boxCust.style.display='block';
                if(boxDrv) boxDrv.style.display='none';
                initPassengerMapbox();
            }
        };

        // ===== Passenger sub-mode =====
        function switchPassengerMode(mode) {
            var regForm = document.getElementById('cust-register-form');
            var loginForm = document.getElementById('cust-login-form');
            var btnReg = document.getElementById('sub-btn-cust-reg');
            var btnLogin = document.getElementById('sub-btn-cust-login');
            if (mode === 'register') {
                if(regForm) regForm.style.display = '';
                if(loginForm) loginForm.style.display = 'none';
                if(btnReg) {btnReg.className='sub-btn on';}
                if(btnLogin) {btnLogin.className='sub-btn off';}
            } else {
                if(regForm) regForm.style.display = 'none';
                if(loginForm) loginForm.style.display = '';
                if(btnReg) {btnReg.className='sub-btn off';}
                if(btnLogin) {btnLogin.className='sub-btn on';}
            }
        }

        // ===== Driver sub-mode =====
        function switchDriverMode(mode) {
            var regForm = document.getElementById('driver-register-form');
            var loginForm = document.getElementById('driver-login-form');
            var btnReg = document.getElementById('sub-btn-driver-reg');
            var btnLogin = document.getElementById('sub-btn-driver-login');
            if (mode === 'register') {
                if(regForm) regForm.style.display = '';
                if(loginForm) loginForm.style.display = 'none';
                if(btnReg) {btnReg.className='sub-btn on';}
                if(btnLogin) {btnLogin.className='sub-btn off';}
            } else {
                if(regForm) regForm.style.display = 'none';
                if(loginForm) loginForm.style.display = '';
                if(btnReg) {btnReg.className='sub-btn off';}
                if(btnLogin) {btnLogin.className='sub-btn on';}
            }
        }

        // ===== Trip type selection (registration form) =====
        var selectedRegTripType = null;
        function selectRegTripType(type) {
            selectedRegTripType = type;
            var cardShort = document.getElementById('reg-trip-short');
            var cardDaily = document.getElementById('reg-trip-daily');
            if (!cardShort || !cardDaily) return;
            if (type === 'short') {
                cardShort.className = 'trip-card selected';
                cardDaily.className = 'trip-card';
            } else {
                cardDaily.className = 'trip-card selected';
                cardShort.className = 'trip-card';
            }
        }

        // ===== Trip type modal (after login) =====
        var _pendingAppParams = null;
        var selectedTripType = null;
        function selectTripType(type) {
            selectedTripType = type;
            document.getElementById('trip-short').className = type === 'short' ? 'trip-card selected' : 'trip-card';
            document.getElementById('trip-daily').className = type === 'daily' ? 'trip-card selected' : 'trip-card';
            var btn = document.getElementById('btn-open-app');
            if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        }
        function confirmTripTypeAndOpen() {
            if (!_pendingAppParams) return;
            var modal = document.getElementById('trip-type-modal');
            if (modal) modal.style.display = 'none';
            var p = _pendingAppParams;
            // Store trip type in localStorage for flutter app
            try {
                localStorage.setItem('selected_trip_type', selectedTripType || 'short');
                localStorage.setItem('flutter.selected_trip_type', JSON.stringify(selectedTripType || 'short'));
            } catch(_) {}
            openAppView(p.token, p.userId, p.role, p.fullName);
        }

        function showTripTypeModal(token, userId, role, fullName) {
            _pendingAppParams = { token, userId, role, fullName };
            selectedTripType = null;
            document.getElementById('trip-short').className = 'trip-card';
            document.getElementById('trip-daily').className = 'trip-card';
            var btn = document.getElementById('btn-open-app');
            if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
            var modal = document.getElementById('trip-type-modal');
            if (modal) { modal.style.display = 'flex'; }
        }

        // ===== Captain Login =====
        async function handleCaptainLogin(event) {
            event.preventDefault();
            var identifier = document.getElementById('login-driver-identifier').value.trim();
            var password = document.getElementById('login-driver-password').value;
            var submitBtn = document.getElementById('btn-login-driver-submit');
            if (!identifier || !password) { alert('يرجى إدخال رقم الهاتف وكلمة المرور'); return; }
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> جاري التحقق...';
            try {
                var res = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({identifier,password,role:'Driver'}) });
                var data = await res.json();
                if (res.ok && data.success) {
                    persistSession(data);
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> تم الدخول!';
                    setTimeout(function(){ showTripTypeModal(data.token, data.userId, data.role||'Driver', data.fullName||'كابتن توصيله'); }, 200);
                } else {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> دخول';
                    alert(data.error || 'فشل تسجيل الدخول. تحقق من رقم الهاتف وكلمة المرور.');
                }
            } catch(err) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> دخول';
                alert('خطأ في الاتصال بالخادم.');
            }
        }

        // ===== Passenger OTP =====
        window.__isPhoneVerified = false;
        window.__verifiedOtpCode = '';

        async function handleSendWhatsappOtp(isResend) {
            var phoneInput = document.getElementById('cust-reg-phone');
            var phone = (phoneInput.value || '').trim();
            var sendBtn = document.getElementById(isResend ? 'btn-resend-whatsapp-otp' : 'btn-send-whatsapp-otp');
            var alertBox = document.getElementById('cust-reg-alert');
            var otpBox = document.getElementById('cust-otp-box');
            if (alertBox) alertBox.style.display = 'none';
            var normalized = normalizeArabicDigits(phone);
            var digits = normalized.replace(/[^0-9]/g,'');
            if (!digits || digits.length < 9) { alert('أدخل رقم هاتف عراقي صالح (مثال: 07801234567)'); phoneInput.focus(); return; }
            var orig = sendBtn.innerHTML;
            sendBtn.disabled = true;
            sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> جاري الإرسال...';
            try {
                var res = await fetch('/api/auth/send-whatsapp-otp', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phoneNumber:normalized}) });
                var data = await res.json();
                if (res.ok && data.success) {
                    otpBox.style.display = 'block';
                    phoneInput.readOnly = true;
                    var otpInput = document.getElementById('cust-reg-otp');
                    if (otpInput) { otpInput.value=''; otpInput.focus(); }
                    if (isResend) alert('تمت إعادة الإرسال إلى ' + phone);
                } else {
                    if (alertBox) { alertBox.textContent = data.error||'تعذر إرسال الرمز'; alertBox.style.display='block'; }
                    alert(data.error || 'تعذر إرسال الرمز');
                }
            } catch(err) { alert('خطأ في الاتصال.'); }
            finally { sendBtn.disabled=false; sendBtn.innerHTML=orig; }
        }

        async function handleVerifyWhatsappOtp() {
            var phone = normalizeArabicDigits((document.getElementById('cust-reg-phone').value||'').trim());
            var otpInput = document.getElementById('cust-reg-otp');
            var code = normalizeArabicDigits((otpInput.value||'').trim());
            var verifyBtn = document.getElementById('btn-verify-whatsapp-otp');
            var alertBox = document.getElementById('cust-reg-alert');
            if (alertBox) alertBox.style.display = 'none';
            if (!code || code.length < 4) { alert('أدخل رمز التحقق المكون من 6 أرقام'); otpInput.focus(); return; }
            var orig = verifyBtn.innerHTML;
            verifyBtn.disabled = true;
            verifyBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> جاري التحقق...';
            try {
                var res = await fetch('/api/auth/verify-whatsapp-otp', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phoneNumber:phone,code:code}) });
                var data = await res.json();
                if (res.ok && data.success) {
                    window.__isPhoneVerified = true;
                    window.__verifiedOtpCode = code;
                    document.getElementById('cust-otp-box').style.display = 'none';
                    document.getElementById('cust-send-otp-wrap').style.display = 'none';
                    var badge = document.getElementById('cust-verified-badge');
                    if (badge) badge.style.display = 'flex';
                    var details = document.getElementById('cust-details-section');
                    if (details) { details.style.display = 'block'; initPassengerMapbox(); }
                    var fnInp = document.getElementById('cust-reg-firstname');
                    if (fnInp) fnInp.focus();
                } else {
                    if (alertBox) { alertBox.textContent = data.error||'رمز التحقق غير صحيح'; alertBox.style.display='block'; }
                    alert(data.error||'رمز التحقق غير صحيح');
                }
            } catch(err) { alert('خطأ في الاتصال.'); }
            finally { verifyBtn.disabled=false; verifyBtn.innerHTML=orig; }
        }

        function resetPhoneVerification() {
            window.__isPhoneVerified = false;
            window.__verifiedOtpCode = '';
            var phoneInput = document.getElementById('cust-reg-phone');
            if (phoneInput) { phoneInput.readOnly=false; phoneInput.focus(); }
            var otpBox = document.getElementById('cust-otp-box');
            var sendWrap = document.getElementById('cust-send-otp-wrap');
            var badge = document.getElementById('cust-verified-badge');
            var details = document.getElementById('cust-details-section');
            if (otpBox) otpBox.style.display='none';
            if (sendWrap) sendWrap.style.display='block';
            if (badge) badge.style.display='none';
            if (details) details.style.display='none';
        }

        async function handleCustomerRegister(event) {
            event.preventDefault();
            var alertBox = document.getElementById('cust-reg-alert');
            if (alertBox) alertBox.style.display = 'none';
            if (!window.__isPhoneVerified) { alert('يرجى التحقق من رقم الهاتف أولاً'); return; }
            var fname = (document.getElementById('cust-reg-firstname').value||'').trim();
            var lname = (document.getElementById('cust-reg-lastname').value||'').trim();
            var fullName = (fname + ' ' + lname).trim();
            var phone = normalizeArabicDigits(document.getElementById('cust-reg-phone').value.trim());
            var route = (document.getElementById('cust-reg-route').value||'').trim() || 'النجف الأشرف';
            var address = (document.getElementById('cust-reg-address').value||'').trim() || 'النجف الأشرف';
            var password = document.getElementById('cust-reg-password').value;
            var submitBtn = document.getElementById('btn-cust-reg-submit');
            if (!fname || !lname) { alert('يرجى إدخال الاسم واللقب'); return; }
            if (!password) { alert('يرجى إدخال كلمة المرور'); return; }
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> جاري التسجيل...';
            var pickupLat = document.getElementById('cust-pickup-lat')?.value||'32.0200';
            var pickupLon = document.getElementById('cust-pickup-lon')?.value||'44.3200';
            var dropoffLat = document.getElementById('cust-dropoff-lat')?.value||'32.0321';
            var dropoffLon = document.getElementById('cust-dropoff-lon')?.value||'44.3725';
            try {
                var res = await fetch('/api/auth/complete-passenger-registration', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({fullName,phoneNumber:phone,route,address,password,otpCode:window.__verifiedOtpCode||'',pickupLat:parseFloat(pickupLat)||32.02,pickupLon:parseFloat(pickupLon)||44.32,dropoffLat:parseFloat(dropoffLat)||32.0321,dropoffLon:parseFloat(dropoffLon)||44.3725,tripType:selectedRegTripType||'short'})
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    persistSession(data);
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> تم التسجيل!';
                    setTimeout(function(){ showTripTypeModal(data.token, data.userId, 'Customer', data.fullName||'راكب توصيله'); }, 200);
                } else {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> إكمال تسجيل الحساب';
                    if (alertBox) { alertBox.textContent = data.error||'فشل التسجيل'; alertBox.style.display='block'; }
                    alert(data.error||'فشل التسجيل');
                }
            } catch(err) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> إكمال تسجيل الحساب';
                alert('خطأ في الاتصال بالخادم.');
            }
        }

        // ===== Driver OTP =====
        window.__isDriverPhoneVerified = false;
        window.__verifiedDriverOtpCode = '';

        async function handleSendDriverWhatsappOtp(isResend) {
            var phoneInput = document.getElementById('driver-reg-phone');
            var phone = (phoneInput.value||'').trim();
            var sendBtn = document.getElementById(isResend?'btn-resend-driver-otp':'btn-send-driver-otp');
            var alertBox = document.getElementById('driver-reg-alert');
            var otpBox = document.getElementById('driver-otp-box');
            if (alertBox) alertBox.style.display='none';
            var normalized = normalizeArabicDigits(phone);
            var digits = normalized.replace(/[^0-9]/g,'');
            if (!digits||digits.length<9) { alert('أدخل رقم هاتف عراقي صالح'); phoneInput.focus(); return; }
            var orig = sendBtn.innerHTML;
            sendBtn.disabled=true;
            sendBtn.innerHTML='<i class="fa-solid fa-circle-notch fa-spin"></i> جاري الإرسال...';
            try {
                var res = await fetch('/api/auth/send-whatsapp-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:normalized})});
                var data = await res.json();
                if (res.ok && data.success) {
                    otpBox.style.display='block';
                    phoneInput.readOnly=true;
                    var oi = document.getElementById('driver-reg-otp');
                    if(oi){oi.value='';oi.focus();}
                    if(isResend) alert('تمت إعادة الإرسال إلى '+phone);
                } else {
                    if(alertBox){alertBox.textContent=data.error||'تعذر الإرسال';alertBox.style.display='block';}
                    alert(data.error||'تعذر الإرسال');
                }
            } catch(err){alert('خطأ في الاتصال.');}
            finally{sendBtn.disabled=false;sendBtn.innerHTML=orig;}
        }

        async function handleVerifyDriverWhatsappOtp() {
            var phone = normalizeArabicDigits((document.getElementById('driver-reg-phone').value||'').trim());
            var otpInput = document.getElementById('driver-reg-otp');
            var code = normalizeArabicDigits((otpInput.value||'').trim());
            var verifyBtn = document.getElementById('btn-verify-driver-otp');
            var alertBox = document.getElementById('driver-reg-alert');
            if(alertBox) alertBox.style.display='none';
            if(!code||code.length<4){alert('أدخل رمز التحقق');otpInput.focus();return;}
            var orig = verifyBtn.innerHTML;
            verifyBtn.disabled=true;
            verifyBtn.innerHTML='<i class="fa-solid fa-circle-notch fa-spin"></i> جاري التحقق...';
            try {
                var res = await fetch('/api/auth/verify-whatsapp-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone,code:code})});
                var data = await res.json();
                if(res.ok&&data.success){
                    window.__isDriverPhoneVerified=true;
                    window.__verifiedDriverOtpCode=code;
                    document.getElementById('driver-otp-box').style.display='none';
                    document.getElementById('driver-send-otp-wrap').style.display='none';
                    var badge=document.getElementById('driver-verified-badge');
                    if(badge) badge.style.display='flex';
                    var details=document.getElementById('driver-details-section');
                    if(details) details.style.display='block';
                    var ni=document.getElementById('driver-reg-name');
                    if(ni) ni.focus();
                } else {
                    if(alertBox){alertBox.textContent=data.error||'رمز غير صحيح';alertBox.style.display='block';}
                    alert(data.error||'رمز غير صحيح');
                }
            } catch(err){alert('خطأ في الاتصال.');}
            finally{verifyBtn.disabled=false;verifyBtn.innerHTML=orig;}
        }

        function resetDriverPhoneVerification() {
            window.__isDriverPhoneVerified=false;
            window.__verifiedDriverOtpCode='';
            var pi=document.getElementById('driver-reg-phone');
            if(pi){pi.readOnly=false;pi.focus();}
            ['driver-otp-box','driver-reg-alert'].forEach(function(id){var el=document.getElementById(id);if(el)el.style.display='none';});
            var sw=document.getElementById('driver-send-otp-wrap');if(sw)sw.style.display='block';
            var badge=document.getElementById('driver-verified-badge');if(badge)badge.style.display='none';
            var det=document.getElementById('driver-details-section');if(det)det.style.display='none';
        }

        async function handleDriverRegister(event) {
            event.preventDefault();
            var alertBox=document.getElementById('driver-reg-alert');
            if(alertBox) alertBox.style.display='none';
            if(!window.__isDriverPhoneVerified){alert('يرجى التحقق من رقم الهاتف أولاً');return;}
            var name=(document.getElementById('driver-reg-name').value||'').trim();
            var phone=normalizeArabicDigits(document.getElementById('driver-reg-phone').value.trim());
            var license=(document.getElementById('driver-reg-license').value||'').trim();
            var vehicle=(document.getElementById('driver-reg-vehicle')?.value||'').trim();
            var plate=(document.getElementById('driver-reg-plate')?.value||'').trim();
            var password=document.getElementById('driver-reg-password').value;
            var submitBtn=document.getElementById('btn-driver-reg-submit');
            if(!name||!phone||!password){alert('يرجى ملء جميع الحقول');return;}
            submitBtn.disabled=true;
            submitBtn.innerHTML='<i class="fa-solid fa-circle-notch fa-spin"></i> جاري التسجيل...';
            try {
                var res = await fetch('/api/auth/complete-driver-registration',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fullName:name,phoneNumber:phone,licenseNumber:license,vehicleMake:vehicle,vehiclePlate:plate,password,otpCode:window.__verifiedDriverOtpCode||''})});
                var data = await res.json();
                if(res.ok&&data.success){
                    persistSession(data);
                    submitBtn.innerHTML='<i class="fa-solid fa-check"></i> تم التسجيل!';
                    setTimeout(function(){openAppView(data.token,data.userId,'Driver',data.fullName||'كابتن توصيله');},200);
                } else {
                    submitBtn.disabled=false;
                    submitBtn.innerHTML='<i class="fa-solid fa-taxi"></i> إكمال تسجيل حساب السائق';
                    if(alertBox){alertBox.textContent=data.error||'فشل التسجيل';alertBox.style.display='block';}
                    alert(data.error||'فشل التسجيل');
                }
            } catch(err){
                submitBtn.disabled=false;
                submitBtn.innerHTML='<i class="fa-solid fa-taxi"></i> إكمال تسجيل حساب السائق';
                alert('خطأ في الاتصال.');
            }
        }

        // ===== Passenger Login =====
        async function handleCustomerLogin(event) {
            event.preventDefault();
            var identifier=document.getElementById('cust-login-identifier').value.trim();
            var password=document.getElementById('cust-login-password').value;
            var submitBtn=document.getElementById('btn-cust-login-submit');
            if(!identifier||!password){alert('يرجى إدخال رقم الهاتف وكلمة المرور');return;}
            submitBtn.disabled=true;
            submitBtn.innerHTML='<i class="fa-solid fa-circle-notch fa-spin"></i> جاري الدخول...';
            try {
                var res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier,password,role:'Customer'})});
                var data=await res.json();
                if(res.ok&&data.success){
                    persistSession(data);
                    submitBtn.innerHTML='<i class="fa-solid fa-check"></i> تم!';
                    setTimeout(function(){showTripTypeModal(data.token,data.userId,'Customer',data.fullName||'راكب توصيله');},200);
                } else {
                    submitBtn.disabled=false;
                    submitBtn.innerHTML='<i class="fa-solid fa-right-to-bracket"></i> دخول';
                    alert(data.error||'فشل تسجيل الدخول. تحقق من البيانات.');
                }
            } catch(err){
                submitBtn.disabled=false;
                submitBtn.innerHTML='<i class="fa-solid fa-right-to-bracket"></i> دخول';
                alert('خطأ في الاتصال.');
            }
        }

        // ===== Mapbox map =====
        var passengerMap=null, pickupMarker=null, dropoffMarker=null, currentPinMode='pickup';

        function setMapPinMode(mode) {
            currentPinMode=mode;
            var bp=document.getElementById('btn-mode-pickup');
            var bd=document.getElementById('btn-mode-dropoff');
            if(!bp||!bd) return;
            if(mode==='pickup'){
                bp.className='map-mode-btn active-pickup';
                bd.className='map-mode-btn';
            } else {
                bp.className='map-mode-btn';
                bd.className='map-mode-btn active-dropoff';
            }
        }

        async function reverseGeocodeLocation(lng,lat,target) {
            try {
                var token=('pk.'+'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9'+'._J6DYjYBDhsdcidErQrblA');
                var res=await fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/'+lng+','+lat+'.json?country=iq&language=ar&access_token='+token);
                var data=await res.json();
                var pName=(data.features&&data.features.length>0)?(data.features[0].place_name_ar||data.features[0].place_name):'';
                if(!pName){
                    var osm=await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat='+lat+'&lon='+lng);
                    var od=await osm.json();
                    if(od&&od.display_name) pName=od.display_name;
                }
                if(pName){
                    if(target==='pickup'){
                        var ai=document.getElementById('cust-reg-address');if(ai)ai.value=pName;
                        var pd=document.getElementById('pickup-addr-display');if(pd)pd.textContent=pName;
                    } else {
                        var ri=document.getElementById('cust-reg-route');if(ri)ri.value=pName;
                        var dd=document.getElementById('dropoff-addr-display');if(dd)dd.textContent=pName;
                    }
                }
            } catch(_) {}
        }

        function updatePickupPoint(lng,lat,doReverse) {
            document.getElementById('cust-pickup-lat').value=Number(lat).toFixed(6);
            document.getElementById('cust-pickup-lon').value=Number(lng).toFixed(6);
            if(!pickupMarker&&passengerMap){
                pickupMarker=new mapboxgl.Marker({color:'#16a34a',draggable:true}).setLngLat([lng,lat]).addTo(passengerMap);
                pickupMarker.on('dragend',function(){var p=pickupMarker.getLngLat();updatePickupPoint(p.lng,p.lat,true);});
            } else if(pickupMarker) pickupMarker.setLngLat([lng,lat]);
            if(doReverse) reverseGeocodeLocation(lng,lat,'pickup');
        }

        function updateDropoffPoint(lng,lat,doReverse) {
            document.getElementById('cust-dropoff-lat').value=Number(lat).toFixed(6);
            document.getElementById('cust-dropoff-lon').value=Number(lng).toFixed(6);
            if(!dropoffMarker&&passengerMap){
                dropoffMarker=new mapboxgl.Marker({color:'#dc2626',draggable:true}).setLngLat([lng,lat]).addTo(passengerMap);
                dropoffMarker.on('dragend',function(){var p=dropoffMarker.getLngLat();updateDropoffPoint(p.lng,p.lat,true);});
            } else if(dropoffMarker) dropoffMarker.setLngLat([lng,lat]);
            if(doReverse) reverseGeocodeLocation(lng,lat,'dropoff');
        }

        function getCurrentGpsLocation() {
            var btn=document.getElementById('btn-cust-gps');
            if(!navigator.geolocation){alert('GPS غير مدعوم في متصفحك.');return;}
            var orig=btn?btn.innerHTML:'';
            if(btn) btn.innerHTML='<i class="fa-solid fa-circle-notch fa-spin"></i>';
            navigator.geolocation.getCurrentPosition(function(pos){
                if(btn) btn.innerHTML=orig;
                var lat=pos.coords.latitude, lng=pos.coords.longitude;
                if(passengerMap) passengerMap.flyTo({center:[lng,lat],zoom:15});
                if(currentPinMode==='pickup') updatePickupPoint(lng,lat,true);
                else updateDropoffPoint(lng,lat,true);
            },function(){
                if(btn) btn.innerHTML=orig;
                alert('تعذر الوصول إلى موقعك. فعّل إذن الموقع.');
            },{enableHighAccuracy:true,timeout:10000});
        }

        async function initPassengerMapbox() {
            if(passengerMap||!document.getElementById('passenger-map')) return;
            try {
                if(!window.mapboxgl) await window.loadMapboxDynamically();
                if(!window.mapboxgl) return;
                mapboxgl.accessToken=('pk.'+'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9'+'._J6DYjYBDhsdcidErQrblA');
                passengerMap=new mapboxgl.Map({container:'passenger-map',style:'mapbox://styles/mapbox/streets-v12',center:[44.32,32.02],zoom:13,maxBounds:[[44.05,31.75],[44.65,32.35]]});
                if(typeof mapboxgl.getRTLTextPluginStatus==='function'&&mapboxgl.getRTLTextPluginStatus()==='unavailable'){
                    mapboxgl.setRTLTextPlugin('https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js',null,true);
                }
                passengerMap.addControl(new mapboxgl.NavigationControl({showCompass:true}),'top-left');
                passengerMap.on('load',function(){
                    updatePickupPoint(44.3200,32.0200,false);
                    updateDropoffPoint(44.3500,32.0300,false);
                });
                passengerMap.on('click',function(e){
                    if(currentPinMode==='pickup') updatePickupPoint(e.lngLat.lng,e.lngLat.lat,true);
                    else updateDropoffPoint(e.lngLat.lng,e.lngLat.lat,true);
                });
            } catch(e){console.error('Mapbox error:',e);}
        }

        // Search autocomplete
        (function(){
            var si=document.getElementById('cust-map-search');
            var rb=document.getElementById('cust-search-results');
            var st=null;
            if(!si||!rb) return;
            si.addEventListener('input',function(){
                clearTimeout(st);
                var q=si.value.trim();
                if(q.length<1){rb.style.display='none';return;}
                st=setTimeout(async function(){
                    try {
                        var token=('pk.'+'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9'+'._J6DYjYBDhsdcidErQrblA');
                        var url='https://api.mapbox.com/geocoding/v5/mapbox.places/'+encodeURIComponent(q)+'.json?proximity=44.32,32.02&bbox=44.05,31.75,44.65,32.35&country=iq&language=ar&access_token='+token;
                        var res=await fetch(url);
                        var data=await res.json();
                        rb.innerHTML='';
                        var feats=(data&&data.features)?data.features:[];
                        if(feats.length===0){
                            try{
                                var or=await fetch('https://nominatim.openstreetmap.org/search?format=json&countrycodes=iq&q='+encodeURIComponent(q+' النجف'));
                                var od=await or.json();
                                if(od&&od.length>0) feats=od.map(function(o){return{place_name:o.display_name,place_name_ar:o.display_name,center:[parseFloat(o.lon),parseFloat(o.lat)]};});
                            } catch(_){}
                        }
                        if(feats.length>0){
                            rb.style.display='block';
                            feats.forEach(function(feat){
                                var d=document.createElement('div');
                                d.className='search-result-item';
                                var pName=feat.place_name_ar||feat.place_name;
                                d.innerHTML='<span>📍</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+pName+'</span>';
                                d.onclick=function(){
                                    if(passengerMap) passengerMap.flyTo({center:feat.center,zoom:15});
                                    if(currentPinMode==='pickup'){
                                        updatePickupPoint(feat.center[0],feat.center[1],false);
                                        var ai=document.getElementById('cust-reg-address');if(ai)ai.value=pName;
                                        var pd=document.getElementById('pickup-addr-display');if(pd)pd.textContent=pName;
                                    } else {
                                        updateDropoffPoint(feat.center[0],feat.center[1],false);
                                        var ri=document.getElementById('cust-reg-route');if(ri)ri.value=pName;
                                        var dd=document.getElementById('dropoff-addr-display');if(dd)dd.textContent=pName;
                                    }
                                    si.value=pName;
                                    rb.style.display='none';
                                };
                                rb.appendChild(d);
                            });
                        } else rb.style.display='none';
                    } catch(_){rb.style.display='none';}
                },200);
            });
            document.addEventListener('click',function(e){if(!si.contains(e.target)&&!rb.contains(e.target)) rb.style.display='none';});
        })();

        // ===== App view =====
        window.openAppView = function(token,userId,role,fullName) {
            var container=document.getElementById('app-view-container');
            var frame=document.getElementById('app-frame');
            if(!container||!frame) return;
            var targetHash=(role==='Driver'||role==='driver')?'/driver':'/customer';
            var targetUrl='/app-view/#'+targetHash+'?login_token='+encodeURIComponent(token)+'&userId='+encodeURIComponent(userId)+'&role='+encodeURIComponent(role)+'&fullName='+encodeURIComponent(fullName);
            frame.src=targetUrl;
            container.style.display='block';
            document.body.style.overflow='hidden';
        };

        function togglePasswordVisibility(inputId,iconId) {
            var inp=document.getElementById(inputId);
            var ico=document.getElementById(iconId);
            if(!inp) return;
            if(inp.type==='password'){inp.type='text';if(ico){ico.className='fa-solid fa-eye-slash';}}
            else{inp.type='password';if(ico){ico.className='fa-solid fa-eye';}}
        }

        function checkUserSession() {
            try {
                var token=localStorage.getItem('auth_token');
                var userId=localStorage.getItem('user_id')||'usr-current';
                var role=localStorage.getItem('user_role')||'Customer';
                var fullName=localStorage.getItem('user_fullname')||(role==='Driver'?'كابتن توصيله':'راكب توصيله');
                if(token&&token.length>5) {
                    showTripTypeModal(token,userId,role,fullName);
                }
            } catch(_) {}
        }

        window.handleLogout = function() {
            try {
                ['auth_token','user_id','user_role','user_fullname','driver_status',
                 'flutter.auth_token','flutter.user_id','flutter.user_role','flutter.user_fullname','flutter.driver_status'
                ].forEach(function(k){localStorage.removeItem(k);});
                sessionStorage.clear();
            } catch(_) {}
            window.location.replace('/');
        };

        (function() {
            checkUserSession();
            var urlParams=new URLSearchParams(window.location.search);
            var role=urlParams.get('role');
            if(role==='Customer'||role==='customer') window.switchRole('Customer');
            else window.switchRole('Driver');
        })();
    </script>
</body>
</html>`;

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(html);
    }

    renderCaptainLoginHtml(res, reqHost) {
        return this.renderMainPortalHtml(res, 'Driver', reqHost);
    }

    renderOnboardingWizardHtml(res, profile, reqHost) {
        const role = (profile && profile.preselectedRole) || 'Customer';
        return this.renderMainPortalHtml(res, role, reqHost);
    }

    /**
     * Completes Passenger (Customer) Registration with Duplicate Prevention and Password Hashing
     */
    async handleCompletePassengerRegistration(req, res, body) {
        const { fullName, email, password, googleId, phoneNumber, route, address, area, paymentMethod, pickupLat, pickupLon, dropoffLat, dropoffLon } = body;
        if (!fullName || !phoneNumber || !password) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'الاسم الكامل، رقم الهاتف، وكلمة المرور مطلوبة.' }));
        }

        // Iraqi Phone Normalization
        const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
        let strPhone = String(phoneNumber).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d));
        let normDigits = strPhone.replace(/[^0-9]/g, '');
        if (normDigits.startsWith('00964')) normDigits = normDigits.substring(5);
        else if (normDigits.startsWith('964')) normDigits = normDigits.substring(3);
        if (normDigits.length === 10 && normDigits.startsWith('7')) normDigits = '0' + normDigits;

        if (!normDigits || normDigits.length < 10) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'يرجى إدخال رقم هاتف عراقي صالح (مثال: 07701234567).' }));
        }

        const cleanPhone = normDigits.startsWith('0') ? normDigits : ('0' + normDigits);
        const emailLower = email ? email.trim().toLowerCase() : `${cleanPhone}@tawseelaiq.app`;

        // Optional WhatsApp OTP verification if provided
        if (body.otpCode) {
            const whatsappService = require('../whatsapp/whatsappService');
            const otpCheck = whatsappService.verifyOtp(phoneNumber, body.otpCode);
            if (!otpCheck.valid) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(JSON.stringify({ success: false, error: otpCheck.error }));
            }
        }

        // 1. DUPLICATE CHECK (In Memory)
        const normalizeCheck = (p) => {
            if (!p) return '';
            let s = String(p).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
            if (s.startsWith('00964')) s = s.substring(5);
            else if (s.startsWith('964')) s = s.substring(3);
            if (s.length === 10 && s.startsWith('7')) s = '0' + s;
            return s;
        };

        let existingCustomer = db.memoryState.customers.find(c =>
            (c.phoneNumber && normalizeCheck(c.phoneNumber) === cleanPhone) ||
            (c.phoneNumber && c.phoneNumber.trim() === cleanPhone)
        );
        let existingDriver = db.memoryState.drivers.find(d =>
            (d.phoneNumber && normalizeCheck(d.phoneNumber) === cleanPhone) ||
            (d.phoneNumber && d.phoneNumber.trim() === cleanPhone)
        );

        // Check in PostgreSQL
        if (!existingCustomer && !existingDriver && db.isPostgresConnected && db.pool) {
            try {
                const pgCheck = await db.pool.query(`
                    SELECT id, phone_number FROM users 
                    WHERE REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g') LIKE '%' || $1
                       OR phone_number = $2
                    LIMIT 1
                `, [cleanPhone.substring(1), cleanPhone]);
                if (pgCheck.rows && pgCheck.rows.length > 0) {
                    existingCustomer = pgCheck.rows[0];
                }
            } catch (pgErr) {
                console.error('[AuthController] Duplicate check PG error:', pgErr.message);
            }
        }

        if (existingCustomer || existingDriver) {
            res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
                success: false,
                duplicate: true,
                error: 'الرقم مسجل بالفعل، يرجى إدخال رقم هاتف آخر.'
            }));
        }

        const crypto = require('crypto');
        const cleanPassword = String(password).trim();
        const passwordHash = crypto.createHash('sha256').update(cleanPassword).digest('hex');

        const customerId = 'usr-c-' + Math.random().toString(36).substr(2, 9);
        const now = new Date().toISOString();
        const userRoute = (route || area || 'النجف الأشرف').trim();
        const userAddress = (address || area || 'النجف الأشرف').trim();

        const newCustomer = {
            customerId,
            fullName: fullName.trim(),
            email: emailLower,
            phoneNumber: cleanPhone,
            route: userRoute,
            address: userAddress,
            plainPassword: cleanPassword,
            passwordHash,
            googleId: googleId || null,
            preferredPaymentMethod: paymentMethod || 'Cash',
            area: userAddress,
            pickupLat: pickupLat ? parseFloat(pickupLat) : 32.0200,
            pickupLon: pickupLon ? parseFloat(pickupLon) : 44.3200,
            dropoffLat: dropoffLat ? parseFloat(dropoffLat) : 32.0321,
            dropoffLon: dropoffLon ? parseFloat(dropoffLon) : 44.3725,
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
                    INSERT INTO users (id, phone_number, email, full_name, role, password_hash, plain_password, google_id, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, 'Customer', $5, $6, $7, true, false, $8)
                    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, password_hash = EXCLUDED.password_hash, plain_password = EXCLUDED.plain_password
                `, [customerId, cleanPhone, emailLower, fullName.trim(), passwordHash, cleanPassword, googleId || null, now]);

                await db.pool.query(`
                    INSERT INTO customers (customer_id, full_name, phone_number, email, route, address, plain_password, password_hash, google_id, preferred_payment_method, rating_average, total_bookings, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 5.0, 0, true, false, $11)
                    ON CONFLICT (customer_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, route = EXCLUDED.route, address = EXCLUDED.address, plain_password = EXCLUDED.plain_password, password_hash = EXCLUDED.password_hash
                `, [customerId, fullName.trim(), cleanPhone, emailLower, userRoute, userAddress, cleanPassword, passwordHash, googleId || null, newCustomer.preferredPaymentMethod, now]);
            } catch (e) {
                console.error('[AuthController] PG Customer insert error:', e);
            }
        }

        db.addAuditLog('PassengerRegistered', 'Customer', customerId, {
            fullName: newCustomer.fullName,
            phoneNumber: cleanPhone,
            route: userRoute,
            address: userAddress,
            registeredAt: now
        });

        db.saveStateSnapshot();

        try {
            const whatsappService = require('../whatsapp/whatsappService');
            whatsappService.consumeVerification(cleanPhone);
            whatsappService.sendTextMessage(cleanPhone, `مرحباً ${fullName.trim()} في تطبيق توصيلة (Tawsela) 🚖\nتم تسجيل حسابك كراكب بنجاح. نتمنى لك رحلات آمنة ومريحة!`).catch(() => {});
        } catch (_) {}

        const token = 'jwt_customer_' + customerId;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            success: true,
            message: 'تم تسجيل الحساب بنجاح',
            token,
            userId: customerId,
            role: 'Customer',
            fullName: newCustomer.fullName,
            phoneNumber: cleanPhone,
            route: userRoute,
            address: userAddress,
            autoRedirect: true,
            redirectUrl: `/?phone=${encodeURIComponent(cleanPhone)}&registered=true`
        }));
    }

    /**
     * Completes Driver Registration with Duplicate Prevention, Password Hashing, documents & route
     */
    async handleCompleteDriverRegistration(req, res, body) {
        const { fullName, email, password, googleId, phoneNumber, vehicleMake, vehiclePlate, vehicleYear, licenseNumber, documents, route } = body;
        if (!fullName || !phoneNumber || !password) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'الاسم الكامل، رقم الهاتف، وكلمة المرور مطلوبة.' }));
        }

        // Iraqi Phone Normalization
        const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
        let strPhone = String(phoneNumber).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d));
        let normDigits = strPhone.replace(/[^0-9]/g, '');
        if (normDigits.startsWith('00964')) normDigits = normDigits.substring(5);
        else if (normDigits.startsWith('964')) normDigits = normDigits.substring(3);
        if (normDigits.length === 10 && normDigits.startsWith('7')) normDigits = '0' + normDigits;

        if (!normDigits || normDigits.length < 10) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'يرجى إدخال رقم هاتف عراقي صالح (مثال: 07701234567).' }));
        }

        const cleanPhone = normDigits.startsWith('0') ? normDigits : ('0' + normDigits);
        const emailLower = email ? email.trim().toLowerCase() : `${cleanPhone}@tawseelaiq.app`;

        // Optional WhatsApp OTP verification if provided
        if (body.otpCode) {
            const whatsappService = require('../whatsapp/whatsappService');
            const otpCheck = whatsappService.verifyOtp(phoneNumber, body.otpCode);
            if (!otpCheck.valid) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(JSON.stringify({ success: false, error: otpCheck.error }));
            }
        }

        // 1. DUPLICATE CHECK
        const existingCustomer = db.memoryState.customers.find(c =>
            (c.email && c.email.toLowerCase() === emailLower) ||
            (cleanPhone && c.phoneNumber && c.phoneNumber.replace(/[\s\-]/g, '') === cleanPhone)
        );
        const existingDriver = db.memoryState.drivers.find(d =>
            (d.email && d.email.toLowerCase() === emailLower) ||
            (cleanPhone && d.phoneNumber && d.phoneNumber.replace(/[\s\-]/g, '') === cleanPhone)
        );

        if (existingCustomer || existingDriver) {
            res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
                success: false,
                duplicate: true,
                error: 'الرقم مسجل بالفعل، يرجى إدخال رقم هاتف آخر.'
            }));
        }

        const crypto = require('crypto');
        const passwordHash = password ? crypto.createHash('sha256').update(String(password)).digest('hex') : null;

        const driverId = 'drv-g-' + Math.random().toString(36).substr(2, 9);
        const now = new Date().toISOString();
        const finalLicenseNumber = licenseNumber || ('IRQ-NJF-' + Math.floor(1000 + Math.random() * 9000));

        // Process Documents
        const docUrls = {};
        if (documents && typeof documents === 'object') {
            for (const [key, base64] of Object.entries(documents)) {
                if (base64) {
                    const filename = `${driverId}-${key}-${Date.now()}.jpg`;
                    const url = saveBase64Image(base64, filename);
                    if (url) docUrls[key] = url;
                }
            }
        }

        const newDriver = {
            driverId,
            fullName,
            email: emailLower,
            phoneNumber: cleanPhone,
            passwordHash,
            googleId: googleId || null,
            licenseNumber: finalLicenseNumber,
            vehicle: {
                make: vehicleMake || 'تويوتا',
                model: vehicleMake || 'كورولا',
                plateNumber: vehiclePlate || 'النجف',
                year: parseInt(vehicleYear, 10) || 2023
            },
            route: route || null,
            documents: docUrls,
            status: 'Pending',
            isVerified: false,
            isBlocked: false,
            ratingAverage: 5.0,
            totalTrips: 0,
            registeredAt: now
        };

        db.memoryState.drivers.unshift(newDriver);

        // Insert into verification queue
        const verificationEntry = {
            verificationId: 'ver-' + Math.random().toString(36).substr(2, 9),
            driverId,
            driverName: fullName,
            phoneNumber: cleanPhone,
            licenseNumber: finalLicenseNumber,
            documents: docUrls,
            vehicle: newDriver.vehicle,
            status: 'Pending',
            submittedAt: now
        };
        db.memoryState.verifications.unshift(verificationEntry);

        // If driver provided a route, register it
        if (route && route.startName && route.endName) {
            const newRoute = {
                id: 'rt-' + Math.random().toString(36).substr(2, 9),
                driverId,
                driverName: fullName,
                driverPhone: cleanPhone,
                startName: route.startName,
                endName: route.endName,
                startLat: route.startLat,
                startLon: route.startLon,
                endLat: route.endLat,
                endLon: route.endLon,
                departureTime: route.departureTime || '08:00 ص',
                availableSeats: route.availableSeats || 4,
                fare: route.fare || 3000,
                status: 'Active',
                createdAt: now
            };
            db.memoryState.routes.unshift(newRoute);
        }

        // Notify Admin Dashboard
        if (typeof db.addNotification === 'function') {
            db.addNotification(
                'NewDriverPending',
                `كابتن جديد بانتظار التوثيق: ${fullName} (${newDriver.vehicle.make} - ${newDriver.vehicle.plateNumber})`,
                { driverId, verificationId: verificationEntry.verificationId }
            );
        }

        db.addAuditLog('DriverRegistered', 'Driver', driverId, {
            fullName,
            phoneNumber: cleanPhone,
            vehicle: newDriver.vehicle,
            registeredAt: now
        });

        // Insert into PostgreSQL
        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    INSERT INTO users (id, phone_number, email, full_name, role, google_id, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, 'Driver', $5, true, false, $6)
                    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
                `, [driverId, cleanPhone, emailLower, fullName, googleId, now]);

                await db.pool.query(`
                    INSERT INTO drivers (driver_id, full_name, phone_number, email, google_id, license_number, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, status, is_verified, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, 'Pending', false, false, $10)
                    ON CONFLICT (driver_id) DO NOTHING
                `, [driverId, fullName, cleanPhone, emailLower, googleId, licenseNumber, newDriver.vehicle.make, newDriver.vehicle.year, newDriver.vehicle.plateNumber, now]);
            } catch (e) {
                console.error('[AuthController] PG Driver insert error:', e);
            }
        }

        db.saveStateSnapshot();

        const token = 'jwt_driver_' + driverId;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            success: true,
            token,
            userId: driverId,
            role: 'Driver',
            fullName,
            status: 'Pending',
            redirectUrl: `/?login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(driverId)}&role=Driver&fullName=${encodeURIComponent(fullName)}`
        }));
    }



    renderAuthSuccessHtml(res, token, userId, role, fullName, status, reqHost) {
        const safeToken = JSON.stringify(token);
        const safeUserId = JSON.stringify(userId);
        const safeRole = JSON.stringify(role);
        const safeFullName = JSON.stringify(fullName);
        const safeStatus = JSON.stringify(status || 'Active');
        const basePath = '/';
        const target = `${basePath}?login_token=${encodeURIComponent(token)}&userId=${encodeURIComponent(userId)}&role=${encodeURIComponent(role)}&fullName=${encodeURIComponent(fullName)}&status=${encodeURIComponent(status || 'Active')}`;

        const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>توصيله | تسجيل الدخول</title>
  <style>
    body { background-color: #0F172A; color: #FFFFFF; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .box { text-align: center; padding: 36px; background: rgba(30, 41, 59, 0.85); border-radius: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); max-width: 360px; width: 90%; }
    .icon { font-size: 54px; margin-bottom: 16px; }
    .title { font-size: 20px; font-weight: bold; margin-bottom: 8px; color: #F8FAFC; }
    .subtitle { font-size: 14px; color: #94A3B8; }
    .spinner { width: 32px; height: 32px; border: 3px solid rgba(245,158,11,0.2); border-top-color: #F59E0B; border-radius: 50%; animation: spin 1s infinite linear; margin: 20px auto 0; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">🚖</div>
    <div class="title">تم تسجيل الدخول بنجاح!</div>
    <div class="subtitle">جاري تحويلك إلى حسابك...</div>
    <div class="spinner"></div>
  </div>
  <script>
    try {
      var t = ${safeToken};
      var u = ${safeUserId};
      var r = ${safeRole};
      var n = ${safeFullName};
      var s = ${safeStatus};

      localStorage.setItem('auth_token', t);
      localStorage.setItem('user_id', u);
      localStorage.setItem('user_role', r);
      localStorage.setItem('user_fullname', n);
      localStorage.setItem('driver_status', s);

      localStorage.setItem('flutter.auth_token', JSON.stringify(t));
      localStorage.setItem('flutter.user_id', JSON.stringify(u));
      localStorage.setItem('flutter.user_role', JSON.stringify(r));
      localStorage.setItem('flutter.user_fullname', JSON.stringify(n));
      localStorage.setItem('flutter.driver_status', JSON.stringify(s));
    } catch (e) {
      console.error(e);
    }
    setTimeout(function() {
      window.location.replace(${JSON.stringify(target)});
    }, 100);
  </script>
</body>
</html>`;

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(html);
    }

    renderAuthErrorHtml(res, errorMessage) {
        const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>توصيله | خطأ في تسجيل الدخول</title>
  <style>
    body { background-color: #0F172A; color: #FFFFFF; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .box { text-align: center; padding: 36px; background: rgba(30, 41, 59, 0.85); border-radius: 24px; max-width: 400px; width: 90%; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
    .icon { font-size: 54px; margin-bottom: 16px; }
    .title { font-size: 20px; font-weight: bold; margin-bottom: 8px; color: #EF4444; }
    .subtitle { font-size: 14px; color: #94A3B8; margin-bottom: 24px; line-height: 1.6; }
    .btn { display: inline-block; background: #F59E0B; color: #0F172A; text-decoration: none; padding: 12px 28px; border-radius: 12px; font-weight: bold; font-size: 15px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">⚠️</div>
    <div class="title">تعذر إكمال تسجيل الدخول عبر Google</div>
    <div class="subtitle">${escapeHtml(errorMessage)}</div>
    <a href="/" class="btn">العودة لصفحة البداية</a>
  </div>
</body>
</html>`;

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(html);
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

module.exports = new AuthController();
