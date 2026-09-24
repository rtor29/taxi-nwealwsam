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
            res.writeHead(302, { 'Location': '/app/?error=exception' });
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>توصيله | بوابة الدخول والتسجيل الذكية - النجف الأشرف</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">
    <!-- Mapbox GL JS -->
    <link href="https://api.mapbox.com/mapbox-gl-js/v3.2.0/mapbox-gl.css" rel="stylesheet">
    <script src="https://api.mapbox.com/mapbox-gl-js/v3.2.0/mapbox-gl.js"></script>
    <script src="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js"></script>
    
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
            window.location.replace(window.location.origin + window.location.pathname + '?purge=' + Date.now());
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
                boxDrv.style.display = 'block';
                boxCust.style.display = 'none';
            } else {
                btnCust.className = 'py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer tab-btn-active-customer glow-blue';
                btnDrv.className = 'py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer tab-btn-inactive';
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
                if (btnLog) btnLog.className = 'px-4 py-2 rounded-xl text-xs font-black text-slate-400 hover:text-white transition';
            } else {
                if (formReg) formReg.style.display = 'none';
                if (formLog) formLog.style.display = 'block';
                if (btnLog) btnLog.className = 'px-4 py-2 rounded-xl text-xs font-black bg-blue-600 text-white transition shadow-md';
                if (btnReg) btnReg.className = 'px-4 py-2 rounded-xl text-xs font-black text-slate-400 hover:text-white transition';
            }
        };
    </script>

    <style>
        body {
            font-family: 'Cairo', sans-serif;
            background-color: #0b1120;
            color: #f8fafc;
            overflow-x: hidden;
            -webkit-tap-highlight-color: transparent;
        }
        .glow-amber {
            box-shadow: 0 0 35px rgba(245, 158, 11, 0.28);
        }
        .glow-blue {
            box-shadow: 0 0 35px rgba(37, 99, 235, 0.28);
        }
        .glass-card {
            background: rgba(15, 23, 42, 0.88);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
        }
        .tab-btn-active-driver {
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%) !important;
            color: #020617 !important;
            border-color: #fbbf24 !important;
            box-shadow: 0 10px 25px -5px rgba(245, 158, 11, 0.5) !important;
        }
        .tab-btn-active-customer {
            background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%) !important;
            color: #ffffff !important;
            border-color: #60a5fa !important;
            box-shadow: 0 10px 25px -5px rgba(37, 99, 235, 0.5) !important;
        }
        .tab-btn-inactive {
            background: rgba(30, 41, 59, 0.6) !important;
            color: #94a3b8 !important;
            border-color: #334155 !important;
        }
        .tab-btn-inactive:hover {
            background: rgba(51, 65, 85, 0.6) !important;
            color: #f8fafc !important;
        }
    </style>
</head>
<body class="min-h-screen relative flex flex-col justify-between py-6 px-3 sm:px-6">

    <!-- Floating Quick Update App Button -->
    <div style="position:fixed; bottom:16px; left:16px; z-index:99999; direction:rtl;">
        <button onclick="forcePurgeAndReload()" id="btn-purge-cache" title="تحديث التطبيق ومسح الذاكرة المؤقتة"
                class="bg-slate-900/90 hover:bg-amber-500 hover:text-slate-950 text-amber-400 border border-amber-500/80 text-xs font-bold py-2.5 px-4 rounded-full shadow-2xl flex items-center gap-2 transition cursor-pointer backdrop-blur-md">
            <span>🔄</span>
            <span>تحديث التطبيق</span>
        </button>
    </div>

    <!-- Background Ambient Glow -->
    <div class="fixed inset-0 overflow-hidden pointer-events-none -z-10">
        <div class="absolute -top-40 -right-40 w-96 h-96 bg-amber-500/10 rounded-full blur-3xl"></div>
        <div class="absolute -bottom-40 -left-40 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl"></div>
    </div>

    <div class="max-w-2xl w-full mx-auto my-auto space-y-6">

        <!-- Top Header & Branding -->
        <div class="text-center space-y-2">
            <div class="inline-flex items-center justify-center w-20 h-20 bg-amber-500/20 text-amber-400 rounded-3xl text-4xl shadow-xl border border-amber-500/30">
                🚕
            </div>
            <h1 class="text-2xl sm:text-3xl font-black text-white tracking-tight">
                منصة توصيله الذكية
            </h1>
            <p class="text-xs sm:text-sm text-slate-400 font-semibold">
                بوابة التوثيق والاشتراك اليومي - النجف الأشرف
            </p>
        </div>

        <!-- Role Selector Tabs -->
        <div class="grid grid-cols-2 gap-3 p-2 bg-slate-950/90 rounded-3xl border border-slate-800 shadow-2xl backdrop-blur-md">
            <button type="button" id="tab-btn-customer" onclick="switchRole('Customer'); return false;"
                    class="py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer ${preselectedRole === 'Driver' ? 'tab-btn-inactive' : 'tab-btn-active-customer glow-blue'}">
                <i class="fa-solid fa-user text-base sm:text-lg"></i>
                <span>حساب راكب (مستخدم)</span>
            </button>
            <button type="button" id="tab-btn-driver" onclick="switchRole('Driver'); return false;"
                    class="py-4 px-4 sm:px-6 rounded-2xl text-xs sm:text-base font-black flex items-center justify-center gap-2.5 transition border cursor-pointer ${preselectedRole === 'Driver' ? 'tab-btn-active-driver glow-amber' : 'tab-btn-inactive'}">
                <i class="fa-solid fa-taxi text-base sm:text-lg"></i>
                <span>تسجيل الدخول للكباتن</span>
            </button>
        </div>

        <!-- ================================================================= -->
        <!-- TAB 1: PASSENGER (CUSTOMER) - WEB APP REGISTRATION & LOGIN        -->
        <!-- ================================================================= -->
        <div id="customer-section" style="display: ${preselectedRole === 'Driver' ? 'none' : 'block'};" class="space-y-6">
            
            <div class="glass-card rounded-3xl p-5 sm:p-8 border border-blue-500/30 shadow-2xl space-y-6 glow-blue">
                
                <!-- Passenger Sub-mode switchers -->
                <div class="flex items-center justify-between bg-slate-900/90 p-2 rounded-2xl border border-slate-800">
                    <button type="button" id="sub-btn-cust-reg" onclick="switchPassengerMode('register')"
                            class="px-4 py-2 rounded-xl text-xs font-black bg-blue-600 text-white transition shadow-md">
                        استمارة تسجيل راكب جديد 📝
                    </button>
                    <button type="button" id="sub-btn-cust-login" onclick="switchPassengerMode('login')"
                            class="px-4 py-2 rounded-xl text-xs font-black text-slate-400 hover:text-white transition">
                        لديك حساب بالفعل؟ تسجيل الدخول 🔑
                    </button>
                </div>

                <!-- Registration Form for Passengers (5 Fields) -->
                <form id="cust-register-form" onsubmit="handleCustomerRegister(event)" class="space-y-4">
                    <div class="text-right border-b border-slate-800 pb-3">
                        <h3 class="text-base font-black text-white flex items-center gap-2">
                            <span>👤</span>
                            <span>استمارة تسجيل الراكب الجديد</span>
                        </h3>
                        <p class="text-xs text-slate-400 mt-1">أدخل بياناتك وسيتم توجيهك فوراً لدخول التطبيق:</p>
                    </div>

                    <div id="cust-reg-alert" style="display: none;" class="p-3 bg-rose-500/20 border border-rose-500/50 rounded-xl text-xs font-bold text-rose-300 text-right"></div>

                    <!-- 1. Full Name -->
                    <div>
                        <label class="block text-xs text-slate-300 font-bold mb-1.5 text-right">الاسم الكامل <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <i class="fa-solid fa-user absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none"></i>
                            <input type="text" id="cust-reg-name" required placeholder="مثال: حيدر علي الحسني"
                                   class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-slate-500 text-right">
                        </div>
                    </div>

                    <!-- 2. Iraqi Phone -->
                    <div>
                        <label class="block text-xs text-slate-300 font-bold mb-1.5 text-right">رقم الهاتف العراقي <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <i class="fa-solid fa-phone absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none"></i>
                            <input type="tel" id="cust-reg-phone" required placeholder="07701234567" dir="ltr"
                                   class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-slate-500 font-mono text-left">
                        </div>
                    </div>

                    <!-- 3. Route -->
                    <div>
                        <label class="block text-xs text-slate-300 font-bold mb-1.5 text-right">المسار (خط السير المطلوب) <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <i class="fa-solid fa-route absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none"></i>
                            <input type="text" id="cust-reg-route" required placeholder="مثال: من حي الجامعة إلى جامعة الكوفة"
                                   class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-slate-500 text-right">
                        </div>
                    </div>

                    <!-- 4. Address -->
                    <div>
                        <label class="block text-xs text-slate-300 font-bold mb-1.5 text-right">العنوان بالتفصيل <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <i class="fa-solid fa-location-dot absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none"></i>
                            <input type="text" id="cust-reg-address" required placeholder="مثال: النجف - حي الجامعة - قرب المسجد"
                                   class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white placeholder-slate-500 text-right">
                        </div>
                    </div>

                    <!-- 5. Password -->
                    <div>
                        <label class="block text-xs text-slate-300 font-bold mb-1.5 text-right">كلمة المرور (الباسوورد للحساب) <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <i class="fa-solid fa-lock absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none"></i>
                            <input type="password" id="cust-reg-password" required minlength="4" placeholder="••••••••"
                                   class="w-full pr-10 pl-11 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white font-mono">
                            <button type="button" onclick="togglePasswordVisibility('cust-reg-password', 'eye-cust-reg-pwd')" class="absolute left-3 top-3 text-slate-400 hover:text-white p-1">
                                <i id="eye-cust-reg-pwd" class="fa-solid fa-eye"></i>
                            </button>
                        </div>
                    </div>

                    <button type="submit" id="btn-cust-reg-submit"
                            class="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-black rounded-2xl text-base transition flex items-center justify-center gap-2 shadow-xl shadow-blue-600/30 cursor-pointer">
                        <i class="fa-solid fa-user-plus"></i>
                        <span>إكمال تسجيل حساب الراكب والمتابعة 🚀</span>
                    </button>
                </form>

                <!-- Direct Login Form for Existing Passengers -->
                <form id="cust-login-form" onsubmit="handleCustomerLogin(event)" class="space-y-4" style="display: none;">
                    <div class="text-right border-b border-slate-800 pb-3">
                        <h3 class="text-base font-black text-white flex items-center gap-2">
                            <span>🔑</span>
                            <span>تسجيل دخول الراكب ببياناته المسجلة</span>
                        </h3>
                        <p class="text-xs text-slate-400 mt-1">أدخل رقم الهاتف وكلمة المرور المسجلة سابقاً للدخول:</p>
                    </div>

                    <div>
                        <label class="block text-xs text-slate-300 font-bold mb-1.5 text-right">رقم الهاتف <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <i class="fa-solid fa-phone absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none"></i>
                            <input type="text" id="cust-login-identifier" required placeholder="07701234567" dir="ltr"
                                   class="w-full pr-10 pl-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white font-mono text-left">
                        </div>
                    </div>

                    <div>
                        <label class="block text-xs text-slate-300 font-bold mb-1.5 text-right">كلمة المرور (الباسوورد) <span class="text-rose-400">*</span></label>
                        <div class="relative">
                            <i class="fa-solid fa-lock absolute right-3.5 top-3.5 text-slate-400 text-sm pointer-events-none"></i>
                            <input type="password" id="cust-login-password" required placeholder="••••••••"
                                   class="w-full pr-10 pl-11 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-white font-mono">
                            <button type="button" onclick="togglePasswordVisibility('cust-login-password', 'eye-cust-log-pwd')" class="absolute left-3 top-3 text-slate-400 hover:text-white p-1">
                                <i id="eye-cust-log-pwd" class="fa-solid fa-eye"></i>
                            </button>
                        </div>
                    </div>

                    <div class="flex items-center justify-between text-xs">
                        <a href="https://wa.me/9647706204066?text=%D9%86%D8%B3%D9%8A%D8%AA%20%D9%83%D9%84%D9%85%D8%A9%20%D8%A7%D9%84%D9%85%D8%B1%D9%88%D8%B1%20%D9%84%D8%AD%D8%B3%D8%A7%D8%A8%20%D8%A7%D9%84%D8%B1%D8%A7%D9%83%D8%A8" target="_blank" class="text-blue-400 hover:text-blue-300 font-bold">
                            نسيت كلمة المرور؟ (تواصل واتساب)
                        </a>
                    </div>

                    <button type="submit" id="btn-cust-login-submit"
                            class="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-black rounded-2xl text-base transition flex items-center justify-center gap-2 shadow-xl shadow-blue-600/30 cursor-pointer">
                        <i class="fa-solid fa-right-to-bracket"></i>
                        <span>تسجيل الدخول للراكب 🚀</span>
                    </button>
                </form>

                <!-- Interactive Najaf Map Explorer -->
                <div class="space-y-2 pt-2 border-t border-slate-800/80">
                    <label class="block text-xs text-slate-300 font-bold text-right">خريطة خطوط النجف والبحث السريع (اختياري)</label>
                    <div class="relative">
                        <input type="text" id="cust-map-search" placeholder="ابحث عن شارع، حي، مجمع، أو جامعة..."
                               class="w-full px-4 py-2.5 bg-slate-800/90 border border-slate-700 rounded-xl text-xs text-white placeholder-slate-400 focus:outline-none focus:border-blue-500 text-right">
                        <div id="cust-search-results" class="hidden absolute top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 max-h-48 overflow-y-auto"></div>
                    </div>
                    <div id="passenger-map" style="height: 200px; width: 100%; border-radius: 1rem;" class="border border-slate-700 shadow-inner"></div>
                </div>

            </div>
        </div>

        <!-- ================================================================= -->
        <!-- TAB 2: CAPTAIN (DRIVER) - DIRECT LOGIN & DASHBOARD VERIFICATION   -->
        <!-- (EXACT CARD IN SCREENSHOT media_1790236839641.png)                -->
        <!-- ================================================================= -->
        <div id="driver-section" style="display: ${preselectedRole === 'Driver' ? 'block' : 'none'};">
            
            <div class="glass-card rounded-3xl p-6 sm:p-8 border border-amber-500/30 shadow-2xl space-y-5 glow-amber text-center">
                
                <!-- Circular Icon Badge -->
                <div class="w-16 h-16 bg-amber-500/20 text-amber-400 rounded-3xl flex items-center justify-center text-3xl mx-auto shadow-inner border border-amber-500/30">
                    🚕
                </div>

                <div>
                    <h3 class="text-xl sm:text-2xl font-black text-white">تسجيل الدخول للكباتن</h3>
                    <p class="text-xs sm:text-sm text-slate-400 mt-1">أدخل رقم الهاتف وكلمة المرور المعتمدة من لوحة التحكم (الداشبورد):</p>
                </div>

                <form onsubmit="handleCaptainLogin(event)" class="space-y-4 text-right">
                    <div>
                        <label class="block text-xs text-slate-300 font-bold mb-1.5">
                            رقم الهاتف (اسم المستخدم) <span class="text-rose-400">*</span>
                        </label>
                        <div class="relative">
                            <input type="text" id="login-driver-identifier" required placeholder="07801234567 أو 07706204066" dir="rtl"
                                   class="w-full px-4 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white placeholder-slate-400 font-mono text-right">
                        </div>
                    </div>

                    <div>
                        <label class="block text-xs text-slate-300 font-bold mb-1.5">
                            كلمة المرور (الباسوورد) <span class="text-rose-400">*</span>
                        </label>
                        <div class="relative">
                            <input type="password" id="login-driver-password" required placeholder="••••••••"
                                   class="w-full pr-4 pl-11 py-3 bg-slate-800/90 border border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 text-white font-mono text-right">
                            <button type="button" onclick="togglePasswordVisibility('login-driver-password', 'eye-login-drv-pwd')" class="absolute left-3 top-3 text-slate-400 hover:text-white p-1">
                                <i id="eye-login-drv-pwd" class="fa-solid fa-eye"></i>
                            </button>
                        </div>
                    </div>

                    <button type="submit" id="btn-login-driver-submit" 
                            class="w-full py-4 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-2xl text-base transition flex items-center justify-center gap-2 shadow-xl shadow-amber-500/25 cursor-pointer">
                        <i class="fa-solid fa-right-to-bracket text-lg"></i>
                        <span>تسجيل الدخول للكابتن 🚀</span>
                    </button>
                </form>

                <!-- Official Notice Box -->
                <div class="p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-xs text-amber-200/90 leading-relaxed text-right flex items-start gap-2">
                    <span class="text-amber-400 text-sm">⚠️</span>
                    <div>
                        <strong>تنويه للكباتن:</strong> يتم تسجيل واعتماد حسابات الكباتن والسائقين الجدد حصراً من خلال إدارة المنصة ومكتب التوثيق. إذا كنت ترغب بالانضمام ككابتن جديد، يرجى التواصل المباشر مع إدارة المنصة للاعتماد وتفعيل الحساب.
                    </div>
                </div>

                <!-- Two Contact Buttons -->
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <a href="https://wa.me/9647706204066?text=%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%20%D8%B9%D9%84%D9%8A%D9%83%D9%85%D8%8C%20%D8%A3%D8%B1%D8%BA%D8%A8%20%D8%A8%D8%A7%D9%84%D8%AA%D8%B3%D8%AC%D9%8A%D9%84%20%D9%83%D9%83%D8%A7%D8%A8%D8%AA%D9%86%20%D8%AC%D8%AF%D9%8A%D8%AF%20%D9%81%D9%8A%20%D9%85%D9%86%D8%B5%D8%A9%20%D8%AA%D9%88%D8%B5%D9%8A%D9%84%D8%A9" target="_blank" rel="noopener noreferrer"
                       class="py-3 px-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20 cursor-pointer text-center">
                        <i class="fa-brands fa-whatsapp text-lg"></i>
                        <span>تواصل عبر واتساب (07706204066)</span>
                    </a>
                    <a href="tel:07706204066"
                       class="py-3 px-3 bg-slate-800 hover:bg-slate-700 text-amber-400 border border-amber-500/40 rounded-xl text-xs font-bold transition flex items-center justify-center gap-2 shadow-md cursor-pointer text-center">
                        <i class="fa-solid fa-phone text-sm"></i>
                        <span>اتصال هاتفي مباشر (07706204066)</span>
                    </a>
                </div>

            </div>

        </div>

        <!-- Loading Overlay -->
        <div id="loading" style="display: none;" class="text-center py-4 bg-slate-900/90 rounded-2xl border border-slate-800">
            <div class="inline-block w-8 h-8 border-4 border-amber-400 border-t-transparent rounded-full animate-spin"></div>
            <p class="text-xs text-slate-300 mt-2 font-bold" id="loading-text">جاري معالجة طلبك والاتصال بالخادم...</p>
        </div>

        <!-- Footer -->
        <footer class="text-center text-xs text-slate-500 py-2">
            <p>© 2026 توصيله (Tawseela IQ) - جميع الحقوق محفوظة لخدمات النقل الذكي بالنجف الأشرف</p>
        </footer>

    </div>

    <!-- Client-side Logic -->
    <script>
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
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>تم الدخول بنجاح! جاري تحويلك...</span>';
                    const targetUrl = '/app/#' + targetHash + '?login_token=' + encodeURIComponent(data.token) +
                                      '&userId=' + encodeURIComponent(data.userId) +
                                      '&role=' + encodeURIComponent(userRole) +
                                      '&fullName=' + encodeURIComponent(data.fullName || (userRole === 'Driver' ? 'كابتن توصيله' : 'راكب توصيله'));
                    setTimeout(function() { window.location.replace(targetUrl); }, 200);
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

        // 2. PASSENGER REGISTRATION
        async function handleCustomerRegister(event) {
            event.preventDefault();
            const name = document.getElementById('cust-reg-name').value.trim();
            const phone = document.getElementById('cust-reg-phone').value.trim();
            const route = document.getElementById('cust-reg-route').value.trim();
            const address = document.getElementById('cust-reg-address').value.trim();
            const password = document.getElementById('cust-reg-password').value;
            const submitBtn = document.getElementById('btn-cust-reg-submit');
            const alertBox = document.getElementById('cust-reg-alert');

            alertBox.style.display = 'none';

            if (!name || !phone || !route || !address || !password) {
                alert('يرجى ملء جميع الحقول المطلوبة');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جاري إكمال التسجيل...</span>';

            try {
                const res = await fetch('/api/auth/complete-passenger-registration', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fullName: name,
                        phoneNumber: phone,
                        route: route,
                        address: address,
                        password: password
                    })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    persistSession(data);
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>تم التسجيل بنجاح! جاري تحويلك...</span>';
                    const targetUrl = '/app/#/customer?login_token=' + encodeURIComponent(data.token) +
                                      '&userId=' + encodeURIComponent(data.userId) +
                                      '&role=Customer' +
                                      '&fullName=' + encodeURIComponent(data.fullName || 'راكب توصيله');
                    setTimeout(function() { window.location.replace(targetUrl); }, 200);
                } else {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i><span>إكمال تسجيل حساب الراكب والمتابعة 🚀</span>';
                    alertBox.innerText = data.error || 'عذراً، فشل تسجيل الحساب.';
                    alertBox.style.display = 'block';
                    alert(data.error || 'عذراً، فشل تسجيل الحساب.');
                }
            } catch (err) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i><span>إكمال تسجيل حساب الراكب والمتابعة 🚀</span>';
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
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i><span>تم الدخول بنجاح! جاري تحويلك...</span>';
                    const targetUrl = '/app/#/customer?login_token=' + encodeURIComponent(data.token) +
                                      '&userId=' + encodeURIComponent(data.userId) +
                                      '&role=Customer' +
                                      '&fullName=' + encodeURIComponent(data.fullName || 'راكب توصيله');
                    setTimeout(function() { window.location.replace(targetUrl); }, 200);
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

        // 4. MAPBOX INIT FOR PASSENGER
        var passengerMap = null;
        var passengerMarker = null;
        function initPassengerMapbox() {
            if (passengerMap || !document.getElementById('passenger-map')) return;
            try {
                mapboxgl.accessToken = ('pk.' + 'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9' + '._J6DYjYBDhsdcidErQrblA');
                passengerMap = new mapboxgl.Map({
                    container: 'passenger-map',
                    style: 'mapbox://styles/mapbox/streets-v12',
                    center: [44.3238, 32.0004],
                    zoom: 12
                });
                if (mapboxgl.getRTLTextPluginStatus() === 'unavailable') {
                    mapboxgl.setRTLTextPlugin('https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js', null, true);
                }

                passengerMap.on('click', async function(e) {
                    var lng = e.lngLat.lng;
                    var lat = e.lngLat.lat;
                    if (passengerMarker) passengerMarker.remove();
                    passengerMarker = new mapboxgl.Marker({ color: '#2563eb' })
                        .setLngLat([lng, lat])
                        .addTo(passengerMap);

                    try {
                        var revRes = await fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/' + lng + ',' + lat + '.json?country=iq&language=ar&access_token=' + mapboxgl.accessToken);
                        var revData = await revRes.json();
                        if (revData.features && revData.features.length > 0) {
                            var pName = revData.features[0].place_name_ar || revData.features[0].place_name;
                            if (document.getElementById('cust-map-search')) document.getElementById('cust-map-search').value = pName;
                            if (document.getElementById('cust-reg-address')) document.getElementById('cust-reg-address').value = pName;
                            var rInp = document.getElementById('cust-reg-route');
                            if (rInp && !rInp.value) rInp.value = pName;
                        }
                    } catch (_) {}
                });
            } catch (e) { console.error('Mapbox error:', e); }
        }

        // Live Geocoding Search
        var searchInput = document.getElementById('cust-map-search');
        var resultsBox = document.getElementById('cust-search-results');
        var searchTimeout = null;
        if (searchInput && resultsBox) {
            searchInput.addEventListener('input', function() {
                var query = searchInput.value.trim();
                clearTimeout(searchTimeout);
                if (query.length < 2) { resultsBox.classList.add('hidden'); return; }
                searchTimeout = setTimeout(async function() {
                    try {
                        var token = ('pk.' + 'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9' + '._J6DYjYBDhsdcidErQrblA');
                        var res = await fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(query) + '.json?proximity=44.3238,32.0004&country=iq&language=ar&access_token=' + token);
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
                                div.className = 'px-3 py-2 hover:bg-slate-800 cursor-pointer text-xs border-b border-slate-800/50 flex items-center gap-2';
                                var pName = feat.place_name_ar || feat.place_name;
                                div.innerHTML = '<span class="text-amber-400">📍</span> <span>' + pName + '</span>';
                                div.onclick = function() {
                                    if (passengerMap) {
                                        passengerMap.flyTo({ center: feat.center, zoom: 15 });
                                        if (passengerMarker) passengerMarker.remove();
                                        passengerMarker = new mapboxgl.Marker({ color: '#2563eb' })
                                            .setLngLat(feat.center)
                                            .addTo(passengerMap);
                                    }
                                    searchInput.value = pName;
                                    var rInp = document.getElementById('cust-reg-route');
                                    var aInp = document.getElementById('cust-reg-address');
                                    if (rInp && !rInp.value) rInp.value = pName;
                                    if (aInp) aInp.value = pName;
                                    resultsBox.classList.add('hidden');
                                };
                                resultsBox.appendChild(div);
                            });
                        } else { resultsBox.classList.add('hidden'); }
                    } catch (_) { resultsBox.classList.add('hidden'); }
                }, 250);
            });
        }

        // Auto Select Tab on Load from URL (Defaults to Captain/Driver)
        (function() {
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
        const { fullName, email, password, googleId, phoneNumber, route, address, area, paymentMethod } = body;
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
        const { fullName, email, password, googleId, phoneNumber, vehicleMake, vehiclePlate, vehicleYear, documents, route } = body;
        if (!fullName || !email) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'الاسم والبريد الإلكتروني مطلوبان.' }));
        }

        const emailLower = email.trim().toLowerCase();
        const cleanPhone = (phoneNumber || '').trim().replace(/[\s\-]/g, '');

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
        const licenseNumber = 'IRQ-NJF-' + Math.floor(1000 + Math.random() * 9000);

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
            licenseNumber,
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
            licenseNumber,
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
        const isTawseela = reqHost && reqHost.includes('tawseelaiq.app');
        const basePath = isTawseela ? '/' : '/app/';
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
