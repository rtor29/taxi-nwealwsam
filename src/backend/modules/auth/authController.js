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
     * Renders the Unified Smart Dark Web Portal for Tawseela
     * Passengers register/login via Web App tab
     * Captains login via Dashboard-authorized credentials with direct WhatsApp/Call
     */
    renderMainPortalHtml(res, preselectedRole = 'Driver', reqHost) {
        const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="منصة توصيلة - خدمة حجز وتنظيم رحلات التوصيل اليومية والسائقين في النجف الأشرف بسهولة وأمان.">
    <title>توصيله | بوابة الدخول والتسجيل الذكية - النجف الأشرف</title>
    
    <!-- Preconnect & Fonts with font-display: swap -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" rel="stylesheet" media="print" onload="this.media='all'">
    
    <!-- Tailwind CSS with defer -->
    <script src="https://cdn.tailwindcss.com" defer></script>
    
    <script>
        window.forcePurgeAndReload = async function() {
            var btn = document.getElementById('btn-purge-cache');
            if (btn) btn.innerHTML = '<span>⏳</span><span>جاري تحديث التطبيق...</span>';
            try {
                if ('serviceWorker' in navigator) {
                    var registrations = await navigator.serviceWorker.getRegistrations();
                    for (var i = 0; i < registrations.length; i++) await registrations[i].unregister();
                }
            } catch (_) {}
            try {
                if ('caches' in window) {
                    var keys = await caches.keys();
                    for (var j = 0; j < keys.length; j++) await caches.delete(keys[j]);
                }
            } catch (_) {}
            try { sessionStorage.clear(); } catch (_) {}
            window.location.replace(window.location.origin + window.location.pathname);
        };

        window.currentRole = '${preselectedRole}';
        window.switchRole = function(role) {
            window.currentRole = role;
            var btnDrv = document.getElementById('tab-btn-driver');
            var btnCust = document.getElementById('tab-btn-customer');
            var boxDrv = document.getElementById('driver-section');
            var boxCust = document.getElementById('customer-section');
            
            if (!btnDrv || !btnCust || !boxDrv || !boxCust) return;

            if (role === 'Driver') {
                btnDrv.className = 'py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer tab-btn-active-driver glow-amber';
                btnCust.className = 'py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer tab-btn-inactive';
                btnDrv.setAttribute('aria-selected', 'true');
                btnCust.setAttribute('aria-selected', 'false');
                boxDrv.style.display = 'block';
                boxCust.style.display = 'none';
            } else {
                btnCust.className = 'py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer tab-btn-active-customer glow-blue';
                btnDrv.className = 'py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer tab-btn-inactive';
                btnCust.setAttribute('aria-selected', 'true');
                btnDrv.setAttribute('aria-selected', 'false');
                boxCust.style.display = 'block';
                boxDrv.style.display = 'none';
                setTimeout(function() {
                    if (typeof initPassengerMapbox === 'function') initPassengerMapbox();
                    if (window.passengerMap) { try { window.passengerMap.resize(); } catch(e){} }
                }, 150);
            }
        };

        window.togglePasswordVisibility = function(inputId, eyeIconId) {
            var input = document.getElementById(inputId);
            var icon = document.getElementById(eyeIconId);
            if (!input) return;
            if (input.type === 'password') {
                input.type = 'text';
                if (icon) { icon.className = 'fa-solid fa-eye-slash'; }
            } else {
                input.type = 'password';
                if (icon) { icon.className = 'fa-solid fa-eye'; }
            }
        };

        window.switchPassengerMode = function(mode) {
            var formReg = document.getElementById('cust-register-form');
            var formLog = document.getElementById('cust-login-form');
            var btnReg = document.getElementById('sub-btn-cust-reg');
            var btnLog = document.getElementById('sub-btn-cust-login');

            if (mode === 'register') {
                if (formReg) formReg.style.display = 'block';
                if (formLog) formLog.style.display = 'none';
                if (btnReg) btnReg.className = 'px-4 py-2 rounded-xl text-xs font-black bg-blue-600 text-white transition shadow-md';
                if (btnLog) btnLog.className = 'px-4 py-2 rounded-xl text-xs font-black text-slate-300 hover:text-white transition';
            } else {
                if (formReg) formReg.style.display = 'none';
                if (formLog) formLog.style.display = 'block';
                if (btnLog) btnLog.className = 'px-4 py-2 rounded-xl text-xs font-black bg-blue-600 text-white transition shadow-md';
                if (btnReg) btnReg.className = 'px-4 py-2 rounded-xl text-xs font-black text-slate-300 hover:text-white transition';
            }
        };

        window.switchDriverMode = function(mode) {
            var formReg = document.getElementById('driver-register-form');
            var formLog = document.getElementById('driver-login-form');
            var btnReg = document.getElementById('sub-btn-driver-reg');
            var btnLog = document.getElementById('sub-btn-driver-login');

            if (mode === 'register') {
                if (formReg) formReg.style.display = 'block';
                if (formLog) formLog.style.display = 'none';
                if (btnReg) btnReg.className = 'px-4 py-2 rounded-xl text-xs font-black bg-amber-500 text-slate-950 transition shadow-md';
                if (btnLog) btnLog.className = 'px-4 py-2 rounded-xl text-xs font-black text-slate-300 hover:text-white transition';
            } else {
                if (formReg) formReg.style.display = 'none';
                if (formLog) formLog.style.display = 'block';
                if (btnLog) btnLog.className = 'px-4 py-2 rounded-xl text-xs font-black bg-amber-500 text-slate-950 transition shadow-md';
                if (btnReg) btnReg.className = 'px-4 py-2 rounded-xl text-xs font-black text-slate-300 hover:text-white transition';
            }
        };

        window.normalizeArabicDigits = function(str) {
            if (!str) return '';
            var ar = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
            var fa = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
            var res = String(str).replace(/[٠-٩]/g, function(d) {
                return ar.indexOf(d);
            }).replace(/[۰-۹]/g, function(d) {
                return fa.indexOf(d);
            });
            return res;
        };
    </script>

    <style>
        body {
            font-family: 'Cairo', sans-serif;
            background-color: #f0f2f5;
            color: #1a1a2e;
            overflow-x: hidden;
            -webkit-tap-highlight-color: transparent;
            font-display: swap;
        }
        .glow-amber { box-shadow: 0 2px 12px rgba(245,158,11,0.18); }
        .glow-blue  { box-shadow: 0 2px 12px rgba(37,99,235,0.18); }
        .glass-card {
            background: #ffffff;
            border: 1px solid #e2e8f0;
            box-shadow: 0 4px 24px rgba(0,0,0,0.07);
        }
        .tab-btn-active-driver {
            background: #1a1a2e !important;
            color: #f59e0b !important;
            border-color: #1a1a2e !important;
            box-shadow: 0 4px 16px rgba(26,26,46,0.25) !important;
        }
        .tab-btn-active-customer {
            background: #1a1a2e !important;
            color: #ffffff !important;
            border-color: #1a1a2e !important;
            box-shadow: 0 4px 16px rgba(26,26,46,0.25) !important;
        }
        .tab-btn-inactive {
            background: #f8fafc !important;
            color: #475569 !important;
            border-color: #cbd5e1 !important;
        }
        .tab-btn-inactive:hover {
            background: #e2e8f0 !important;
            color: #1a1a2e !important;
        }
        ::placeholder { color: #94a3b8 !important; opacity: 1; }
        /* Override Tailwind dark classes to white-mode */
        .bg-slate-950\/90, .bg-slate-900\/90, .bg-slate-900\/80, .bg-slate-800\/90, .bg-slate-800 {
            background-color: #f8fafc !important;
        }
        .border-slate-800, .border-slate-700 { border-color: #e2e8f0 !important; }
        .text-white { color: #1a1a2e !important; }
        .text-slate-300, .text-slate-400 { color: #475569 !important; }
        .text-slate-500 { color: #64748b !important; }
        .text-amber-400 { color: #d97706 !important; }
        .text-emerald-400 { color: #059669 !important; }
        .text-blue-300 { color: #2563eb !important; }
        .text-rose-300 { color: #e11d48 !important; }
        input, select, textarea {
            background-color: #f8fafc !important;
            border-color: #cbd5e1 !important;
            color: #1a1a2e !important;
        }
        input:focus { border-color: #6366f1 !important; }
    </style>
</head>
<body class="min-h-screen relative flex flex-col justify-between py-6 px-3 sm:px-6">

    <!-- Full-screen Embedded App Interface (Passenger sees drivers, Driver receives requests) -->
    <div id="app-view-container" style="display: none; position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 999999; background: #1a1a2e;">
        <iframe id="app-frame" title="تطبيق توصيلة الذكي" style="width: 100%; height: 100%; border: none; display: block;" allow="geolocation *; microphone *; camera *"></iframe>
    </div>

    <!-- Floating Quick Update App Button -->
    <div style="position:fixed; bottom:16px; left:16px; z-index:99999; direction:rtl;">
        <button onclick="forcePurgeAndReload()" id="btn-purge-cache" title="تحديث التطبيق ومسح الذاكرة المؤقتة" aria-label="تحديث التطبيق ومسح الذاكرة المؤقتة"
                class="bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 text-xs font-bold py-2.5 px-4 rounded-full shadow-lg flex items-center gap-2 transition cursor-pointer">
            <span>🔄</span>
            <span>تحديث التطبيق</span>
        </button>
    </div>

    <main class="max-w-2xl w-full mx-auto my-auto space-y-6">

        <!-- Top Header & Branding -->
        <header class="text-center space-y-2">
            <div class="inline-flex items-center justify-center w-20 h-20 bg-amber-500/20 text-amber-400 rounded-3xl text-4xl shadow-xl border border-amber-500/30" aria-hidden="true">
                🚕
            </div>
            <h1 class="text-2xl sm:text-3xl font-black text-white tracking-tight">
                منصة توصيله الذكية
            </h1>
            <p class="text-xs sm:text-sm text-slate-300 font-semibold">
                بوابة التوثيق والاشتراك اليومي - النجف الأشرف
            </p>
        </header>

        <!-- Role Selector Tabs -->
        <nav aria-label="اختيار نوع الحساب" class="grid grid-cols-2 gap-3 p-2 bg-slate-950/90 rounded-3xl border border-slate-800 shadow-2xl backdrop-blur-md">
            <button type="button" id="tab-btn-customer" onclick="switchRole('Customer'); return false;" aria-label="تسجيل كراكب"
                    class="py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer ${preselectedRole === 'Driver' ? 'tab-btn-inactive' : 'tab-btn-active-customer glow-blue'}">
                <i class="fa-solid fa-user text-base sm:text-lg" aria-hidden="true"></i>
                <span>تسجيل كراكب</span>
            </button>
            <button type="button" id="tab-btn-driver" onclick="switchRole('Driver'); return false;" aria-label="تسجيل كسائق"
                    class="py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer ${preselectedRole === 'Driver' ? 'tab-btn-active-driver glow-amber' : 'tab-btn-inactive'}">
                <i class="fa-solid fa-taxi text-base sm:text-lg" aria-hidden="true"></i>
                <span>تسجيل كسائق</span>
            </button>
        </nav>

        <!-- Logged-in User Profile Card (Visible when user has active session) -->
        <section id="user-logged-in-box" style="display: none;" aria-label="ملف المستخدم المسجل" class="glass-card rounded-3xl p-6 border border-emerald-500/40 shadow-2xl space-y-4 glow-amber">
            <div class="flex items-center justify-between border-b border-slate-800 pb-4">
                <div class="flex items-center gap-3">
                    <div id="logged-user-avatar" class="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-2xl border border-emerald-500/30" aria-hidden="true">
                        🚕
                    </div>
                    <div>
                        <h2 id="logged-user-name" class="text-lg font-black text-white"></h2>
                        <p id="logged-user-role" class="text-xs text-emerald-400 font-bold"></p>
                    </div>
                </div>
                <button type="button" onclick="handleLogout()" aria-label="تسجيل الخروج من الحساب" class="px-4 py-2.5 bg-rose-600/20 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-500/30 rounded-xl text-xs font-black transition flex items-center gap-2 cursor-pointer shadow-lg">
                    <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
                    <span>تسجيل الخروج</span>
                </button>
            </div>
            <div class="p-3.5 bg-slate-900/80 border border-slate-800 rounded-2xl flex items-center justify-between">
                <span class="text-xs text-slate-300 font-semibold">حالة الحساب في المنصة:</span>
                <span class="text-xs font-black px-2.5 py-1 bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 rounded-lg">✅ نشط ومعتمد</span>
            </div>
        </section>

        <!-- ================================================================= -->
        <!-- TAB 1: PASSENGER (CUSTOMER) - WEB APP REGISTRATION & LOGIN        -->
        <!-- ================================================================= -->
        <section id="customer-section" style="display: ${preselectedRole === 'Driver' ? 'none' : 'block'};" aria-label="قسم الركاب" class="space-y-6">
            
            <div class="glass-card rounded-3xl p-5 sm:p-8 border border-blue-500/30 shadow-2xl space-y-6 glow-blue">
                
                <!-- Passenger Sub-mode switchers -->
                <div class="flex items-center justify-between bg-slate-900/90 p-2 rounded-2xl border border-slate-800">
                    <button type="button" id="sub-btn-cust-reg" onclick="switchPassengerMode('register')" aria-label="فتح استمارة تسجيل راكب جديد"
                            class="px-4 py-2 rounded-xl text-xs font-black bg-blue-600 text-white transition shadow-md">
                        استمارة تسجيل راكب جديد 📝
                    </button>
                    <button type="button" id="sub-btn-cust-login" onclick="switchPassengerMode('login')" aria-label="فتح نموذج تسجيل دخول الراكب"
                            class="px-4 py-2 rounded-xl text-xs font-black text-slate-300 hover:text-white transition">
                        لديك حساب بالفعل؟ تسجيل الدخول 🔑
                    </button>
                </div>

                <!-- Registration Form for Passengers (WhatsApp OTP Verified) -->
                <form id="cust-register-form" onsubmit="handleCustomerRegister(event)" class="space-y-4">
                    <div class="text-right border-b border-slate-800 pb-3">
                        <h2 class="text-base font-black text-white flex items-center gap-2">
                            <span>👤</span>
                            <span>استمارة تسجيل الراكب الجديد</span>
                        </h2>
                        <p class="text-xs text-slate-300 mt-1">تحقق من رقم هاتفك عبر واتساب أولاً لإكمال تسجيل الحساب:</p>
                    </div>

                    <div id="cust-reg-alert" style="display: none;" role="alert" class="p-3 bg-rose-500/20 border border-rose-500/50 rounded-xl text-xs font-bold text-rose-300 text-right"></div>

                    <!-- Step 1: Iraqi Phone & WhatsApp OTP Verification -->
                    <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-3.5 space-y-3">
                        <div class="flex items-center justify-between">
                            <span id="cust-step1-badge" class="px-2.5 py-0.5 bg-blue-500/20 text-blue-300 text-[11px] font-bold rounded-full border border-blue-500/30">خطوة 1: تأكيد الهاتف عبر واتساب</span>
                            <label for="cust-reg-phone" class="text-xs text-slate-300 font-bold">رقم الهاتف العراقي <span class="text-rose-400">*</span></label>
                        </div>
                        <div class="flex items-center gap-2">
                            <div class="flex items-center gap-1.5 px-3 py-3 bg-slate-800 border border-slate-700 rounded-xl text-xs font-black text-amber-400 select-none">
                                <span>🇮🇶</span>
                                <span dir="ltr">+964</span>
                            </div>
                            <div class="relative flex-1">
                                <i class="fa-brands fa-whatsapp absolute right-3.5 top-3.5 text-emerald-400 text-base pointer-events-none" aria-hidden="true"></i>
                                <input type="tel" id="cust-reg-phone" required placeholder="07706204066" dir="ltr" aria-label="رقم الهاتف العراقي"
                                       oninput="this.value = normalizeArabicDigits(this.value)"
                                       class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-slate-400 font-mono text-left">
                            </div>
                        </div>

                        <!-- Button to send WhatsApp OTP -->
                        <div id="cust-send-otp-wrap">
                            <button type="button" id="btn-send-whatsapp-otp" onclick="handleSendWhatsappOtp(false)" aria-label="إرسال رمز التحقق عبر واتساب"
                                    class="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20 cursor-pointer">
                                <i class="fa-brands fa-whatsapp text-base" aria-hidden="true"></i>
                                <span>المتابعة وإرسال رمز التحقق عبر واتساب 📲</span>
                            </button>
                        </div>

                        <!-- OTP Input Box (shown after sending OTP) -->
                        <div id="cust-otp-box" style="display: none;" class="space-y-2.5 pt-2 border-t border-slate-800">
                            <!-- Instant notification banner -->
                            <div class="p-2.5 bg-emerald-950/60 border border-emerald-500/40 rounded-xl text-xs text-emerald-300 font-bold flex items-center gap-2 text-right">
                                <i class="fa-brands fa-whatsapp text-emerald-400 text-base flex-shrink-0" aria-hidden="true"></i>
                                <span>تابع الواتساب ليصلك رمز التحقق 💬</span>
                            </div>

                            <div>
                                <label for="cust-reg-otp" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">أدخل رمز التحقق (6 أرقام) <span class="text-rose-400">*</span></label>
                                <div class="relative">
                                    <i class="fa-solid fa-key absolute right-3.5 top-3 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                                    <input type="text" id="cust-reg-otp" maxlength="6" placeholder="------" dir="ltr" aria-label="رمز التحقق المكون من 6 أرقام"
                                           oninput="this.value = normalizeArabicDigits(this.value)"
                                           class="w-full pr-10 pl-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-base tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-emerald-500 text-emerald-400 font-mono font-black">
                                </div>
                            </div>

                            <div class="flex items-center gap-2">
                                <button type="button" id="btn-verify-whatsapp-otp" onclick="handleVerifyWhatsappOtp()" aria-label="تأكيد رمز التحقق والمتابعة"
                                        class="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white font-black rounded-xl text-xs transition flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-blue-600/20">
                                    <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
                                    <span>تأكيد الرمز والمتابعة ✅</span>
                                </button>
                                <button type="button" id="btn-resend-whatsapp-otp" onclick="handleSendWhatsappOtp(true)" aria-label="إعادة إرسال رمز التحقق"
                                        class="px-3.5 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer">
                                    إعادة إرسال
                                </button>
                            </div>
                        </div>

                        <!-- Verified Badge (shown when verified) -->
                        <div id="cust-verified-badge" style="display: none;" class="p-2.5 bg-emerald-500/20 border border-emerald-500/40 rounded-xl text-xs font-bold text-emerald-300 flex items-center justify-between">
                            <span class="flex items-center gap-1.5"><i class="fa-solid fa-circle-check text-emerald-400" aria-hidden="true"></i> تم التحقق من رقم الهاتف عبر واتساب بنجاح ✅</span>
                            <button type="button" onclick="resetPhoneVerification()" aria-label="تغيير رقم الهاتف" class="text-[11px] text-slate-300 hover:text-white underline cursor-pointer">تغيير الرقم</button>
                        </div>
                    </div>

                    <!-- Step 2: Customer Details (Unlocked after OTP verification) -->
                    <div id="cust-details-section" style="display: none;" class="space-y-4 pt-1 border-t border-slate-800">
                        <div class="text-right">
                            <span class="px-2.5 py-0.5 bg-emerald-500/20 text-emerald-300 text-[11px] font-bold rounded-full border border-emerald-500/30">خطوة 2: إكمال بيانات الحساب</span>
                        </div>

                        <!-- 1. Full Name -->
                        <div>
                            <label for="cust-reg-name" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">الاسم الكامل <span class="text-rose-400">*</span></label>
                            <div class="relative">
                                <i class="fa-solid fa-user absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                                <input type="text" id="cust-reg-name" placeholder="مثال: حيدر علي الحسني" aria-label="الاسم الكامل للراكب"
                                       class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-slate-400 text-right">
                            </div>
                        </div>

                        <!-- 2. Route -->
                        <div>
                            <label for="cust-reg-route" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">المسار (خط السير المطلوب) <span class="text-rose-400">*</span></label>
                            <div class="relative">
                                <i class="fa-solid fa-route absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                                <input type="text" id="cust-reg-route" placeholder="مثال: من حي الجامعة إلى جامعة الكوفة" aria-label="المسار أو خط السير المطلوب"
                                       class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-slate-400 text-right">
                            </div>
                        </div>

                        <!-- 3. Address -->
                        <div>
                            <label for="cust-reg-address" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">العنوان بالتفصيل <span class="text-rose-400">*</span></label>
                            <div class="relative">
                                <i class="fa-solid fa-location-dot absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                                <input type="text" id="cust-reg-address" placeholder="مثال: النجف - حي الجامعة - قرب المسجد" aria-label="العنوان بالتفصيل"
                                       class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-slate-400 text-right">
                            </div>
                        </div>

                        <!-- Hidden Coordinates for Pickup & Dropoff -->
                        <input type="hidden" id="cust-pickup-lat" name="pickupLat" value="32.0200">
                        <input type="hidden" id="cust-pickup-lon" name="pickupLon" value="44.3200">
                        <input type="hidden" id="cust-dropoff-lat" name="dropoffLat" value="32.0321">
                        <input type="hidden" id="cust-dropoff-lon" name="dropoffLon" value="44.3725">

                        <!-- Interactive Najaf Map UX (Mapbox) -->
                        <div class="space-y-2.5 pt-2 border-t border-slate-800">
                            <div class="flex items-center justify-between">
                                <label class="text-xs text-slate-300 font-bold">تحديد موقعي الانطلاق والتوصيل بالنجف 📍</label>
                                <button type="button" id="btn-cust-gps" onclick="getCurrentGpsLocation()" aria-label="تحديد موقعي الحالي عبر الجي بي اس" class="px-2.5 py-1 bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 border border-blue-500/40 rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition cursor-pointer">
                                    <i class="fa-solid fa-crosshairs" aria-hidden="true"></i>
                                    <span>تحديد موقعي الحالي (GPS)</span>
                                </button>
                            </div>

                            <!-- Concise Guidance Box -->
                            <div class="p-2.5 bg-slate-800/80 border border-slate-700 rounded-xl text-[11px] text-amber-300 flex items-start gap-2">
                                <span class="text-amber-400 text-sm" aria-hidden="true">💡</span>
                                <span>اضغط على الخريطة أو اسحب الدبوس لتحديد نقطتي: <b>الانطلاق (بالأخضر)</b> و<b>التوصيل (بالأحمر)</b> بدقة في محافظة النجف الأشرف.</span>
                            </div>

                            <!-- Mode selection toggle -->
                            <div class="grid grid-cols-2 gap-2 text-xs">
                                <button type="button" id="btn-mode-pickup" onclick="setMapPinMode('pickup')" aria-label="تحديد نقطة الانطلاق" class="py-2 px-3 rounded-xl font-bold flex items-center justify-center gap-1.5 border border-emerald-500 bg-emerald-500/20 text-emerald-300 cursor-pointer transition">
                                    <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" aria-hidden="true"></span>
                                    <span>نقطة الانطلاق (Pickup)</span>
                                </button>
                                <button type="button" id="btn-mode-dropoff" onclick="setMapPinMode('dropoff')" aria-label="تحديد نقطة التوصيل" class="py-2 px-3 rounded-xl font-bold flex items-center justify-center gap-1.5 border border-slate-700 bg-slate-800 text-slate-300 hover:text-white cursor-pointer transition">
                                    <span class="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" aria-hidden="true"></span>
                                    <span>نقطة التوصيل (Dropoff)</span>
                                </button>
                            </div>

                            <!-- Autocomplete Search from 1st char -->
                            <div class="relative">
                                <input type="text" id="cust-map-search" placeholder="ابحث عن شارع، حي، مجمع، أو جامعة في النجف..." aria-label="البحث عن موقع في النجف"
                                       class="w-full px-4 py-2.5 bg-slate-800/90 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-400 focus:outline-none focus:border-blue-500 text-right">
                                <div id="cust-search-results" class="hidden absolute top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 max-h-48 overflow-y-auto"></div>
                            </div>

                            <div id="passenger-map" style="height: 220px; width: 100%; border-radius: 1rem;" role="region" aria-label="خريطة تحديد الموقع في النجف" class="border border-slate-700 shadow-inner"></div>
                        </div>

                        <!-- 4. Password -->
                        <div>
                            <label for="cust-reg-password" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">كلمة المرور (الباسوورد للحساب) <span class="text-rose-400">*</span></label>
                            <div class="relative">
                                <i class="fa-solid fa-lock absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                                <input type="password" id="cust-reg-password" minlength="4" placeholder="••••••••" aria-label="كلمة المرور لتسجيل الراكب"
                                       class="w-full pr-10 pl-11 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white font-mono">
                                <button type="button" onclick="togglePasswordVisibility('cust-reg-password', 'eye-cust-reg-pwd')" aria-label="إظهار أو إخفاء كلمة المرور" class="absolute left-3 top-3 text-slate-400 hover:text-white p-1">
                                    <i id="eye-cust-reg-pwd" class="fa-solid fa-eye" aria-hidden="true"></i>
                                </button>
                            </div>
                        </div>

                        <button type="submit" id="btn-cust-reg-submit" aria-label="إكمال تسجيل حساب الراكب والمتابعة"
                                class="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-black rounded-2xl text-base transition flex items-center justify-center gap-2 shadow-xl shadow-blue-600/30 cursor-pointer">
                            <i class="fa-solid fa-user-plus" aria-hidden="true"></i>
                            <span>إكمال تسجيل حساب الراكب والمتابعة 🚀</span>
                        </button>
                    </div>
                </form>

                <!-- Direct Login Form for Existing Passengers -->
                <form id="cust-login-form" onsubmit="handleCustomerLogin(event)" class="space-y-4" style="display: none;">
                    <div class="text-right border-b border-slate-800 pb-3">
                        <h2 class="text-base font-black text-white flex items-center gap-2">
                            <span>🔑</span>
                            <span>تسجيل دخول الراكب ببياناته المسجلة</span>
                        </h2>
                        <p class="text-xs text-slate-300 mt-1">أدخل رقم الهاتف وكلمة المرور المسجلة سابقاً للدخول:</p>
                    </div>

                    <div>
                        <label for="cust-login-identifier" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">رقم الهاتف <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <i class="fa-solid fa-phone absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                            <input type="text" id="cust-login-identifier" required placeholder="07701234567" dir="ltr" aria-label="رقم الهاتف للراكب"
                                   class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white font-mono text-left">
                        </div>
                    </div>

                    <div>
                        <label for="cust-login-password" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">كلمة المرور (الباسوورد) <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <i class="fa-solid fa-lock absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                            <input type="password" id="cust-login-password" required placeholder="••••••••" aria-label="كلمة المرور للدخول"
                                   class="w-full pr-10 pl-11 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white font-mono">
                            <button type="button" onclick="togglePasswordVisibility('cust-login-password', 'eye-cust-log-pwd')" aria-label="إظهار أو إخفاء كلمة المرور" class="absolute left-3 top-3 text-slate-400 hover:text-white p-1">
                                <i id="eye-cust-log-pwd" class="fa-solid fa-eye" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>

                    <div class="flex items-center justify-between text-xs">
                        <a href="https://wa.me/9647706204066?text=%D9%86%D8%B3%D9%8A%D8%AA%20%D9%83%D9%84%D9%85%D8%A9%20%D8%A7%D9%84%D9%85%D8%B1%D9%88%D8%B1%20%D9%84%D8%AD%D8%B3%D8%A7%D8%A8%20%D8%A7%D9%84%D8%B1%D8%A7%D9%83%D8%A8" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:text-blue-300 font-bold">
                            نسيت كلمة المرور؟ (تواصل واتساب)
                        </a>
                    </div>

                    <button type="submit" id="btn-cust-login-submit" aria-label="تسجيل الدخول للراكب"
                            class="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-black rounded-2xl text-base transition flex items-center justify-center gap-2 shadow-xl shadow-blue-600/30 cursor-pointer">
                        <i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i>
                        <span>تسجيل الدخول للراكب 🚀</span>
                    </button>
                </form>

            </div>
        </section>

        <!-- ================================================================= -->
        <!-- TAB 2: DRIVER REGISTRATION (WHATSAPP OTP VERIFIED)                -->
        <!-- ================================================================= -->
        <section id="driver-section" style="display: ${preselectedRole === 'Driver' ? 'block' : 'none'};" aria-label="قسم السائقين">
            
            <div class="glass-card rounded-3xl p-5 sm:p-8 border border-amber-500/30 shadow-2xl space-y-6 glow-amber">
                
                <!-- Driver Sub-mode switchers -->
                <div class="flex items-center justify-between bg-slate-900/90 p-2 rounded-2xl border border-slate-800">
                    <button type="button" id="sub-btn-driver-reg" onclick="switchDriverMode('register')" aria-label="استمارة تسجيل سائق جديد"
                            class="px-4 py-2 rounded-xl text-xs font-black bg-amber-500 text-slate-950 transition shadow-md">
                        استمارة تسجيل سائق جديد 🚕
                    </button>
                    <button type="button" id="sub-btn-driver-login" onclick="switchDriverMode('login')" aria-label="تسجيل دخول سائق مسجل"
                            class="px-4 py-2 rounded-xl text-xs font-black text-slate-300 hover:text-white transition">
                        لديك حساب بالفعل؟ تسجيل الدخول 🔑
                    </button>
                </div>

                <div id="driver-reg-alert" style="display: none;" role="alert" class="p-3 bg-rose-500/20 border border-rose-500/50 rounded-xl text-xs font-bold text-rose-300 text-right"></div>

                <!-- Registration Form for Drivers -->
                <form id="driver-register-form" onsubmit="handleDriverRegister(event)" class="space-y-4">
                    <div class="text-right border-b border-slate-800 pb-3">
                        <h2 class="text-base font-black text-white flex items-center gap-2">
                            <span>🚖</span>
                            <span>استمارة تسجيل السائق الجديد</span>
                        </h2>
                        <p class="text-xs text-slate-300 mt-1">تحقق من رقم هاتفك عبر واتساب أولاً لإكمال تسجيل حساب الكابتن:</p>
                    </div>

                    <!-- Step 1: Iraqi Phone & WhatsApp OTP -->
                    <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-3.5 space-y-3">
                        <div class="flex items-center justify-between">
                            <span id="driver-step1-badge" class="px-2.5 py-0.5 bg-amber-500/20 text-amber-300 text-[11px] font-bold rounded-full border border-amber-500/30">خطوة 1: تأكيد الهاتف عبر واتساب</span>
                            <label for="driver-reg-phone" class="text-xs text-slate-300 font-bold">رقم الهاتف العراقي <span class="text-rose-400">*</span></label>
                        </div>
                        <div class="flex items-center gap-2">
                            <div class="flex items-center gap-1.5 px-3 py-3 bg-slate-800 border border-slate-700 rounded-xl text-xs font-black text-amber-400 select-none">
                                <span>🇮🇶</span>
                                <span dir="ltr">+964</span>
                            </div>
                            <div class="relative flex-1">
                                <i class="fa-brands fa-whatsapp absolute right-3.5 top-3.5 text-emerald-400 text-base pointer-events-none" aria-hidden="true"></i>
                                <input type="tel" id="driver-reg-phone" required placeholder="07706204066" dir="ltr" aria-label="رقم الهاتف العراقي للسائق"
                                       oninput="this.value = normalizeArabicDigits(this.value)"
                                       class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white placeholder-slate-400 font-mono text-left">
                            </div>
                        </div>

                        <!-- Button to send WhatsApp OTP -->
                        <div id="driver-send-otp-wrap">
                            <button type="button" id="btn-send-driver-otp" onclick="handleSendDriverWhatsappOtp(false)" aria-label="إرسال رمز التحقق عبر واتساب"
                                    class="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20 cursor-pointer">
                                <i class="fa-brands fa-whatsapp text-base" aria-hidden="true"></i>
                                <span>المتابعة وإرسال رمز التحقق عبر واتساب 📲</span>
                            </button>
                        </div>

                        <!-- OTP Input Box -->
                        <div id="driver-otp-box" style="display: none;" class="space-y-2.5 pt-2 border-t border-slate-800">
                            <div class="p-2.5 bg-emerald-950/60 border border-emerald-500/40 rounded-xl text-xs text-emerald-300 font-bold flex items-center gap-2 text-right">
                                <i class="fa-brands fa-whatsapp text-emerald-400 text-base flex-shrink-0" aria-hidden="true"></i>
                                <span>تابع الواتساب ليصلك رمز التحقق 💬</span>
                            </div>

                            <div>
                                <label for="driver-reg-otp" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">أدخل رمز التحقق (6 أرقام) <span class="text-rose-400">*</span></label>
                                <div class="relative">
                                    <i class="fa-solid fa-key absolute right-3.5 top-3 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                                    <input type="text" id="driver-reg-otp" maxlength="6" placeholder="------" dir="ltr" aria-label="رمز التحقق المكون من 6 أرقام"
                                           oninput="this.value = normalizeArabicDigits(this.value)"
                                           class="w-full pr-10 pl-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-base tracking-widest text-center focus:outline-none focus:ring-2 focus:ring-emerald-500 text-emerald-400 font-mono font-black">
                                </div>
                            </div>

                            <div class="flex items-center gap-2 pt-1">
                                <button type="button" id="btn-verify-driver-otp" onclick="handleVerifyDriverWhatsappOtp()" aria-label="تأكيد رمز التحقق"
                                        class="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs transition flex items-center justify-center gap-1.5 cursor-pointer">
                                    <i class="fa-solid fa-check-circle" aria-hidden="true"></i>
                                    <span>تأكيد رمز التحقق ✅</span>
                                </button>
                                <button type="button" id="btn-resend-driver-otp" onclick="handleSendDriverWhatsappOtp(true)" aria-label="إعادة إرسال رمز التحقق"
                                        class="px-3 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition cursor-pointer">
                                    إعادة إرسال 🔄
                                </button>
                            </div>
                        </div>

                        <!-- Verified Badge -->
                        <div id="driver-verified-badge" style="display: none;" class="p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center justify-between text-xs text-emerald-400 font-bold">
                            <span class="flex items-center gap-1.5">
                                <i class="fa-solid fa-circle-check text-emerald-400 text-sm" aria-hidden="true"></i>
                                <span>تم تأكيد رقم الهاتف بنجاح عبر واتساب</span>
                            </span>
                            <button type="button" onclick="resetDriverPhoneVerification()" class="text-[11px] text-slate-400 hover:text-rose-400 underline cursor-pointer">
                                تغيير الرقم
                            </button>
                        </div>
                    </div>

                    <!-- Step 2: Driver Details (Unlocked after OTP) -->
                    <div id="driver-details-section" style="display: none;" class="space-y-4 pt-2 border-t border-slate-800 animate-fadeIn">
                        <div>
                            <label for="driver-reg-name" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">الاسم الكامل للكابتن <span class="text-rose-400">*</span></label>
                            <div class="relative">
                                <i class="fa-solid fa-id-card absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                                <input type="text" id="driver-reg-name" required placeholder="مثال: علي محمد حسن" aria-label="الاسم الكامل للكابتن"
                                       class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white">
                            </div>
                        </div>

                        <div>
                            <label for="driver-reg-license" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">رقم إجازة السوق <span class="text-rose-400">*</span></label>
                            <div class="relative">
                                <i class="fa-solid fa-address-card absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                                <input type="text" id="driver-reg-license" required placeholder="مثال: IQ-NJF-4819" aria-label="رقم إجازة السوق"
                                       class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white font-mono">
                            </div>
                        </div>

                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label for="driver-reg-vehicle" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">نوع وموديل المركبة</label>
                                <input type="text" id="driver-reg-vehicle" placeholder="مثال: تويوتا كورولا 2021" aria-label="نوع وموديل المركبة"
                                       class="w-full px-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white">
                            </div>
                            <div>
                                <label for="driver-reg-plate" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">رقم اللوحة</label>
                                <input type="text" id="driver-reg-plate" placeholder="مثال: النجف 12345 أ" aria-label="رقم لوحة المركبة"
                                       class="w-full px-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white">
                            </div>
                        </div>

                        <div>
                            <label for="driver-reg-password" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">كلمة المرور (الباسوورد) <span class="text-rose-400">*</span></label>
                            <div class="relative">
                                <i class="fa-solid fa-lock absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none" aria-hidden="true"></i>
                                <input type="password" id="driver-reg-password" required minlength="4" placeholder="••••••••" aria-label="كلمة المرور للسائق"
                                       class="w-full pr-10 pl-11 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white font-mono">
                                <button type="button" onclick="togglePasswordVisibility('driver-reg-password', 'eye-drv-reg-pwd')" aria-label="إظهار أو إخفاء كلمة المرور" class="absolute left-3 top-3 text-slate-400 hover:text-white p-1">
                                    <i id="eye-drv-reg-pwd" class="fa-solid fa-eye" aria-hidden="true"></i>
                                </button>
                            </div>
                        </div>

                        <button type="submit" id="btn-driver-reg-submit" aria-label="إكمال تسجيل حساب السائق والمتابعة"
                                class="w-full py-4 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-2xl text-base transition flex items-center justify-center gap-2 shadow-xl shadow-amber-500/25 cursor-pointer">
                            <i class="fa-solid fa-taxi text-lg" aria-hidden="true"></i>
                            <span>إكمال تسجيل حساب السائق والمتابعة 🚀</span>
                        </button>
                    </div>
                </form>

                <!-- Driver Direct Login Form -->
                <form id="driver-login-form" onsubmit="handleCaptainLogin(event)" class="space-y-4" style="display: none;">
                    <div class="text-right border-b border-slate-800 pb-3">
                        <h2 class="text-base font-black text-white flex items-center gap-2">
                            <span>🔑</span>
                            <span>تسجيل دخول السائق (الكابتن)</span>
                        </h2>
                        <p class="text-xs text-slate-300 mt-1">أدخل رقم الهاتف وكلمة المرور المسجلة للدخول:</p>
                    </div>

                    <div>
                        <label for="login-driver-identifier" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">رقم الهاتف <span class="text-rose-400">*</span></label>
                        <input type="text" id="login-driver-identifier" required placeholder="07706204066" dir="ltr" aria-label="رقم الهاتف للكابتن"
                               oninput="this.value = normalizeArabicDigits(this.value)"
                               class="w-full px-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white font-mono text-left">
                    </div>

                    <div>
                        <label for="login-driver-password" class="block text-xs text-slate-300 font-bold mb-1.5 text-right">كلمة المرور <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <input type="password" id="login-driver-password" required placeholder="••••••••" aria-label="كلمة المرور للكابتن"
                                   class="w-full pr-4 pl-11 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white font-mono text-left">
                            <button type="button" onclick="togglePasswordVisibility('login-driver-password', 'eye-login-drv-pwd')" aria-label="إظهار أو إخفاء كلمة المرور" class="absolute left-3 top-3 text-slate-400 hover:text-white p-1">
                                <i id="eye-login-drv-pwd" class="fa-solid fa-eye" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>

                    <button type="submit" id="btn-login-driver-submit" aria-label="تسجيل الدخول للكابتن"
                            class="w-full py-4 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-2xl text-base transition flex items-center justify-center gap-2 shadow-xl shadow-amber-500/25 cursor-pointer">
                        <i class="fa-solid fa-right-to-bracket text-lg" aria-hidden="true"></i>
                        <span>تسجيل الدخول للكابتن 🚀</span>
                    </button>
                </form>

            </div>

        </section>

        <!-- Loading Overlay -->
        <div id="loading" style="display: none;" role="status" aria-live="polite" class="text-center py-4 bg-slate-900/90 rounded-2xl border border-slate-800">
            <div class="inline-block w-8 h-8 border-4 border-amber-400 border-t-transparent rounded-full animate-spin" aria-hidden="true"></div>
            <p class="text-xs text-slate-300 mt-2 font-bold" id="loading-text">جاري معالجة طلبك والاتصال بالخادم...</p>
        </div>

        <!-- Footer -->
        <footer class="text-center text-xs text-slate-400 py-2">
            <p>© 2026 توصيله (Tawseela IQ) - جميع الحقوق محفوظة لخدمات النقل الذكي بالنجف الأشرف</p>
        </footer>

    </main>

    <!-- Client-side Logic -->
    <script>
        // Dynamic Mapbox Loader on Demand
        window.loadMapboxDynamically = function() {
            return new Promise(function(resolve) {
                if (window.mapboxgl) return resolve();
                var css = document.createElement('link');
                css.rel = 'stylesheet';
                css.href = 'https://api.mapbox.com/mapbox-gl-js/v3.2.0/mapbox-gl.css';
                document.head.appendChild(css);

                var script = document.createElement('script');
                script.src = 'https://api.mapbox.com/mapbox-gl-js/v3.2.0/mapbox-gl.js';
                script.onload = function() {
                    var rtlScript = document.createElement('script');
                    rtlScript.src = 'https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js';
                    rtlScript.onload = function() { resolve(); };
                    rtlScript.onerror = function() { resolve(); };
                    document.head.appendChild(rtlScript);
                };
                script.onerror = function() { resolve(); };
                document.head.appendChild(script);
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

        // 1. CAPTAIN LOGIN
        async function handleCaptainLogin(event) {
            event.preventDefault();
            const identifier = document.getElementById('login-driver-identifier').value.trim();
            const password = document.getElementById('login-driver-password').value;
            const submitBtn = document.getElementById('btn-login-driver-submit');

            if (!identifier || !password) {
                alert('يرجى إدخال رقم الهاتف وكلمة المرور المحددة لك في الداشبورد');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري التحقق من بيانات الكابتن...</span>';

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ identifier, password, role: 'Driver' })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    persistSession(data);
                    const userRole = data.role || 'Driver';
                    const targetHash = userRole === 'Customer' ? '/customer' : '/driver';
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>تم الدخول بنجاح! جاري فتح شاشة الكابتن...</span>';
                    setTimeout(function() {
                        openAppView(data.token, data.userId, data.role || 'Driver', data.fullName || 'كابتن توصيله');
                    }, 250);
                } else {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i><span>تسجيل الدخول للكابتن 🚀</span>';
                    alert(data.error || 'عذراً، فشل تسجيل الدخول. يرجى التأكد من رقم الهاتف وكلمة المرور المعتمدة من الداشبورد.');
                }
            } catch (err) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i><span>تسجيل الدخول للكابتن 🚀</span>';
                alert('حدث خطأ في الاتصال بالخادم. يرجى المحاولة مرة أخرى.');
            }
        }

        // 2. PASSENGER REGISTRATION & WHATSAPP OTP WORKFLOW
        window.__isPhoneVerified = false;
        window.__verifiedOtpCode = '';

        async function handleSendWhatsappOtp(isResend) {
            const phoneInput = document.getElementById('cust-reg-phone');
            const phone = (phoneInput.value || '').trim();
            const sendBtn = document.getElementById(isResend ? 'btn-resend-whatsapp-otp' : 'btn-send-whatsapp-otp');
            const alertBox = document.getElementById('cust-reg-alert');
            const otpBox = document.getElementById('cust-otp-box');

            if (alertBox) alertBox.style.display = 'none';

            const normalized = normalizeArabicDigits(phone);
            const digits = normalized.replace(/[^0-9]/g, '');
            if (!digits || digits.length < 9) {
                alert('يرجى إدخال رقم هاتف عراقي صالح (مثال: 07801234567 أو 07701234567)');
                phoneInput.focus();
                return;
            }

            const originalBtnHtml = sendBtn.innerHTML;
            sendBtn.disabled = true;
            sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري الإرسال عبر واتساب...</span>';

            try {
                const res = await fetch('/api/auth/send-whatsapp-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber: normalized })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    otpBox.style.display = 'block';
                    phoneInput.readOnly = true;
                    const otpInput = document.getElementById('cust-reg-otp');
                    if (otpInput) {
                        otpInput.value = '';
                        otpInput.focus();
                    }
                    if (isResend) {
                        alert('تمت إعادة إرسال رمز التحقق عبر واتساب إلى ' + phone);
                    }
                } else {
                    if (alertBox) {
                        alertBox.innerText = data.error || 'تعذر إرسال رمز التحقق، يرجى المحاولة لاحقاً.';
                        alertBox.style.display = 'block';
                    }
                    alert(data.error || 'تعذر إرسال رمز التحقق');
                }
            } catch (err) {
                alert('حدث خطأ في الاتصال بالخادم لإرسال رمز التحقق.');
            } finally {
                sendBtn.disabled = false;
                sendBtn.innerHTML = originalBtnHtml;
            }
        }

        async function handleVerifyWhatsappOtp() {
            const phone = normalizeArabicDigits((document.getElementById('cust-reg-phone').value || '').trim());
            const otpInput = document.getElementById('cust-reg-otp');
            const code = normalizeArabicDigits((otpInput.value || '').trim());
            const verifyBtn = document.getElementById('btn-verify-whatsapp-otp');
            const alertBox = document.getElementById('cust-reg-alert');
            const otpBox = document.getElementById('cust-otp-box');
            const sendWrap = document.getElementById('cust-send-otp-wrap');
            const verifiedBadge = document.getElementById('cust-verified-badge');
            const detailsSection = document.getElementById('cust-details-section');

            if (alertBox) alertBox.style.display = 'none';

            if (!code || code.length < 4) {
                alert('يرجى إدخال رمز التحقق المكون من 6 أرقام');
                otpInput.focus();
                return;
            }

            const originalBtnHtml = verifyBtn.innerHTML;
            verifyBtn.disabled = true;
            verifyBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري التحقق...</span>';

            try {
                const res = await fetch('/api/auth/verify-whatsapp-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber: phone, code: code })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    window.__isPhoneVerified = true;
                    window.__verifiedOtpCode = code;

                    // Hide OTP input box and initial send button
                    if (otpBox) otpBox.style.display = 'none';
                    if (sendWrap) sendWrap.style.display = 'none';

                    // Show verified badge
                    if (verifiedBadge) verifiedBadge.style.display = 'flex';

                    // Unlock Step 2 Form details
                    if (detailsSection) detailsSection.style.display = 'block';

                    const nameInput = document.getElementById('cust-reg-name');
                    if (nameInput) nameInput.focus();
                } else {
                    if (alertBox) {
                        alertBox.innerText = data.error || 'رمز التحقق غير صحيح، يرجى التأكد وإعادة المحاولة.';
                        alertBox.style.display = 'block';
                    }
                    alert(data.error || 'رمز التحقق غير صحيح');
                }
            } catch (err) {
                alert('حدث خطأ في الاتصال بالخادم للتحقق من الرمز.');
            } finally {
                verifyBtn.disabled = false;
                verifyBtn.innerHTML = originalBtnHtml;
            }
        }

        function resetPhoneVerification() {
            window.__isPhoneVerified = false;
            window.__verifiedOtpCode = '';

            const phoneInput = document.getElementById('cust-reg-phone');
            if (phoneInput) {
                phoneInput.readOnly = false;
                phoneInput.focus();
            }

            const otpBox = document.getElementById('cust-otp-box');
            const sendWrap = document.getElementById('cust-send-otp-wrap');
            const verifiedBadge = document.getElementById('cust-verified-badge');
            const detailsSection = document.getElementById('cust-details-section');
            const alertBox = document.getElementById('cust-reg-alert');

            if (otpBox) otpBox.style.display = 'none';
            if (sendWrap) sendWrap.style.display = 'block';
            if (verifiedBadge) verifiedBadge.style.display = 'none';
            if (detailsSection) detailsSection.style.display = 'none';
            if (alertBox) alertBox.style.display = 'none';
        }

        async function handleCustomerRegister(event) {
            event.preventDefault();
            const alertBox = document.getElementById('cust-reg-alert');
            if (alertBox) alertBox.style.display = 'none';

            if (!window.__isPhoneVerified) {
                alert('يرجى التحقق من رقم الهاتف عبر واتساب أولاً للمتابعة');
                return;
            }

            const name = document.getElementById('cust-reg-name').value.trim();
            const phone = normalizeArabicDigits(document.getElementById('cust-reg-phone').value.trim());
            const route = document.getElementById('cust-reg-route').value.trim();
            const address = document.getElementById('cust-reg-address').value.trim();
            const password = document.getElementById('cust-reg-password').value;
            const submitBtn = document.getElementById('btn-cust-reg-submit');

            if (!name || !phone || !route || !address || !password) {
                alert('يرجى ملء جميع الحقول المطلوبة');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري إكمال التسجيل...</span>';

            const pickupLat = document.getElementById('cust-pickup-lat')?.value || '32.0200';
            const pickupLon = document.getElementById('cust-pickup-lon')?.value || '44.3200';
            const dropoffLat = document.getElementById('cust-dropoff-lat')?.value || '32.0321';
            const dropoffLon = document.getElementById('cust-dropoff-lon')?.value || '44.3725';

            try {
                const res = await fetch('/api/auth/complete-passenger-registration', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fullName: name,
                        phoneNumber: phone,
                        route: route,
                        address: address,
                        password: password,
                        otpCode: window.__verifiedOtpCode || '',
                        pickupLat: parseFloat(pickupLat) || 32.0200,
                        pickupLon: parseFloat(pickupLon) || 44.3200,
                        dropoffLat: parseFloat(dropoffLat) || 32.0321,
                        dropoffLon: parseFloat(dropoffLon) || 44.3725
                    })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    persistSession(data);
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>تم التسجيل بنجاح! جاري فتح شاشة الراكب...</span>';
                    setTimeout(function() {
                        openAppView(data.token, data.userId, 'Customer', data.fullName || 'راكب توصيله');
                    }, 250);
                } else {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i><span>إكمال تسجيل حساب الراكب والمتابعة 🚀</span>';
                    if (alertBox) {
                        alertBox.innerText = data.error || 'عذراً، فشل تسجيل الحساب.';
                        alertBox.style.display = 'block';
                    }
                    alert(data.error || 'عذراً، فشل تسجيل الحساب.');
                }
            } catch (err) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i><span>إكمال تسجيل حساب الراكب والمتابعة 🚀</span>';
                alert('حدث خطأ في الاتصال بالخادم. يرجى التأكد من اتصال الإنترنت.');
            }
        }

        // DRIVER REGISTRATION & WHATSAPP OTP WORKFLOW
        window.__isDriverPhoneVerified = false;
        window.__verifiedDriverOtpCode = '';

        async function handleSendDriverWhatsappOtp(isResend) {
            const phoneInput = document.getElementById('driver-reg-phone');
            const phone = (phoneInput.value || '').trim();
            const sendBtn = document.getElementById(isResend ? 'btn-resend-driver-otp' : 'btn-send-driver-otp');
            const alertBox = document.getElementById('driver-reg-alert');
            const otpBox = document.getElementById('driver-otp-box');

            if (alertBox) alertBox.style.display = 'none';

            const normalized = normalizeArabicDigits(phone);
            const digits = normalized.replace(/[^0-9]/g, '');
            if (!digits || digits.length < 9) {
                alert('يرجى إدخال رقم هاتف عراقي صالح (مثال: 07801234567 أو 07701234567)');
                phoneInput.focus();
                return;
            }

            const originalBtnHtml = sendBtn.innerHTML;
            sendBtn.disabled = true;
            sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري الإرسال عبر واتساب...</span>';

            try {
                const res = await fetch('/api/auth/send-whatsapp-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber: normalized })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    otpBox.style.display = 'block';
                    phoneInput.readOnly = true;
                    const otpInput = document.getElementById('driver-reg-otp');
                    if (otpInput) {
                        otpInput.value = '';
                        otpInput.focus();
                    }
                    if (isResend) {
                        alert('تمت إعادة إرسال رمز التحقق عبر واتساب إلى ' + phone);
                    }
                } else {
                    if (alertBox) {
                        alertBox.innerText = data.error || 'تعذر إرسال رمز التحقق، يرجى المحاولة لاحقاً.';
                        alertBox.style.display = 'block';
                    }
                    alert(data.error || 'تعذر إرسال رمز التحقق');
                }
            } catch (err) {
                alert('حدث خطأ في الاتصال بالخادم لإرسال رمز التحقق.');
            } finally {
                sendBtn.disabled = false;
                sendBtn.innerHTML = originalBtnHtml;
            }
        }

        async function handleVerifyDriverWhatsappOtp() {
            const phone = normalizeArabicDigits((document.getElementById('driver-reg-phone').value || '').trim());
            const otpInput = document.getElementById('driver-reg-otp');
            const code = normalizeArabicDigits((otpInput.value || '').trim());
            const verifyBtn = document.getElementById('btn-verify-driver-otp');
            const alertBox = document.getElementById('driver-reg-alert');
            const otpBox = document.getElementById('driver-otp-box');
            const sendWrap = document.getElementById('driver-send-otp-wrap');
            const verifiedBadge = document.getElementById('driver-verified-badge');
            const detailsSection = document.getElementById('driver-details-section');

            if (alertBox) alertBox.style.display = 'none';

            if (!code || code.length < 4) {
                alert('يرجى إدخال رمز التحقق المكون من 6 أرقام');
                otpInput.focus();
                return;
            }

            const originalBtnHtml = verifyBtn.innerHTML;
            verifyBtn.disabled = true;
            verifyBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري التحقق...</span>';

            try {
                const res = await fetch('/api/auth/verify-whatsapp-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber: phone, code: code })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    window.__isDriverPhoneVerified = true;
                    window.__verifiedDriverOtpCode = code;

                    if (otpBox) otpBox.style.display = 'none';
                    if (sendWrap) sendWrap.style.display = 'none';
                    if (verifiedBadge) verifiedBadge.style.display = 'flex';
                    if (detailsSection) detailsSection.style.display = 'block';

                    const nameInput = document.getElementById('driver-reg-name');
                    if (nameInput) nameInput.focus();
                } else {
                    if (alertBox) {
                        alertBox.innerText = data.error || 'رمز التحقق غير صحيح، يرجى التأكد وإعادة المحاولة.';
                        alertBox.style.display = 'block';
                    }
                    alert(data.error || 'رمز التحقق غير صحيح');
                }
            } catch (err) {
                alert('حدث خطأ في الاتصال بالخادم للتحقق من الرمز.');
            } finally {
                verifyBtn.disabled = false;
                verifyBtn.innerHTML = originalBtnHtml;
            }
        }

        function resetDriverPhoneVerification() {
            window.__isDriverPhoneVerified = false;
            window.__verifiedDriverOtpCode = '';

            const phoneInput = document.getElementById('driver-reg-phone');
            if (phoneInput) {
                phoneInput.readOnly = false;
                phoneInput.focus();
            }

            const otpBox = document.getElementById('driver-otp-box');
            const sendWrap = document.getElementById('driver-send-otp-wrap');
            const verifiedBadge = document.getElementById('driver-verified-badge');
            const detailsSection = document.getElementById('driver-details-section');
            const alertBox = document.getElementById('driver-reg-alert');

            if (otpBox) otpBox.style.display = 'none';
            if (sendWrap) sendWrap.style.display = 'block';
            if (verifiedBadge) verifiedBadge.style.display = 'none';
            if (detailsSection) detailsSection.style.display = 'none';
            if (alertBox) alertBox.style.display = 'none';
        }

        async function handleDriverRegister(event) {
            event.preventDefault();
            const alertBox = document.getElementById('driver-reg-alert');
            if (alertBox) alertBox.style.display = 'none';

            if (!window.__isDriverPhoneVerified) {
                alert('يرجى التحقق من رقم الهاتف عبر واتساب أولاً للمتابعة');
                return;
            }

            const name = document.getElementById('driver-reg-name').value.trim();
            const phone = normalizeArabicDigits(document.getElementById('driver-reg-phone').value.trim());
            const license = document.getElementById('driver-reg-license').value.trim();
            const vehicle = (document.getElementById('driver-reg-vehicle')?.value || '').trim();
            const plate = (document.getElementById('driver-reg-plate')?.value || '').trim();
            const password = document.getElementById('driver-reg-password').value;
            const submitBtn = document.getElementById('btn-driver-reg-submit');

            if (!name || !phone || !password) {
                alert('يرجى ملء جميع الحقول المطلوبة');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري إكمال تسجيل السائق...</span>';

            try {
                const res = await fetch('/api/auth/complete-driver-registration', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fullName: name,
                        phoneNumber: phone,
                        licenseNumber: license,
                        vehicleMake: vehicle,
                        vehiclePlate: plate,
                        password: password,
                        otpCode: window.__verifiedDriverOtpCode || ''
                    })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    persistSession(data);
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>تم التسجيل بنجاح! جاري فتح شاشة الكابتن...</span>';
                    setTimeout(function() {
                        openAppView(data.token, data.userId, 'Driver', data.fullName || 'كابتن توصيله');
                    }, 250);
                } else {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fa-solid fa-taxi"></i><span>إكمال تسجيل حساب السائق والمتابعة 🚀</span>';
                    if (alertBox) {
                        alertBox.innerText = data.error || 'عذراً، فشل تسجيل الحساب.';
                        alertBox.style.display = 'block';
                    }
                    alert(data.error || 'عذراً، فشل تسجيل الحساب.');
                }
            } catch (err) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-taxi"></i><span>إكمال تسجيل حساب السائق والمتابعة 🚀</span>';
                alert('حدث خطأ في الاتصال بالخادم. يرجى التأكد من اتصال الإنترنت.');
            }
        }

        // 3. PASSENGER LOGIN
        async function handleCustomerLogin(event) {
            event.preventDefault();
            const identifier = document.getElementById('cust-login-identifier').value.trim();
            const password = document.getElementById('cust-login-password').value;
            const submitBtn = document.getElementById('btn-cust-login-submit');

            if (!identifier || !password) {
                alert('يرجى إدخال رقم الهاتف وكلمة المرور');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري تسجيل الدخول...</span>';

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ identifier, password, role: 'Customer' })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    persistSession(data);
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>تم الدخول بنجاح! جاري فتح شاشة الراكب...</span>';
                    setTimeout(function() {
                        openAppView(data.token, data.userId, 'Customer', data.fullName || 'راكب توصيله');
                    }, 250);
                } else {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i><span>تسجيل الدخول للراكب 🚀</span>';
                    alert(data.error || 'فشل تسجيل الدخول. يرجى التأكد من صحة رقم الهاتف وكلمة المرور.');
                }
            } catch (err) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i><span>تسجيل الدخول للراكب 🚀</span>';
                alert('حدث خطأ في الاتصال بالخادم.');
            }
        }

        // 4. MAPBOX INIT FOR PASSENGER (Restricted to Najaf [44.32, 32.02])
        var passengerMap = null;
        var pickupMarker = null;
        var dropoffMarker = null;
        var currentPinMode = 'pickup'; // 'pickup' or 'dropoff'

        function setMapPinMode(mode) {
            currentPinMode = mode;
            var btnPickup = document.getElementById('btn-mode-pickup');
            var btnDropoff = document.getElementById('btn-mode-dropoff');
            if (btnPickup && btnDropoff) {
                if (mode === 'pickup') {
                    btnPickup.className = 'py-2 px-3 rounded-xl font-bold flex items-center justify-center gap-1.5 border border-emerald-500 bg-emerald-500/20 text-emerald-300 cursor-pointer transition';
                    btnDropoff.className = 'py-2 px-3 rounded-xl font-bold flex items-center justify-center gap-1.5 border border-slate-700 bg-slate-800 text-slate-400 hover:text-white cursor-pointer transition';
                } else {
                    btnPickup.className = 'py-2 px-3 rounded-xl font-bold flex items-center justify-center gap-1.5 border border-slate-700 bg-slate-800 text-slate-400 hover:text-white cursor-pointer transition';
                    btnDropoff.className = 'py-2 px-3 rounded-xl font-bold flex items-center justify-center gap-1.5 border border-rose-500 bg-rose-500/20 text-rose-300 cursor-pointer transition';
                }
            }
        }

        async function reverseGeocodeLocation(lng, lat, target) {
            try {
                var token = ('pk.' + 'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9' + '._J6DYjYBDhsdcidErQrblA');
                var res = await fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/' + lng + ',' + lat + '.json?country=iq&language=ar&access_token=' + token);
                var data = await res.json();
                var pName = (data.features && data.features.length > 0) ? (data.features[0].place_name_ar || data.features[0].place_name) : '';
                if (!pName) {
                    var osm = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng);
                    var osmData = await osm.json();
                    if (osmData && osmData.display_name) pName = osmData.display_name;
                }
                if (pName) {
                    if (target === 'pickup') {
                        var aInp = document.getElementById('cust-reg-address');
                        if (aInp) aInp.value = pName;
                    } else if (target === 'dropoff') {
                        var rInp = document.getElementById('cust-reg-route');
                        if (rInp) rInp.value = pName;
                    }
                }
            } catch (_) {}
        }

        function updatePickupPoint(lng, lat, doReverse) {
            document.getElementById('cust-pickup-lat').value = Number(lat).toFixed(6);
            document.getElementById('cust-pickup-lon').value = Number(lng).toFixed(6);
            if (!pickupMarker && passengerMap) {
                pickupMarker = new mapboxgl.Marker({ color: '#10b981', draggable: true })
                    .setLngLat([lng, lat])
                    .addTo(passengerMap);
                pickupMarker.on('dragend', function() {
                    var pos = pickupMarker.getLngLat();
                    updatePickupPoint(pos.lng, pos.lat, true);
                });
            } else if (pickupMarker) {
                pickupMarker.setLngLat([lng, lat]);
            }
            if (doReverse) reverseGeocodeLocation(lng, lat, 'pickup');
        }

        function updateDropoffPoint(lng, lat, doReverse) {
            document.getElementById('cust-dropoff-lat').value = Number(lat).toFixed(6);
            document.getElementById('cust-dropoff-lon').value = Number(lng).toFixed(6);
            if (!dropoffMarker && passengerMap) {
                dropoffMarker = new mapboxgl.Marker({ color: '#ef4444', draggable: true })
                    .setLngLat([lng, lat])
                    .addTo(passengerMap);
                dropoffMarker.on('dragend', function() {
                    var pos = dropoffMarker.getLngLat();
                    updateDropoffPoint(pos.lng, pos.lat, true);
                });
            } else if (dropoffMarker) {
                dropoffMarker.setLngLat([lng, lat]);
            }
            if (doReverse) reverseGeocodeLocation(lng, lat, 'dropoff');
        }

        function getCurrentGpsLocation() {
            var btn = document.getElementById('btn-cust-gps');
            if (!navigator.geolocation) {
                alert('خاصية تحديد الموقع الجغرافي (GPS) غير مدعومة في متصفحك.');
                return;
            }
            var originalText = btn ? btn.innerHTML : '';
            if (btn) btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري التحديد...</span>';

            navigator.geolocation.getCurrentPosition(function(pos) {
                if (btn) btn.innerHTML = originalText;
                var lat = pos.coords.latitude;
                var lng = pos.coords.longitude;
                // If coordinates within or near Najaf
                if (passengerMap) {
                    passengerMap.flyTo({ center: [lng, lat], zoom: 15 });
                }
                if (currentPinMode === 'pickup') {
                    updatePickupPoint(lng, lat, true);
                } else {
                    updateDropoffPoint(lng, lat, true);
                }
            }, function(err) {
                if (btn) btn.innerHTML = originalText;
                alert('تعذر الوصول إلى موقعك الحالي. يرجى تفعيل إذن الموقع الجغرافي.');
            }, { enableHighAccuracy: true, timeout: 10000 });
        }

        async function initPassengerMapbox() {
            if (passengerMap || !document.getElementById('passenger-map')) return;
            try {
                if (!window.mapboxgl) {
                    await window.loadMapboxDynamically();
                }
                if (!window.mapboxgl) return;
                mapboxgl.accessToken = ('pk.' + 'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9' + '._J6DYjYBDhsdcidErQrblA');
                passengerMap = new mapboxgl.Map({
                    container: 'passenger-map',
                    style: 'mapbox://styles/mapbox/streets-v12',
                    center: [44.32, 32.02],
                    zoom: 13,
                    maxBounds: [[44.05, 31.75], [44.65, 32.35]]
                });

                if (typeof mapboxgl.getRTLTextPluginStatus === 'function' && mapboxgl.getRTLTextPluginStatus() === 'unavailable') {
                    mapboxgl.setRTLTextPlugin('https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js', null, true);
                }

                // Add standard navigation controls
                passengerMap.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'top-left');

                // Initialize default markers in Najaf
                passengerMap.on('load', function() {
                    updatePickupPoint(44.3200, 32.0200, false);
                    updateDropoffPoint(44.3500, 32.0300, false);
                });

                passengerMap.on('click', function(e) {
                    var lng = e.lngLat.lng;
                    var lat = e.lngLat.lat;
                    if (currentPinMode === 'pickup') {
                        updatePickupPoint(lng, lat, true);
                    } else {
                        updateDropoffPoint(lng, lat, true);
                    }
                });
            } catch (e) { console.error('Mapbox error:', e); }
        }

        // Live Geocoding Autocomplete Search for Najaf from 1st char
        var searchInput = document.getElementById('cust-map-search');
        var resultsBox = document.getElementById('cust-search-results');
        var searchTimeout = null;
        if (searchInput && resultsBox) {
            searchInput.addEventListener('input', function() {
                var query = searchInput.value.trim();
                clearTimeout(searchTimeout);
                if (query.length < 1) { resultsBox.classList.add('hidden'); return; }
                searchTimeout = setTimeout(async function() {
                    try {
                        var token = ('pk.' + 'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9' + '._J6DYjYBDhsdcidErQrblA');
                        var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(query) + '.json?proximity=44.32,32.02&bbox=44.05,31.75,44.65,32.35&country=iq&language=ar&access_token=' + token;
                        var res = await fetch(url);
                        var data = await res.json();
                        resultsBox.innerHTML = '';
                        var features = (data && data.features) ? data.features : [];

                        // Fallback to OSM Nominatim if Mapbox returns no results
                        if (features.length === 0) {
                            try {
                                var osmRes = await fetch('https://nominatim.openstreetmap.org/search?format=json&countrycodes=iq&q=' + encodeURIComponent(query + ' النجف'));
                                var osmData = await osmRes.json();
                                if (osmData && osmData.length > 0) {
                                    features = osmData.map(function(o) {
                                        return {
                                            place_name: o.display_name,
                                            place_name_ar: o.display_name,
                                            center: [parseFloat(o.lon), parseFloat(o.lat)]
                                        };
                                    });
                                }
                            } catch (_) {}
                        }

                        if (features.length > 0) {
                            resultsBox.classList.remove('hidden');
                            features.forEach(function(feat) {
                                var div = document.createElement('div');
                                div.className = 'px-3 py-2.5 hover:bg-slate-800 cursor-pointer text-xs border-b border-slate-800/50 flex items-center justify-between';
                                var pName = feat.place_name_ar || feat.place_name;
                                var modeBadge = currentPinMode === 'pickup' ? '<span class="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">نقطة انطلاق</span>' : '<span class="text-[10px] bg-rose-500/20 text-rose-300 px-1.5 py-0.5 rounded">نقطة توصيل</span>';
                                div.innerHTML = '<div class="flex items-center gap-2 text-right flex-1 truncate"><span class="text-amber-400">📍</span> <span class="truncate">' + pName + '</span></div>' + modeBadge;
                                div.onclick = function() {
                                    if (passengerMap) {
                                        passengerMap.flyTo({ center: feat.center, zoom: 15 });
                                    }
                                    if (currentPinMode === 'pickup') {
                                        updatePickupPoint(feat.center[0], feat.center[1], false);
                                        var aInp = document.getElementById('cust-reg-address');
                                        if (aInp) aInp.value = pName;
                                    } else {
                                        updateDropoffPoint(feat.center[0], feat.center[1], false);
                                        var rInp = document.getElementById('cust-reg-route');
                                        if (rInp) rInp.value = pName;
                                    }
                                    searchInput.value = pName;
                                    resultsBox.classList.add('hidden');
                                };
                                resultsBox.appendChild(div);
                            });
                        } else { resultsBox.classList.add('hidden'); }
                    } catch (_) { resultsBox.classList.add('hidden'); }
                }, 150);
            });
        }

        window.openAppView = function(token, userId, role, fullName) {
            var container = document.getElementById('app-view-container');
            var frame = document.getElementById('app-frame');
            if (!container || !frame) return;

            var targetHash = (role === 'Driver' || role === 'driver') ? '/driver' : '/customer';
            var targetUrl = '/app-view/#' + targetHash + '?login_token=' + encodeURIComponent(token) +
                            '&userId=' + encodeURIComponent(userId) +
                            '&role=' + encodeURIComponent(role) +
                            '&fullName=' + encodeURIComponent(fullName);

            frame.src = targetUrl;
            container.style.display = 'block';
            document.body.style.overflow = 'hidden';
        };

        function checkUserSession() {
            try {
                var token = localStorage.getItem('auth_token');
                var userId = localStorage.getItem('user_id') || 'usr-current';
                var role = localStorage.getItem('user_role') || 'Customer';
                var fullName = localStorage.getItem('user_fullname') || (role === 'Driver' ? 'كابتن توصيله' : 'راكب توصيله');

                if (token && token.length > 5) {
                    window.openAppView(token, userId, role, fullName);
                }
            } catch (_) {}
        }

        window.handleLogout = function() {
            try {
                localStorage.removeItem('auth_token');
                localStorage.removeItem('user_id');
                localStorage.removeItem('user_role');
                localStorage.removeItem('user_fullname');
                localStorage.removeItem('driver_status');
                localStorage.removeItem('flutter.auth_token');
                localStorage.removeItem('flutter.user_id');
                localStorage.removeItem('flutter.user_role');
                localStorage.removeItem('flutter.user_fullname');
                sessionStorage.clear();
            } catch (_) {}
            window.location.replace('/');
        };

        // Auto Select Tab on Load from URL (Defaults to Captain/Driver)
        (function() {
            checkUserSession();
            var urlParams = new URLSearchParams(window.location.search);
            var role = urlParams.get('role');
            if (role === 'Customer' || role === 'customer') {
                window.switchRole('Customer');
            } else {
                window.switchRole('Driver');
            }
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
