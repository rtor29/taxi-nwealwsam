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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="theme-color" content="#ffffff">
    <meta name="description" content="منصة توصيلة - خدمة حجز وتنظيم رحلات التوصيل اليومية والسائقين في النجف الأشرف.">
    <title>توصيله | التسجيل والدخول</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap" rel="stylesheet">
    <link href="https://api.mapbox.com/mapbox-gl-js/v3.2.0/mapbox-gl.css" rel="stylesheet">
    <script src="https://api.mapbox.com/mapbox-gl-js/v3.2.0/mapbox-gl.js"></script>
    <script src="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js" defer></script>
    <script src="https://cdn.tailwindcss.com" defer></script>
    <style>
        *{box-sizing:border-box}
        body{font-family:'Cairo',sans-serif;background:#ffffff;color:#111111;margin:0;padding:0;min-height:100vh;overflow-x:hidden}
        @keyframes pulseGreen{0%,100%{box-shadow:0 6px 25px rgba(22,163,106,0.4)}50%{box-shadow:0 6px 35px rgba(22,163,106,0.7)}}
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
        .range-chip{background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:20px;padding:4px 10px;font-size:11px;font-weight:700;font-family:'Cairo',sans-serif;cursor:pointer;transition:all .15s}
        .range-chip.active{background:#111827;color:#fff;border-color:#111827}
        .day-chip{background:#f3f4f6;color:#4b5563;border:1.5px solid #e5e7eb;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;transition:all .15s;text-align:center}
        .day-chip.active{background:#10b981;color:#fff;border-color:#059669}
        .driver-mini-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;transition:all .2s;cursor:pointer}
        .driver-mini-card:hover{border-color:#3b82f6;background:#f0f9ff}
        .match-badge{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;border-radius:20px;padding:2px 8px;font-size:10px;font-weight:800}
        html, body {
            touch-action: manipulation;
            -webkit-tap-highlight-color: transparent;
            -webkit-text-size-adjust: 100%;
            overscroll-behavior-y: none;
        }
        button, input, select, textarea {
            touch-action: manipulation;
            font-family: inherit;
        }
        /* Full Screen Map & Floating Controls */
        #booking-main-body {
            position: relative !important;
            flex: 1 !important;
            width: 100% !important;
            height: 100% !important;
            overflow: hidden !important;
        }
        #booking-map-wrapper {
            position: absolute !important;
            inset: 0 !important;
            width: 100% !important;
            height: 100% !important;
            z-index: 1 !important;
        }
        #booking-mapbox-map {
            width: 100% !important;
            height: 100% !important;
        }
        #booking-sidebar {
            position: absolute !important;
            top: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            width: 380px !important;
            max-width: 90vw !important;
            height: 100% !important;
            background: #ffffff !important;
            box-shadow: -4px 0 25px rgba(0,0,0,0.2) !important;
            z-index: 40 !important;
            overflow-y: auto !important;
            -webkit-overflow-scrolling: touch !important;
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1) !important;
            transform: translateX(105%) !important;
            padding: 16px !important;
        }
        #booking-sidebar.drawer-open {
            transform: translateX(0) !important;
        }
        #booking-sidebar-backdrop {
            display: none;
            position: absolute;
            inset: 0;
            background: rgba(0,0,0,0.4);
            z-index: 35;
        }
        #booking-sidebar-backdrop.active {
            display: block;
        }
        .search-autocomplete-dropdown {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            z-index: 100;
            background: #ffffff;
            border: 1.5px solid #e2e8f0;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.15);
            max-height: 220px;
            overflow-y: auto;
            margin-top: 4px;
        }
        .search-result-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            border-bottom: 1px solid #f1f5f9;
            cursor: pointer;
            transition: background 0.15s;
            font-size: 13px;
        }
        .search-result-item:hover, .search-result-item:active {
            background: #f8fafc;
        }
        .search-result-item:last-child {
            border-bottom: none;
        }
        .mode-chip {
            padding: 4px 10px;
            border-radius: 8px;
            font-size: 11px;
            font-weight: 800;
            border: 1.5px solid transparent;
            cursor: pointer;
            transition: all 0.15s;
            font-family: inherit;
        }
        .mode-chip.active {
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        }
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

    <!-- ========================================================================= -->
    <!-- INTERACTIVE MAPBOX BOOKING & DISPATCH APP (STAGES 1, 2, 3, 4) -->
    <!-- ========================================================================= -->
    <div id="booking-modal-view" style="display:none;position:fixed;inset:0;width:100vw;height:100vh;z-index:999999;background:#f8fafc;flex-direction:column;font-family:'Cairo',sans-serif;" dir="rtl">
        <!-- Top App Bar -->
        <header style="background:#111827;color:#fff;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 10px rgba(0,0,0,0.25);flex-shrink:0;z-index:20;">
            <div style="display:flex;align-items:center;gap:10px;">
                <button type="button" id="btn-toggle-booking-drawer" onclick="toggleBookingDrawer()" style="background:#1f2937;color:#fff;border:1px solid #374151;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px;font-family:inherit;" title="القائمة الجانبية (Drawer)">
                    <i class="fa-solid fa-bars"></i>
                    <span style="font-size:11px;font-weight:700;">القائمة</span>
                </button>
                <span style="font-size:26px;">🚕</span>
                <div>
                    <div style="font-size:15px;font-weight:900;line-height:1.2;">توصيلة النجف</div>
                    <div id="booking-header-subtitle" style="font-size:11px;color:#9ca3af;">تثبيت المسار وإدارة طلبات الانضمام</div>
                </div>
            </div>

            <!-- Tabs: واجهة الراكب / واجهة السائق & إدارة طلبات الانضمام -->
            <div style="display:flex;background:#1f2937;padding:3px;border-radius:10px;gap:4px;">
                <button id="book-tab-set-route" type="button" onclick="switchRouteTab('set-route')" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:900;cursor:pointer;font-family:inherit;">
                    👤 واجهة الراكب
                </button>
                <button id="book-tab-join-requests" type="button" onclick="switchRouteTab('join-requests')" style="background:transparent;color:#d1d5db;border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">
                    🙋 إدارة طلبات الانضمام
                </button>
            </div>

            <!-- Fast Exit X Button (اعلى نافذة الخريطة للإغلاق السريع) -->
            <button type="button" onclick="closeBookingApp()" style="background:#ef4444;color:#fff;border:none;border-radius:50%;width:38px;height:38px;font-size:18px;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(239,68,68,0.4);" title="إغلاق سريع (X)">
                ✕
            </button>
        </header>

        <!-- Main Body -->
        <div id="booking-main-body">
            <!-- MAP VIEWPORT (FULL SCREEN) -->
            <div id="booking-map-wrapper">
                <div id="booking-mapbox-map"></div>

                <!-- Top Floating Controls Card (Floating over map) — DRAGGABLE -->
                <div id="floating-route-card" style="position:absolute;top:12px;right:12px;width:320px;z-index:25;background:rgba(255,255,255,0.96);backdrop-filter:blur(10px);border:1.5px solid #e2e8f0;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,0.12);padding:0;display:flex;flex-direction:column;gap:0;touch-action:none;user-select:none;">

                    <!-- Drag Handle -->
                    <div id="floating-card-handle" style="background:linear-gradient(135deg,#111827,#1e293b);border-radius:14px 14px 0 0;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;cursor:grab;">
                        <span style="font-size:11px;font-weight:800;color:#9ca3af;letter-spacing:1px;">☰ اسحب للتحريك</span>
                        <div style="display:flex;gap:4px;">
                            <button type="button" id="btn-target-pickup" onclick="setMapTarget('pickup')" class="mode-chip active" style="background:#dcfce7;color:#15803d;border-color:#86efac;font-size:10px;padding:3px 7px;">🟢 الانطلاق</button>
                            <button type="button" id="btn-target-dropoff" onclick="setMapTarget('dropoff')" class="mode-chip" style="background:#fee2e2;color:#b91c1c;border-color:#fca5a5;font-size:10px;padding:3px 7px;">🔴 الوصول</button>
                        </div>
                    </div>

                    <!-- Card Body -->
                    <div style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;">
                        <!-- Status label -->
                        <span id="map-target-status" style="font-size:11px;font-weight:800;color:#1e40af;background:#eff6ff;padding:3px 8px;border-radius:8px;text-align:center;">📍 انقر على الخريطة أو ابحث</span>

                        <!-- 🟢 Pickup Search Input Row + GPS Button -->
                        <div style="position:relative;">
                            <div style="display:flex;gap:6px;align-items:center;">
                                <div style="position:relative;flex:1;">
                                    <input type="text" id="book-pickup-input" class="inp" placeholder="🟢 نقطة الانطلاق أو انقر الخريطة..." value="" oninput="onBookingPickupSearch(this.value)" onfocus="setMapTarget('pickup');onBookingPickupSearch(this.value)" style="font-size:11px;padding:8px 10px;padding-left:22px;">
                                    <button type="button" onclick="clearPickupInput()" id="btn-clear-pickup" style="display:none;position:absolute;left:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:12px;">✕</button>
                                </div>
                                <button type="button" onclick="centerOnUserGps()" id="btn-gps-pickup" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 10px;font-size:11px;font-weight:800;cursor:pointer;white-space:nowrap;font-family:inherit;box-shadow:0 2px 8px rgba(37,99,235,0.25);display:flex;align-items:center;gap:4px;" title="تحديد موقعي الحالي تلقائياً">
                                    <span>📍 موقعي الحالي</span>
                                </button>
                            </div>
                            <div id="book-pickup-results" class="search-autocomplete-dropdown"></div>
                        </div>

                        <!-- 🔴 Dropoff Search Input Row -->
                        <div style="position:relative;">
                            <div style="display:flex;gap:6px;align-items:center;">
                                <div style="position:relative;flex:1;">
                                    <input type="text" id="book-dropoff-input" class="inp" placeholder="🔴 ابحث: حولي النجف، مرقد الإمام علي..." value="" oninput="onBookingDropoffSearch(this.value)" onfocus="setMapTarget('dropoff');onBookingDropoffSearch(this.value)" style="font-size:11px;padding:8px 10px;padding-left:22px;">
                                    <button type="button" onclick="clearDropoffInput()" id="btn-clear-dropoff" style="display:none;position:absolute;left:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:12px;">✕</button>
                                </div>
                            </div>
                            <div id="book-dropoff-results" class="search-autocomplete-dropdown"></div>
                        </div>

                        <!-- Live Route Summary Badge -->
                        <div id="floating-route-summary-pill" style="display:none;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:5px 10px;align-items:center;justify-content:space-between;font-size:11px;font-weight:800;">
                            <span id="card-route-dist" style="color:#1e293b;">📏 -- كم</span>
                            <span id="card-route-dur" style="color:#1e293b;">⏱️ -- دقيقة</span>
                            <span id="card-route-fare" style="color:#059669;font-weight:900;">💰 -- د.ع</span>
                        </div>

                        <!-- 📌 Save Route Button (merged into card) -->
                        <button type="button" id="btn-floating-save-route" onclick="saveUserRouteToDatabase()" style="background:linear-gradient(135deg,#111827,#1f2937);color:#fff;border:2px solid #374151;border-radius:12px;padding:11px 14px;font-size:13px;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 15px rgba(0,0,0,0.25);font-family:inherit;width:100%;transition:all .2s;">
                            <span>📌</span>
                            <span id="floating-save-btn-text">تأكيد وتثبيت المسار</span>
                            <span id="floating-btn-fare" style="display:none;background:#059669;color:#fff;padding:2px 6px;border-radius:6px;font-size:10px;font-weight:800;"></span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- OFF-CANVAS SIDEBAR DRAWER (FOR REQUESTS & MATCHING DRIVERS) -->
            <div id="booking-sidebar-backdrop" onclick="toggleBookingDrawer(false)"></div>
            <div id="booking-sidebar">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <span style="font-size:14px;font-weight:900;color:#111;">القائمة وإدارة الطلبات</span>
                    <button type="button" onclick="toggleBookingDrawer(false)" style="background:#f3f4f6;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-weight:900;color:#6b7280;font-size:14px;">✕</button>
                </div>
                <!-- Panel content will be dynamically rendered -->
                <div id="sidebar-panel-set-route" style="display:none;flex-direction:column;gap:12px;"></div>
                <div id="sidebar-panel-join-requests" style="display:flex;flex-direction:column;gap:12px;"></div>
                <div id="sidebar-panel-short" style="display:none;flex-direction:column;gap:12px;"></div>
                <div id="sidebar-panel-daily" style="display:none;flex-direction:column;gap:12px;"></div>
                <div id="sidebar-panel-driver" style="display:none;flex-direction:column;gap:12px;"></div>
            </div>
        </div>
    </div>

    <!-- 30-Second Auto-Escalation Dispatch Modal (Stage 1) -->
    <div id="ride-dispatch-modal" style="display:none;position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,0.65);align-items:center;justify-content:center;padding:16px;font-family:'Cairo',sans-serif;" dir="rtl">
        <div class="card" style="max-width:400px;width:100%;padding:24px 20px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.3);">
            <div style="font-size:36px;margin-bottom:8px;" id="dispatch-modal-icon">⏳</div>
            <h3 id="dispatch-modal-title" style="font-size:17px;font-weight:900;margin:0 0 6px;color:#111;">جاري البحث عن أقرب سائق متواجد...</h3>
            <p id="dispatch-modal-subtitle" style="font-size:12px;color:#6b7280;margin:0 0 16px;">يتم الآن فحص وتحديد أقرب كابتن لتنفيذ مشوارك السريع</p>

            <!-- Circular timer -->
            <div style="display:inline-flex;align-items:center;justify-content:center;width:72px;height:72px;border-radius:50%;border:4px solid #f59e0b;margin-bottom:14px;">
                <span id="dispatch-timer-seconds" style="font-size:24px;font-weight:900;color:#d97706;">30</span>
            </div>

            <!-- Assigned Driver Info Box -->
            <div id="dispatch-driver-info-box" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:16px;text-align:right;">
                <div style="font-size:13px;font-weight:900;color:#111;" id="dispatch-drv-name">كابتن: --</div>
                <div style="font-size:11px;color:#64748b;margin-top:2px;" id="dispatch-drv-car">المركبة: --</div>
                <div style="font-size:11px;color:#059669;font-weight:700;margin-top:2px;" id="dispatch-drv-status">الحالة: يتم الإشعار الآن</div>
            </div>

            <!-- Action buttons -->
            <div id="dispatch-actions-wrap" style="display:flex;gap:8px;">
                <button type="button" onclick="cancelRideRequest()" class="btn-secondary" style="color:#dc2626;border-color:#fecaca;background:#fef2f2;">إلغاء الطلب</button>
            </div>
        </div>
    </div>

    <!-- Driver Incoming Ride Alert Modal (Stage 4) -->
    <div id="driver-incoming-modal" style="display:none;position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,0.65);align-items:center;justify-content:center;padding:16px;font-family:'Cairo',sans-serif;" dir="rtl">
        <div class="card" style="max-width:400px;width:100%;padding:22px 18px;text-align:center;border:2px solid #f59e0b;">
            <div style="font-size:36px;margin-bottom:6px;">🚖</div>
            <h3 style="font-size:17px;font-weight:900;margin:0 0 4px;color:#111;">طلب مشوار قصير جديد!</h3>
            <p style="font-size:12px;color:#6b7280;margin:0 0 12px;">لديك 30 ثانية للموافقة قبل انتقال الطلب لسائق آخر</p>

            <!-- 30s countdown for driver -->
            <div style="font-size:22px;font-weight:900;color:#d97706;margin-bottom:12px;" id="driver-incoming-timer">⏳ 30 ثانية</div>

            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:16px;text-align:right;font-size:12px;">
                <div style="font-weight:900;margin-bottom:4px;" id="incoming-passenger-name">👤 الراكب: --</div>
                <div style="color:#16a34a;margin-bottom:3px;" id="incoming-pickup-addr">🟢 الانطلاق: --</div>
                <div style="color:#dc2626;margin-bottom:3px;" id="incoming-dropoff-addr">🔴 الوصول: --</div>
                <div style="font-weight:900;color:#111;margin-top:6px;" id="incoming-fare-info">💰 الأجرة المقدرة: -- د.ع (المسافة: -- كم)</div>
            </div>

            <div style="display:flex;gap:8px;">
                <button type="button" onclick="respondToIncomingRide('accept')" class="btn-primary" style="background:#16a34a;flex:1;">
                    ✅ قبول المشوار
                </button>
                <button type="button" onclick="respondToIncomingRide('reject')" class="btn-secondary" style="color:#dc2626;flex:1;">
                    ❌ رفض
                </button>
            </div>
        </div>
    </div>

    <!-- Driver Active Ride Modal (Waze Navigation & Arrival Status) -->
    <div id="driver-active-ride-modal" style="display:none;position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,0.65);align-items:center;justify-content:center;padding:16px;font-family:'Cairo',sans-serif;" dir="rtl">
        <div class="card" style="max-width:420px;width:100%;padding:22px 18px;text-align:center;border:2px solid #10b981;">
            <div style="font-size:36px;margin-bottom:6px;">🚗</div>
            <h3 style="font-size:17px;font-weight:900;margin:0 0 4px;color:#111;">الرحلة الجارية الحالية</h3>
            <p style="font-size:12px;color:#6b7280;margin:0 0 12px;" id="driver-active-ride-status">أنت الآن في طريقك إلى موقع الراكب</p>

            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:14px;text-align:right;font-size:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <span style="font-weight:900;font-size:13px;" id="driver-active-passenger-name">👤 الراكب: --</span>
                    <span style="font-weight:900;color:#059669;" id="driver-active-fare">💰 -- د.ع</span>
                </div>
                <div style="color:#16a34a;margin-bottom:4px;" id="driver-active-pickup">🟢 الانطلاق: --</div>
                <div style="color:#dc2626;margin-bottom:8px;" id="driver-active-dropoff">🔴 الوجهة: --</div>
                <div style="display:flex;gap:6px;" id="driver-active-contact-wrap">
                    <a id="driver-active-wa-link" href="#" target="_blank" class="btn-small" style="background:#25d366;color:#fff;text-decoration:none;flex:1;text-align:center;padding:8px;">💬 واتساب الراكب</a>
                    <a id="driver-active-tel-link" href="#" class="btn-small" style="background:#10b981;color:#fff;text-decoration:none;flex:1;text-align:center;padding:8px;">📞 اتصال بالراكب</a>
                </div>
            </div>

            <!-- Waze Navigation Buttons -->
            <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
                <button type="button" onclick="openDriverWaze('dropoff')" class="btn-primary" style="background:#00d8cc;color:#0f172a;display:flex;align-items:center;justify-content:center;gap:8px;font-weight:900;padding:12px;">
                    <span>🧭</span> <span>التنقل إلى الوجهة عبر Waze 🚗</span>
                </button>
                <button type="button" onclick="openDriverWaze('pickup')" class="btn-secondary" style="display:flex;align-items:center;justify-content:center;gap:8px;font-weight:700;padding:10px;">
                    <span>📍</span> <span>التنقل إلى موقع الراكب عبر Waze</span>
                </button>
            </div>

            <!-- Arrival and Completion Actions -->
            <div style="display:flex;flex-direction:column;gap:8px;">
                <button type="button" id="btn-driver-arrived" onclick="driverMarkArrived()" class="btn-primary" style="background:#f59e0b;padding:12px;">
                    📍 أنا وصلت عند موقع الراكب
                </button>
                <button type="button" onclick="driverCompleteRide()" class="btn-primary" style="background:#16a34a;padding:12px;">
                    🏁 إنهاء وإكمال المشوار بنجاح
                </button>
                <button type="button" onclick="closeDriverActiveRideModal()" class="btn-small" style="color:#6b7280;background:transparent;border:none;margin-top:4px;">
                    تصغير النافذة
                </button>
            </div>
        </div>
    </div>

    <!-- Passenger Driver Arrived Notification Modal -->
    <div id="passenger-arrived-modal" style="display:none;position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;padding:16px;font-family:'Cairo',sans-serif;" dir="rtl">
        <div class="card" style="max-width:380px;width:100%;padding:26px 20px;text-align:center;border:2.5px solid #16a34a;box-shadow:0 12px 35px rgba(0,0,0,0.35);animation:pulseGreen 2s infinite;">
            <div style="font-size:48px;margin-bottom:10px;">🚖</div>
            <h3 style="font-size:19px;font-weight:900;margin:0 0 6px;color:#15803d;">وصل الكابتن إلى موقعك!</h3>
            <p style="font-size:13px;color:#374151;margin:0 0 14px;line-height:1.5;" id="passenger-arrived-msg">الكابتن في انتظارك الآن عند نقطة الانطلاق.</p>
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:10px;margin-bottom:16px;font-size:12px;color:#166534;" id="passenger-arrived-driver-box">
                <span id="arrived-drv-name-text">🚕 الكابتن بانتظارك</span>
            </div>
            <button type="button" onclick="dismissPassengerArrivedModal()" class="btn-primary" style="background:#16a34a;padding:12px;font-size:14px;">
                🏃‍♂️ حسناً، أنا قادم الآن
            </button>
        </div>
    </div>

    <!-- Passenger Active Ride Exists Alert Modal -->
    <div id="passenger-active-blocked-modal" style="display:none;position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,0.65);align-items:center;justify-content:center;padding:16px;font-family:'Cairo',sans-serif;" dir="rtl">
        <div class="card" style="max-width:390px;width:100%;padding:22px 18px;text-align:center;border:2px solid #f59e0b;">
            <div style="font-size:40px;margin-bottom:8px;">⚠️</div>
            <h3 style="font-size:17px;font-weight:900;margin:0 0 6px;color:#92400e;">لديك مشوار جاري ومقبول بالفعل!</h3>
            <p style="font-size:12px;color:#6b7280;margin:0 0 14px;line-height:1.5;" id="active-blocked-msg">
                تم قبول طلبك السابق من قبل الكابتن. لا يمكنك طلب مشوار جديد حتى يتم إلغاء الرحلة الحالية أو إكمالها.
            </p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:10px;margin-bottom:16px;text-align:right;font-size:12px;" id="active-blocked-info">
            </div>
            <div style="display:flex;gap:8px;">
                <button type="button" onclick="cancelExistingAcceptedRide()" class="btn-secondary" style="color:#dc2626;border-color:#fecaca;background:#fef2f2;flex:1;padding:10px;font-weight:900;">
                    ❌ إلغاء الرحلة المقبولة
                </button>
                <button type="button" onclick="viewExistingAcceptedRide()" class="btn-primary" style="background:#111827;flex:1;padding:10px;">
                    👁️ عرض الرحلة
                </button>
            </div>
            <button type="button" onclick="document.getElementById('passenger-active-blocked-modal').style.display='none'" class="btn-small" style="margin-top:10px;background:transparent;border:none;color:#6b7280;">
                إغلاق
            </button>
        </div>
    </div>

    <!-- Trip type selection (shown after login, before opening app) -->
    <div id="trip-type-modal" style="display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.5);align-items:center;justify-content:center;padding:16px">
        <div class="card" style="max-width:420px;width:100%;margin:0 auto;padding:24px 20px;max-height:90vh;overflow-y:auto;box-sizing:border-box">
            <div style="text-align:center;margin-bottom:18px">
                <div id="trip-modal-icon" style="font-size:32px;margin-bottom:6px">🚕</div>
                <h2 id="trip-modal-title" style="font-size:18px;font-weight:900;margin:0 0 4px;color:#111">اختر نوع الرحلة</h2>
                <p id="trip-modal-subtitle" style="font-size:13px;color:#6b7280;margin:0">حدد ما يناسبك قبل فتح التطبيق</p>
            </div>

            <!-- Passenger Options (2 cards) -->
            <div id="passenger-trip-options" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
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

            <!-- Short trip drivers preview container (appears when passenger selects short trip) -->
            <div id="passenger-short-drivers-box" style="display:none;margin-bottom:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:12px">
                <div style="font-size:12px;font-weight:800;color:#1f2937;margin-bottom:8px;display:flex;align-items:center;gap:6px">
                    <span>⚡</span><span>السائقون المسجلون كمشوار قصير والقريبون منك:</span>
                </div>
                <div id="passenger-short-drivers-list" style="max-height:180px;overflow-y:auto"></div>
            </div>

            <!-- Driver Options (3 cards) -->
            <div id="driver-trip-options" style="display:none;grid-template-columns:1fr;gap:10px;margin-bottom:16px">
                <div class="trip-card" id="drv-opt-short" onclick="selectDriverServiceType('ShortTrip')" style="text-align:right;padding:12px 14px;display:flex;align-items:center;gap:12px">
                    <div style="font-size:26px">⚡</div>
                    <div>
                        <div style="font-size:14px;font-weight:900">مشاوير قصيرة</div>
                        <div style="font-size:11px;color:#6b7280">استقبال طلبات الرحلات الفورية السريعة</div>
                    </div>
                </div>
                <div class="trip-card" id="drv-opt-daily" onclick="selectDriverServiceType('PermanentLine')" style="text-align:right;padding:12px 14px;display:flex;align-items:center;gap:12px">
                    <div style="font-size:26px">🔄</div>
                    <div>
                        <div style="font-size:14px;font-weight:900">خطوط دائمة</div>
                        <div style="font-size:11px;color:#6b7280">الاشتراكات اليومية والمسارات الثابتة للدوام والجامعة</div>
                    </div>
                </div>
                <div class="trip-card" id="drv-opt-both" onclick="selectDriverServiceType('Both')" style="text-align:right;padding:12px 14px;display:flex;align-items:center;gap:12px">
                    <div style="font-size:26px">🚖</div>
                    <div>
                        <div style="font-size:14px;font-weight:900">كلاهما</div>
                        <div style="font-size:11px;color:#6b7280">تقديم المشاوير القصيرة والخطوط الدائمة معاً</div>
                    </div>
                </div>
            </div>

            <button class="btn-primary" id="btn-open-app" onclick="confirmTripTypeAndOpen()" disabled style="opacity:0.5;width:100%">
                متابعة وفتح التطبيق
            </button>
            <button type="button" onclick="closeTripTypeModal()" style="margin-top:10px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;padding:10px;font-family:'Cairo',sans-serif;font-size:13px;font-weight:700;color:#6b7280;cursor:pointer;width:100%">
                إلغاء ✕
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
    <!-- Onboarding Tutorial -->
    <div id="onboarding-overlay" style="display:none;position:fixed;inset:0;z-index:99998;background:#ffffff;align-items:center;justify-content:center;flex-direction:column">
        <button type="button" onclick="finishOnboarding()" style="position:absolute;top:16px;left:16px;background:#f3f4f6;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:700;color:#6b7280;cursor:pointer;font-family:'Cairo',sans-serif">تخطي ✕</button>
        <div id="onboarding-content" style="max-width:380px;width:90%;text-align:center;padding:40px 20px">
            <div id="onb-icon" style="font-size:64px;margin-bottom:16px"></div>
            <h2 id="onb-title" style="font-size:20px;font-weight:900;color:#111;margin:0 0 8px"></h2>
            <p id="onb-desc" style="font-size:14px;color:#6b7280;margin:0 0 24px"></p>
            <div id="onb-dots" style="display:flex;justify-content:center;gap:8px;margin-bottom:24px"></div>
            <button id="onb-next-btn" onclick="nextOnboardingScreen()" style="background:#111;color:#fff;border:none;border-radius:12px;padding:14px 40px;font-family:'Cairo',sans-serif;font-weight:900;font-size:15px;cursor:pointer">التالي</button>
        </div>
    </div>
    <main style="max-width:480px;width:100%;margin:0 auto;padding:24px 16px 40px">

        <!-- Logo & Title -->
        <header style="text-align:center;padding:20px 0 24px">
            <div id="app-main-logo" style="font-size:40px;margin-bottom:10px">🚕</div>
            <h1 id="app-main-title" style="font-size:22px;font-weight:900;margin:0 0 6px;color:#111">منصة توصيله</h1>
            <p id="app-main-subtitle" style="font-size:13px;color:#6b7280;margin:0">النجف الأشرف - سجّل دخولك أو أنشئ حسابك</p>
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
            <div id="driver-route-btn-wrap" style="display:none;margin-top:12px">
                <button type="button" id="btn-user-main-app" onclick="openRouteApp('set-route')" class="btn-primary" style="padding:13px 16px;font-size:14px;font-weight:900;background:linear-gradient(135deg,#2563eb,#1d4ed8);display:flex;align-items:center;justify-content:center;gap:8px;border-radius:12px;width:100%;box-shadow:0 4px 14px rgba(37,99,235,0.3);">
                    <span id="btn-user-main-app-icon">👤</span> <span id="btn-user-main-app-text">واجهة الراكب</span>
                </button>
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
                            <button type="button" onclick="startTruecallerVerification('customer')" class="btn-primary" style="background:linear-gradient(135deg,#0087ff,#005bb5);margin-bottom:8px;display:flex;align-items:center;justify-content:center;gap:8px;border:none;box-shadow:0 3px 10px rgba(0,135,255,0.25)" aria-label="تحقق عبر تراكولر">
                                <i class="fa-solid fa-bolt" aria-hidden="true"></i> تحقق فوري عبر Truecaller
                            </button>
                            <button type="button" id="btn-send-whatsapp-otp" onclick="handleSendWhatsappOtp(false)" class="btn-secondary" style="width:100%;border-color:#16a34a;color:#16a34a;background:#f0fdf4" aria-label="إرسال رمز واتساب">
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

                        <!-- Governorate Dropdown (Auto-located) -->
                        <input type="hidden" id="cust-reg-governorate" value="najaf">

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

                        <!-- Hidden coords (empty until selected by user on map) -->
                        <input type="hidden" id="cust-pickup-lat" value="">
                        <input type="hidden" id="cust-pickup-lon" value="">
                        <input type="hidden" id="cust-dropoff-lat" value="">
                        <input type="hidden" id="cust-dropoff-lon" value="">

                        <!-- Route / Address (auto-filled from map or typed by user) -->
                        <div style="margin-bottom:12px">
                            <label for="cust-reg-address" class="label">عنوان الانطلاق بالتفصيل <span style="color:#dc2626">*</span></label>
                            <input type="text" id="cust-reg-address" class="inp" placeholder="حدد الانطلاق من الخريطة أو اكتبه هنا" aria-label="عنوان الانطلاق">
                        </div>
                        <div style="margin-bottom:12px">
                            <label for="cust-reg-route" class="label">عنوان الوصول بالتفصيل <span style="color:#dc2626">*</span></label>
                            <input type="text" id="cust-reg-route" class="inp" placeholder="حدد الوصول من الخريطة أو اكتبه هنا" aria-label="عنوان الوصول">
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
                            <button type="button" onclick="startTruecallerVerification('driver')" class="btn-primary" style="background:linear-gradient(135deg,#0087ff,#005bb5);margin-bottom:8px;display:flex;align-items:center;justify-content:center;gap:8px;border:none;box-shadow:0 3px 10px rgba(0,135,255,0.25)" aria-label="تحقق عبر تراكولر">
                                <i class="fa-solid fa-bolt" aria-hidden="true"></i> تحقق فوري عبر Truecaller
                            </button>
                            <button type="button" id="btn-send-driver-otp" onclick="handleSendDriverWhatsappOtp(false)" class="btn-secondary" style="width:100%;border-color:#16a34a;color:#16a34a;background:#f0fdf4" aria-label="إرسال رمز واتساب">
                                <i class="fa-brands fa-whatsapp" aria-hidden="true"></i> إرسال رمز التحقق عبر واتساب
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

                        <!-- Governorate Dropdown (Auto-located) -->
                        <input type="hidden" id="driver-reg-governorate" value="najaf">

                        <!-- Driver Service Type Selection -->
                        <div style="margin-bottom:12px">
                            <label class="label" style="margin-bottom:10px">نوع الخدمة <span style="color:#dc2626">*</span></label>
                            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                                <div class="trip-card" id="drv-reg-short" onclick="selectDriverRegServiceType('ShortTrip')" style="text-align:center;padding:10px 6px">
                                    <div style="font-size:20px;margin-bottom:4px">⚡</div>
                                    <div style="font-size:12px;font-weight:900">مشاوير</div>
                                    <div style="font-size:10px;color:#6b7280;margin-top:2px">رحلات فورية</div>
                                </div>
                                <div class="trip-card" id="drv-reg-daily" onclick="selectDriverRegServiceType('PermanentLine')" style="text-align:center;padding:10px 6px">
                                    <div style="font-size:20px;margin-bottom:4px">🔄</div>
                                    <div style="font-size:12px;font-weight:900">خطوط دائمة</div>
                                    <div style="font-size:10px;color:#6b7280;margin-top:2px">اشتراك يومي</div>
                                </div>
                                <div class="trip-card" id="drv-reg-both" onclick="selectDriverRegServiceType('Both')" style="text-align:center;padding:10px 6px">
                                    <div style="font-size:20px;margin-bottom:4px">🚖</div>
                                    <div style="font-size:12px;font-weight:900">كلاهما</div>
                                    <div style="font-size:10px;color:#6b7280;margin-top:2px">مشاوير+خطوط</div>
                                </div>
                            </div>
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
                        <!-- Driver Route (من/إلى) -->
                        <div style="border:1.5px solid #e5e7eb;border-radius:12px;padding:12px;margin-bottom:16px">
                            <div style="font-size:12px;font-weight:700;color:#111;margin-bottom:8px">🛣️ مسارك الفعلي (إلزامي) <span style="color:#dc2626">*</span></div>
                            <div style="position:relative;margin-bottom:8px">
                                <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);width:8px;height:8px;border-radius:50%;background:#16a34a;display:inline-block"></span>
                                <input type="text" id="driver-reg-from" required class="inp" style="padding-right:26px;font-size:12px" placeholder="نقطة انطلاقك الفعلية (حي/شارع)" aria-label="نقطة انطلاق السائق">
                            </div>
                            <div style="position:relative">
                                <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);width:8px;height:8px;border-radius:50%;background:#dc2626;display:inline-block"></span>
                                <input type="text" id="driver-reg-to" required class="inp" style="padding-right:26px;font-size:12px" placeholder="نقطة وصولك الفعلية (حي/شارع)" aria-label="نقطة وصول السائق">
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

        <footer id="app-main-footer" style="text-align:center;margin-top:28px;font-size:12px;color:#9ca3af">
            © 2026 توصيله (Tawseela IQ) · النجف الأشرف
        </footer>
        <div id="custom-buttons-container" style="margin-top:16px"></div>
        <div id="ads-container" style="margin-top:12px"></div>
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

        // ===== Iraqi Governorates with bbox & center =====
        var IRAQ_GOVERNORATES = {
            baghdad:      { name: 'بغداد',       center: [44.3661, 33.3152], bbox: '44.10,33.10,44.65,33.55' },
            basra:        { name: 'البصرة',      center: [47.7835, 30.5085], bbox: '47.30,29.90,48.60,31.20' },
            najaf:        { name: 'النجف',       center: [44.3168, 31.9961], bbox: '44.05,31.75,44.65,32.35' },
            karbala:      { name: 'كربلاء',      center: [44.0249, 32.6160], bbox: '43.65,32.30,44.45,33.00' },
            erbil:        { name: 'أربيل',       center: [44.0089, 36.1912], bbox: '43.40,35.70,45.10,37.00' },
            sulaymaniyah: { name: 'السليمانية',   center: [45.4351, 35.5574], bbox: '44.60,34.90,46.30,36.30' },
            duhok:        { name: 'دهوك',        center: [42.9884, 36.8670], bbox: '42.30,36.40,44.00,37.40' },
            kirkuk:       { name: 'كركوك',       center: [44.3958, 35.4681], bbox: '43.50,34.60,45.40,36.10' },
            nineveh:      { name: 'نينوى',       center: [43.1340, 36.3350], bbox: '41.80,35.40,44.30,37.30' },
            diyala:       { name: 'ديالى',       center: [44.9500, 33.7487], bbox: '44.30,33.10,46.10,34.80' },
            anbar:        { name: 'الأنبار',     center: [41.9000, 33.4000], bbox: '38.80,31.50,44.20,35.00' },
            babil:        { name: 'بابل',        center: [44.4200, 32.4680], bbox: '44.00,32.00,45.00,33.00' },
            wasit:        { name: 'واسط',        center: [45.8306, 32.6027], bbox: '45.00,32.00,46.80,33.30' },
            saladin:      { name: 'صلاح الدين',  center: [43.8750, 34.4640], bbox: '43.00,33.50,45.00,35.50' },
            dhi_qar:      { name: 'ذي قار',      center: [46.2570, 31.0439], bbox: '45.30,30.30,47.30,31.80' },
            maysan:       { name: 'ميسان',       center: [47.2340, 31.8379], bbox: '46.30,31.00,48.00,33.00' },
            muthanna:     { name: 'المثنى',      center: [45.2980, 31.3200], bbox: '44.00,29.80,46.40,31.90' },
            qadisiyyah:   { name: 'القادسية',    center: [44.9330, 31.9845], bbox: '44.40,31.40,45.60,32.60' }
        };

        var selectedGovernorate = localStorage.getItem('user_governorate') || '';
        var selectedDriverRegService = null;

        window.onGovernorateChange = function(govKey, role) {
            selectedGovernorate = govKey;
            localStorage.setItem('user_governorate', govKey);
            var gov = IRAQ_GOVERNORATES[govKey];
            if (!gov) return;
            bUserLat = gov.center[1];
            bUserLon = gov.center[0];
            var parts = gov.bbox.split(',').map(Number);
            var bounds = [[parts[0], parts[1]], [parts[2], parts[3]]];
            if (passengerMap) {
                passengerMap.flyTo({ center: gov.center, zoom: 12 });
                try { passengerMap.setMaxBounds(bounds); } catch(_) {}
            }
            if (bMap) {
                bMap.flyTo({ center: gov.center, zoom: 12 });
                try { bMap.setMaxBounds(bounds); } catch(_) {}
            }
        };

        window.selectDriverRegServiceType = function(type) {
            selectedDriverRegService = type;
            var s = document.getElementById('drv-reg-short');
            var d = document.getElementById('drv-reg-daily');
            var b = document.getElementById('drv-reg-both');
            if (s) s.className = (type === 'ShortTrip') ? 'trip-card selected' : 'trip-card';
            if (d) d.className = (type === 'PermanentLine') ? 'trip-card selected' : 'trip-card';
            if (b) b.className = (type === 'Both') ? 'trip-card selected' : 'trip-card';
        };

        // Helper: get active search bbox string (Iraq-wide)
        function getActiveGovBbox() {
            return '38.79,29.07,48.63,37.38';
        }

        // ===== Trip type modal (after login) =====
        var _pendingAppParams = null;
        var selectedTripType = null;
        var selectedDriverServiceType = null;

        function selectTripType(type) {
            selectedTripType = type;
            var cShort = document.getElementById('trip-short');
            var cDaily = document.getElementById('trip-daily');
            if (cShort) cShort.className = (type === 'short') ? 'trip-card selected' : 'trip-card';
            if (cDaily) cDaily.className = (type === 'daily') ? 'trip-card selected' : 'trip-card';
            var btn = document.getElementById('btn-open-app');
            if (btn) { btn.disabled = false; btn.style.opacity = '1'; }

            var nearbyBox = document.getElementById('passenger-short-drivers-box');
            if (type === 'short') {
                if (nearbyBox) {
                    nearbyBox.style.display = 'block';
                    loadNearbyShortDrivers();
                }
            } else {
                if (nearbyBox) {
                    nearbyBox.style.display = 'none';
                }
            }
        }

        function selectDriverServiceType(type) {
            selectedDriverServiceType = type;
            var btnShort = document.getElementById('drv-opt-short');
            var btnDaily = document.getElementById('drv-opt-daily');
            var btnBoth = document.getElementById('drv-opt-both');
            if (btnShort) btnShort.className = (type === 'ShortTrip') ? 'trip-card selected' : 'trip-card';
            if (btnDaily) btnDaily.className = (type === 'PermanentLine') ? 'trip-card selected' : 'trip-card';
            if (btnBoth) btnBoth.className = (type === 'Both') ? 'trip-card selected' : 'trip-card';
            var btn = document.getElementById('btn-open-app');
            if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        }

        async function loadNearbyShortDrivers() {
            var container = document.getElementById('passenger-short-drivers-list');
            if (!container) return;
            container.innerHTML = '<div style="text-align:center;padding:12px;color:#6b7280;font-size:12px"><i class="fa-solid fa-circle-notch fa-spin"></i> جاري البحث عن السائقين القريبين للمشاوير القصيرة...</div>';

            var lat = 31.9961;
            var lon = 44.3168;
            if (navigator.geolocation) {
                try {
                    var pos = await new Promise(function(resolve, reject){
                        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 3500 });
                    });
                    if (pos && pos.coords) {
                        lat = pos.coords.latitude;
                        lon = pos.coords.longitude;
                    }
                } catch(_) {}
            }

            try {
                var res = await fetch('/api/drivers/nearby?tripType=short&lat=' + lat + '&lon=' + lon);
                var drivers = await res.json();
                if (!Array.isArray(drivers) || drivers.length === 0) {
                    container.innerHTML = '<div style="background:#fff;border:1px dashed #d1d5db;border-radius:10px;padding:12px;text-align:center;font-size:12px;color:#6b7280">🚕 لا يوجد سائقون قريبون للمشاوير القصيرة حالياً في نطاقك.<br><span style="font-size:11px;color:#9ca3af">يمكنك المتابعة وسيتم تنبيه السائقين فور توفرهم.</span></div>';
                    return;
                }

                var html = '';
                drivers.slice(0, 6).forEach(function(d) {
                    var name = d.driverName || d.fullName || 'كابتن توصيله';
                    var vehicle = d.vehicleInfo || d.carModel || 'تويوتا كورولا';
                    var dist = (d.distanceKm !== undefined ? d.distanceKm.toFixed(1) + ' كم' : 'قريب منك');
                    var phone = d.phone || d.phoneNumber || '';
                    var waNum = phone.replace(/[^0-9]/g, '').replace(/^07/, '9647');
                    
                    html += '<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:9px 12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;text-align:right">' +
                        '<div>' +
                            '<div style="font-weight:800;font-size:13px;color:#111;display:flex;align-items:center;gap:6px">' +
                                '<span>🚕</span><span>' + name + '</span>' +
                                '<span style="background:#e0f2fe;color:#0369a1;font-size:10px;padding:2px 6px;border-radius:6px;font-weight:700">⚡ مشوار قصير</span>' +
                            '</div>' +
                            '<div style="font-size:11px;color:#6b7280;margin-top:2px">' + vehicle + ' • 📍 ' + dist + '</div>' +
                        '</div>' +
                        '<div style="display:flex;gap:6px">' +
                            (waNum ? '<a href="https://wa.me/' + waNum + '" target="_blank" style="background:#25D366;color:#fff;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:700;text-decoration:none;display:inline-flex;align-items:center;gap:4px">واتساب</a>' : '') +
                        '</div>' +
                    '</div>';
                });
                container.innerHTML = html;
            } catch(e) {
                container.innerHTML = '<div style="font-size:12px;color:#ef4444;text-align:center;padding:8px">تعذر جلب السائقين القريبين حالياً. اضغط متابعة لفتح التطبيق.</div>';
            }
        }

        async function confirmTripTypeAndOpen() {
            if (!_pendingAppParams) return;
            var modal = document.getElementById('trip-type-modal');
            var p = _pendingAppParams;
            var isDriver = (p.role === 'Driver' || p.role === 'driver');
            
            if (isDriver) {
                var sType = selectedDriverServiceType || 'Both';
                try {
                    localStorage.setItem('driver_service_type', sType);
                    localStorage.setItem('flutter.driver_service_type', JSON.stringify(sType));
                    await fetch('/api/driver/service-type', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ driverId: p.userId, serviceType: sType })
                    });
                } catch(_) {}
            } else {
                try {
                    localStorage.setItem('selected_trip_type', selectedTripType || 'short');
                    localStorage.setItem('flutter.selected_trip_type', JSON.stringify(selectedTripType || 'short'));
                } catch(_) {}
            }
            if (modal) modal.style.display = 'none';
            if (isDriver) {
                window.openBookingApp('driver');
            } else {
                window.openBookingApp(selectedTripType || 'short');
            }
        }

        function showTripTypeModal(token, userId, role, fullName) {
            _pendingAppParams = { token, userId, role, fullName };
            var isDriver = (role === 'Driver' || role === 'driver');
            
            var modalIcon = document.getElementById('trip-modal-icon');
            var modalTitle = document.getElementById('trip-modal-title');
            var modalSubtitle = document.getElementById('trip-modal-subtitle');
            var passContainer = document.getElementById('passenger-trip-options');
            var drvContainer = document.getElementById('driver-trip-options');
            var nearbyBox = document.getElementById('passenger-short-drivers-box');
            var btn = document.getElementById('btn-open-app');

            if (nearbyBox) nearbyBox.style.display = 'none';

            if (isDriver) {
                selectedDriverServiceType = null;
                if (modalIcon) modalIcon.textContent = '🚖';
                if (modalTitle) modalTitle.textContent = 'نوع المشاوير التي تقدمها';
                if (modalSubtitle) modalSubtitle.textContent = 'اختر نمط عملك المفضل في توصيلة كابتن';
                if (passContainer) passContainer.style.display = 'none';
                if (drvContainer) drvContainer.style.display = 'grid';
                var btnShort = document.getElementById('drv-opt-short');
                var btnDaily = document.getElementById('drv-opt-daily');
                var btnBoth = document.getElementById('drv-opt-both');
                if (btnShort) btnShort.className = 'trip-card';
                if (btnDaily) btnDaily.className = 'trip-card';
                if (btnBoth) btnBoth.className = 'trip-card';
                if (btn) {
                    btn.textContent = 'متابعة ودخول لوحة السائق';
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                }
            } else {
                selectedTripType = null;
                if (modalIcon) modalIcon.textContent = '🚕';
                if (modalTitle) modalTitle.textContent = 'اختر نوع الرحلة';
                if (modalSubtitle) modalSubtitle.textContent = 'حدد ما يناسبك قبل فتح التطبيق';
                if (drvContainer) drvContainer.style.display = 'none';
                if (passContainer) passContainer.style.display = 'grid';
                var cShort = document.getElementById('trip-short');
                var cDaily = document.getElementById('trip-daily');
                if (cShort) cShort.className = 'trip-card';
                if (cDaily) cDaily.className = 'trip-card';
                if (btn) {
                    btn.textContent = 'متابعة وفتح التطبيق';
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                }
            }

            var modal = document.getElementById('trip-type-modal');
            if (modal) { modal.style.display = 'flex'; }
        }

        window.closeTripTypeModal = function() {
            var modal = document.getElementById('trip-type-modal');
            if (modal) modal.style.display = 'none';
        };

        window.openUserAppNow = function() {
            var role = localStorage.getItem('user_role') || 'Customer';
            var status = localStorage.getItem('driver_status') || '';
            if (role === 'Driver' && (status === 'Pending' || status === 'Rejected')) {
                alert('⚠️ حسابك معلّق بانتظار التوثيق من قبل إدارة المنصة.\\nيرجى إرسال المستمسكات عبر الواتساب أو التيليجرام للاعتماد.');
                return;
            }
            openRouteApp('set-route');
        };

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
                    if (data.status === 'Pending' || data.isVerified === false) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> دخول';
                        alert('⚠️ حسابك معلّق بانتظار التوثيق من قبل إدارة المنصة.\\nيرجى إرسال المستمسكات عبر الواتساب أو التيليجرام للاعتماد.');
                        return;
                    }
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

        // ===== Truecaller Verification =====
        var _truecallerPollTimer = null;
        function startTruecallerVerification(role) {
            var partnerKey = 'eicFd6d7759e7941e4527934ffac0102354f7';
            var nonce = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
            var isDriver = (role === 'driver');
            var alertBox = document.getElementById(isDriver ? 'driver-reg-alert' : 'cust-reg-alert');
            if (alertBox) {
                alertBox.style.display = 'block';
                alertBox.className = 'alert-info';
                alertBox.style.background = '#eff6ff';
                alertBox.style.color = '#1d4ed8';
                alertBox.style.border = '1px solid #bfdbfe';
                alertBox.style.padding = '10px 14px';
                alertBox.style.borderRadius = '8px';
                alertBox.style.fontSize = '13px';
                alertBox.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> جاري فتح تطبيق Truecaller للتحقق الفوري من رقمك...';
            }

            var deepLink = 'truecallersdk://truesdk/web_verify?type=btmsheet&requestNonce=' + encodeURIComponent(nonce) + '&partnerKey=' + encodeURIComponent(partnerKey) + '&partnerName=' + encodeURIComponent('توصيلة') + '&lang=ar&title=' + encodeURIComponent('تأكيد رقم الهاتف');

            var startTime = Date.now();
            window.location.href = deepLink;

            setTimeout(function() {
                if (document.hasFocus() && (Date.now() - startTime < 3500)) {
                    if (alertBox && alertBox.innerHTML.indexOf('جاري فتح') !== -1) {
                        alertBox.className = 'alert-warning';
                        alertBox.style.background = '#fffbeb';
                        alertBox.style.color = '#b45309';
                        alertBox.style.border = '1px solid #fde68a';
                        alertBox.innerHTML = '<i class="fa-solid fa-circle-info"></i> إذا لم يفتح تطبيق Truecaller، يمكنك تأكيد رقمك عبر زر واتساب أدناه.';
                    }
                }
            }, 2500);

            if (_truecallerPollTimer) clearInterval(_truecallerPollTimer);
            var pollAttempts = 0;
            var maxAttempts = 60;

            _truecallerPollTimer = setInterval(async function() {
                pollAttempts++;
                if (pollAttempts > maxAttempts) {
                    clearInterval(_truecallerPollTimer);
                    _truecallerPollTimer = null;
                    if (alertBox && alertBox.innerHTML.indexOf('جاري فتح') !== -1) {
                        alertBox.style.display = 'none';
                    }
                    return;
                }

                try {
                    var res = await fetch('/api/auth/truecaller/status?requestId=' + encodeURIComponent(nonce));
                    var data = await res.json();
                    if (data && data.status === 'verified') {
                        clearInterval(_truecallerPollTimer);
                        _truecallerPollTimer = null;

                        if (isDriver) {
                            window.__isDriverPhoneVerified = true;
                            window.__verifiedDriverOtpCode = 'TRUECALLER_VERIFIED';
                            var pi = document.getElementById('driver-reg-phone');
                            if (pi) { pi.value = data.phoneNumber || pi.value; pi.readOnly = true; }
                            var ni = document.getElementById('driver-reg-name');
                            if (ni && !ni.value && data.fullName) { ni.value = data.fullName; }
                            var ob = document.getElementById('driver-otp-box');
                            if (ob) ob.style.display = 'none';
                            var sw = document.getElementById('driver-send-otp-wrap');
                            if (sw) sw.style.display = 'none';
                            var badge = document.getElementById('driver-verified-badge');
                            if (badge) badge.style.display = 'flex';
                            var det = document.getElementById('driver-details-section');
                            if (det) det.style.display = 'block';
                            if (alertBox) {
                                alertBox.className = 'alert-success';
                                alertBox.style.background = '#f0fdf4';
                                alertBox.style.color = '#15803d';
                                alertBox.style.border = '1px solid #bbf7d0';
                                alertBox.innerHTML = '<i class="fa-solid fa-circle-check"></i> تم التحقق بنجاح من رقمك عبر Truecaller ✅';
                                setTimeout(function(){ alertBox.style.display = 'none'; }, 4000);
                            }
                        } else {
                            window.__isPhoneVerified = true;
                            window.__verifiedOtpCode = 'TRUECALLER_VERIFIED';
                            var pi = document.getElementById('cust-reg-phone');
                            if (pi) { pi.value = data.phoneNumber || pi.value; pi.readOnly = true; }
                            if (data.fullName) {
                                var parts = data.fullName.trim().split(/\s+/);
                                var fi = document.getElementById('cust-reg-firstname');
                                var li = document.getElementById('cust-reg-lastname');
                                if (fi && !fi.value && parts[0]) fi.value = parts[0];
                                if (li && !li.value && parts.length > 1) li.value = parts.slice(1).join(' ');
                            }
                            var ob = document.getElementById('cust-otp-box');
                            if (ob) ob.style.display = 'none';
                            var sw = document.getElementById('cust-send-otp-wrap');
                            if (sw) sw.style.display = 'none';
                            var badge = document.getElementById('cust-verified-badge');
                            if (badge) badge.style.display = 'flex';
                            var det = document.getElementById('cust-details-section');
                            if (det) { det.style.display = 'block'; if (typeof initPassengerMapbox === 'function') initPassengerMapbox(); }
                            if (alertBox) {
                                alertBox.className = 'alert-success';
                                alertBox.style.background = '#f0fdf4';
                                alertBox.style.color = '#15803d';
                                alertBox.style.border = '1px solid #bbf7d0';
                                alertBox.innerHTML = '<i class="fa-solid fa-circle-check"></i> تم التحقق بنجاح من رقمك عبر Truecaller ✅';
                                setTimeout(function(){ alertBox.style.display = 'none'; }, 4000);
                            }
                        }
                    } else if (data && data.status === 'rejected') {
                        clearInterval(_truecallerPollTimer);
                        _truecallerPollTimer = null;
                        if (alertBox) {
                            alertBox.className = 'alert-warning';
                            alertBox.style.background = '#fffbeb';
                            alertBox.style.color = '#b45309';
                            alertBox.style.border = '1px solid #fde68a';
                            alertBox.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ' + (data.error || 'تم إلغاء التحقق عبر Truecaller');
                        }
                    }
                } catch(e) {
                    console.warn('Truecaller status poll error:', e);
                }
            }, 2000);
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
            if (_truecallerPollTimer) { clearInterval(_truecallerPollTimer); _truecallerPollTimer = null; }
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
            var gov = (document.getElementById('cust-reg-governorate')?.value||'').trim() || localStorage.getItem('user_governorate') || 'najaf';
            localStorage.setItem('user_governorate', gov);
            var fname = (document.getElementById('cust-reg-firstname').value||'').trim();
            var lname = (document.getElementById('cust-reg-lastname').value||'').trim();
            var fullName = (fname + ' ' + lname).trim();
            var phone = normalizeArabicDigits(document.getElementById('cust-reg-phone').value.trim());
            var route = (document.getElementById('cust-reg-route').value||'').trim() || (IRAQ_GOVERNORATES[gov]?.name || 'العراق');
            var address = (document.getElementById('cust-reg-address').value||'').trim() || (IRAQ_GOVERNORATES[gov]?.name || 'العراق');
            var password = document.getElementById('cust-reg-password').value;
            var submitBtn = document.getElementById('btn-cust-reg-submit');
            if (!fname || !lname) { alert('يرجى إدخال الاسم واللقب'); return; }
            if (!password) { alert('يرجى إدخال كلمة المرور'); return; }
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> جاري التسجيل...';
            var pickupText = (document.getElementById('cust-pickup-text')?.value||'').trim();
            var dropoffText = (document.getElementById('cust-dropoff-text')?.value||'').trim();
            var address = (document.getElementById('cust-reg-address').value||'').trim() || pickupText;
            var route = (document.getElementById('cust-reg-route').value||'').trim() || dropoffText;
            var pickupLat = document.getElementById('cust-pickup-lat')?.value;
            var pickupLon = document.getElementById('cust-pickup-lon')?.value;
            var dropoffLat = document.getElementById('cust-dropoff-lat')?.value;
            var dropoffLon = document.getElementById('cust-dropoff-lon')?.value;

            if (!pickupLat || !pickupLon || !dropoffLat || !dropoffLon || !address || !route) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> إكمال تسجيل الحساب';
                alert('⚠️ يجب تحديد مسارك الفعلي (نقطة الانطلاق ونقطة الوصول) على الخريطة أولاً لإكمال التسجيل');
                return;
            }

            try {
                var res = await fetch('/api/auth/complete-passenger-registration', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({fullName,phoneNumber:phone,route,address,password,otpCode:window.__verifiedOtpCode||'',pickupLat:parseFloat(pickupLat),pickupLon:parseFloat(pickupLon),dropoffLat:parseFloat(dropoffLat),dropoffLon:parseFloat(dropoffLon),tripType:selectedRegTripType||'short',governorate:gov})
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
            if (_truecallerPollTimer) { clearInterval(_truecallerPollTimer); _truecallerPollTimer = null; }
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
            var gov = (document.getElementById('driver-reg-governorate')?.value||'').trim() || localStorage.getItem('user_governorate') || 'najaf';
            if (!selectedDriverRegService) { alert('يرجى اختيار نوع الخدمة (مشاوير، خطوط دائمة، كلاهما)'); return; }
            localStorage.setItem('user_governorate', gov);
            var name=(document.getElementById('driver-reg-name').value||'').trim();
            var phone=normalizeArabicDigits(document.getElementById('driver-reg-phone').value.trim());
            var license=(document.getElementById('driver-reg-license').value||'').trim();
            var vehicle=(document.getElementById('driver-reg-vehicle')?.value||'').trim();
            var plate=(document.getElementById('driver-reg-plate')?.value||'').trim();
            var password=document.getElementById('driver-reg-password').value;
            var fromRoute=(document.getElementById('driver-reg-from')?.value||'').trim();
            var toRoute=(document.getElementById('driver-reg-to')?.value||'').trim();
            var submitBtn=document.getElementById('btn-driver-reg-submit');
            if(!name||!phone||!password){alert('يرجى ملء جميع الحقول المطلوبة');return;}
            if(!fromRoute||!toRoute){alert('⚠️ يجب تحديد مسارك الفعلي (نقطة الانطلاق ونقطة الوصول) لإكمال التسجيل');return;}
            submitBtn.disabled=true;
            submitBtn.innerHTML='<i class="fa-solid fa-circle-notch fa-spin"></i> جاري التسجيل...';
            try {
                var res = await fetch('/api/auth/complete-driver-registration',{
                    method:'POST',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({fullName:name,phoneNumber:phone,licenseNumber:license,vehicleMake:vehicle,vehiclePlate:plate,password,fromRoute,toRoute,route:(fromRoute+' ➔ '+toRoute),otpCode:window.__verifiedDriverOtpCode||'',governorate:gov,serviceType:selectedDriverRegService})
                });
                var data = await res.json();
                if (res.ok && data.success) {
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> تم استلام الطلب!';
                    var formBox = document.getElementById('driver-register-form');
                    var tgLink = window.__telegramAdminLink || 'https://t.me/tawseela_najaf_bot';
                    var waLink = window.__whatsappAdminLink || 'https://wa.me/9647706204066';
                    if (formBox) {
                        formBox.innerHTML = '<div style="background:#fffbeb;border:2px solid #fde68a;border-radius:14px;padding:22px 18px;text-align:center">' +
                            '<div style="font-size:38px;margin-bottom:10px">⏳</div>' +
                            '<h3 style="font-size:16px;font-weight:900;color:#92400e;margin:0 0 8px">تم تسجيل طلبك بنجاح - الحساب معلّق</h3>' +
                            '<p style="font-size:13px;color:#78350f;margin:0 0 16px;line-height:1.6">حسابك الآن بانتظار توثيق الإدارة. لن تتمكن من الدخول أو استقبال الطلبات حتى إرسال مستمسكاتك واعتماد الحساب من لوحة التحكم.</p>' +
                            '<div style="background:#ffffff;border:1.5px solid #fcd34d;border-radius:12px;padding:14px;text-align:right;margin-bottom:16px">' +
                                '<div style="font-weight:900;font-size:13px;color:#92400e;margin-bottom:10px">📋 يرجى إرسال المستمسكات (البطاقة، إجازة السوق، السنوية) عبر:</div>' +
                                '<div style="display:flex;flex-direction:column;gap:8px">' +
                                    '<a href="' + waLink + '" target="_blank" style="display:flex;align-items:center;justify-content:center;gap:8px;background:#25d366;color:#fff;padding:11px;border-radius:10px;font-weight:900;font-size:13px;text-decoration:none">📱 إرسال عبر واتساب الإدارة</a>' +
                                    '<a href="' + tgLink + '" target="_blank" style="display:flex;align-items:center;justify-content:center;gap:8px;background:#0088cc;color:#fff;padding:11px;border-radius:10px;font-weight:900;font-size:13px;text-decoration:none">💬 إرسال عبر تيليجرام الإدارة</a>' +
                                '</div>' +
                            '</div>' +
                            '<p style="font-size:12px;color:#a16207;font-weight:700;margin:0">سيتم تفعيل حسابك من قبل الإدارة بعد مراجعة المستمسكات.</p>' +
                        '</div>';
                    }
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
            drawRouteLine();
            showNearestDriver();
        }

        function updateDropoffPoint(lng,lat,doReverse) {
            document.getElementById('cust-dropoff-lat').value=Number(lat).toFixed(6);
            document.getElementById('cust-dropoff-lon').value=Number(lng).toFixed(6);
            if(!dropoffMarker&&passengerMap){
                dropoffMarker=new mapboxgl.Marker({color:'#dc2626',draggable:true}).setLngLat([lng,lat]).addTo(passengerMap);
                dropoffMarker.on('dragend',function(){var p=dropoffMarker.getLngLat();updateDropoffPoint(p.lng,p.lat,true);});
            } else if(dropoffMarker) dropoffMarker.setLngLat([lng,lat]);
            if(doReverse) reverseGeocodeLocation(lng,lat,'dropoff');
            drawRouteLine();
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
                var initialCenter = [bUserLon || 44.3168, bUserLat || 31.9961];
                passengerMap=new mapboxgl.Map({container:'passenger-map',style:'mapbox://styles/mapbox/streets-v12',center:initialCenter,zoom:13});
                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(function(pos) {
                        if (passengerMap) {
                            passengerMap.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 14 });
                        }
                    }, function(_) {}, { enableHighAccuracy: true, timeout: 10000 });
                }
                if(typeof mapboxgl.getRTLTextPluginStatus==='function'&&mapboxgl.getRTLTextPluginStatus()==='unavailable'){
                    mapboxgl.setRTLTextPlugin('https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js',null,true);
                }
                passengerMap.addControl(new mapboxgl.NavigationControl({showCompass:true}),'top-left');
                passengerMap.on('load',function(){
                    // Map loads clean without static default route
                });
                passengerMap.on('click',function(e){
                    if(currentPinMode==='pickup') updatePickupPoint(e.lngLat.lng,e.lngLat.lat,true);
                    else updateDropoffPoint(e.lngLat.lng,e.lngLat.lat,true);
                });
            } catch(e){console.error('Mapbox error:',e);}
        }

        // Draw route between pickup and dropoff
        async function drawRouteLine() {
            if (!passengerMap || !window.mapboxgl) return;
            try {
                var pLat = document.getElementById('cust-pickup-lat').value;
                var pLon = document.getElementById('cust-pickup-lon').value;
                var dLat = document.getElementById('cust-dropoff-lat').value;
                var dLon = document.getElementById('cust-dropoff-lon').value;
                if (!pLat || !dLat) return;
                var token = mapboxgl.accessToken;
                var url = 'https://api.mapbox.com/directions/v5/mapbox/driving/' + pLon+','+pLat+';'+dLon+','+dLat+'?geometries=geojson&overview=full&access_token='+token;
                var res = await fetch(url);
                var data = await res.json();
                if (!data.routes || !data.routes[0]) return;
                var route = data.routes[0].geometry;
                if (passengerMap.getSource('route-line')) {
                    passengerMap.getSource('route-line').setData({ type:'Feature', geometry: route });
                } else {
                    passengerMap.addSource('route-line', { type:'geojson', data:{ type:'Feature', geometry: route } });
                    passengerMap.addLayer({ id:'route-line-layer', type:'line', source:'route-line', paint:{ 'line-color':'#111111', 'line-width':4, 'line-opacity':0.85 }, layout:{ 'line-cap':'round', 'line-join':'round' } });
                }
                // Show distance and time
                var dist = (data.routes[0].distance/1000).toFixed(1);
                var mins = Math.round(data.routes[0].duration/60);
                var info = document.getElementById('route-info-display');
                if (info) info.innerHTML = '📏 '+dist+' كم · ⏱️ '+mins+' دقيقة';
            } catch(e) { console.error('Route error:', e); }
        }

        // Show nearest driver on map
        var nearestDriverMarker = null;
        async function showNearestDriver() {
            if (!passengerMap) return;
            try {
                var pLat = parseFloat(document.getElementById('cust-pickup-lat').value) || 32.02;
                var pLon = parseFloat(document.getElementById('cust-pickup-lon').value) || 44.32;
                var res = await fetch('/api/fleet/active-drivers');
                var data = await res.json();
                var drivers = (data.drivers || data || []).filter(function(d) { return d.lat && d.lon; });
                if (drivers.length === 0) return;
                var closest = null, minDist = Infinity;
                drivers.forEach(function(d) {
                    var dx = d.lat - pLat, dy = d.lon - pLon;
                    var dist = Math.sqrt(dx*dx + dy*dy);
                    if (dist < minDist) { minDist = dist; closest = d; }
                });
                if (!closest) return;
                if (nearestDriverMarker) nearestDriverMarker.remove();
                var el = document.createElement('div');
                el.style.cssText = 'width:32px;height:32px;background:#111;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
                el.textContent = '🚕';
                nearestDriverMarker = new mapboxgl.Marker({ element: el }).setLngLat([closest.lon, closest.lat]).addTo(passengerMap);
                var ndi = document.getElementById('nearest-driver-info');
                if (ndi) ndi.innerHTML = '🚕 أقرب سائق: ' + (closest.name||'متاح') + ' (' + (minDist*111).toFixed(1) + ' كم)';
            } catch(e) {}
        }

        // ===== Geocode text input for passenger (Feature 4) =====
        var geocodeTimers = {};
        window.geocodePassengerInput = function(q, target) {
            clearTimeout(geocodeTimers[target]);
            var resultsEl = document.getElementById('cust-'+target+'-results');
            if (!resultsEl) return;
            if (!q || q.length < 1) { resultsEl.style.display = 'none'; return; }
            geocodeTimers[target] = setTimeout(async function() {
                try {
                    var token = ('pk.'+'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9'+'._J6DYjYBDhsdcidErQrblA');
                    var activeGov = IRAQ_GOVERNORATES[selectedGovernorate || localStorage.getItem('user_governorate') || 'najaf'] || IRAQ_GOVERNORATES.najaf;
                    var bbox = getActiveGovBbox();
                    var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/'+encodeURIComponent(q)+'.json?proximity='+activeGov.center[0]+','+activeGov.center[1]+'&bbox='+bbox+'&country=iq&language=ar&types=poi,address,neighborhood,place,locality&limit=5&access_token='+token;
                    var res = await fetch(url);
                    var data = await res.json();
                    var feats = (data && data.features) ? data.features : [];
                    if (feats.length === 0) {
                        try {
                            var or = await fetch('https://nominatim.openstreetmap.org/search?format=json&countrycodes=iq&q='+encodeURIComponent(q+' '+activeGov.name));
                            var od = await or.json();
                            if (od && od.length > 0) feats = od.map(function(o){ return { place_name_ar: o.display_name, center: [parseFloat(o.lon), parseFloat(o.lat)] }; });
                        } catch(_) {}
                    }
                    resultsEl.innerHTML = '';
                    if (feats.length > 0) {
                        resultsEl.style.display = 'block';
                        feats.slice(0, 5).forEach(function(feat) {
                            var d = document.createElement('div');
                            d.className = 'search-result-item';
                            var pName = feat.place_name_ar || feat.place_name || '';
                            d.innerHTML = '<span>📍</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+pName+'</span>';
                            d.onclick = function() {
                                var inp = document.getElementById('cust-'+target+'-text');
                                if (inp) inp.value = pName;
                                resultsEl.style.display = 'none';
                                if (target === 'pickup') {
                                    updatePickupPoint(feat.center[0], feat.center[1], false);
                                    var ai = document.getElementById('cust-reg-address'); if(ai) ai.value = pName;
                                } else {
                                    updateDropoffPoint(feat.center[0], feat.center[1], false);
                                    var ri = document.getElementById('cust-reg-route'); if(ri) ri.value = pName;
                                }
                                if (passengerMap) passengerMap.flyTo({ center: feat.center, zoom: 15 });
                                if (!window.mapboxgl) return;
                                loadMapboxDynamically().then(function() { initPassengerMapbox(); });
                            };
                            resultsEl.appendChild(d);
                        });
                    } else resultsEl.style.display = 'none';
                } catch(_) { resultsEl.style.display = 'none'; }
            }, 250);
        };

        // Close dropdowns on outside click
        document.addEventListener('click', function(e) {
            ['cust-pickup-results','cust-dropoff-results'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el && !el.contains(e.target)) el.style.display = 'none';
            });
        });

        // ===== Fix passenger route + show nearby drivers (Feature 4) =====
        window.fixPassengerRoute = async function() {
            var pLatVal = (document.getElementById('cust-pickup-lat') || {}).value;
            var pLonVal = (document.getElementById('cust-pickup-lon') || {}).value;
            var dLatVal = (document.getElementById('cust-dropoff-lat') || {}).value;
            var dLonVal = (document.getElementById('cust-dropoff-lon') || {}).value;
            var pickupText = ((document.getElementById('cust-pickup-text') || {}).value || '').trim();
            var dropoffText = ((document.getElementById('cust-dropoff-text') || {}).value || '').trim();
            if (!pLatVal || !pLonVal || !dLatVal || !dLonVal || !pickupText || !dropoffText) {
                alert('⚠️ يرجى تحديد نقطة الانطلاق ونقطة الوصول الفعلية على الخريطة لتثبيت المسار');
                return;
            }
            await initPassengerMapbox();
            drawRouteLine();
            showNearestDriver();
            var pLat = parseFloat(pLatVal);
            var pLon = parseFloat(pLonVal);
            var dLat = parseFloat(dLatVal);
            var dLon = parseFloat(dLonVal);
            var container = document.getElementById('nearby-driver-routes');
            if (!container) return;
            container.style.display = 'block';
            container.innerHTML = '<div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:8px">🚕 السائقون المتاحون قريباً من مسارك:</div><div id="driver-routes-list" style="font-size:12px;color:#6b7280">جاري البحث...</div>';
            try {
                var res = await fetch('/api/driver/active-routes');
                var data = await res.json();
                var routes = (data.routes || []);
                var list = document.getElementById('driver-routes-list');
                if (!list) return;
                if (routes.length === 0) { list.innerHTML = '<div style="color:#6b7280;text-align:center;padding:10px">لا يوجد سائقون نشطون حالياً على مسارك</div>'; return; }
                list.innerHTML = '';
                routes.slice(0, 6).forEach(function(dr) {
                    var d = document.createElement('div');
                    d.style.cssText = 'background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:10px;padding:10px;margin-bottom:8px';
                    var waNum = (dr.driverPhone || '').replace(/[^0-9]/g,'');
                    if (waNum.startsWith('07')) waNum = '964' + waNum.substring(1);
                    var waLink = 'https://wa.me/'+waNum+'?text='+encodeURIComponent('مرحباً، أريد الانضمام لمسارك من '+pickupText+' إلى '+dropoffText);
                    var tgLink = 'https://t.me/+'+waNum;
                    var passId = localStorage.getItem('user_id') || '';
                    // Header info
                    var header = document.createElement('div');
                    header.style.cssText = 'font-weight:900;font-size:13px;color:#111;margin-bottom:4px';
                    header.textContent = '🚕 ' + (dr.driverName || '');
                    d.appendChild(header);
                    var sub = document.createElement('div');
                    sub.style.cssText = 'font-size:11px;color:#6b7280;margin-bottom:6px';
                    sub.textContent = (dr.vehicle||'') + ' · ' + (dr.route.fromText||'--') + ' ← → ' + (dr.route.toText||'--');
                    d.appendChild(sub);
                    var btnRow = document.createElement('div');
                    btnRow.style.cssText = 'display:flex;gap:6px';
                    // Join button (only for logged-in passengers)
                    if (passId) {
                        var joinBtn = document.createElement('button');
                        joinBtn.style.cssText = 'flex:1;background:#111;color:#fff;border:none;border-radius:8px;padding:7px 6px;font-size:11px;font-weight:900;font-family:inherit;cursor:pointer';
                        joinBtn.textContent = '🙋 انضمام';
                        (function(did, pt, dt, plat, plon, dlat, dlon) {
                            joinBtn.onclick = function() { joinDriverRoute(did, encodeURIComponent(pt), encodeURIComponent(dt), plat, plon, dlat, dlon); };
                        })(dr.driverId, pickupText, dropoffText, pLat, pLon, dLat, dLon);
                        btnRow.appendChild(joinBtn);
                    }
                    // WhatsApp contact
                    var waBtn = document.createElement('a');
                    waBtn.href = waLink; waBtn.target = '_blank';
                    waBtn.style.cssText = 'flex:1;background:#25d366;color:#fff;border-radius:8px;padding:7px 6px;font-size:11px;font-weight:900;text-decoration:none;text-align:center';
                    waBtn.textContent = '📱 واتساب';
                    (function(did){ waBtn.onclick = function() { logExternalContact(did, 'whatsapp'); }; })(dr.driverId);
                    btnRow.appendChild(waBtn);
                    // Telegram contact
                    var tgBtn = document.createElement('a');
                    tgBtn.href = tgLink; tgBtn.target = '_blank';
                    tgBtn.style.cssText = 'flex:1;background:#0088cc;color:#fff;border-radius:8px;padding:7px 6px;font-size:11px;font-weight:900;text-decoration:none;text-align:center';
                    tgBtn.textContent = '💬 تيليجرام';
                    (function(did){ tgBtn.onclick = function() { logExternalContact(did, 'telegram'); }; })(dr.driverId);
                    btnRow.appendChild(tgBtn);
                    d.appendChild(btnRow);
                    list.appendChild(d);
                });
            } catch(e) {
                var list2 = document.getElementById('driver-routes-list');
                if (list2) list2.innerHTML = '<div style="color:#dc2626">تعذر تحميل السائقين</div>';
            }
        };

        // ===== Feature 9: Secure Telegram links (force external browser) =====
        function openTelegramSafe(url) {
            // Returns URL with tg_open=1 marker; handled at click to force window.open
            return url;
        }
        document.addEventListener('click', function(e) {
            var a = e.target.closest('a[href*="t.me"]');
            if (!a) return;
            var href = a.getAttribute('href');
            if (!href) return;
            e.preventDefault();
            try { window.open(href, '_system'); } catch(_) { window.open(href, '_blank', 'noopener,noreferrer'); }
        });


        // ===== Feature: Permanent Location =====
        window.fixPermanentLocation = async function() {
            var pLat = (document.getElementById('cust-pickup-lat') || {}).value;
            var pLon = (document.getElementById('cust-pickup-lon') || {}).value;
            var dLat = (document.getElementById('cust-dropoff-lat') || {}).value;
            var dLon = (document.getElementById('cust-dropoff-lon') || {}).value;
            var pickupText = ((document.getElementById('cust-pickup-text') || {}).value || '').trim();
            var dropoffText = ((document.getElementById('cust-dropoff-text') || {}).value || '').trim();
            if (!pLat || !pLon || !pickupText) {
                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(function(pos) {
                        document.getElementById('cust-pickup-lat').value = pos.coords.latitude.toFixed(6);
                        document.getElementById('cust-pickup-lon').value = pos.coords.longitude.toFixed(6);
                        fixPermanentLocation();
                    }, function() {
                        alert('⚠️ يرجى تحديد نقطة الانطلاق على الخريطة أولاً أو تفعيل GPS');
                    });
                    return;
                }
                alert('⚠️ يرجى تحديد نقطة الانطلاق على الخريطة أولاً');
                return;
            }
            var passId = localStorage.getItem('user_id') || '';
            if (!passId) { alert('يرجى تسجيل الدخول أولاً'); return; }
            try {
                var res = await fetch('/api/passenger/set-permanent-location', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({
                        passengerId: passId,
                        lat: parseFloat(pLat), lon: parseFloat(pLon), locationName: pickupText,
                        dropoffLat: dLat ? parseFloat(dLat) : null, dropoffLon: dLon ? parseFloat(dLon) : null, dropoffName: dropoffText
                    })
                });
                var data = await res.json();
                if (data.success) {
                    var st = document.getElementById('perm-loc-status');
                    if (st) {
                        st.style.display = 'block';
                        st.style.background = '#f0fdf4';
                        st.style.padding = '12px';
                        st.style.borderRadius = '12px';
                        st.style.fontSize = '14px';
                        st.innerHTML = '✅ <b>تم تثبيت مسارك الدائمي بنجاح!</b><br>📍 من: ' + pickupText + (dropoffText ? '<br>📍 إلى: ' + dropoffText : '') + '<br><span style="font-size:11px;color:#6b7280">سيظهر موقعك للسائقين القريبين في التطبيق وتليجرام</span>';
                    }
                    localStorage.setItem('perm_lat', pLat);
                    localStorage.setItem('perm_lon', pLon);
                    localStorage.setItem('perm_name', pickupText);
                } else alert(data.error || 'خطأ في حفظ الموقع');
            } catch(e) { alert('خطأ في الاتصال'); }
        };

        
        // Auto-show Flutter app if redirected from Telegram or with login_token / showMap
        (function() {
            var params = new URLSearchParams(window.location.search);
            var token = params.get('login_token');
            var gov = params.get('governorate');
            var tripType = params.get('tripType');

            if (gov) {
                localStorage.setItem('user_governorate', gov);
                try { localStorage.setItem('flutter.user_governorate', JSON.stringify(gov)); } catch(_) {}
                if (window.IRAQ_GOVERNORATES && window.IRAQ_GOVERNORATES[gov]) {
                    window.selectedGovernorate = gov;
                }
            }

            if (tripType) {
                localStorage.setItem('trip_type', tripType);
                try { localStorage.setItem('flutter.trip_type', JSON.stringify(tripType)); } catch(_) {}
            }

            if (token || params.get('showMap') === '1' || params.get('openMap') === '1') {
                var tokenToUse = token || localStorage.getItem('auth_token') || '';
                var userId = params.get('userId') || localStorage.getItem('user_id') || '';
                var role = params.get('role') || localStorage.getItem('user_role') || 'Customer';
                var fullName = params.get('fullName') || localStorage.getItem('user_fullname') || '';
                
                if (tokenToUse) {
                    localStorage.setItem('auth_token', tokenToUse);
                    localStorage.setItem('user_id', userId);
                    localStorage.setItem('user_role', role);
                    if (fullName) localStorage.setItem('user_fullname', fullName);

                    try {
                        localStorage.setItem('flutter.auth_token', JSON.stringify(tokenToUse));
                        localStorage.setItem('flutter.user_id', JSON.stringify(userId));
                        localStorage.setItem('flutter.user_role', JSON.stringify(role));
                        if (fullName) localStorage.setItem('flutter.user_fullname', JSON.stringify(fullName));
                    } catch(_) {}
                    
                    setTimeout(function() {
                        if (typeof window.openAppView === 'function') {
                            window.openAppView(tokenToUse, userId, role, fullName, true);
                        }
                    }, 100);
                } else if (params.get('showMap') === '1' || params.get('openMap') === '1') {
                    setTimeout(function() {
                        alert('يرجى تسجيل الدخول أولاً لتثبيت المسار.');
                    }, 500);
                }
            }
        })();

        // Load saved permanent location on page load
        (function() {
            var savedLat = localStorage.getItem('perm_lat');
            var savedLon = localStorage.getItem('perm_lon');
            var savedName = localStorage.getItem('perm_name');
            if (savedLat && savedLon) {
                var st = document.getElementById('perm-loc-status');
                if (st) { st.style.display = 'block'; st.textContent = '📍 موقعك الدائمي المثبت: ' + (savedName || savedLat + ',' + savedLon); }
            }
        })();

        // ===== Feature 1: Log external contact =====
        window.logExternalContact = function(driverId, channel) {
            var passId = localStorage.getItem('user_id') || '';
            var passPhone = '';
            try { passPhone = localStorage.getItem('user_phone') || ''; } catch(_) {}
            var pickup = (document.getElementById('cust-pickup-text') || {}).value || '';
            var dropoff = (document.getElementById('cust-dropoff-text') || {}).value || '';
            fetch('/api/bookings/external', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ passengerId: passId, driverId: driverId, channel: channel, passengerPhone: passPhone, pickup: pickup, dropoff: dropoff }) }).catch(function(){});
        };

        // ===== Feature 4: Join driver route =====
        window.joinDriverRoute = async function(driverId, pickupTextEnc, dropoffTextEnc, pLat, pLon, dLat, dLon) {
            var passId = localStorage.getItem('user_id') || '';
            if (!passId) { alert('يرجى تسجيل الدخول أولاً'); return; }
            try {
                var res = await fetch('/api/passenger/join-request', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ passengerId: passId, driverId: driverId, pickupLat: pLat, pickupLon: pLon, dropoffLat: dLat, dropoffLon: dLon, pickupText: decodeURIComponent(pickupTextEnc), dropoffText: decodeURIComponent(dropoffTextEnc) }) });
                var data = await res.json();
                if (data.success) {
                    alert('✅ تم إرسال طلب الانضمام للسائق. سيتم إعلامك عند الموافقة.');
                    // Poll for approval
                    pollJoinStatus(passId);
                } else alert(data.error || 'تعذر إرسال الطلب');
            } catch(e) { alert('خطأ في الاتصال'); }
        };

        // Poll join status every 10 seconds (Feature 6: Waze on approval)
        var joinPollInterval = null;
        function pollJoinStatus(passId) {
            if (joinPollInterval) clearInterval(joinPollInterval);
            joinPollInterval = setInterval(async function() {
                try {
                    var res = await fetch('/api/passenger/join-status/'+passId);
                    var data = await res.json();
                    if (data.request && data.request.status === 'Approved') {
                        clearInterval(joinPollInterval);
                        var dr = data.request;
                        alert('🎉 وافق السائق '+(dr.driverName||'')+'\\nسيتواصل معك قريباً.');
                    }
                } catch(_) {}
            }, 10000);
        }

        // ===== App view =====
        window.openAppView = function(token,userId,role,fullName, forceMap) {
            var mode = (role === 'Driver' || role === 'driver') ? 'driver' : (selectedTripType || 'short');
            window.openBookingApp(mode);
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
                var token = localStorage.getItem('auth_token');
                var userId = localStorage.getItem('user_id') || 'usr-current';
                var role = localStorage.getItem('user_role') || 'Customer';
                var fullName = localStorage.getItem('user_fullname') || (role === 'Driver' ? 'كابتن توصيله' : 'راكب توصيله');
                var status = localStorage.getItem('driver_status') || '';

                if (token && token.length > 5) {
                    if (role === 'Driver' && (status === 'Pending' || status === 'Rejected')) {
                        return;
                    }
                    var box = document.getElementById('user-logged-in-box');
                    if (box) {
                        box.style.display = 'block';
                        var nameEl = document.getElementById('logged-user-name');
                        var roleEl = document.getElementById('logged-user-role');
                        var isDriver = (role === 'Driver' || role === 'driver');
                        if (nameEl) nameEl.textContent = fullName;
                        if (roleEl) roleEl.textContent = isDriver ? 'كابتن معتمد' : 'راكب';

                        var btnAppText = document.getElementById('btn-user-main-app-text');
                        var btnAppIcon = document.getElementById('btn-user-main-app-icon');
                        var btnApp = document.getElementById('btn-user-main-app');
                        if (btnAppText) btnAppText.textContent = isDriver ? 'واجهة السائق' : 'واجهة الراكب';
                        if (btnAppIcon) btnAppIcon.textContent = isDriver ? '🚖' : '👤';
                        if (btnApp) {
                            btnApp.style.background = isDriver ? 'linear-gradient(135deg,#059669,#047857)' : 'linear-gradient(135deg,#2563eb,#1d4ed8)';
                        }
                        var drBtnWrap = document.getElementById('driver-route-btn-wrap');
                        if (drBtnWrap) drBtnWrap.style.display = 'block';
                    }
                }
            } catch (_) {}
        }

        window.showDriverSetRouteFromBox = function() {
            openRouteApp('set-route');
        };

        window.handleLogout = function() {
            try {
                ['auth_token','user_id','user_role','user_fullname','driver_status',
                 'flutter.auth_token','flutter.user_id','flutter.user_role','flutter.user_fullname','flutter.driver_status'
                ].forEach(function(k){localStorage.removeItem(k);});
                sessionStorage.clear();
            } catch(_) {}
            window.location.replace('/');
        };

        // Dynamic Config from Dashboard
        window.__telegramAdminLink = 'https://t.me/tawseela_najaf_bot';
        window.__whatsappAdminLink = 'https://wa.me/9647706204066';

        function applyDynamicTheme(th) {
            if (!th) return;
            var fontColor = th.fontColor || th.textColor;
            var primaryColor = th.primaryColor || '#111111';
            var buttonColor = th.buttonColor || primaryColor;
            var buttonHoverColor = th.buttonHoverColor || '#374151';
            var activeTabColor = th.activeTabColor || th.activeColor || '#f59e0b';
            var bgColor = th.bgColor;
            var searchInputColor = th.searchInputColor;
            var searchInputBg = th.searchInputBg;

            if (th.appName) {
                var titleEl = document.getElementById('app-main-title');
                if (titleEl) titleEl.textContent = th.appName;
                document.title = th.appName + ' | التسجيل والدخول';
            }
            if (th.logoEmoji) {
                var logoEl = document.getElementById('app-main-logo');
                if (logoEl) logoEl.textContent = th.logoEmoji;
            }
            if (th.footerText) {
                var footEl = document.getElementById('app-main-footer');
                if (footEl) footEl.textContent = th.footerText;
            }
            if (th.fontFamily) {
                document.body.style.fontFamily = '"' + th.fontFamily + '", sans-serif';
            }
            if (th.fontSize) {
                var fsStyle = document.getElementById('dynamic-theme-fontsize-style');
                if (!fsStyle) {
                    fsStyle = document.createElement('style');
                    fsStyle.id = 'dynamic-theme-fontsize-style';
                    document.head.appendChild(fsStyle);
                }
                fsStyle.textContent = 'body, p, label, .label, input, select, textarea, button, .sub-btn, .trip-card { font-size: ' + th.fontSize + ' !important; }';
            }

            // 1. Font color
            if (fontColor) {
                var fStyle = document.getElementById('dynamic-theme-font-style');
                if (!fStyle) {
                    fStyle = document.createElement('style');
                    fStyle.id = 'dynamic-theme-font-style';
                    document.head.appendChild(fStyle);
                }
                fStyle.textContent = 'body, label, .label, input, select, textarea, p, h1, h2, h3, h4, div:not(.trip-card):not(.badge-green):not(.tab-active):not(.btn-primary) { color: ' + fontColor + ' !important; } ::placeholder { color: ' + fontColor + ' !important; opacity: 0.65; }';
            }

            // 2. Background color
            if (bgColor) {
                document.body.style.backgroundColor = bgColor;
                var bStyle = document.getElementById('dynamic-theme-bg-style');
                if (!bStyle) {
                    bStyle = document.createElement('style');
                    bStyle.id = 'dynamic-theme-bg-style';
                    document.head.appendChild(bStyle);
                }
                bStyle.textContent = 'body { background-color: ' + bgColor + ' !important; }';
            }

            // 3. Search & Text inputs
            if (searchInputColor || searchInputBg) {
                var sis = document.getElementById('dynamic-theme-search-input-style');
                if (!sis) { sis = document.createElement('style'); sis.id = 'dynamic-theme-search-input-style'; document.head.appendChild(sis); }
                var rules = '';
                if (searchInputColor) rules += 'color: ' + searchInputColor + ' !important; ';
                if (searchInputBg) rules += 'background-color: ' + searchInputBg + ' !important; ';
                sis.textContent = '.search-input, .inp, #cust-pickup-text, #cust-dropoff-text, #cust-phone-input, #driver-phone-input, #cust-fullname-input, #driver-fullname-input { ' + rules + '}';
            }

            // 4. Buttons, Tab Active/Inactive, Trip Cards, and Sub-buttons
            var btnStyle = document.getElementById('dynamic-theme-button-style');
            if (!btnStyle) {
                btnStyle = document.createElement('style');
                btnStyle.id = 'dynamic-theme-button-style';
                document.head.appendChild(btnStyle);
            }
            btnStyle.textContent = 
                '.btn-primary, button.btn-primary, [type="submit"], #cust-submit-btn, #driver-submit-btn, #btn-open-app { background-color: ' + buttonColor + ' !important; color: #ffffff !important; border: none !important; } ' +
                '.btn-primary:hover, button.btn-primary:hover, [type="submit"]:hover, #cust-submit-btn:hover, #driver-submit-btn:hover, #btn-open-app:hover { background-color: ' + buttonHoverColor + ' !important; color: #ffffff !important; } ' +
                '.btn-primary:active, button.btn-primary:active, [type="submit"]:active, #cust-submit-btn:active, #driver-submit-btn:active { transform: scale(0.98); } ' +
                '.tab-active, button.tab-active, #tab-btn-customer.tab-active, #tab-btn-driver.tab-active { background-color: ' + activeTabColor + ' !important; border-color: ' + activeTabColor + ' !important; color: #ffffff !important; } ' +
                '.tab-active *, button.tab-active *, #tab-btn-customer.tab-active *, #tab-btn-driver.tab-active * { color: #ffffff !important; } ' +
                '.tab-inactive, button.tab-inactive, #tab-btn-customer.tab-inactive, #tab-btn-driver.tab-inactive { background-color: #f3f4f6 !important; border-color: #e5e7eb !important; color: #6b7280 !important; } ' +
                '.tab-inactive *, button.tab-inactive *, #tab-btn-customer.tab-inactive *, #tab-btn-driver.tab-inactive * { color: #6b7280 !important; } ' +
                '.tab-inactive:hover, #tab-btn-customer.tab-inactive:hover, #tab-btn-driver.tab-inactive:hover { background-color: #e5e7eb !important; color: #111111 !important; } ' +
                '.tab-inactive:hover *, #tab-btn-customer.tab-inactive:hover *, #tab-btn-driver.tab-inactive:hover * { color: #111111 !important; } ' +
                '.sub-btn.on { background-color: ' + activeTabColor + ' !important; color: #ffffff !important; } ' +
                '.sub-btn.on * { color: #ffffff !important; } ' +
                '.sub-btn.off { background-color: transparent !important; color: #6b7280 !important; } ' +
                '.sub-btn.off:hover { color: #111111 !important; } ' +
                '.trip-card.selected { background-color: ' + activeTabColor + ' !important; border-color: ' + activeTabColor + ' !important; color: #ffffff !important; } ' +
                '.trip-card.selected * { color: #ffffff !important; } ' +
                '.trip-card:not(.selected) { background-color: #fafafa !important; border-color: #e5e7eb !important; } ' +
                '.trip-card:not(.selected):hover { border-color: #9ca3af !important; background-color: #f3f4f6 !important; } ' +
                '.btn-secondary { background-color: #f3f4f6 !important; color: #111111 !important; border-color: #e5e7eb !important; } ' +
                '.btn-secondary:hover { background-color: #e5e7eb !important; } ' +
                '.btn-small { background-color: #f3f4f6 !important; color: #374151 !important; border-color: #d1d5db !important; } ' +
                '.btn-small:hover { background-color: #e5e7eb !important; }';
        }

        async function applyDynamicAppConfig() {
            try {
                var res = await fetch('/api/admin/app-config?t=' + Date.now());
                var cfg = await res.json();
                if (!cfg) return;

                if (cfg.telegramAdminLink) window.__telegramAdminLink = cfg.telegramAdminLink;
                if (cfg.whatsappAdminLink) window.__whatsappAdminLink = cfg.whatsappAdminLink;

                if (cfg.theme) {
                    applyDynamicTheme(cfg.theme);
                }

                if (cfg.staticTexts) {
                    if (cfg.staticTexts.welcomeTitle) {
                        var wt = document.getElementById('app-main-title');
                        if (wt) wt.textContent = cfg.staticTexts.welcomeTitle;
                    }
                    if (cfg.staticTexts.welcomeSubtitle) {
                        var ws = document.getElementById('app-main-subtitle');
                        if (ws) ws.textContent = cfg.staticTexts.welcomeSubtitle;
                    }
                }
            } catch(e) {}
        }

        // Real-time config sync via BroadcastChannel (instant reflection on font & color changes)
        try {
            var configSyncChannel = new BroadcastChannel('tawseela_config_sync');
            configSyncChannel.onmessage = function(evt) {
                if (evt.data && evt.data.type === 'config_updated') {
                    if (evt.data.config && evt.data.config.theme) {
                        applyDynamicTheme(evt.data.config.theme);
                    }
                    applyDynamicAppConfig();
                }
            };
        } catch(_) {}

        // Also poll config every 60s (Feature 7 fallback)
        setInterval(applyDynamicAppConfig, 60000);

        // Feature 5: Driver set-route after login
        window.showDriverSetRoute = function(driverId) {
            var existing = document.getElementById('driver-set-route-panel');
            if (existing) { existing.style.display = existing.style.display === 'none' ? 'block' : 'none'; return; }
            var panel = document.createElement('div');
            panel.id = 'driver-set-route-panel';
            panel.style.cssText = 'position:fixed;bottom:80px;left:0;right:0;background:#fff;border-top:2px solid #e5e7eb;padding:16px;z-index:1000;box-shadow:0 -4px 20px rgba(0,0,0,0.1)';
            var inner = document.createElement('div');
            inner.style.cssText = 'max-width:420px;margin:0 auto';
            var title = document.createElement('div');
            title.style.cssText = 'font-size:14px;font-weight:900;color:#111;margin-bottom:12px';
            title.textContent = '🛣️ تثبيت مسارك';
            inner.appendChild(title);
            // From input
            var fromWrap = document.createElement('div');
            fromWrap.style.cssText = 'position:relative;margin-bottom:8px';
            fromWrap.innerHTML = '<span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);width:8px;height:8px;border-radius:50%;background:#16a34a;display:inline-block"></span><input type="text" id="drv-from-input" class="inp" style="padding-right:26px" placeholder="نقطة الانطلاق">';
            inner.appendChild(fromWrap);
            // To input
            var toWrap = document.createElement('div');
            toWrap.style.cssText = 'position:relative;margin-bottom:12px';
            toWrap.innerHTML = '<span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);width:8px;height:8px;border-radius:50%;background:#dc2626;display:inline-block"></span><input type="text" id="drv-to-input" class="inp" style="padding-right:26px" placeholder="نقطة الوصول">';
            inner.appendChild(toWrap);
            // Buttons row
            var btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:8px';
            var setBtn = document.createElement('button');
            setBtn.style.cssText = 'flex:1;background:#111;color:#fff;border:none;border-radius:10px;padding:11px;font-size:13px;font-weight:900;font-family:inherit;cursor:pointer';
            setBtn.textContent = '📌 تثبيت المسار';
            setBtn.onclick = function() { submitDriverRoute(driverId); };
            var reqBtn = document.createElement('button');
            reqBtn.style.cssText = 'flex:1;background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:11px;font-size:13px;font-weight:900;font-family:inherit;cursor:pointer';
            reqBtn.textContent = '🙋 طلبات الانضمام';
            reqBtn.onclick = function() { checkDriverJoinRequests(driverId); };
            btnRow.appendChild(setBtn);
            btnRow.appendChild(reqBtn);
            inner.appendChild(btnRow);
            var joinList = document.createElement('div');
            joinList.id = 'driver-join-list';
            joinList.style.marginTop = '10px';
            inner.appendChild(joinList);
            panel.appendChild(inner);
            document.body.appendChild(panel);
        };

        window.submitDriverRoute = async function(driverId) {
            var from = (document.getElementById('drv-from-input') || {}).value || '';
            var to = (document.getElementById('drv-to-input') || {}).value || '';
            if (!from || !to) { alert('أدخل نقطة الانطلاق والوصول'); return; }
            try {
                var res = await fetch('/api/driver/set-route', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ driverId: driverId, fromText: from, toText: to }) });
                var data = await res.json();
                if (data.success) { alert('✅ تم تثبيت مسارك. سيظهر للركاب الآن.'); }
                else alert(data.error || 'خطأ في حفظ المسار');
            } catch(e) { alert('خطأ في الاتصال'); }
        };

        window.checkDriverJoinRequests = async function(driverId) {
            var list = document.getElementById('driver-join-list');
            if (!list) return;
            list.innerHTML = '<div style="font-size:12px;color:#6b7280;text-align:center">جاري التحميل...</div>';
            try {
                var res = await fetch('/api/driver/join-requests/' + driverId);
                var data = await res.json();
                var requests = data.requests || [];
                if (requests.length === 0) { list.innerHTML = '<div style="font-size:12px;color:#6b7280;text-align:center;padding:8px">لا توجد طلبات انضمام</div>'; return; }
                list.innerHTML = '';
                requests.forEach(function(jr) {
                    var d = document.createElement('div');
                    d.style.cssText = 'background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:10px;padding:10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px';
                    var info = document.createElement('div');
                    var nameDiv = document.createElement('div');
                    nameDiv.style.cssText = 'font-size:12px;font-weight:700;color:#111';
                    nameDiv.textContent = '🙋 ' + (jr.passengerName || 'راكب');
                    var destDiv = document.createElement('div');
                    destDiv.style.cssText = 'font-size:11px;color:#6b7280';
                    destDiv.textContent = 'إلى: ' + (jr.dropoffText || '--');
                    info.appendChild(nameDiv); info.appendChild(destDiv);
                    d.appendChild(info);
                    var btns = document.createElement('div');
                    btns.style.cssText = 'display:flex;gap:6px';
                    var apprBtn = document.createElement('button');
                    apprBtn.style.cssText = 'background:#16a34a;color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:900;font-family:inherit;cursor:pointer';
                    apprBtn.textContent = '✅ قبول';
                    (function(rid, did) { apprBtn.onclick = function() { driverApproveJoin(rid, did); }; })(jr.requestId, driverId);
                    var rejBtn = document.createElement('button');
                    rejBtn.style.cssText = 'background:#dc2626;color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:900;font-family:inherit;cursor:pointer';
                    rejBtn.textContent = '❌ رفض';
                    (function(rid) { rejBtn.onclick = function() { driverRejectJoin(rid); }; })(jr.requestId);
                    btns.appendChild(apprBtn); btns.appendChild(rejBtn);
                    d.appendChild(btns);
                    list.appendChild(d);
                });
            } catch(e) { list.innerHTML = '<div style="font-size:12px;color:#dc2626;text-align:center">خطأ في التحميل</div>'; }
        };

        // Feature 6: Driver approve join → open Waze
        window.driverApproveJoin = async function(requestId, driverId) {
            try {
                var res = await fetch('/api/driver/approve-join', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ requestId: requestId, driverId: driverId }) });
                var data = await res.json();
                if (data.success) {
                    alert('✅ تم قبول الراكب!');
                    // Feature 6: Open Waze
                    if (data.wazeUrl) {
                        try { window.open(data.wazeUrl, '_system'); } catch(_) {
                            window.location.href = data.wazeUrl;
                        }
                    }
                    checkDriverJoinRequests(driverId);
                }
            } catch(e) { alert('خطأ في الاتصال'); }
        };

        window.driverRejectJoin = async function(requestId) {
            try {
                await fetch('/api/driver/reject-join', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ requestId: requestId }) });
                alert('تم رفض الطلب.');
            } catch(e) {}
        };

        // Onboarding
        var onbScreens = [], onbIndex = 0;
        async function initOnboarding() {
            try {
                var res = await fetch('/api/admin/onboarding?t=' + Date.now());
                var data = await res.json();
                if (!data.enabled || !data.screens || data.screens.length === 0) return;
                if (localStorage.getItem('onboarding_done')) return;
                onbScreens = data.screens;
                onbIndex = 0;
                showOnboardingScreen();
            } catch(e) {}
        }
        function showOnboardingScreen() {
            if (onbIndex >= onbScreens.length) { finishOnboarding(); return; }
            var s = onbScreens[onbIndex];
            var overlay = document.getElementById('onboarding-overlay');
            if (!overlay) return;
            overlay.style.display = 'flex';
            document.getElementById('onb-icon').textContent = s.icon || '📱';
            document.getElementById('onb-title').textContent = s.title || '';
            document.getElementById('onb-desc').textContent = s.description || '';
            var dots = document.getElementById('onb-dots');
            dots.innerHTML = onbScreens.map(function(_,i) { return '<span style="width:8px;height:8px;border-radius:50%;background:'+(i===onbIndex?'#111':'#d1d5db')+'"></span>'; }).join('');
            document.getElementById('onb-next-btn').textContent = onbIndex === onbScreens.length-1 ? 'ابدأ الآن' : 'التالي';
        }
        function nextOnboardingScreen() { onbIndex++; showOnboardingScreen(); }
        function finishOnboarding() {
            localStorage.setItem('onboarding_done', '1');
            var o = document.getElementById('onboarding-overlay'); if(o) o.style.display='none';
        }

        // Load custom buttons
        async function loadAppCustomButtons() {
            try {
                var res = await fetch('/api/admin/custom-buttons?t=' + Date.now());
                var buttons = await res.json();
                var container = document.getElementById('custom-buttons-container');
                if (!container || !buttons || !Array.isArray(buttons) || buttons.length === 0) return;
                container.innerHTML = '';
                buttons.filter(function(b){ return b.visible !== false; }).forEach(function(b) {
                    var a = document.createElement('a');
                    a.href = b.url || '#';
                    a.target = b.target || '_blank';
                    a.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border-radius:12px;background:' + (b.color || '#111') + ';color:#fff;font-weight:900;font-size:14px;text-decoration:none;margin-bottom:8px;font-family:Cairo,sans-serif';
                    a.textContent = (b.icon || '🔗') + ' ' + (b.label || '');
                    container.appendChild(a);
                });
            } catch(e) {}
        }

        async function loadAppAds() {
            try {
                var res = await fetch('/api/admin/advertisements?t=' + Date.now());
                var ads = await res.json();
                var container = document.getElementById('ads-container');
                if (!container || !ads || !Array.isArray(ads) || ads.length === 0) return;
                container.innerHTML = '';
                ads.filter(function(a){ return a.active !== false; }).forEach(function(a) {
                    var d = document.createElement('div');
                    d.style.cssText = 'background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:12px;padding:14px;margin-bottom:8px' + (a.linkUrl ? ';cursor:pointer' : '');
                    d.innerHTML = '<div style="font-size:14px;font-weight:900;color:#111;margin-bottom:4px">' + (a.title || '') + '</div><div style="font-size:12px;color:#6b7280">' + (a.content || '') + '</div>';
                    if (a.linkUrl) {
                        d.onclick = function() { window.open(a.linkUrl, '_blank'); };
                    }
                    container.appendChild(d);
                });
            } catch(e) {}
        }

        // =============================================================================
        // INTERACTIVE MAPBOX BOOKING & DISPATCH ENGINE (STAGES 1, 2, 3, 4)
        // =============================================================================
        var BOOKING_MAPBOX_TOKEN = 'pk.eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9._J6DYjYBDhsdcidErQrblA';
        var bMap = null, bGeolocate = null;
        var bUserLat = 31.9961, bUserLon = 44.3168, bHasUserGps = false;
        var bActiveTab = 'short';
        var bRangeKm = 5;
        var bPickupMarker = null, bDropoffMarker = null;
        var bPickupCoords = null, bDropoffCoords = null;
        var bPickupName = '', bDropoffName = '';
        var bRouteDist = 0, bRouteDur = 0, bRouteFare = 0, bRouteGeom = null;
        var bNearbyDrivers = [];
        var bDriversPollTimer = null;
        var bActiveRideId = null, bRidePollTimer = null, bDispatchSeconds = 30, bDispatchTimer = null;
        var bPassengerMonitorTimer = null, bDriverActiveRide = null;
        var bPermDays = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء'];
        var bDriverOnline = false, bDriverWatchId = null, bDriverIncomingTimer = null, bDriverReqTimer = null;
        var bMapPickTarget = 'pickup';
        var bLiveTrackingTimer = null; // Stage 3: live driver tracking interval

        window.openRouteApp = function(tab) {
            window.openBookingApp(tab || 'set-route');
        };

        window.openBookingApp = async function(tab) {
            var modal = document.getElementById('booking-modal-view');
            if (!modal) return;
            modal.style.display = 'flex';
            document.body.style.overflow = 'hidden';

            var role = localStorage.getItem('user_role') || 'Customer';
            var isDriver = (role === 'Driver' || role === 'driver');

            var sidebar = document.getElementById('booking-sidebar');
            if (sidebar) sidebar.classList.add('drawer-collapsed');
            var backdrop = document.getElementById('booking-sidebar-backdrop');
            if (backdrop) backdrop.style.display = 'none';
            bMapPickTarget = 'pickup';

            var tabSet = document.getElementById('book-tab-set-route');
            if (tabSet) {
                tabSet.innerHTML = isDriver ? '🚖 واجهة السائق' : '👤 واجهة الراكب';
            }
            var headerSub = document.getElementById('booking-header-subtitle');
            if (headerSub) {
                headerSub.textContent = isDriver ? 'واجهة السائق - تثبيت المسار وإدارة طلبات الانضمام' : 'واجهة الراكب - تثبيت المسار وإدارة طلبات الانضمام';
            }

            var targetTab = (tab === 'join-requests' || tab === 'requests') ? 'join-requests' : 'set-route';
            bActiveTab = targetTab;
            window.switchRouteTab(bActiveTab);

            if (typeof mapboxgl === 'undefined' && window.loadMapboxDynamically) {
                await window.loadMapboxDynamically();
            }

            if (!bMap) {
                await initBookingMapbox();
            } else {
                setTimeout(function() { if (bMap) bMap.resize(); }, 100);
                setTimeout(function() { if (bMap) bMap.resize(); }, 350);
                fetchNearbyDriversForMap();
            }
        };


        var NAJAF_PLACES = [
            { name: 'مرقد الإمام علي عليه السلام', lat: 31.9962, lon: 44.3113 },
            { name: 'حولي النجف', lat: 32.0010, lon: 44.3350 },
            { name: 'بنات الحسن', lat: 31.9900, lon: 44.3050 },
            { name: 'المحافظة - مبنى المحافظة', lat: 31.9955, lon: 44.3170 },
            { name: 'جامعة الكوفة', lat: 32.0296, lon: 44.3828 },
            { name: 'كلية الطب - جامعة الكوفة', lat: 32.0270, lon: 44.3800 },
            { name: 'كلية الهندسة - جامعة الكوفة', lat: 32.0310, lon: 44.3850 },
            { name: 'جامعة الإمام الصادق', lat: 32.0050, lon: 44.3200 },
            { name: 'مستشفى الصدر التعليمي', lat: 31.9985, lon: 44.3220 },
            { name: 'مستشفى الحكيم', lat: 32.0010, lon: 44.3260 },
            { name: 'مستشفى النجف التعليمي', lat: 31.9960, lon: 44.3120 },
            { name: 'مركز صحي حي الجامعة', lat: 32.0100, lon: 44.3300 },
            { name: 'حي الجامعة', lat: 32.0100, lon: 44.3300 },
            { name: 'حي الحسين', lat: 31.9950, lon: 44.3100 },
            { name: 'حي القادسية', lat: 32.0150, lon: 44.3400 },
            { name: 'حي الصالحية', lat: 32.0080, lon: 44.3180 },
            { name: 'حي الشرطة', lat: 32.0020, lon: 44.3200 },
            { name: 'حي الرسالة', lat: 31.9870, lon: 44.3050 },
            { name: 'حي الإسكان', lat: 32.0200, lon: 44.3500 },
            { name: 'حي الزهراء', lat: 31.9930, lon: 44.3000 },
            { name: 'حي الكوفة القديمة', lat: 32.0280, lon: 44.4000 },
            { name: 'حي العلوية', lat: 32.0060, lon: 44.3140 },
            { name: 'حي المنطقة الصناعية', lat: 32.0400, lon: 44.3600 },
            { name: 'شارع الروان', lat: 31.9980, lon: 44.3160 },
            { name: 'شارع الكوفة', lat: 32.0100, lon: 44.3600 },
            { name: 'السوق الكبير - النجف', lat: 31.9970, lon: 44.3140 },
            { name: 'الصحن الشريف - الحرم العلوي', lat: 31.9962, lon: 44.3113 },
            { name: 'بلدية النجف', lat: 31.9965, lon: 44.3180 },
            { name: 'مديرية تربية النجف', lat: 32.0015, lon: 44.3250 },
            { name: 'مطار النجف الأشرف', lat: 31.9906, lon: 44.4040 },
            { name: 'الحيرة', lat: 32.0700, lon: 44.4000 },
            { name: 'الكوفة', lat: 32.0300, lon: 44.4000 },
            { name: 'المشخاب', lat: 31.7600, lon: 44.3500 }
        ];

        function normalizeArabicText(s) {
            return (s || '').replace(/\u0623|\u0625|\u0622/g, '\u0627').replace(/\u0629/g, '\u0647').replace(/\u0649/g, '\u064a').toLowerCase().trim();
        }

        function searchLocalNajafPlaces(query) {
            var q = normalizeArabicText(query);
            if (q.length < 2) return [];
            return NAJAF_PLACES.filter(function(p) {
                return normalizeArabicText(p.name).indexOf(q) !== -1;
            }).slice(0, 5);
        }

        window.setMapTarget = function(target) {
            bMapPickTarget = target;
            var statusEl = document.getElementById('map-target-status');
            var btnPickup = document.getElementById('btn-target-pickup');
            var btnDropoff = document.getElementById('btn-target-dropoff');
            if (target === 'pickup') {
                if (statusEl) statusEl.textContent = '\u{1F4CD} \u0627\u0646\u0642\u0631 \u0627\u0644\u062e\u0631\u064a\u0637\u0629 \u0644\u062a\u062d\u062f\u064a\u062f \u0646\u0642\u0637\u0629 \u0627\u0644\u0627\u0646\u0637\u0644\u0627\u0642 \uD83D\uDFE2';
                if (btnPickup) { btnPickup.style.background = '#dcfce7'; btnPickup.style.color = '#15803d'; btnPickup.style.borderColor = '#86efac'; btnPickup.style.fontWeight = '900'; }
                if (btnDropoff) { btnDropoff.style.background = 'transparent'; btnDropoff.style.color = '#6b7280'; btnDropoff.style.borderColor = '#e5e7eb'; btnDropoff.style.fontWeight = '700'; }
            } else {
                if (statusEl) statusEl.textContent = '\u{1F4CD} \u0627\u0646\u0642\u0631 \u0627\u0644\u062e\u0631\u064a\u0637\u0629 \u0644\u062a\u062d\u062f\u064a\u062f \u0646\u0642\u0637\u0629 \u0627\u0644\u0648\u0635\u0648\u0644 \uD83D\uDD34';
                if (btnPickup) { btnPickup.style.background = 'transparent'; btnPickup.style.color = '#6b7280'; btnPickup.style.borderColor = '#e5e7eb'; btnPickup.style.fontWeight = '700'; }
                if (btnDropoff) { btnDropoff.style.background = '#fee2e2'; btnDropoff.style.color = '#b91c1c'; btnDropoff.style.borderColor = '#fca5a5'; btnDropoff.style.fontWeight = '900'; }
            }
        };

        window.clearPickupInput = function() {
            var inp = document.getElementById('book-pickup-input');
            var clr = document.getElementById('btn-clear-pickup');
            if (inp) inp.value = '';
            if (clr) clr.style.display = 'none';
            bPickupCoords = null; bPickupName = '';
            if (bPickupMarker) { bPickupMarker.remove(); bPickupMarker = null; }
        };

        window.clearDropoffInput = function() {
            var inp = document.getElementById('book-dropoff-input');
            var clr = document.getElementById('btn-clear-dropoff');
            if (inp) inp.value = '';
            if (clr) clr.style.display = 'none';
            bDropoffCoords = null; bDropoffName = '';
            if (bDropoffMarker) { bDropoffMarker.remove(); bDropoffMarker = null; }
        };

        var bPickupTimer = null;
        window.onBookingPickupSearch = function(query) {
            clearTimeout(bPickupTimer);
            var clrBtn = document.getElementById('btn-clear-pickup');
            if (clrBtn) clrBtn.style.display = query ? 'block' : 'none';
            var resultsEl = document.getElementById('book-pickup-results');
            if (!resultsEl) return;
            if (query) bPickupName = query;
            if (!query || query.trim().length < 1) { resultsEl.style.display = 'none'; return; }

            resultsEl.innerHTML = '';
            var customItem = document.createElement('div');
            customItem.className = 'search-result-item';
            customItem.style.cssText = 'background:#f0fdf4;font-weight:bold;color:#166534;border-bottom:1px solid #dcfce7;';
            customItem.innerHTML = '<span>📌</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">اعتماد: "' + query + '"</span>';
            customItem.onclick = function() {
                resultsEl.style.display = 'none';
                var pLon = bUserLon || 44.3168;
                var pLat = bUserLat || 31.9961;
                setBookingPickup(pLon, pLat, query);
                setMapTarget('dropoff');
            };
            resultsEl.appendChild(customItem);
            resultsEl.style.display = 'block';

            var local = searchLocalNajafPlaces(query);
            if (local.length > 0) {
                local.forEach(function(p) {
                    var item = document.createElement('div');
                    item.className = 'search-result-item';
                    item.innerHTML = '<span>📍</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + p.name + '</span>';
                    item.onclick = function() { resultsEl.style.display = 'none'; setBookingPickup(p.lon, p.lat, p.name); setMapTarget('dropoff'); };
                    resultsEl.appendChild(item);
                });
            }
            bPickupTimer = setTimeout(async function() {
                try {
                    var q = encodeURIComponent(query.trim());
                    var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + q + '.json?country=iq&proximity=' + (bUserLon||44.3168) + ',' + (bUserLat||31.9961) + '&language=ar,en&types=poi,address,neighborhood,place,locality&limit=6&access_token=' + BOOKING_MAPBOX_TOKEN;
                    var res = await fetch(url);
                    var data = await res.json();
                    var feats = (data && data.features) ? data.features : [];
                    resultsEl.innerHTML = '';
                    resultsEl.appendChild(customItem);
                    if (local.length > 0) {
                        local.forEach(function(p) {
                            var item = document.createElement('div');
                            item.className = 'search-result-item';
                            item.innerHTML = '<span>📍</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + p.name + '</span>';
                            item.onclick = function() { resultsEl.style.display = 'none'; setBookingPickup(p.lon, p.lat, p.name); setMapTarget('dropoff'); };
                            resultsEl.appendChild(item);
                        });
                    }
                    feats.forEach(function(f) {
                        var nm = f.place_name_ar || f.place_name || '';
                        var item = document.createElement('div');
                        item.className = 'search-result-item';
                        item.innerHTML = '<span>🗺️</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + nm + '</span>';
                        item.onclick = function() { resultsEl.style.display = 'none'; setBookingPickup(f.center[0], f.center[1], nm); setMapTarget('dropoff'); };
                        resultsEl.appendChild(item);
                    });
                    resultsEl.style.display = resultsEl.children.length > 0 ? 'block' : 'none';
                } catch(_) {}
            }, 300);
        };

        window.toggleBookingDrawer = function(forceOpen) {
            var sidebar = document.getElementById('booking-sidebar');
            var backdrop = document.getElementById('booking-sidebar-backdrop');
            if (!sidebar) return;
            var isOpen = !sidebar.classList.contains('drawer-collapsed');
            if (forceOpen === false || isOpen) {
                sidebar.classList.add('drawer-collapsed');
                if (backdrop) backdrop.style.display = 'none';
            } else {
                sidebar.classList.remove('drawer-collapsed');
                if (backdrop) backdrop.style.display = 'block';
            }
            if (bMap) setTimeout(function() { bMap.resize(); }, 150);
        };

        window.closeBookingApp = function() {
            var modal = document.getElementById('booking-modal-view');
            if (modal) modal.style.display = 'none';
            document.body.style.overflow = '';
            if (bDriversPollTimer) clearInterval(bDriversPollTimer);
        };

        // ── Draggable floating card ──────────────────────────────────────────
        (function initDraggableCard() {
            var card, handle, isDragging = false, startX, startY, origLeft, origTop;

            function getCard() { return document.getElementById('floating-route-card'); }
            function getHandle() { return document.getElementById('floating-card-handle'); }

            function onStart(clientX, clientY) {
                card = getCard(); handle = getHandle();
                if (!card) return;
                isDragging = true;
                startX = clientX; startY = clientY;
                var rect = card.getBoundingClientRect();
                origLeft = rect.left; origTop = rect.top;
                card.style.right = 'auto';
                card.style.left = origLeft + 'px';
                card.style.top = origTop + 'px';
                if (handle) handle.style.cursor = 'grabbing';
            }

            function onMove(clientX, clientY) {
                if (!isDragging || !card) return;
                var dx = clientX - startX, dy = clientY - startY;
                var newLeft = origLeft + dx, newTop = origTop + dy;
                var maxLeft = window.innerWidth - card.offsetWidth - 4;
                var maxTop = window.innerHeight - card.offsetHeight - 4;
                newLeft = Math.max(4, Math.min(newLeft, maxLeft));
                newTop = Math.max(4, Math.min(newTop, maxTop));
                card.style.left = newLeft + 'px';
                card.style.top = newTop + 'px';
            }

            function onEnd() {
                isDragging = false;
                card = null;
                var h = getHandle();
                if (h) h.style.cursor = 'grab';
            }

            // Mouse events
            document.addEventListener('mousedown', function(e) {
                var h = getHandle();
                if (h && h.contains(e.target)) { e.preventDefault(); onStart(e.clientX, e.clientY); }
            });
            document.addEventListener('mousemove', function(e) { if (isDragging) onMove(e.clientX, e.clientY); });
            document.addEventListener('mouseup', onEnd);

            // Touch events
            document.addEventListener('touchstart', function(e) {
                var h = getHandle();
                if (h && h.contains(e.target)) { onStart(e.touches[0].clientX, e.touches[0].clientY); }
            }, { passive: true });
            document.addEventListener('touchmove', function(e) {
                if (isDragging) { e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); }
            }, { passive: false });
            document.addEventListener('touchend', onEnd);
        })();
        // ────────────────────────────────────────────────────────────────────

        window.switchRouteTab = function(tab) {
            bActiveTab = tab;
            var role = localStorage.getItem('user_role') || 'Customer';
            var isDriver = (role === 'Driver' || role === 'driver');

            var tSet = document.getElementById('book-tab-set-route');
            var tJoin = document.getElementById('book-tab-join-requests');
            var pSet = document.getElementById('sidebar-panel-set-route');
            var pJoin = document.getElementById('sidebar-panel-join-requests');
            var pShort = document.getElementById('sidebar-panel-short');
            var pDaily = document.getElementById('sidebar-panel-daily');
            var pDriver = document.getElementById('sidebar-panel-driver');

            if (pShort) pShort.style.display = 'none';
            if (pDaily) pDaily.style.display = 'none';
            if (pDriver) pDriver.style.display = 'none';

            if (tSet) {
                tSet.innerHTML = isDriver ? '🚖 واجهة السائق' : '👤 واجهة الراكب';
                tSet.style.background = tab === 'set-route' ? (isDriver ? '#059669' : '#2563eb') : 'transparent';
                tSet.style.color = tab === 'set-route' ? '#fff' : '#d1d5db';
                tSet.style.fontWeight = tab === 'set-route' ? '900' : '700';
            }
            if (tJoin) {
                tJoin.style.background = tab === 'join-requests' ? '#059669' : 'transparent';
                tJoin.style.color = tab === 'join-requests' ? '#fff' : '#d1d5db';
                tJoin.style.fontWeight = tab === 'join-requests' ? '900' : '700';
            }

            if (pSet) pSet.style.display = tab === 'set-route' ? 'flex' : 'none';
            if (pJoin) pJoin.style.display = tab === 'join-requests' ? 'flex' : 'none';

            if (tab === 'set-route') {
                renderSetRouteSidebar();
            } else if (tab === 'join-requests') {
                renderJoinRequestsSidebar();
            }
            if (bMap) setTimeout(function() { bMap.resize(); }, 150);
        };

        window.switchBookingTab = function(tab) {
            if (tab === 'join-requests' || tab === 'driver') window.switchRouteTab('join-requests');
            else window.switchRouteTab('set-route');
        };

        function renderSetRouteSidebar() {
            var panel = document.getElementById('sidebar-panel-set-route');
            if (!panel) return;
            var role = localStorage.getItem('user_role') || 'Customer';
            var isDriver = (role === 'Driver' || role === 'driver');
            var fullName = localStorage.getItem('user_fullname') || (isDriver ? 'كابتن توصيله' : 'راكب توصيله');

            var drawerNavHtml = '<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:8px 10px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">' +
                '<div style="display:flex;align-items:center;gap:8px;">' +
                    '<span style="font-size:18px;">' + (isDriver ? '🚖' : '👤') + '</span>' +
                    '<div>' +
                        '<div style="font-size:12px;font-weight:900;color:#111;">' + fullName + '</div>' +
                        '<div style="font-size:10px;color:#64748b;font-weight:700;">' + (isDriver ? 'كابتن معتمد' : 'راكب') + '</div>' +
                    '</div>' +
                '</div>' +
                '<button type="button" onclick="switchRouteTab(&quot;join-requests&quot;)" style="background:#059669;color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;">' +
                    '🙋 طلبات الانضمام' +
                '</button>' +
            '</div>';

            panel.innerHTML = drawerNavHtml +
                '<div style="font-size:14px;font-weight:900;color:#111;margin-bottom:4px;">' + (isDriver ? '🚖 واجهة السائق (تثبيت المسار)' : '👤 واجهة الراكب (تثبيت المسار)') + '</div>' +
                '<p style="font-size:12px;color:#6b7280;margin:0 0 10px;">انقر على الخريطة أو ابحث لتحديد نقطة الانطلاق والوصول:</p>' +
                '<div style="position:relative;margin-bottom:8px;">' +
                    '<label class="label" style="font-size:11px;">🟢 نقطة الانطلاق</label>' +
                    '<div style="display:flex;gap:6px;">' +
                        '<input type="text" id="book-pickup-input" class="inp" placeholder="حدد الانطلاق على الخريطة أو عبر GPS" value="' + (bPickupName||'') + '" style="font-size:12px;padding:9px 12px;">' +
                        '<button type="button" onclick="centerOnUserGps()" class="btn-small" style="padding:8px 10px;" title="موقعي الحالي">📍</button>' +
                    '</div>' +
                '</div>' +
                '<div style="position:relative;margin-bottom:10px;">' +
                    '<label class="label" style="font-size:11px;">🔴 نقطة الوصول</label>' +
                    '<input type="text" id="book-dropoff-input" class="inp" placeholder="ابحث: جامعة الكوفة، مركز النجف، شارع الروان..." value="' + (bDropoffName||'') + '" oninput="onBookingDropoffSearch(this.value)" style="font-size:12px;padding:9px 12px;">' +
                    '<div id="book-dropoff-results" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:50;background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;box-shadow:0 4px 15px rgba(0,0,0,0.1);max-height:160px;overflow-y:auto;margin-top:2px;"></div>' +
                '</div>' +
                '<div id="side-route-summary" style="display:' + (bRouteDist > 0 ? 'block' : 'none') + ';background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:10px;margin-bottom:10px;">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
                        '<span style="font-weight:900;color:#111;">معلومات المسار:</span>' +
                        '<span style="font-weight:900;color:#059669;font-size:14px;">' + (bRouteFare||0).toLocaleString() + ' د.ع</span>' +
                    '</div>' +
                    '<div style="font-size:11px;color:#64748b;display:flex;gap:12px;">' +
                        '<span>📏 ' + bRouteDist + ' كم</span>' +
                        '<span>⏱️ ' + bRouteDur + ' دقيقة</span>' +
                    '</div>' +
                '</div>' +
                '<button type="button" id="btn-save-route-db" onclick="saveUserRouteToDatabase()" class="btn-primary" style="background:#111827;font-size:13px;padding:12px;display:flex;align-items:center;justify-content:center;gap:8px;">' +
                    '<span>📌</span> <span>تثبيت المسار في قاعدة البيانات</span>' +
                '</button>' +
                (!isDriver ? 
                    '<div style="margin-top:14px;">' +
                        '<div style="font-size:12px;font-weight:800;color:#374151;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">' +
                            '<span>السائقون القريبون المطابقون لمسارك:</span>' +
                            '<button type="button" onclick="loadMatchingDriversForPassenger()" style="background:none;border:none;color:#2563eb;font-size:11px;cursor:pointer;">تحديث 🔄</button>' +
                        '</div>' +
                        '<div id="passenger-matching-drivers-list" style="display:flex;flex-direction:column;gap:8px;"></div>' +
                    '</div>' : '');

            if (!isDriver) {
                loadMatchingDriversForPassenger();
            }
        }

        window.saveUserRouteToDatabase = async function() {
            var pickInp = document.getElementById('book-pickup-input');
            var dropInp = document.getElementById('book-dropoff-input');
            var typedPickup = pickInp ? pickInp.value.trim() : '';
            var typedDropoff = dropInp ? dropInp.value.trim() : '';

            if (typedPickup && !bPickupName) bPickupName = typedPickup;
            if (typedDropoff && !bDropoffName) bDropoffName = typedDropoff;

            if (!bPickupCoords) {
                var pLon = bUserLon || 44.3168;
                var pLat = bUserLat || 31.9961;
                bPickupCoords = [pLon, pLat];
                if (!bPickupName) bPickupName = typedPickup || 'موقعي الحالي';
            }

            if (!bDropoffCoords) {
                if (!typedDropoff && !bDropoffName) {
                    alert('⚠️ يرجى كتابة أو تحديد وجهة الوصول أولاً');
                    if (dropInp) dropInp.focus();
                    return;
                }
                bDropoffName = typedDropoff || bDropoffName || 'وجهة الوصول';
                bDropoffCoords = [bPickupCoords[0] + 0.025, bPickupCoords[1] + 0.025];
            }

            var userId = localStorage.getItem('user_id') || 'usr-current';
            var role = localStorage.getItem('user_role') || 'Customer';
            var isDriver = (role === 'Driver' || role === 'driver');
            var tripType = localStorage.getItem('selected_trip_type') || bActiveTab || 'short';
            var isShortTrip = !isDriver && (tripType === 'short' || tripType === 'ShortTrip');
            var fullName = localStorage.getItem('user_fullname') || (isDriver ? 'كابتن توصيله' : 'راكب توصيله');
            var phone = localStorage.getItem('user_phone') || '';
            var fromText = bPickupName || typedPickup || 'نقطة الانطلاق';
            var toText = bDropoffName || typedDropoff || 'نقطة الوصول';

            var saveBtn = document.getElementById('btn-floating-save-route') || document.getElementById('btn-save-route-db');
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.innerHTML = isShortTrip ? '<span>🔍</span> <span>جاري البحث عن أقرب سائق متواجد...</span>' : '⏳ جاري الحفظ في قاعدة البيانات...';
            }

            try {
                if (isDriver) {
                    var res = await fetch('/api/driver/set-route', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            driverId: userId,
                            fromText: fromText,
                            toText: toText,
                            fromLat: bPickupCoords[1],
                            fromLon: bPickupCoords[0],
                            toLat: bDropoffCoords[1],
                            toLon: bDropoffCoords[0]
                        })
                    });
                    var data = await res.json();
                    if (data.success) {
                        alert('✅ تم تثبيت مسارك بنجاح في قاعدة البيانات.');
                        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '✅ تم حفظ وتثبيت المسار'; }
                    } else {
                        alert(data.error || 'تعذر حفظ المسار');
                        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '📌 تأكيد وتثبيت المسار'; }
                    }
                } else {
                    await fetch('/api/passenger/set-permanent-location', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            customerId: userId,
                            lat: bPickupCoords[1],
                            lon: bPickupCoords[0],
                            locationName: fromText,
                            dropoffLat: bDropoffCoords[1],
                            dropoffLon: bDropoffCoords[0],
                            dropoffName: toText,
                            route: fromText + ' ➔ ' + toText
                        })
                    });

                    if (isShortTrip) {
                        var statusEl = document.getElementById('map-target-status');
                        if (statusEl) {
                            statusEl.textContent = '🔍 جاري البحث عن أقرب سائق متواجد...';
                            statusEl.style.background = '#fef3c7';
                            statusEl.style.color = '#b45309';
                        }
                        if (saveBtn) {
                            saveBtn.disabled = true;
                            saveBtn.innerHTML = '<span>🔍</span> <span>جاري البحث عن أقرب سائق متواجد...</span>';
                        }
                        var modal = document.getElementById('ride-dispatch-modal');
                        if (modal) {
                            modal.style.display = 'flex';
                            var titleEl = document.getElementById('dispatch-modal-title');
                            if (titleEl) titleEl.textContent = 'جاري البحث عن أقرب سائق متواجد...';
                            var subEl = document.getElementById('dispatch-modal-subtitle');
                            if (subEl) subEl.textContent = 'تم تثبيت مسارك (' + fromText + ' ➔ ' + toText + ')، جاري الاتصال بأقرب كابتن...';
                            var drvName = document.getElementById('dispatch-drv-name');
                            if (drvName) drvName.textContent = '🚕 جاري البحث عن أقرب كابتن...';
                            var drvStatus = document.getElementById('dispatch-drv-status');
                            if (drvStatus) { drvStatus.textContent = 'الحالة: جاري إرسال الطلب...'; drvStatus.style.color = '#2563eb'; }
                        }
                        await requestNearestDriver();
                    } else {
                        await fetch('/api/routes/permanent', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                passengerId: userId,
                                passengerName: fullName,
                                passengerPhone: phone,
                                startLat: bPickupCoords[1],
                                startLon: bPickupCoords[0],
                                startName: fromText,
                                endLat: bDropoffCoords[1],
                                endLon: bDropoffCoords[0],
                                endName: toText,
                                days: bPermDays || ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء'],
                                departureTime: '08:00 AM',
                                routeGeometry: bRouteGeom
                            })
                        });

                        alert('✅ تم تثبيت مسارك في قاعدة البيانات بنجاح: ' + fromText + ' ➔ ' + toText);
                        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '✅ تم تثبيت المسار'; }
                        loadMatchingDriversForPassenger();
                    }
                }
            } catch(e) {
                alert('خطأ في الاتصال بقاعدة البيانات');
                if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '📌 تأكيد وتثبيت المسار'; }
            }
        };

        window.loadMatchingDriversForPassenger = async function() {
            var container = document.getElementById('passenger-matching-drivers-list');
            if (!container) return;
            container.innerHTML = '<div style="font-size:12px;color:#6b7280;text-align:center;padding:12px;"><i class="fa-solid fa-circle-notch fa-spin"></i> جاري مطابقة السائقين القريبين لمسارك...</div>';

            var pLat = bPickupCoords ? bPickupCoords[1] : (bUserLat || 32.0);
            var pLon = bPickupCoords ? bPickupCoords[0] : (bUserLon || 44.3);

            try {
                var res = await fetch('/api/drivers/nearby?lat=' + pLat + '&lon=' + pLon + '&rangeKm=25');
                var data = await res.json();
                var drivers = Array.isArray(data) ? data : (data.drivers || []);

                if (drivers.length === 0) {
                    container.innerHTML = '<div style="font-size:12px;color:#94a3b8;text-align:center;padding:12px;background:#f8fafc;border-radius:10px;">لا يوجد سائقون قريبون متاحون حالياً على مسارك</div>';
                    return;
                }

                container.innerHTML = '';
                drivers.slice(0, 10).forEach(function(d) {
                    var card = document.createElement('div');
                    card.className = 'driver-mini-card';
                    card.style.cssText = 'background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:8px;';
                    var dPhone = d.phoneNumber || d.phone || d.driverPhone || '';
                    var waNum = dPhone.replace(/[^0-9]/g, '').replace(/^07/, '9647');
                    var waBtn = waNum ? '<a href="https://wa.me/' + waNum + '" target="_blank" class="btn-small" style="background:#25d366;color:#fff;text-decoration:none;padding:6px 10px;font-size:11px;font-weight:700;">واتساب 💬</a>' : '';

                    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
                        '<span style="font-weight:900;font-size:13px;color:#111;">🚕 ' + (d.driverName || d.fullName || 'كابتن') + '</span>' +
                        '<span style="font-size:11px;font-weight:800;color:#059669;">📍 يبعد ' + (d.distanceKm || 1) + ' كم</span>' +
                        '</div>' +
                        '<div style="font-size:11px;color:#64748b;margin-bottom:6px;">🚗 ' + (d.carModel || d.vehicleInfo || 'تويوتا') + '</div>' +
                        '<div style="display:flex;gap:6px;align-items:center;">' +
                        '<button type="button" onclick="sendPassengerJoinRequest(&quot;' + d.driverId + '&quot;)" class="btn-primary" style="flex:1;padding:6px 10px;font-size:11px;background:#2563eb;">🙋 طلب انضمام</button>' +
                        waBtn +
                        '</div>';
                    container.appendChild(card);
                });
            } catch(e) {
                container.innerHTML = '<div style="font-size:12px;color:#dc2626;text-align:center;">تعذر تحميل السائقين القريبين</div>';
            }
        };


        window.sendPassengerJoinRequest = async function(driverId) {
            var userId = localStorage.getItem('user_id') || 'usr-current';
            if (!bPickupCoords || !bDropoffCoords) {
                alert('يرجى تحديد مسارك على الخريطة أولاً');
                return;
            }
            try {
                var res = await fetch('/api/passenger/join-request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        passengerId: userId,
                        driverId: driverId,
                        pickupLat: bPickupCoords[1],
                        pickupLon: bPickupCoords[0],
                        dropoffLat: bDropoffCoords[1],
                        dropoffLon: bDropoffCoords[0],
                        pickupText: bPickupName || 'موقع الركوب',
                        dropoffText: bDropoffName || 'وجهة الوصول'
                    })
                });
                var data = await res.json();
                if (data.success) {
                    alert('🎉 تم إرسال طلب الانضمام إلى الكابتن بنجاح! سيتم إشعارك فور القبول.');
                } else {
                    alert(data.error || 'تعذر إرسال طلب الانضمام');
                }
            } catch(e) {
                alert('خطأ في الاتصال بالخادم');
            }
        };

        window.renderJoinRequestsSidebar = async function() {
            var panel = document.getElementById('sidebar-panel-join-requests');
            if (!panel) return;
            var role = localStorage.getItem('user_role') || 'Customer';
            var isDriver = (role === 'Driver' || role === 'driver');
            var driverId = localStorage.getItem('user_id') || '';
            var fullName = localStorage.getItem('user_fullname') || (isDriver ? 'كابتن توصيله' : 'راكب توصيله');

            var drawerNavHtml = '<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:8px 10px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">' +
                '<div style="display:flex;align-items:center;gap:8px;">' +
                    '<span style="font-size:18px;">' + (isDriver ? '🚖' : '👤') + '</span>' +
                    '<div>' +
                        '<div style="font-size:12px;font-weight:900;color:#111;">' + fullName + '</div>' +
                        '<div style="font-size:10px;color:#64748b;font-weight:700;">' + (isDriver ? 'كابتن معتمد' : 'راكب') + '</div>' +
                    '</div>' +
                '</div>' +
                '<button type="button" onclick="switchRouteTab(&quot;set-route&quot;)" style="background:' + (isDriver ? '#059669' : '#2563eb') + ';color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;">' +
                    (isDriver ? '🚖 واجهة السائق' : '👤 واجهة الراكب') +
                '</button>' +
            '</div>';

            if (isDriver) {
                panel.innerHTML = drawerNavHtml +
                    '<div style="font-size:14px;font-weight:900;color:#111;margin-bottom:6px;">🙋 إدارة طلبات الانضمام لمسارك</div>' +
                    '<div style="font-size:12px;color:#6b7280;margin-bottom:12px;">طلبات الركاب الراغبين بالانضمام إلى مسارك المعتمد</div>' +
                    '<div id="driver-join-requests-container" style="display:flex;flex-direction:column;gap:10px;max-height:60vh;overflow-y:auto;">' +
                    '<div style="text-align:center;padding:12px;color:#6b7280;font-size:12px;"><i class="fa-solid fa-circle-notch fa-spin"></i> جاري جلب الطلبات...</div>' +
                    '</div>';

                try {
                    var res = await fetch('/api/driver/join-requests/' + driverId);
                    var data = await res.json();
                    var requests = data.requests || [];
                    var box = document.getElementById('driver-join-requests-container');
                    if (!box) return;
                    if (requests.length === 0) {
                        box.innerHTML = '<div style="font-size:12px;color:#94a3b8;text-align:center;padding:16px;background:#f8fafc;border-radius:12px;">لا توجد طلبات انضمام جديدة حالياً</div>';
                        return;
                    }
                    box.innerHTML = '';
                    requests.forEach(function(jr) {
                        var card = document.createElement('div');
                        card.style.cssText = 'background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:6px;';
                        card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                            '<span style="font-weight:900;font-size:13px;color:#111;">👤 ' + (jr.passengerName || 'راكب') + '</span>' +
                            '<span style="font-size:10px;background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:6px;font-weight:700;">طلب انضمام</span>' +
                            '</div>' +
                            '<div style="font-size:11px;color:#16a34a;">🟢 الانطلاق: ' + (jr.pickupText || 'موقع الركوب') + '</div>' +
                            '<div style="font-size:11px;color:#dc2626;">🔴 الوجهة: ' + (jr.dropoffText || 'نقطة الوصول') + '</div>' +
                            '<div style="display:flex;gap:6px;margin-top:6px;">' +
                            '<button type="button" onclick="driverApproveJoinRequest(&quot;' + jr.requestId + '&quot;)" class="btn-primary" style="flex:1;background:#16a34a;padding:8px;font-size:12px;font-weight:900;">✅ قبول وملاحة Waze</button>' +
                            '<button type="button" onclick="driverRejectJoinRequest(&quot;' + jr.requestId + '&quot;)" class="btn-secondary" style="color:#dc2626;border-color:#fecaca;padding:8px;font-size:12px;">❌ رفض</button>' +
                            '</div>';
                        box.appendChild(card);
                    });
                } catch(_) {
                    var b = document.getElementById('driver-join-requests-container');
                    if (b) b.innerHTML = '<div style="font-size:12px;color:#dc2626;text-align:center;">تعذر تحميل الطلبات</div>';
                }
            } else {
                panel.innerHTML = drawerNavHtml +
                    '<div style="font-size:14px;font-weight:900;color:#111;margin-bottom:6px;">🙋 إدارة طلبات الانضمام</div>' +
                    '<div style="font-size:12px;color:#6b7280;margin-bottom:12px;">السائقون القريبون على نفس مسارك لتثبيت الانضمام</div>' +
                    '<div id="passenger-matching-drivers-list"></div>';
                loadMatchingDriversForPassenger();
            }
        };

        window.driverApproveJoinRequest = async function(requestId) {
            var driverId = localStorage.getItem('user_id') || '';
            try {
                var res = await fetch('/api/driver/approve-join', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: requestId, driverId: driverId })
                });
                var data = await res.json();
                if (data.success) {
                    alert('✅ تم قبول الراكب بنجاح! جاري فتح ملاحة Waze...');
                    if (data.wazeUrl) {
                        window.open(data.wazeUrl, '_blank');
                    } else if (data.pickupLat && data.pickupLon) {
                        window.open('https://waze.com/ul?ll=' + data.pickupLat + ',' + data.pickupLon + '&navigate=yes', '_blank');
                    }
                    renderJoinRequestsSidebar();
                } else {
                    alert(data.error || 'تعذر قبول الطلب');
                }
            } catch(e) {
                alert('خطأ في الاتصال');
            }
        };

        window.driverRejectJoinRequest = async function(requestId) {
            if (!confirm('هل تريد رفض طلب الانضمام؟')) return;
            try {
                var res = await fetch('/api/driver/reject-join', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: requestId })
                });
                var data = await res.json();
                if (data.success) {
                    renderJoinRequestsSidebar();
                }
            } catch(_) {}
        };

        window.setBookingSearchRange = function(km) {
            bRangeKm = km;
            [3, 5, 10, 15].forEach(function(k) {
                var el = document.getElementById('rng-chip-' + k);
                if (el) el.className = (k === km ? 'range-chip active' : 'range-chip');
            });
            fetchNearbyDriversForMap();
        };

        window.centerOnUserGps = function() {
            var btn = document.getElementById('btn-gps-pickup');
            if (btn) btn.innerHTML = '<span>⏳ جاري تحديد موقعك...</span>';

            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(function(pos) {
                    bUserLat = pos.coords.latitude;
                    bUserLon = pos.coords.longitude;
                    bHasUserGps = true;
                    if (bMap) {
                        bMap.flyTo({ center: [bUserLon, bUserLat], zoom: 16 });
                    }
                    setBookingPickup(bUserLon, bUserLat, 'موقعي الحالي');
                    bReverseGeocode(bUserLon, bUserLat).then(function(addr) {
                        if (addr) {
                            bPickupName = addr;
                            var inp = document.getElementById('book-pickup-input');
                            if (inp) inp.value = addr;
                        }
                    });
                    if (btn) btn.innerHTML = '<span>📍 موقعي الحالي ✅</span>';
                    var statusEl = document.getElementById('map-target-status');
                    if (statusEl) {
                        statusEl.textContent = '✅ تم تثبيت موقعك الحالي - حدد أو اكتب الوجهة';
                        statusEl.style.background = '#dcfce7';
                        statusEl.style.color = '#15803d';
                    }
                    setMapTarget('dropoff');
                    fetchNearbyDriversForMap();
                }, function(err) {
                    console.log('GPS error:', err);
                    if (btn) btn.innerHTML = '<span>📍 موقعي الحالي</span>';
                    if (bGeolocate) {
                        try { bGeolocate.trigger(); } catch(_) {}
                    } else {
                        alert('⚠️ تعذر جلب الموقع الدقيق. يرجى تفعيل الـ GPS في المتصفح أو الهاتف.');
                    }
                }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
            } else if (bGeolocate) {
                bGeolocate.trigger();
                if (btn) btn.innerHTML = '<span>📍 موقعي الحالي ✅</span>';
            }
        };

        async function initBookingMapbox() {
            if (typeof mapboxgl === 'undefined' && window.loadMapboxDynamically) {
                await window.loadMapboxDynamically();
            }
            if (typeof mapboxgl === 'undefined') return;
            mapboxgl.accessToken = BOOKING_MAPBOX_TOKEN;
            if (typeof mapboxgl.getRTLTextPluginStatus === 'function' && mapboxgl.getRTLTextPluginStatus() === 'unavailable') {
                try {
                    mapboxgl.setRTLTextPlugin('https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js', null, true);
                } catch(_) {}
            }
            var initialCenter = [bUserLon || 44.3168, bUserLat || 31.9961];
            bMap = new mapboxgl.Map({
                container: 'booking-mapbox-map',
                style: 'mapbox://styles/mapbox/streets-v12',
                center: initialCenter,
                zoom: 14
            });
            setTimeout(function() { if (bMap) bMap.resize(); }, 150);
            setTimeout(function() { if (bMap) bMap.resize(); }, 500);

            bMap.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'top-left');

            bGeolocate = new mapboxgl.GeolocateControl({
                positionOptions: { enableHighAccuracy: true },
                trackUserLocation: true,
                showUserHeading: true
            });
            bMap.addControl(bGeolocate, 'top-left');

            bGeolocate.on('geolocate', function(e) {
                bUserLat = e.coords.latitude;
                bUserLon = e.coords.longitude;
                bHasUserGps = true;
                if (!bPickupCoords) {
                    setBookingPickup(bUserLon, bUserLat, 'موقعي الحالي');
                }
                fetchNearbyDriversForMap();
            });

            // Fallback immediate GPS lookup
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(function(pos) {
                    bUserLat = pos.coords.latitude;
                    bUserLon = pos.coords.longitude;
                    bHasUserGps = true;
                    if (bMap) {
                        bMap.flyTo({ center: [bUserLon, bUserLat], zoom: 15 });
                    }
                    if (!bPickupCoords) {
                        setBookingPickup(bUserLon, bUserLat, 'موقعي الحالي');
                    }
                    fetchNearbyDriversForMap();
                }, function(err) {
                    console.log('GPS lookup info:', err);
                }, { enableHighAccuracy: true, timeout: 10000 });
            }

            bMap.on('load', function() {
                // Auto request geolocation on open (Stage 1)
                try { bGeolocate.trigger(); } catch(_) {}

                // Drivers GeoJSON source & layers (Stage 1)
                bMap.addSource('booking-drivers-source', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] }
                });
                bMap.addLayer({
                    id: 'booking-drivers-circle',
                    type: 'circle',
                    source: 'booking-drivers-source',
                    paint: {
                        'circle-radius': 14,
                        'circle-color': '#f59e0b',
                        'circle-stroke-width': 2.5,
                        'circle-stroke-color': '#ffffff'
                    }
                });
                bMap.addLayer({
                    id: 'booking-drivers-symbol',
                    type: 'symbol',
                    source: 'booking-drivers-source',
                    layout: {
                        'text-field': '🚕',
                        'text-size': 18,
                        'text-allow-overlap': true,
                        'text-ignore-placement': true
                    }
                });

                // Directions route line source & layers (Stage 2)
                bMap.addSource('booking-route-source', {
                    type: 'geojson',
                    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
                });
                bMap.addLayer({
                    id: 'booking-route-casing',
                    type: 'line',
                    source: 'booking-route-source',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': '#0f172a', 'line-width': 7, 'line-opacity': 0.75 }
                });
                bMap.addLayer({
                    id: 'booking-route-line',
                    type: 'line',
                    source: 'booking-route-source',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': '#2563eb', 'line-width': 4.5, 'line-opacity': 0.95 }
                });

                // Live assigned driver tracking source & layer (Stage 3 - Phase 3)
                bMap.addSource('live-driver-source', {
                    type: 'geojson',
                    data: { type: 'FeatureCollection', features: [] }
                });
                bMap.addLayer({
                    id: 'live-driver-circle',
                    type: 'circle',
                    source: 'live-driver-source',
                    paint: {
                        'circle-radius': 18,
                        'circle-color': '#16a34a',
                        'circle-stroke-width': 3,
                        'circle-stroke-color': '#ffffff'
                    }
                });
                bMap.addLayer({
                    id: 'live-driver-symbol',
                    type: 'symbol',
                    source: 'live-driver-source',
                    layout: {
                        'text-field': '🚗',
                        'text-size': 22,
                        'text-allow-overlap': true,
                        'text-ignore-placement': true
                    }
                });

                // Live driver → pickup route line (Stage 3)
                bMap.addSource('live-driver-route-source', {
                    type: 'geojson',
                    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
                });
                bMap.addLayer({
                    id: 'live-driver-route-casing',
                    type: 'line',
                    source: 'live-driver-route-source',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': '#064e3b', 'line-width': 7, 'line-opacity': 0.6 }
                });
                bMap.addLayer({
                    id: 'live-driver-route-line',
                    type: 'line',
                    source: 'live-driver-route-source',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': '#22c55e', 'line-width': 4, 'line-opacity': 0.95 }
                });

                // Map Click handler to set pins based on active target
                bMap.on('click', function(e) {
                    var lng = e.lngLat.lng, lat = e.lngLat.lat;
                    if (bMapPickTarget === 'dropoff') {
                        setBookingDropoff(lng, lat, '');
                    } else {
                        setBookingPickup(lng, lat, '');
                        if (!bDropoffCoords) setMapTarget('dropoff');
                    }
                });

                fetchNearbyDriversForMap();
                if (bDriversPollTimer) clearInterval(bDriversPollTimer);
                bDriversPollTimer = setInterval(fetchNearbyDriversForMap, 5000);
            });
        }

        async function bReverseGeocode(lng, lat) {
            try {
                var res = await fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/' + lng + ',' + lat + '.json?country=iq&language=ar&access_token=' + BOOKING_MAPBOX_TOKEN);
                var data = await res.json();
                if (data && data.features && data.features.length > 0) {
                    return data.features[0].place_name_ar || data.features[0].place_name || '';
                }
            } catch(_) {}
            return lat.toFixed(4) + ', ' + lng.toFixed(4);
        }

        function setBookingPickup(lng, lat, name) {
            bPickupCoords = [lng, lat];
            if (!bPickupMarker && bMap) {
                var el = document.createElement('div');
                el.innerHTML = '<div style="background:#16a34a;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,0.3);font-size:14px;cursor:grab;">🟢</div>';
                bPickupMarker = new mapboxgl.Marker({ element: el, draggable: true }).setLngLat([lng, lat]).addTo(bMap);
                bPickupMarker.on('dragend', async function() {
                    var p = bPickupMarker.getLngLat();
                    bPickupCoords = [p.lng, p.lat];
                    var addr = await bReverseGeocode(p.lng, p.lat);
                    bPickupName = addr;
                    var inp = document.getElementById('book-pickup-input');
                    if (inp) inp.value = addr;
                    calculateBookingRoute();
                });
            } else if (bPickupMarker) {
                bPickupMarker.setLngLat([lng, lat]);
            }

            if (name) {
                bPickupName = name;
                var inp = document.getElementById('book-pickup-input');
                if (inp) inp.value = name;
            } else {
                bReverseGeocode(lng, lat).then(function(addr) {
                    bPickupName = addr;
                    var inp = document.getElementById('book-pickup-input');
                    if (inp) inp.value = addr;
                });
            }
            calculateBookingRoute();
        }

        function setBookingDropoff(lng, lat, name) {
            bDropoffCoords = [lng, lat];
            if (!bDropoffMarker && bMap) {
                var el = document.createElement('div');
                el.innerHTML = '<div style="background:#dc2626;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,0.3);font-size:14px;cursor:grab;">🔴</div>';
                bDropoffMarker = new mapboxgl.Marker({ element: el, draggable: true }).setLngLat([lng, lat]).addTo(bMap);
                bDropoffMarker.on('dragend', async function() {
                    var p = bDropoffMarker.getLngLat();
                    bDropoffCoords = [p.lng, p.lat];
                    var addr = await bReverseGeocode(p.lng, p.lat);
                    bDropoffName = addr;
                    var inp = document.getElementById('book-dropoff-input');
                    if (inp) inp.value = addr;
                    calculateBookingRoute();
                });
            } else if (bDropoffMarker) {
                bDropoffMarker.setLngLat([lng, lat]);
            }

            if (name) {
                bDropoffName = name;
                var inp = document.getElementById('book-dropoff-input');
                if (inp) inp.value = name;
            } else {
                bReverseGeocode(lng, lat).then(function(addr) {
                    bDropoffName = addr;
                    var inp = document.getElementById('book-dropoff-input');
                    if (inp) inp.value = addr;
                });
            }
            calculateBookingRoute();
        }

        async function calculateBookingRoute() {
            if (!bPickupCoords || !bDropoffCoords || !bMap) return;
            try {
                var url = 'https://api.mapbox.com/directions/v5/mapbox/driving/' + bPickupCoords[0] + ',' + bPickupCoords[1] + ';' + bDropoffCoords[0] + ',' + bDropoffCoords[1] + '?geometries=geojson&overview=full&access_token=' + BOOKING_MAPBOX_TOKEN;
                var res = await fetch(url);
                var data = await res.json();
                if (!data.routes || !data.routes[0]) return;
                var r = data.routes[0];
                bRouteGeom = r.geometry;
                bRouteDist = Math.round((r.distance / 1000) * 10) / 10;
                bRouteDur = Math.max(1, Math.round(r.duration / 60));
                bRouteFare = Math.max(2000, Math.round(2000 + (bRouteDist * 500) / 250) * 250);

                if (bMap.getSource('booking-route-source')) {
                    bMap.getSource('booking-route-source').setData({ type: 'Feature', geometry: bRouteGeom });
                }

                var bounds = new mapboxgl.LngLatBounds();
                bounds.extend(bPickupCoords);
                bounds.extend(bDropoffCoords);
                bMap.fitBounds(bounds, { padding: 60, maxZoom: 15 });

                var pill = document.getElementById('booking-route-pill');
                if (pill) {
                    pill.style.display = 'flex';
                    var dEl = document.getElementById('route-pill-dist');
                    var duEl = document.getElementById('route-pill-dur');
                    var fEl = document.getElementById('route-pill-fare');
                    if (dEl) dEl.textContent = '📏 ' + bRouteDist + ' كم';
                    if (duEl) duEl.textContent = '⏱️ ' + bRouteDur + ' دقيقة';
                    if (fEl) fEl.textContent = '💰 ' + bRouteFare.toLocaleString() + ' د.ع';
                }

                // Update floating card summary pill
                var cardPill = document.getElementById('floating-route-summary-pill');
                if (cardPill) {
                    cardPill.style.display = 'flex';
                    var cdEl = document.getElementById('card-route-dist');
                    var cdurEl = document.getElementById('card-route-dur');
                    var cfEl = document.getElementById('card-route-fare');
                    if (cdEl) cdEl.textContent = '📏 ' + bRouteDist + ' كم';
                    if (cdurEl) cdurEl.textContent = '⏱️ ' + bRouteDur + ' دقيقة';
                    if (cfEl) cfEl.textContent = '💰 ' + bRouteFare.toLocaleString() + ' د.ع';
                }

                // Update floating save button fare badge
                var fareSpan = document.getElementById('floating-btn-fare');
                if (fareSpan) { fareSpan.style.display = 'inline'; fareSpan.textContent = bRouteFare.toLocaleString() + ' د.ع'; }

                var sideInfo = document.getElementById('side-route-summary');
                if (sideInfo) {
                    sideInfo.style.display = 'block';
                    sideInfo.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-weight:900;color:#111">المسار المقدر:</span><span style="font-weight:900;color:#059669;font-size:14px">' + bRouteFare.toLocaleString() + ' د.ع</span></div><div style="font-size:11px;color:#64748b;display:flex;gap:12px"><span>📏 ' + bRouteDist + ' كم</span><span>⏱️ ' + bRouteDur + ' دقيقة</span></div>';
                }
            } catch(e) {}
        }

        async function fetchNearbyDriversForMap() {
            try {
                var lat = bPickupCoords ? bPickupCoords[1] : bUserLat;
                var lon = bPickupCoords ? bPickupCoords[0] : bUserLon;
                var res = await fetch('/api/drivers/nearby?tripType=short&lat=' + lat + '&lon=' + lon + '&rangeKm=' + bRangeKm);
                var drivers = await res.json();
                bNearbyDrivers = Array.isArray(drivers) ? drivers : [];

                if (bMap && bMap.getSource('booking-drivers-source')) {
                    var features = bNearbyDrivers.map(function(d) {
                        return {
                            type: 'Feature',
                            properties: { id: d.driverId, name: d.driverName, car: d.carModel, distance: d.distanceKm },
                            geometry: { type: 'Point', coordinates: [d.longitude, d.latitude] }
                        };
                    });
                    bMap.getSource('booking-drivers-source').setData({ type: 'FeatureCollection', features: features });
                }

                if (bActiveTab === 'short') {
                    renderNearbyDriversList();
                }
            } catch(_) {}
        }

        // Search Autocomplete for Dropoff
        var bDropoffTimer = null;
        window.onBookingDropoffSearch = function(query) {
            clearTimeout(bDropoffTimer);
            var clrBtn = document.getElementById('btn-clear-dropoff');
            if (clrBtn) clrBtn.style.display = query ? 'block' : 'none';
            var resultsEl = document.getElementById('book-dropoff-results');
            if (!resultsEl) return;
            if (query) bDropoffName = query;
            if (!query || query.trim().length < 1) { resultsEl.style.display = 'none'; return; }

            resultsEl.innerHTML = '';
            var customItem = document.createElement('div');
            customItem.className = 'search-result-item';
            customItem.style.cssText = 'background:#f0fdf4;font-weight:bold;color:#166534;border-bottom:1px solid #dcfce7;';
            customItem.innerHTML = '<span>📌</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">اعتماد: "' + query + '"</span>';
            customItem.onclick = function() {
                resultsEl.style.display = 'none';
                var pLon = (bPickupCoords ? bPickupCoords[0] : (bUserLon || 44.3168)) + 0.02;
                var pLat = (bPickupCoords ? bPickupCoords[1] : (bUserLat || 31.9961)) + 0.02;
                setBookingDropoff(pLon, pLat, query);
            };
            resultsEl.appendChild(customItem);
            resultsEl.style.display = 'block';

            var local = searchLocalNajafPlaces(query);
            if (local.length > 0) {
                local.forEach(function(p) {
                    var item = document.createElement('div');
                    item.className = 'search-result-item';
                    item.innerHTML = '<span>📍</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + p.name + '</span>';
                    item.onclick = function() { resultsEl.style.display = 'none'; setBookingDropoff(p.lon, p.lat, p.name); };
                    resultsEl.appendChild(item);
                });
            }

            bDropoffTimer = setTimeout(async function() {
                try {
                    var q = encodeURIComponent(query.trim());
                    var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + q + '.json?country=iq&proximity=' + (bUserLon||44.3168) + ',' + (bUserLat||31.9961) + '&language=ar,en&types=poi,address,neighborhood,place,locality&limit=6&access_token=' + BOOKING_MAPBOX_TOKEN;
                    var res = await fetch(url);
                    var data = await res.json();
                    var feats = (data && data.features) ? data.features : [];
                    resultsEl.innerHTML = '';
                    resultsEl.appendChild(customItem);
                    if (local.length > 0) {
                        local.forEach(function(p) {
                            var item = document.createElement('div');
                            item.className = 'search-result-item';
                            item.innerHTML = '<span>📍</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + p.name + '</span>';
                            item.onclick = function() { resultsEl.style.display = 'none'; setBookingDropoff(p.lon, p.lat, p.name); };
                            resultsEl.appendChild(item);
                        });
                    }
                    feats.forEach(function(f) {
                        var nm = f.place_name_ar || f.place_name || '';
                        var item = document.createElement('div');
                        item.className = 'search-result-item';
                        item.innerHTML = '<span>🗺️</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + nm + '</span>';
                        item.onclick = function() { resultsEl.style.display = 'none'; setBookingDropoff(f.center[0], f.center[1], nm); };
                        resultsEl.appendChild(item);
                    });
                    resultsEl.style.display = resultsEl.children.length > 0 ? 'block' : 'none';
                } catch(_) {}
            }, 300);
        };

        // Render Short Trip Sidebar (Stage 1 & 2)
        function renderShortTripSidebar() {
            var panel = document.getElementById('sidebar-panel-short');
            if (!panel) return;
            panel.innerHTML = '<div style="font-size:14px;font-weight:900;color:#111;margin-bottom:4px;">⚡ حجز مشوار قصير فوري</div>' +
                '<div style="position:relative;">' +
                    '<label class="label" style="font-size:11px;">🟢 نقطة الانطلاق</label>' +
                    '<div style="display:flex;gap:6px;">' +
                        '<input type="text" id="book-pickup-input" class="inp" placeholder="حدد على الخريطة أو موقعي الحالي" value="' + (bPickupName||'') + '" style="font-size:12px;padding:9px 12px;">' +
                        '<button type="button" onclick="centerOnUserGps()" class="btn-small" style="padding:8px 10px;" title="موقعي الحالي">📍</button>' +
                    '</div>' +
                '</div>' +
                '<div style="position:relative;">' +
                    '<label class="label" style="font-size:11px;">🔴 نقطة الوصول (ابحث عن جامعة/حي/معلم)</label>' +
                    '<input type="text" id="book-dropoff-input" class="inp" placeholder="ابحث: جامعة الكوفة، شارع الروان..." value="' + (bDropoffName||'') + '" oninput="onBookingDropoffSearch(this.value)" style="font-size:12px;padding:9px 12px;">' +
                    '<div id="book-dropoff-results" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:50;background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;box-shadow:0 4px 15px rgba(0,0,0,0.1);max-height:160px;overflow-y:auto;margin-top:2px;"></div>' +
                '</div>' +
                '<div id="side-route-summary" style="display:' + (bRouteDist > 0 ? 'block' : 'none') + ';background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:10px;">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
                        '<span style="font-weight:900;color:#111;">المسار المقدر:</span>' +
                        '<span style="font-weight:900;color:#059669;font-size:14px;">' + (bRouteFare||0).toLocaleString() + ' د.ع</span>' +
                    '</div>' +
                    '<div style="font-size:11px;color:#64748b;display:flex;gap:12px;">' +
                        '<span>📏 ' + bRouteDist + ' كم</span>' +
                        '<span>⏱️ ' + bRouteDur + ' دقيقة</span>' +
                    '</div>' +
                '</div>' +
                '<button type="button" onclick="requestNearestDriver()" class="btn-primary" style="background:#111827;font-size:13px;padding:12px;display:flex;align-items:center;justify-content:center;gap:8px;">' +
                    '<span>🚕</span> <span>اطلب أقرب سائق متاح</span>' +
                '</button>' +
                '<div style="margin-top:6px;">' +
                    '<div style="font-size:12px;font-weight:800;color:#374151;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">' +
                        '<span>السائقون القريبون (' + bNearbyDrivers.length + '):</span>' +
                        '<span style="font-size:10px;color:#6b7280;">تحديث كل 5 ثوانٍ 🔄</span>' +
                    '</div>' +
                    '<div id="side-drivers-list" style="display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;"></div>' +
                '</div>';
            renderNearbyDriversList();
        }

        function renderNearbyDriversList() {
            var list = document.getElementById('side-drivers-list');
            if (!list) return;
            if (bNearbyDrivers.length === 0) {
                list.innerHTML = '<div style="font-size:12px;color:#94a3b8;text-align:center;padding:12px;background:#f8fafc;border-radius:10px;">لا يوجد سائقون متاحون ضمن النطاق المحدد</div>';
                return;
            }
            list.innerHTML = '';
            bNearbyDrivers.slice(0, 10).forEach(function(d) {
                var card = document.createElement('div');
                card.className = 'driver-mini-card';
                var eta = Math.max(2, Math.round(d.distanceKm / 0.5));
                card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">' +
                        '<span style="font-weight:900;font-size:12px;color:#111;">🚕 ' + d.driverName + '</span>' +
                        '<span style="font-size:11px;font-weight:800;color:#059669;">⏱️ ' + eta + ' دقيقة</span>' +
                    '</div>' +
                    '<div style="font-size:11px;color:#64748b;display:flex;justify-content:space-between;align-items:center;">' +
                        '<span>🚗 ' + (d.carModel || 'تويوتا') + '</span>' +
                        '<span>📏 يبعد ' + d.distanceKm + ' كم</span>' +
                    '</div>';
                card.onclick = function() {
                    if (bMap) bMap.flyTo({ center: [d.longitude, d.latitude], zoom: 15 });
                };
                list.appendChild(card);
            });
        }

        // Request Nearest Driver & 30-Second Escalation (Stage 1)
        window.requestNearestDriver = async function() {
            var existingAccepted = null;
            try {
                existingAccepted = JSON.parse(localStorage.getItem('active_accepted_ride') || 'null');
            } catch(_) {}
            if (existingAccepted && (existingAccepted.status === 'Accepted' || existingAccepted.status === 'Arrived' || existingAccepted.status === 'InProgress')) {
                showPassengerActiveBlockedModal(existingAccepted);
                return;
            }

            var pInp = document.getElementById('book-pickup-input');
            var dInp = document.getElementById('book-dropoff-input');
            var pTxt = pInp ? pInp.value.trim() : '';
            var dTxt = dInp ? dInp.value.trim() : '';

            if (!bPickupCoords) {
                var pLon = bUserLon || 44.3168;
                var pLat = bUserLat || 31.9961;
                bPickupCoords = [pLon, pLat];
                if (!bPickupName) bPickupName = pTxt || 'موقعي الحالي';
            }
            if (!bDropoffCoords) {
                if (!dTxt && !bDropoffName) {
                    alert('يرجى كتابة أو تحديد وجهة الوصول على الخريطة');
                    if (dInp) dInp.focus();
                    return;
                }
                bDropoffName = dTxt || bDropoffName;
                bDropoffCoords = [bPickupCoords[0] + 0.025, bPickupCoords[1] + 0.025];
            }
            var uid = localStorage.getItem('user_id') || 'cust-user';
            var uName = localStorage.getItem('user_fullname') || 'راكب توصيله';
            var uPhone = localStorage.getItem('user_phone') || '';

            try {
                var res = await fetch('/api/ride/request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        customerId: uid,
                        customerName: uName,
                        customerPhone: uPhone,
                        pickupName: bPickupName || 'موقع الركوب',
                        pickupLat: bPickupCoords[1],
                        pickupLon: bPickupCoords[0],
                        dropoffName: bDropoffName || 'وجهة الوصول',
                        dropoffLat: bDropoffCoords[1],
                        dropoffLon: bDropoffCoords[0],
                        fare: bRouteFare || 3000,
                        distanceKm: bRouteDist || 3.5,
                        durationMins: bRouteDur || 8,
                        rangeKm: bRangeKm
                    })
                });
                var data = await res.json();
                if (data.activeRideExists) {
                    var actReq = data.activeRequest || { id: data.activeRequestId };
                    localStorage.setItem('active_accepted_ride', JSON.stringify(actReq));
                    resetSaveRouteButton();
                    showPassengerActiveBlockedModal(actReq);
                    return;
                }
                if (data.success && data.request) {
                    bActiveRideId = data.request.id;
                    showDispatchModal(data.request);
                } else {
                    resetSaveRouteButton();
                    alert(data.error || 'تعذر إرسال طلب المشوار');
                }
            } catch(e) {
                resetSaveRouteButton();
                alert('خطأ في الاتصال بالخادم');
            }
        };

        function showDispatchModal(req) {
            var modal = document.getElementById('ride-dispatch-modal');
            if (!modal) return;
            modal.style.display = 'flex';
            bDispatchSeconds = 30;
            var titleEl = document.getElementById('dispatch-modal-title');
            if (titleEl) titleEl.textContent = 'جاري البحث عن أقرب سائق متواجد...';
            updateDispatchUi(req);

            if (bDispatchTimer) clearInterval(bDispatchTimer);
            bDispatchTimer = setInterval(function() {
                bDispatchSeconds--;
                var tEl = document.getElementById('dispatch-timer-seconds');
                if (tEl) tEl.textContent = Math.max(0, bDispatchSeconds);
                if (bDispatchSeconds <= 0) {
                    bDispatchSeconds = 30;
                }
            }, 1000);

            if (bRidePollTimer) clearInterval(bRidePollTimer);
            bRidePollTimer = setInterval(async function() {
                if (!bActiveRideId) return;
                try {
                    var res = await fetch('/api/ride/status/' + bActiveRideId);
                    var data = await res.json();
                    if (data.success && data.request) {
                        updateDispatchUi(data.request);
                        if (data.request.status === 'Accepted') {
                            clearInterval(bRidePollTimer);
                            clearInterval(bDispatchTimer);
                            onRideAccepted(data.request);
                        }
                    }
                } catch(_) {}
            }, 1500);
        }

        function updateDispatchUi(req) {
            var nameEl = document.getElementById('dispatch-drv-name');
            var carEl = document.getElementById('dispatch-drv-car');
            var stEl = document.getElementById('dispatch-drv-status');
            var titleEl = document.getElementById('dispatch-modal-title');
            if (titleEl) titleEl.textContent = 'جاري البحث عن أقرب سائق متواجد...';
            if (nameEl) nameEl.textContent = '🚕 الكابتن: ' + (req.assignedDriverName || 'أقرب سائق متاح');
            if (carEl) carEl.textContent = '🚗 المركبة: ' + (req.assignedDriverVehicle || 'تويوتا');
            if (stEl) {
                if (req.assignedDriverName) {
                    stEl.textContent = '⏳ جاري انتظار القبول (السائق #' + ((req.currentDriverIndex || 0) + 1) + ')';
                    stEl.style.color = '#d97706';
                } else {
                    stEl.textContent = '🔍 جاري البحث عن أقرب سائق متواجد...';
                    stEl.style.color = '#2563eb';
                }
            }
        }

        function onRideAccepted(req) {
            bActiveRideId = req.id;
            localStorage.setItem('active_accepted_ride', JSON.stringify(req));
            document.getElementById('dispatch-modal-icon').textContent = '🎉';
            document.getElementById('dispatch-modal-title').textContent = 'تم قبول رحلتك بنجاح!';
            document.getElementById('dispatch-modal-subtitle').textContent = 'الكابتن ' + (req.assignedDriverName || 'المعين') + ' في طريقه إليك!';
            document.getElementById('dispatch-timer-seconds').textContent = '✅';
            var waNum = (req.assignedDriverPhone || '').replace(/[^0-9]/g, '').replace(/^07/, '9647');
            var act = document.getElementById('dispatch-actions-wrap');
            if (act) {
                act.innerHTML = '<a href="https://wa.me/' + waNum + '" target="_blank" class="btn-primary" style="background:#25d366;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;flex:1;">💬 واتساب</a><a href="tel:' + req.assignedDriverPhone + '" class="btn-primary" style="background:#10b981;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;flex:1;">📞 اتصال</a><button type="button" onclick="cancelRideRequest()" class="btn-secondary" style="flex:1;">إغلاق</button>';
            }
            startPassengerRideMonitor(req.id);
            startLiveDriverTracking(req); // Stage 3: start live driver tracking on map
        }

        function startPassengerRideMonitor(rideId) {
            if (!rideId) return;
            if (bPassengerMonitorTimer) clearInterval(bPassengerMonitorTimer);
            bPassengerMonitorTimer = setInterval(async function() {
                try {
                    var res = await fetch('/api/ride/status/' + rideId);
                    var data = await res.json();
                    if (!data.success || !data.request) return;
                    var r = data.request;
                    if (r.status === 'Arrived') {
                        showPassengerArrivedModal(r);
                    } else if (r.status === 'Completed') {
                        clearInterval(bPassengerMonitorTimer);
                        stopLiveDriverTracking();
                        localStorage.removeItem('active_accepted_ride');
                        resetSaveRouteButton();
                        var arrModal = document.getElementById('passenger-arrived-modal');
                        if (arrModal) arrModal.style.display = 'none';
                        var dispModal = document.getElementById('ride-dispatch-modal');
                        if (dispModal) dispModal.style.display = 'none';
                        alert('🏁 تم إكمال المشوار بنجاح! نتمنى لك يوماً سعيداً.');
                    } else if (r.status === 'Cancelled') {
                        clearInterval(bPassengerMonitorTimer);
                        stopLiveDriverTracking();
                        localStorage.removeItem('active_accepted_ride');
                        resetSaveRouteButton();
                        var arrModal = document.getElementById('passenger-arrived-modal');
                        if (arrModal) arrModal.style.display = 'none';
                        var dispModal = document.getElementById('ride-dispatch-modal');
                        if (dispModal) dispModal.style.display = 'none';
                        alert('⚠️ تم إلغاء المشوار: ' + (r.cancelReason || ''));
                    }
                } catch(_) {}
            }, 2500);
        }

        // Stage 3: Live driver tracking on passenger map
        function startLiveDriverTracking(req) {
            if (!req || !req.assignedDriverId) return;
            var driverId = req.acceptedDriverId || req.assignedDriverId;
            var pickupLon = req.pickupLon || bPickupCoords && bPickupCoords[0];
            var pickupLat = req.pickupLat || bPickupCoords && bPickupCoords[1];

            if (bLiveTrackingTimer) clearInterval(bLiveTrackingTimer);

            async function updateDriverOnMap() {
                try {
                    var res = await fetch('/api/driver/' + driverId + '/live');
                    var d = await res.json();
                    if (!d || !d.latitude || !d.longitude) return;

                    var dLon = parseFloat(d.longitude);
                    var dLat = parseFloat(d.latitude);

                    // Update driver icon position on map
                    if (bMap && bMap.getSource('live-driver-source')) {
                        bMap.getSource('live-driver-source').setData({
                            type: 'FeatureCollection',
                            features: [{
                                type: 'Feature',
                                geometry: { type: 'Point', coordinates: [dLon, dLat] },
                                properties: { name: req.assignedDriverName || 'الكابتن' }
                            }]
                        });
                    }

                    // Draw live straight line from driver to passenger pickup
                    if (bMap && bMap.getSource('live-driver-route-source') && pickupLon && pickupLat) {
                        // Try Directions API for realistic route line
                        try {
                            var dirRes = await fetch('https://api.mapbox.com/directions/v5/mapbox/driving/' +
                                dLon + ',' + dLat + ';' + pickupLon + ',' + pickupLat +
                                '?geometries=geojson&overview=full&access_token=' + BOOKING_MAPBOX_TOKEN);
                            var dirData = await dirRes.json();
                            if (dirData && dirData.routes && dirData.routes[0]) {
                                bMap.getSource('live-driver-route-source').setData({
                                    type: 'Feature',
                                    geometry: dirData.routes[0].geometry
                                });
                            } else {
                                throw new Error('no route');
                            }
                        } catch(_) {
                            // Fallback: straight line
                            bMap.getSource('live-driver-route-source').setData({
                                type: 'Feature',
                                geometry: { type: 'LineString', coordinates: [[dLon, dLat], [pickupLon, pickupLat]] }
                            });
                        }
                    }
                } catch(_) {}
            }

            updateDriverOnMap();
            bLiveTrackingTimer = setInterval(updateDriverOnMap, 3000);
        }

        function stopLiveDriverTracking() {
            if (bLiveTrackingTimer) { clearInterval(bLiveTrackingTimer); bLiveTrackingTimer = null; }
            if (bMap && bMap.getSource('live-driver-source')) {
                bMap.getSource('live-driver-source').setData({ type: 'FeatureCollection', features: [] });
            }
            if (bMap && bMap.getSource('live-driver-route-source')) {
                bMap.getSource('live-driver-route-source').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
            }
        }

        function playArrivalNotificationSound() {
            try {
                var AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return;
                var ctx = new AudioCtx();
                var now = ctx.currentTime;
                var notes = [659.25, 830.61, 987.77];
                notes.forEach(function(freq, idx) {
                    var osc = ctx.createOscillator();
                    var gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(freq, now + idx * 0.18);
                    gain.gain.setValueAtTime(0.35, now + idx * 0.18);
                    gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.18 + 0.35);
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.start(now + idx * 0.18);
                    osc.stop(now + idx * 0.18 + 0.36);
                });
            } catch(_) {}
        }

        window.showPassengerArrivedModal = function(req) {
            var modal = document.getElementById('passenger-arrived-modal');
            if (!modal) return;
            if (modal.style.display === 'flex') return;
            var msg = document.getElementById('passenger-arrived-msg');
            var drvBox = document.getElementById('arrived-drv-name-text');
            if (msg) msg.textContent = 'الكابتن ' + (req.assignedDriverName || 'المعين') + ' وصل الآن إلى نقطة انطلاقك وهو بانتظارك!';
            if (drvBox) drvBox.textContent = '🚕 ' + (req.assignedDriverName || 'الكابتن') + ' (' + (req.assignedDriverVehicle || 'مركبة') + ') بانتظارك';
            modal.style.display = 'flex';
            playArrivalNotificationSound();
            if (navigator.vibrate) {
                try { navigator.vibrate([250, 120, 250, 120, 400]); } catch(_) {}
            }
            if ('Notification' in window && Notification.permission === 'granted') {
                try {
                    new Notification('🚖 وصل الكابتن!', { body: 'الكابتن وصل إلى موقعك وهو بانتظارك الآن' });
                } catch(_) {}
            }
        };

        window.dismissPassengerArrivedModal = function() {
            var modal = document.getElementById('passenger-arrived-modal');
            if (modal) modal.style.display = 'none';
        };

        window.showPassengerActiveBlockedModal = function(req) {
            var modal = document.getElementById('passenger-active-blocked-modal');
            if (!modal) return;
            var infoBox = document.getElementById('active-blocked-info');
            if (infoBox) {
                var drv = req.assignedDriverName || req.driverName || 'الكابتن';
                var pick = req.pickupName || 'موقع الركوب';
                var drop = req.dropoffName || 'الوجهة';
                var fareStr = req.fare ? (req.fare).toLocaleString() + ' د.ع' : '3,000 د.ع';
                infoBox.innerHTML =
                    '<div style="font-weight:900;color:#111;margin-bottom:4px;">🚕 الكابتن: ' + drv + '</div>' +
                    '<div style="color:#16a34a;margin-bottom:2px;">🟢 الانطلاق: ' + pick + '</div>' +
                    '<div style="color:#dc2626;margin-bottom:4px;">🔴 الوجهة: ' + drop + '</div>' +
                    '<div style="font-weight:700;color:#059669;">💰 الأجرة: ' + fareStr + '</div>';
            }
            modal.style.display = 'flex';
        };

        window.cancelExistingAcceptedRide = async function() {
            var existing = null;
            try { existing = JSON.parse(localStorage.getItem('active_accepted_ride') || 'null'); } catch(_) {}
            var rideId = (existing && existing.id) || bActiveRideId;
            if (!rideId) {
                localStorage.removeItem('active_accepted_ride');
                var m = document.getElementById('passenger-active-blocked-modal');
                if (m) m.style.display = 'none';
                return;
            }
            if (!confirm('هل أنت متأكد من إلغاء الرحلة الحالية المقبولة لتتمكن من طلب مشوار جديد؟')) return;
            try {
                var res = await fetch('/api/ride/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: rideId, reason: 'إلغاء من قبل الراكب لطلب مشوار آخر' })
                });
                var data = await res.json();
                localStorage.removeItem('active_accepted_ride');
                if (bRidePollTimer) clearInterval(bRidePollTimer);
                if (bDispatchTimer) clearInterval(bDispatchTimer);
                if (bPassengerMonitorTimer) clearInterval(bPassengerMonitorTimer);
                bActiveRideId = null;
                resetSaveRouteButton();
                var m = document.getElementById('passenger-active-blocked-modal');
                if (m) m.style.display = 'none';
                var dispModal = document.getElementById('ride-dispatch-modal');
                if (dispModal) dispModal.style.display = 'none';
                alert('تم إلغاء الرحلة المقبولة بنجاح. يمكنك الآن طلب مشوار جديد.');
            } catch(e) {
                alert('حدث خطأ أثناء الإلغاء');
            }
        };

        window.viewExistingAcceptedRide = function() {
            var m = document.getElementById('passenger-active-blocked-modal');
            if (m) m.style.display = 'none';
            var existing = null;
            try { existing = JSON.parse(localStorage.getItem('active_accepted_ride') || 'null'); } catch(_) {}
            if (existing) {
                showDispatchModal(existing);
                onRideAccepted(existing);
            }
        };

        window.resetSaveRouteButton = function() {
            var saveBtn = document.getElementById('btn-floating-save-route') || document.getElementById('btn-save-route-db');
            if (saveBtn) {
                saveBtn.disabled = false;
                var fareHtml = '';
                if (bRouteFare) {
                    fareHtml = ' <span id="floating-btn-fare" style="background:#059669;color:#fff;padding:2px 6px;border-radius:6px;font-size:10px;font-weight:800;">' + Number(bRouteFare).toLocaleString() + ' د.ع</span>';
                }
                saveBtn.innerHTML = '<span>📌</span> <span id="floating-save-btn-text">تأكيد وتثبيت المسار</span>' + fareHtml;
            }
            var statusEl = document.getElementById('map-target-status');
            if (statusEl) {
                statusEl.textContent = '📍 تم تثبيت المسار - جاهز للطلب';
                statusEl.style.background = '#e0f2fe';
                statusEl.style.color = '#0369a1';
            }
        };

        window.cancelRideRequest = function() {
            var existing = null;
            try { existing = JSON.parse(localStorage.getItem('active_accepted_ride') || 'null'); } catch(_) {}
            if (existing && existing.id) {
                var modal = document.getElementById('ride-dispatch-modal');
                if (modal) modal.style.display = 'none';
                resetSaveRouteButton();
                return;
            }
            if (bActiveRideId) {
                try {
                    fetch('/api/ride/cancel', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ requestId: bActiveRideId, reason: 'إلغاء من قبل الراكب' })
                    }).catch(function() {});
                } catch(_) {}
            }
            if (bRidePollTimer) clearInterval(bRidePollTimer);
            if (bDispatchTimer) clearInterval(bDispatchTimer);
            bActiveRideId = null;
            var modal = document.getElementById('ride-dispatch-modal');
            if (modal) modal.style.display = 'none';
            resetSaveRouteButton();
        };

        // Render Permanent Line Sidebar (Stage 3)
        function renderDailyTripSidebar() {
            var panel = document.getElementById('sidebar-panel-daily');
            if (!panel) return;
            var days = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
            var chipsHtml = days.map(function(d) {
                var act = bPermDays.includes(d) ? 'day-chip active' : 'day-chip';
                return '<div class="' + act + '" onclick="togglePermDay(&quot;' + d + '&quot;)">' + d + '</div>';
            }).join('');

            panel.innerHTML = '<div style="font-size:14px;font-weight:900;color:#111;margin-bottom:4px;">🔄 تثبيت خط دائمي (اشتراك يومي)</div>' +
                '<div style="position:relative;">' +
                    '<label class="label" style="font-size:11px;">🟢 نقطة الانطلاق الدائمية</label>' +
                    '<input type="text" id="book-pickup-input" class="inp" placeholder="حدد الانطلاق على الخريطة" value="' + (bPickupName || '') + '" style="font-size:12px;padding:9px 12px;">' +
                '</div>' +
                '<div style="position:relative;">' +
                    '<label class="label" style="font-size:11px;">🔴 نقطة الوصول الدائمية (الدوام / الجامعة)</label>' +
                    '<input type="text" id="book-dropoff-input" class="inp" placeholder="حدد الوصول على الخريطة" value="' + (bDropoffName || '') + '" oninput="onBookingDropoffSearch(this.value)" style="font-size:12px;padding:9px 12px;">' +
                    '<div id="book-dropoff-results" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:50;background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;box-shadow:0 4px 15px rgba(0,0,0,0.1);max-height:160px;overflow-y:auto;margin-top:2px;"></div>' +
                '</div>' +
                '<div>' +
                    '<label class="label" style="font-size:11px;">📅 أيام الأسبوع المطلوبة</label>' +
                    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;" id="perm-days-container">' + chipsHtml + '</div>' +
                '</div>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
                    '<div>' +
                        '<label class="label" style="font-size:11px;">⏰ وقت الانطلاق</label>' +
                        '<input type="text" id="perm-dep-time" class="inp" value="07:30 ص" style="font-size:12px;padding:8px 10px;">' +
                    '</div>' +
                    '<div>' +
                        '<label class="label" style="font-size:11px;">🔄 التكرار</label>' +
                        '<select id="perm-frequency" class="inp" style="font-size:12px;padding:8px 10px;">' +
                            '<option value="يومي">يومي (الدوام)</option>' +
                            '<option value="أسبوعي">أسبوعي</option>' +
                        '</select>' +
                    '</div>' +
                '</div>' +
                '<button type="button" onclick="savePermanentRoute()" class="btn-primary" style="background:#059669;font-size:13px;padding:12px;display:flex;align-items:center;justify-content:center;gap:8px;">' +
                    '<span>📌</span> <span>تثبيت المسار وحفظ الخط</span>' +
                '</button>' +
                '<div style="margin-top:6px;">' +
                    '<div style="font-size:12px;font-weight:800;color:#374151;margin-bottom:6px;">خطوطي الدائمة المثبتة:</div>' +
                    '<div id="side-perm-routes-list" style="display:flex;flex-direction:column;gap:8px;max-height:200px;overflow-y:auto;"></div>' +
                '</div>';
        }

        window.togglePermDay = function(day) {
            if (bPermDays.includes(day)) {
                bPermDays = bPermDays.filter(function(d){ return d !== day; });
            } else {
                bPermDays.push(day);
            }
            renderDailyTripSidebar();
        };

        window.savePermanentRoute = async function() {
            if (!bPickupCoords || !bDropoffCoords) {
                alert('يرجى تحديد نقطة الانطلاق ونقطة الوصول على الخريطة أولاً');
                return;
            }
            var uid = localStorage.getItem('user_id') || 'cust-user';
            var uName = localStorage.getItem('user_fullname') || 'راكب توصيله';
            var uPhone = localStorage.getItem('user_phone') || '';
            var depTime = (document.getElementById('perm-dep-time') || {}).value || '07:30 ص';
            var freq = (document.getElementById('perm-frequency') || {}).value || 'يومي';

            try {
                var res = await fetch('/api/routes/permanent', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        customerId: uid,
                        customerName: uName,
                        customerPhone: uPhone,
                        startName: bPickupName || 'الانطلاق',
                        endName: bDropoffName || 'الوصول',
                        startLat: bPickupCoords[1],
                        startLon: bPickupCoords[0],
                        endLat: bDropoffCoords[1],
                        endLon: bDropoffCoords[0],
                        geometry: bRouteGeom,
                        days: bPermDays,
                        departureTime: depTime,
                        frequency: freq,
                        fare: bRouteFare || 3000
                    })
                });
                var data = await res.json();
                if (data.success) {
                    alert('🎉 تم تثبيت مسار الخط الدائم بنجاح!\\nسيظهر في لوحة تحكمك وعند الكباتن القريبين من مسارك.');
                    loadPassengerPermanentRoutes();
                } else {
                    alert(data.error || 'تعذر حفظ المسار');
                }
            } catch(e) { alert('خطأ في الاتصال بالخادم'); }
        };

        async function loadPassengerPermanentRoutes() {
            var uid = localStorage.getItem('user_id') || '';
            try {
                var res = await fetch('/api/routes/permanent' + (uid ? '?customerId=' + uid : ''));
                var data = await res.json();
                var routes = data.routes || [];
                var list = document.getElementById('side-perm-routes-list');
                if (!list) return;
                if (routes.length === 0) {
                    list.innerHTML = '<div style="font-size:11px;color:#94a3b8;text-align:center;padding:10px;background:#f8fafc;border-radius:10px;">لا توجد خطوط دائمة مثبتة حالياً</div>';
                    return;
                }
                list.innerHTML = '';
                routes.forEach(function(r) {
                    var card = document.createElement('div');
                    card.style.cssText = 'background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:10px;font-size:11px;';
                    var statusBadge = r.status === 'Active' ? '<span style="background:#ecfdf5;color:#059669;padding:2px 6px;border-radius:10px;font-weight:800;font-size:10px;">نشط 🟢</span>' : '<span style="background:#fef3c7;color:#d97706;padding:2px 6px;border-radius:10px;font-weight:800;font-size:10px;">معلق 🟡</span>';
                    var daysList = (r.days || []).join('، ');
                    var toggleLabel = r.status === 'Active' ? 'إيقاف مؤقت' : 'تفعيل';
                    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
                            '<span style="font-weight:900;color:#111;">' + (r.startName || '') + ' ➔ ' + (r.endName || '') + '</span>' +
                            statusBadge +
                        '</div>' +
                        '<div style="color:#64748b;margin-bottom:6px;">⏰ ' + (r.departureTime || '') + ' · 📅 ' + daysList + '</div>' +
                        '<div style="display:flex;gap:6px;">' +
                            '<button type="button" onclick="previewPermOnMap(&quot;' + r.id + '&quot;)" class="btn-small" style="padding:4px 8px;font-size:10px;flex:1;">معاينة 🗺️</button>' +
                            '<button type="button" onclick="togglePermStatus(&quot;' + r.id + '&quot;,&quot;' + r.status + '&quot;)" class="btn-small" style="padding:4px 8px;font-size:10px;flex:1;">' + toggleLabel + '</button>' +
                            '<button type="button" onclick="deletePermRoute(&quot;' + r.id + '&quot;)" class="btn-small" style="padding:4px 8px;font-size:10px;color:#dc2626;">حذف 🗑️</button>' +
                        '</div>';
                    list.appendChild(card);
                });
            } catch(_) {}
        }

        window.previewPermOnMap = function(routeId) {
            fetch('/api/routes/permanent').then(r => r.json()).then(data => {
                var r = (data.routes || []).find(x => x.id === routeId);
                if (!r || !bMap) return;
                setBookingPickup(r.startLon, r.startLat, r.startName);
                setBookingDropoff(r.endLon, r.endLat, r.endName);
            });
        };

        window.togglePermStatus = async function(id, cur) {
            var next = cur === 'Active' ? 'Paused' : 'Active';
            await fetch('/api/routes/permanent/' + id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ status: next }) });
            loadPassengerPermanentRoutes();
        };

        window.deletePermRoute = async function(id) {
            if (!confirm('هل أنت متأكد من حذف هذا الخط؟')) return;
            await fetch('/api/routes/permanent/' + id, { method:'DELETE' });
            loadPassengerPermanentRoutes();
        };

        // Render Driver Sidebar (Stage 4)
        function renderDriverSidebar() {
            var panel = document.getElementById('sidebar-panel-driver');
            if (!panel) return;
            var did = localStorage.getItem('user_id') || 'drv-test';
            var statusColor = bDriverOnline ? '#16a34a' : '#dc2626';
            var statusText = bDriverOnline ? 'متصل ومتاح للطلبات 🟢' : 'غير متصل (مغلق) 🔴';
            var btnBg = bDriverOnline ? '#dc2626' : '#16a34a';
            var btnText = bDriverOnline ? 'قطع الاتصال' : 'اتصال الآن';

            var activeCardHtml = '';
            var curRide = null;
            try { curRide = bDriverActiveRide || JSON.parse(localStorage.getItem('driver_active_ride') || 'null'); } catch(_) {}
            if (curRide && curRide.status !== 'Completed' && curRide.status !== 'Cancelled') {
                activeCardHtml = '<div style="background:#ecfdf5;border:1.5px solid #10b981;border-radius:12px;padding:12px;margin-bottom:10px;">' +
                    '<div style="font-weight:900;color:#065f46;font-size:13px;margin-bottom:3px;">🚗 المشوار الجاري المقبول</div>' +
                    '<div style="font-size:11px;color:#047857;margin-bottom:8px;">👤 ' + (curRide.customerName || 'الراكب') + ' · ' + (curRide.fare || 3000).toLocaleString() + ' د.ع</div>' +
                    '<button type="button" onclick="showDriverActiveRideModal(bDriverActiveRide || curRide)" class="btn-primary" style="background:#059669;padding:8px;font-size:11px;font-weight:900;">فتح تفاصيل الرحلة و Waze 🧭</button>' +
                '</div>';
            }

            panel.innerHTML = '<div style="font-size:14px;font-weight:900;color:#111;margin-bottom:4px;">🚖 لوحة الكابتن والطلبات الحية</div>' +
                activeCardHtml +
                '<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:12px;display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
                    '<div>' +
                        '<div style="font-weight:900;font-size:13px;color:#111;">حالة الاتصال والخدمة</div>' +
                        '<div id="driver-status-text" style="font-size:11px;color:' + statusColor + ';font-weight:700;">' + statusText + '</div>' +
                    '</div>' +
                    '<button type="button" onclick="toggleDriverOnlineState()" id="btn-driver-toggle" class="btn-primary" style="width:auto;padding:8px 14px;font-size:12px;background:' + btnBg + ';">' + btnText + '</button>' +
                '</div>' +
                '<div>' +
                    '<label class="label" style="font-size:11px;">🛣️ مسار عملك المعتاد (الانطلاق والوصول)</label>' +
                    '<div style="display:flex;flex-direction:column;gap:6px;">' +
                        '<input type="text" id="drv-route-from" class="inp" placeholder="الانطلاق: حي الأمير، الكوفة..." style="font-size:12px;padding:8px 10px;">' +
                        '<input type="text" id="drv-route-to" class="inp" placeholder="الوصول: جامعة الكوفة، مركز النجف..." style="font-size:12px;padding:8px 10px;">' +
                        '<button type="button" onclick="saveDriverActiveRoute()" class="btn-secondary" style="font-size:11px;padding:8px;">حفظ مساري المعتاد 💾</button>' +
                    '</div>' +
                '</div>' +
                '<div style="margin-top:6px;">' +
                    '<div style="font-size:12px;font-weight:800;color:#374151;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">' +
                        '<span>الخطوط الدائمة المتقاطعة مع مسارك:</span>' +
                        '<button type="button" onclick="loadDriverMatchingRoutes()" style="background:none;border:none;font-size:11px;color:#2563eb;cursor:pointer;">تحديث 🔄</button>' +
                    '</div>' +
                    '<div id="driver-matching-routes-list" style="display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;"></div>' +
                '</div>';
            loadDriverMatchingRoutes();
        }

        window.toggleDriverOnlineState = async function() {
            var did = localStorage.getItem('user_id') || 'drv-test';
            bDriverOnline = !bDriverOnline;
            try {
                await fetch('/api/driver/toggle-online', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ driverId: did, isOnline: bDriverOnline })
                });
            } catch(_) {}

            renderDriverSidebar();

            if (bDriverOnline) {
                // Live location stream
                if (navigator.geolocation) {
                    bDriverWatchId = navigator.geolocation.watchPosition(function(pos) {
                        fetch('/api/driver/location', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                driverId: did,
                                latitude: pos.coords.latitude,
                                longitude: pos.coords.longitude,
                                heading: pos.coords.heading || 0,
                                speedKmh: Math.round((pos.coords.speed || 0) * 3.6)
                            })
                        }).catch(function(){});
                    }, function(){}, { enableHighAccuracy: true });
                }
                // Poll for incoming ride requests every 3s (Stage 4)
                if (bDriverIncomingTimer) clearInterval(bDriverIncomingTimer);
                bDriverIncomingTimer = setInterval(checkDriverIncomingPendingRequests, 3000);
            } else {
                if (bDriverWatchId && navigator.geolocation) {
                    navigator.geolocation.clearWatch(bDriverWatchId);
                }
                if (bDriverIncomingTimer) clearInterval(bDriverIncomingTimer);
            }
        };

        window.saveDriverActiveRoute = async function() {
            var did = localStorage.getItem('user_id') || 'drv-test';
            var from = (document.getElementById('drv-route-from') || {}).value;
            var to = (document.getElementById('drv-route-to') || {}).value;
            if (!from || !to) { alert('أدخل نقطة الانطلاق والوصول'); return; }
            try {
                var res = await fetch('/api/driver/set-route', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        driverId: did,
                        fromText: from,
                        toText: to,
                        fromLat: bPickupCoords ? bPickupCoords[1] : 31.9961,
                        fromLon: bPickupCoords ? bPickupCoords[0] : 44.3168,
                        toLat: bDropoffCoords ? bDropoffCoords[1] : 32.0321,
                        toLon: bDropoffCoords ? bDropoffCoords[0] : 44.3725
                    })
                });
                var data = await res.json();
                if (data.success) {
                    alert('✅ تم حفظ مسارك المعتاد بنجاح!');
                    loadDriverMatchingRoutes();
                } else alert(data.error || 'خطأ في الحفظ');
            } catch(e) { alert('خطأ في الاتصال'); }
        };

        async function loadDriverMatchingRoutes() {
            var did = localStorage.getItem('user_id') || 'drv-test';
            var list = document.getElementById('driver-matching-routes-list');
            if (!list) return;
            list.innerHTML = '<div style="font-size:11px;color:#94a3b8;text-align:center;padding:8px;">جاري حساب المطابقة الجغرافية...</div>';
            try {
                var res = await fetch('/api/driver/' + did + '/matching-permanent');
                var data = await res.json();
                var matches = data.matches || [];
                if (matches.length === 0) {
                    list.innerHTML = '<div style="font-size:11px;color:#94a3b8;text-align:center;padding:10px;background:#f8fafc;border-radius:10px;">لا توجد خطوط دائمة حالياً للمطابقة</div>';
                    return;
                }
                list.innerHTML = '';
                matches.slice(0, 10).forEach(function(m) {
                    var card = document.createElement('div');
                    card.style.cssText = 'background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:10px;font-size:11px;';
                    var waNum = (m.customerPhone || '').replace(/[^0-9]/g, '').replace(/^07/, '9647');
                    var daysList = (m.days || []).join('، ');
                    var waBtn = waNum ? '<a href="https://wa.me/' + waNum + '" target="_blank" class="btn-small" style="background:#25d366;color:#fff;text-decoration:none;text-align:center;padding:4px 8px;font-size:10px;flex:1;">واتساب 💬</a>' : '';
                    var telBtn = m.customerPhone ? '<a href="tel:' + m.customerPhone + '" class="btn-small" style="background:#10b981;color:#fff;text-decoration:none;text-align:center;padding:4px 8px;font-size:10px;flex:1;">اتصال 📞</a>' : '';
                    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
                            '<span style="font-weight:900;color:#111;">👤 ' + (m.customerName || '') + '</span>' +
                            '<span class="match-badge">🔥 تطابق ' + (m.matchPercentage || 0) + '%</span>' +
                        '</div>' +
                        '<div style="font-size:11px;color:#475569;margin-bottom:3px;">' + (m.startName || '') + ' ➔ ' + (m.endName || '') + '</div>' +
                        '<div style="font-size:10px;color:#94a3b8;margin-bottom:6px;">⏰ ' + (m.departureTime || '') + ' · 📅 ' + daysList + '</div>' +
                        '<div style="display:flex;gap:6px;">' +
                            waBtn +
                            telBtn +
                        '</div>';
                    list.appendChild(card);
                });
            } catch(_) {
                list.innerHTML = '<div style="font-size:11px;color:#ef4444;text-align:center;">تعذر تحميل المطابقات</div>';
            }
        }

        // Driver Incoming Ride Alerts (Stage 4)
        var bCurrentIncomingReq = null;
        async function checkDriverIncomingPendingRequests() {
            var did = localStorage.getItem('user_id') || 'drv-test';
            try {
                var res = await fetch('/api/driver/' + did + '/pending-requests');
                var data = await res.json();
                if (data.success && data.requests && data.requests.length > 0) {
                    var req = data.requests[0];
                    if (!bCurrentIncomingReq || bCurrentIncomingReq.id !== req.id) {
                        bCurrentIncomingReq = req;
                        showIncomingDriverModal(req);
                    }
                }
            } catch(_) {}
        }

        function showIncomingDriverModal(req) {
            var modal = document.getElementById('driver-incoming-modal');
            if (!modal) return;
            modal.style.display = 'flex';
            var pName = document.getElementById('incoming-passenger-name');
            var pPick = document.getElementById('incoming-pickup-addr');
            var pDrop = document.getElementById('incoming-dropoff-addr');
            var pFare = document.getElementById('incoming-fare-info');

            if (pName) pName.textContent = '👤 الراكب: ' + req.customerName;
            if (pPick) pPick.textContent = '🟢 الانطلاق: ' + req.pickupName;
            if (pDrop) pDrop.textContent = '🔴 الوصول: ' + req.dropoffName;
            if (pFare) pFare.textContent = '💰 الأجرة: ' + (req.fare || 3000).toLocaleString() + ' د.ع (' + (req.distanceKm || 3) + ' كم)';

            var sec = 30;
            var timerEl = document.getElementById('driver-incoming-timer');
            if (bDriverReqTimer) clearInterval(bDriverReqTimer);
            bDriverReqTimer = setInterval(function() {
                sec--;
                if (timerEl) timerEl.textContent = '⏳ ' + Math.max(0, sec) + ' ثانية';
                if (sec <= 0) {
                    clearInterval(bDriverReqTimer);
                    modal.style.display = 'none';
                    bCurrentIncomingReq = null;
                }
            }, 1000);
        }

        window.respondToIncomingRide = async function(action) {
            if (!bCurrentIncomingReq) return;
            var incoming = bCurrentIncomingReq;
            var did = localStorage.getItem('user_id') || 'drv-test';
            var modal = document.getElementById('driver-incoming-modal');
            if (modal) modal.style.display = 'none';
            if (bDriverReqTimer) clearInterval(bDriverReqTimer);

            try {
                var res = await fetch('/api/ride/respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        requestId: incoming.id,
                        driverId: did,
                        action: action
                    })
                });
                var data = await res.json();
                if (action === 'accept') {
                    incoming.status = 'Accepted';
                    bDriverActiveRide = incoming;
                    localStorage.setItem('driver_active_ride', JSON.stringify(incoming));
                    showDriverActiveRideModal(incoming);
                }
            } catch(_) {}
            bCurrentIncomingReq = null;
        };

        window.showDriverActiveRideModal = function(req) {
            if (!req) return;
            bDriverActiveRide = req;
            localStorage.setItem('driver_active_ride', JSON.stringify(req));
            var modal = document.getElementById('driver-active-ride-modal');
            if (!modal) return;
            var pName = document.getElementById('driver-active-passenger-name');
            var pFare = document.getElementById('driver-active-fare');
            var pPick = document.getElementById('driver-active-pickup');
            var pDrop = document.getElementById('driver-active-dropoff');
            var pWa = document.getElementById('driver-active-wa-link');
            var pTel = document.getElementById('driver-active-tel-link');
            var stEl = document.getElementById('driver-active-ride-status');
            var btnArrived = document.getElementById('btn-driver-arrived');

            if (pName) pName.textContent = '👤 الراكب: ' + (req.customerName || 'راكب توصيله');
            if (pFare) pFare.textContent = '💰 ' + (req.fare || 3000).toLocaleString() + ' د.ع';
            if (pPick) pPick.textContent = '🟢 الانطلاق: ' + (req.pickupName || 'موقع الركوب');
            if (pDrop) pDrop.textContent = '🔴 الوجهة: ' + (req.dropoffName || 'وجهة الوصول');

            if (stEl) {
                stEl.textContent = req.status === 'Arrived' ? '📍 أنت في موقع الراكب الآن' : 'أنت الآن في طريقك إلى موقع الراكب';
                stEl.style.color = req.status === 'Arrived' ? '#15803d' : '#6b7280';
            }
            if (btnArrived) {
                if (req.status === 'Arrived') {
                    btnArrived.disabled = true;
                    btnArrived.style.opacity = '0.6';
                    btnArrived.textContent = '✅ تم تأكيد وصولك للراكب';
                } else {
                    btnArrived.disabled = false;
                    btnArrived.style.opacity = '1';
                    btnArrived.textContent = '📍 أنا وصلت عند موقع الراكب';
                }
            }

            var phone = req.customerPhone || '';
            var waNum = phone.replace(/[^0-9]/g, '').replace(/^07/, '9647');
            if (pWa) pWa.href = waNum ? 'https://wa.me/' + waNum : '#';
            if (pTel) pTel.href = phone ? 'tel:' + phone : '#';

            modal.style.display = 'flex';
        };

        window.closeDriverActiveRideModal = function() {
            var modal = document.getElementById('driver-active-ride-modal');
            if (!modal) return;
            modal.style.display = 'none';
        };

        window.openDriverWaze = function(target) {
            if (!bDriverActiveRide) return;
            var lat, lon;
            if (target === 'dropoff') {
                lat = bDriverActiveRide.dropoffLat;
                lon = bDriverActiveRide.dropoffLon;
            } else {
                lat = bDriverActiveRide.pickupLat;
                lon = bDriverActiveRide.pickupLon;
            }
            if (!lat || !lon) {
                alert('إحداثيات الموقع غير متوفرة للتنقل عبر Waze');
                return;
            }
            var wazeUrl = 'https://waze.com/ul?ll=' + lat + ',' + lon + '&navigate=yes';
            window.open(wazeUrl, '_blank');
        };

        window.driverMarkArrived = async function() {
            if (!bDriverActiveRide) return;
            var did = localStorage.getItem('user_id') || 'drv-test';
            try {
                var res = await fetch('/api/ride/arrived', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: bDriverActiveRide.id, driverId: did })
                });
                var data = await res.json();
                if (data.success) {
                    bDriverActiveRide.status = 'Arrived';
                    localStorage.setItem('driver_active_ride', JSON.stringify(bDriverActiveRide));
                    var stEl = document.getElementById('driver-active-ride-status');
                    if (stEl) {
                        stEl.textContent = '📍 تم إشعار الراكب بوصولك إلى الموقع!';
                        stEl.style.color = '#15803d';
                        stEl.style.fontWeight = '900';
                    }
                    var btnArrived = document.getElementById('btn-driver-arrived');
                    if (btnArrived) {
                        btnArrived.disabled = true;
                        btnArrived.style.opacity = '0.6';
                        btnArrived.textContent = '✅ تم تأكيد وصولك للراكب';
                    }
                    alert('تم إشعار الراكب بوصولك بنجاح! 📍');
                } else {
                    alert(data.error || 'تعذر تأكيد الوصول');
                }
            } catch(e) {
                alert('خطأ في الاتصال بالخادم');
            }
        };

        window.driverCompleteRide = async function() {
            if (!bDriverActiveRide) return;
            if (!confirm('هل وصلت للوجهة وتريد إنهاء المشوار بنجاح؟')) return;
            var did = localStorage.getItem('user_id') || 'drv-test';
            try {
                var res = await fetch('/api/ride/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: bDriverActiveRide.id, driverId: did })
                });
                var data = await res.json();
                if (data.success) {
                    alert('🎉 تم إنهاء المشوار بنجاح! شكراً لك.');
                    closeDriverActiveRideModal();
                    bDriverActiveRide = null;
                    localStorage.removeItem('driver_active_ride');
                } else {
                    alert(data.error || 'تعذر إكمال المشوار');
                }
            } catch(e) {
                alert('خطأ في الاتصال بالخادم');
            }
        };

        (function() {
            applyDynamicAppConfig();
            initOnboarding();
            loadAppCustomButtons();
            loadAppAds();
            checkUserSession();
            var urlParams = new URLSearchParams(window.location.search);
            var role = urlParams.get('role');
            if (role === 'Customer' || role === 'customer') window.switchRole('Customer');
            else if (role === 'Driver' || role === 'driver') window.switchRole('Driver');
            var phoneParam = urlParams.get('phone');
            if (phoneParam) {
                var isDrv = (role === 'Driver' || role === 'driver');
                var pReg = document.getElementById(isDrv ? 'driver-reg-phone' : 'cust-reg-phone');
                if (pReg) pReg.value = phoneParam;
                var pLog = document.getElementById(isDrv ? 'driver-phone' : 'cust-phone');
                if (pLog) pLog.value = phoneParam;
            }
            if (urlParams.get('openMap') === '1' || urlParams.get('showMap') === '1') {
                window.openBookingApp(urlParams.get('tripType') || 'short');
            }
            try {
                var savedRide = JSON.parse(localStorage.getItem('active_accepted_ride') || 'null');
                if (savedRide && savedRide.id) {
                    startPassengerRideMonitor(savedRide.id);
                    startLiveDriverTracking(savedRide);
                }
            } catch(_) {}
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
        const { fullName, email, password, googleId, phoneNumber, route, address, area, paymentMethod, pickupLat, pickupLon, dropoffLat, dropoffLon, governorate, tripType } = body;
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
        if (body.otpCode && body.otpCode !== 'TRUECALLER_VERIFIED') {
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
        const userAddress = (address || area || '').trim();
        if (!pickupLat || !dropoffLat || !userAddress || !userRoute) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ success: false, error: 'يجب تحديد نقطة الانطلاق ونقطة الوصول الفعلية على الخريطة' }));
        }

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
            governorate: governorate || 'najaf',
            tripType: tripType || 'short',
            pickupLat: parseFloat(pickupLat),
            pickupLon: parseFloat(pickupLon),
            dropoffLat: parseFloat(dropoffLat),
            dropoffLon: parseFloat(dropoffLon),
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
        const { fullName, email, password, googleId, phoneNumber, vehicleMake, vehiclePlate, vehicleYear, licenseNumber, documents, route, governorate, serviceType } = body;
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
        if (body.otpCode && body.otpCode !== 'TRUECALLER_VERIFIED') {
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
            activeRoute: (body.fromRoute && body.toRoute) ? { fromText: body.fromRoute.trim(), toText: body.toRoute.trim(), setAt: now } : null,
            documents: docUrls,
            governorate: governorate || 'najaf',
            serviceType: serviceType || 'Both',
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

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            success: true,
            userId: driverId,
            role: 'Driver',
            fullName,
            status: 'Pending',
            message: 'تم استلام طلب التسجيل بنجاح. حسابك معلّق بانتظار التوثيق من قبل إدارة المنصة.'
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
