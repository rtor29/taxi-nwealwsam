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
        /* Mobile Phones (< 768px): Drawer on Top, Map below */
        @media (max-width: 767px) {
            #booking-main-body { flex-direction: column !important; }
            #booking-sidebar {
                width: 100% !important;
                max-height: 48vh !important;
                border-left: none !important;
                border-bottom: 2px solid #e2e8f0 !important;
                box-shadow: 0 4px 15px rgba(0,0,0,0.08) !important;
                flex-shrink: 0 !important;
                padding: 12px 14px !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch !important;
            }
            #booking-map-wrapper {
                width: 100% !important;
                flex: 1 !important;
                min-height: 240px !important;
                height: 52vh !important;
            }
        }
        /* iPads & Tablets (768px to 1024px): Drawer on Right, Map next to it */
        @media (min-width: 768px) and (max-width: 1024px) {
            #booking-main-body { flex-direction: row !important; }
            #booking-sidebar {
                width: 360px !important;
                max-width: 42% !important;
                height: 100% !important;
                border-left: 1.5px solid #e2e8f0 !important;
                box-shadow: -4px 0 15px rgba(0,0,0,0.06) !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch !important;
            }
            #booking-map-wrapper { flex: 1 !important; height: 100% !important; }
        }
        /* Desktops (> 1024px): Drawer on Right, Map on Left */
        @media (min-width: 1025px) {
            #booking-main-body { flex-direction: row !important; }
            #booking-sidebar {
                width: 400px !important;
                height: 100% !important;
                border-left: 1.5px solid #e2e8f0 !important;
                box-shadow: -4px 0 15px rgba(0,0,0,0.06) !important;
                overflow-y: auto !important;
            }
            #booking-map-wrapper { flex: 1 !important; height: 100% !important; }
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
                <span style="font-size:26px;">🚕</span>
                <div>
                    <div style="font-size:15px;font-weight:900;line-height:1.2;">توصيلة النجف</div>
                    <div style="font-size:11px;color:#9ca3af;">مشاوير قصيرة وخطوط دائمة</div>
                </div>
            </div>

            <!-- Tabs: Short Trip / Permanent Line / Driver Console -->
            <div style="display:flex;background:#1f2937;padding:3px;border-radius:10px;gap:4px;">
                <button id="book-tab-short" type="button" onclick="switchBookingTab('short')" style="background:#f59e0b;color:#111;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:900;cursor:pointer;font-family:inherit;">
                    ⚡ مشوار قصير
                </button>
                <button id="book-tab-daily" type="button" onclick="switchBookingTab('daily')" style="background:transparent;color:#d1d5db;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">
                    🔄 خط دائمي
                </button>
                <button id="book-tab-driver" type="button" onclick="switchBookingTab('driver')" style="background:transparent;color:#d1d5db;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">
                    🚖 واجهة الكابتن
                </button>
            </div>

            <button type="button" onclick="closeBookingApp()" style="background:#374151;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">
                ✕ إغلاق
            </button>
        </header>

        <!-- Main Body -->
        <div id="booking-main-body" style="display:flex;flex:1;overflow:hidden;position:relative;">
            <!-- SIDEBAR PANEL (DRAWER: ON RIGHT IN RTL, ON TOP IN PHONES/COLUMN) -->
            <div id="booking-sidebar" style="width:390px;max-width:100%;background:#ffffff;border-left:1.5px solid #e2e8f0;overflow-y:auto;display:flex;flex-direction:column;padding:16px;gap:14px;box-shadow:-2px 0 10px rgba(0,0,0,0.05);flex-shrink:0;z-index:15;">
                <!-- Panel content will be dynamically rendered or toggled -->
                <div id="sidebar-panel-short" style="display:flex;flex-direction:column;gap:12px;"></div>
                <div id="sidebar-panel-daily" style="display:none;flex-direction:column;gap:12px;"></div>
                <div id="sidebar-panel-driver" style="display:none;flex-direction:column;gap:12px;"></div>
            </div>

            <!-- MAP VIEWPORT -->
            <div id="booking-map-wrapper" style="flex:1;height:100%;min-height:260px;position:relative;">
                <div id="booking-mapbox-map" style="width:100%;height:100%;min-height:260px;background:#e2e8f0;"></div>

                <!-- Floating Range Selector (Stage 1) -->
                <div style="position:absolute;top:12px;right:12px;z-index:10;display:flex;gap:6px;background:rgba(255,255,255,0.92);backdrop-filter:blur(6px);padding:6px 10px;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,0.12);align-items:center;">
                    <span style="font-size:11px;font-weight:800;color:#374151;">النطاق:</span>
                    <button type="button" class="range-chip" onclick="setBookingSearchRange(3)" id="rng-chip-3">3 كم</button>
                    <button type="button" class="range-chip active" onclick="setBookingSearchRange(5)" id="rng-chip-5">5 كم</button>
                    <button type="button" class="range-chip" onclick="setBookingSearchRange(10)" id="rng-chip-10">10 كم</button>
                    <button type="button" class="range-chip" onclick="setBookingSearchRange(15)" id="rng-chip-15">15 كم</button>
                </div>

                <!-- Floating GPS Button -->
                <button type="button" onclick="centerOnUserGps()" style="position:absolute;bottom:24px;left:16px;z-index:10;background:#fff;border:1.5px solid #d1d5db;border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 15px rgba(0,0,0,0.15);cursor:pointer;font-size:18px;color:#1d4ed8;" title="تحديد موقعي">
                    <i class="fa-solid fa-crosshairs"></i>
                </button>

                <!-- Floating Route Summary Pill (Stage 2) -->
                <div id="booking-route-pill" style="display:none;position:absolute;bottom:16px;right:16px;left:70px;max-width:380px;z-index:10;margin:0 auto;background:#111827;color:#fff;padding:10px 14px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,0.25);font-size:12px;font-weight:800;align-items:center;justify-content:space-between;">
                    <span id="route-pill-dist">📏 -- كم</span>
                    <span id="route-pill-dur">⏱️ -- دقيقة</span>
                    <span id="route-pill-fare" style="color:#f59e0b;">💰 -- د.ع</span>
                </div>
            </div>
        </div>
    </div>

    <!-- 30-Second Auto-Escalation Dispatch Modal (Stage 1) -->
    <div id="ride-dispatch-modal" style="display:none;position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,0.65);align-items:center;justify-content:center;padding:16px;font-family:'Cairo',sans-serif;" dir="rtl">
        <div class="card" style="max-width:400px;width:100%;padding:24px 20px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.3);">
            <div style="font-size:36px;margin-bottom:8px;" id="dispatch-modal-icon">⏳</div>
            <h3 id="dispatch-modal-title" style="font-size:17px;font-weight:900;margin:0 0 6px;color:#111;">جاري انتظار رد الكابتن...</h3>
            <p id="dispatch-modal-subtitle" style="font-size:12px;color:#6b7280;margin:0 0 16px;">إذا لم يرد السائق خلال 30 ثانية سيتم تحويل الطلب تلقائياً للأقرب التالي</p>

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
            <button type="button" onclick="openUserAppNow()" class="btn-primary" style="margin-top:12px;padding:11px 14px;font-size:13px">
                <i class="fa-solid fa-play" aria-hidden="true"></i> متابعة وفتح تطبيق الرحلات
            </button>
            <div id="driver-route-btn-wrap" style="display:none;margin-top:8px">
                <button type="button" onclick="openBookingApp('driver')" class="btn-primary" style="margin-bottom:8px;padding:12px 14px;font-size:13px;background:linear-gradient(135deg,#111827,#1f2937);display:flex;align-items:center;justify-content:center;gap:8px">
                    <span>🗺️</span> <span>خريطة حجز التكسي والخطوط المباشرة (Mapbox)</span>
                </button>
                <button type="button" onclick="showDriverSetRouteFromBox()" class="btn-primary" style="padding:10px 14px;font-size:12px;background:#3b82f6">
                    🛣️ تثبيت مسارك وإدارة طلبات الانضمام
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
            var token = localStorage.getItem('auth_token');
            var userId = localStorage.getItem('user_id') || 'usr-current';
            var role = localStorage.getItem('user_role') || 'Customer';
            var fullName = localStorage.getItem('user_fullname') || (role === 'Driver' ? 'كابتن توصيله' : 'راكب توصيله');
            var status = localStorage.getItem('driver_status') || '';
            if (role === 'Driver' && (status === 'Pending' || status === 'Rejected')) {
                alert('⚠️ حسابك معلّق بانتظار التوثيق من قبل إدارة المنصة.\\nيرجى إرسال المستمسكات عبر الواتساب أو التيليجرام للاعتماد.');
                return;
            }
            if (token) {
                showTripTypeModal(token, userId, role, fullName);
            }
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
                    body:JSON.stringify({fullName,phoneNumber:phone,route,address,password,otpCode:window.__verifiedOtpCode||'',pickupLat:parseFloat(pickupLat),pickupLon:parseFloat(pickupLon),dropoffLat:parseFloat(dropoffLat),dropoffLon:parseFloat(dropoffLon),tripType:selectedRegTripType||'short'})
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
                    body:JSON.stringify({fullName:name,phoneNumber:phone,licenseNumber:license,vehicleMake:vehicle,vehiclePlate:plate,password,fromRoute,toRoute,route:(fromRoute+' ➔ '+toRoute),otpCode:window.__verifiedDriverOtpCode||''})
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
                passengerMap=new mapboxgl.Map({container:'passenger-map',style:'mapbox://styles/mapbox/streets-v12',center:[44.32,32.02],zoom:13,maxBounds:[[44.05,31.75],[44.65,32.35]]});
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
                    var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/'+encodeURIComponent(q)+'.json?proximity=44.32,32.02&bbox=44.05,31.75,44.65,32.35&country=iq&language=ar&types=poi,address,neighborhood,place,locality&limit=5&access_token='+token;
                    var res = await fetch(url);
                    var data = await res.json();
                    var feats = (data && data.features) ? data.features : [];
                    if (feats.length === 0) {
                        try {
                            var or = await fetch('https://nominatim.openstreetmap.org/search?format=json&countrycodes=iq&q='+encodeURIComponent(q+' النجف'));
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

        
        // Auto-show Flutter app if redirected from Telegram or with showMap=1
        (function() {
            var params = new URLSearchParams(window.location.search);
            if (params.get('showMap') === '1' || params.get('openMap') === '1') {
                var token = params.get('login_token') || localStorage.getItem('auth_token') || '';
                var userId = params.get('userId') || localStorage.getItem('user_id') || '';
                var role = params.get('role') || localStorage.getItem('user_role') || 'Customer';
                var fullName = params.get('fullName') || localStorage.getItem('user_fullname') || '';
                
                if (token) {
                    // Save to local storage in case we need it
                    localStorage.setItem('auth_token', token);
                    localStorage.setItem('user_id', userId);
                    localStorage.setItem('user_role', role);
                    if (fullName) localStorage.setItem('user_fullname', fullName);
                    
                    setTimeout(function() {
                        window.openAppView(token, userId, role, fullName, true);
                    }, 100);
                } else {
                    setTimeout(function() {
                        alert('يرجى تسجيل الدخول أولاً لتثبيت المسار الدائمي.');
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
                        if (nameEl) nameEl.textContent = fullName;
                        if (roleEl) roleEl.textContent = role === 'Driver' ? 'كابتن معتمد' : 'راكب';
                        // Feature 5: Show driver route button
                        if (role === 'Driver') {
                            var drBtnWrap = document.getElementById('driver-route-btn-wrap');
                            if (drBtnWrap) drBtnWrap.style.display = 'block';
                        }
                    }
                }
            } catch (_) {}
        }

        window.showDriverSetRouteFromBox = function() {
            var driverId = localStorage.getItem('user_id') || '';
            showDriverSetRoute(driverId);
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
        var bPermDays = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء'];
        var bDriverOnline = false, bDriverWatchId = null, bDriverIncomingTimer = null, bDriverReqTimer = null;

        window.openBookingApp = async function(tab) {
            var modal = document.getElementById('booking-modal-view');
            if (!modal) return;
            modal.style.display = 'flex';
            document.body.style.overflow = 'hidden';
            if (tab) bActiveTab = tab;
            window.switchBookingTab(bActiveTab);

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

        window.closeBookingApp = function() {
            var modal = document.getElementById('booking-modal-view');
            if (modal) modal.style.display = 'none';
            document.body.style.overflow = '';
            if (bDriversPollTimer) clearInterval(bDriversPollTimer);
        };

        window.switchBookingTab = function(tab) {
            bActiveTab = tab;
            var tShort = document.getElementById('book-tab-short');
            var tDaily = document.getElementById('book-tab-daily');
            var tDriver = document.getElementById('book-tab-driver');
            var pShort = document.getElementById('sidebar-panel-short');
            var pDaily = document.getElementById('sidebar-panel-daily');
            var pDriver = document.getElementById('sidebar-panel-driver');

            [tShort, tDaily, tDriver].forEach(function(b) {
                if (b) { b.style.background = 'transparent'; b.style.color = '#d1d5db'; b.style.fontWeight = '700'; }
            });
            [pShort, pDaily, pDriver].forEach(function(p) { if (p) p.style.display = 'none'; });

            if (tab === 'short') {
                if (tShort) { tShort.style.background = '#f59e0b'; tShort.style.color = '#111'; tShort.style.fontWeight = '900'; }
                if (pShort) pShort.style.display = 'flex';
                renderShortTripSidebar();
            } else if (tab === 'daily') {
                if (tDaily) { tDaily.style.background = '#f59e0b'; tDaily.style.color = '#111'; tDaily.style.fontWeight = '900'; }
                if (pDaily) pDaily.style.display = 'flex';
                renderDailyTripSidebar();
                loadPassengerPermanentRoutes();
            } else if (tab === 'driver') {
                if (tDriver) { tDriver.style.background = '#f59e0b'; tDriver.style.color = '#111'; tDriver.style.fontWeight = '900'; }
                if (pDriver) pDriver.style.display = 'flex';
                renderDriverSidebar();
            }
            if (bMap) setTimeout(function() { bMap.resize(); }, 100);
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
            if (bGeolocate) {
                bGeolocate.trigger();
            } else if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(function(pos) {
                    bUserLat = pos.coords.latitude;
                    bUserLon = pos.coords.longitude;
                    bHasUserGps = true;
                    if (bMap) bMap.flyTo({ center: [bUserLon, bUserLat], zoom: 15 });
                    setBookingPickup(bUserLon, bUserLat, 'موقعي الحالي');
                    fetchNearbyDriversForMap();
                });
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
            bMap = new mapboxgl.Map({
                container: 'booking-mapbox-map',
                style: 'mapbox://styles/mapbox/streets-v12',
                center: [bUserLon, bUserLat],
                zoom: 13
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

                // Map Click handler to set pins
                bMap.on('click', function(e) {
                    var lng = e.lngLat.lng, lat = e.lngLat.lat;
                    if (!bPickupCoords) setBookingPickup(lng, lat, '');
                    else setBookingDropoff(lng, lat, '');
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
            var resultsEl = document.getElementById('book-dropoff-results');
            if (!resultsEl) return;
            if (!query || query.trim().length < 2) {
                resultsEl.style.display = 'none';
                return;
            }
            bDropoffTimer = setTimeout(async function() {
                try {
                    var q = encodeURIComponent(query.trim());
                    var url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + q + '.json?country=iq&proximity=' + bUserLon + ',' + bUserLat + '&language=ar,en&types=poi,address,neighborhood,place,locality&limit=6&access_token=' + BOOKING_MAPBOX_TOKEN;
                    var res = await fetch(url);
                    var data = await res.json();
                    var feats = (data && data.features) ? data.features : [];
                    if (feats.length === 0) { resultsEl.style.display = 'none'; return; }
                    resultsEl.innerHTML = '';
                    resultsEl.style.display = 'block';
                    feats.forEach(function(f) {
                        var item = document.createElement('div');
                        item.className = 'search-result-item';
                        var name = f.place_name_ar || f.place_name || '';
                        item.innerHTML = '<span>📍</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</span>';
                        item.onclick = function() {
                            resultsEl.style.display = 'none';
                            setBookingDropoff(f.center[0], f.center[1], name);
                        };
                        resultsEl.appendChild(item);
                    });
                } catch(_) { resultsEl.style.display = 'none'; }
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
            if (!bPickupCoords) {
                alert('يرجى تحديد نقطة الانطلاق أولاً أو الضغط على زر موقعي');
                return;
            }
            if (!bDropoffCoords) {
                alert('يرجى كتابة أو تحديد نقطة الوصول على الخريطة');
                return;
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
                if (data.success && data.request) {
                    bActiveRideId = data.request.id;
                    showDispatchModal(data.request);
                } else {
                    alert(data.error || 'تعذر إرسال طلب المشوار');
                }
            } catch(e) {
                alert('خطأ في الاتصال بالخادم');
            }
        };

        function showDispatchModal(req) {
            var modal = document.getElementById('ride-dispatch-modal');
            if (!modal) return;
            modal.style.display = 'flex';
            bDispatchSeconds = 30;
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
            if (nameEl) nameEl.textContent = '🚕 الكابتن: ' + (req.assignedDriverName || 'أقرب سائق متاح');
            if (carEl) carEl.textContent = '🚗 المركبة: ' + (req.assignedDriverVehicle || 'تويوتا');
            if (stEl) {
                stEl.textContent = '⏳ جاري انتظار القبول (السائق #' + ((req.currentDriverIndex || 0) + 1) + ')';
                stEl.style.color = '#d97706';
            }
        }

        function onRideAccepted(req) {
            document.getElementById('dispatch-modal-icon').textContent = '🎉';
            document.getElementById('dispatch-modal-title').textContent = 'تم قبول رحلتك بنجاح!';
            document.getElementById('dispatch-modal-subtitle').textContent = 'الكابتن ' + req.assignedDriverName + ' في طريقه إليك!';
            document.getElementById('dispatch-timer-seconds').textContent = '✅';
            var waNum = (req.assignedDriverPhone || '').replace(/[^0-9]/g, '').replace(/^07/, '9647');
            var act = document.getElementById('dispatch-actions-wrap');
            if (act) {
                act.innerHTML = '<a href="https://wa.me/' + waNum + '" target="_blank" class="btn-primary" style="background:#25d366;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;flex:1;">💬 واتساب</a><a href="tel:' + req.assignedDriverPhone + '" class="btn-primary" style="background:#10b981;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;flex:1;">📞 اتصال</a><button type="button" onclick="cancelRideRequest()" class="btn-secondary" style="flex:1;">إغلاق</button>';
            }
        }

        window.cancelRideRequest = function() {
            if (bRidePollTimer) clearInterval(bRidePollTimer);
            if (bDispatchTimer) clearInterval(bDispatchTimer);
            bActiveRideId = null;
            var modal = document.getElementById('ride-dispatch-modal');
            if (modal) modal.style.display = 'none';
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

            panel.innerHTML = '<div style="font-size:14px;font-weight:900;color:#111;margin-bottom:4px;">🚖 لوحة الكابتن والطلبات الحية</div>' +
                '<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:12px;display:flex;align-items:center;justify-content:space-between;">' +
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
            var did = localStorage.getItem('user_id') || 'drv-test';
            var modal = document.getElementById('driver-incoming-modal');
            if (modal) modal.style.display = 'none';
            if (bDriverReqTimer) clearInterval(bDriverReqTimer);

            try {
                await fetch('/api/ride/respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        requestId: bCurrentIncomingReq.id,
                        driverId: did,
                        action: action
                    })
                });
                if (action === 'accept') {
                    alert('🎉 قبلت المشوار بنجاح! سيتم توجيه الراكب للتواصل معك.');
                }
            } catch(_) {}
            bCurrentIncomingReq = null;
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
            else window.switchRole('Driver');
            if (urlParams.get('openMap') === '1' || urlParams.get('showMap') === '1') {
                window.openBookingApp(urlParams.get('tripType') || 'short');
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
            activeRoute: (body.fromRoute && body.toRoute) ? { fromText: body.fromRoute.trim(), toText: body.toRoute.trim(), setAt: now } : null,
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
