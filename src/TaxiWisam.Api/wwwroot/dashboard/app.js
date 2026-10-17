// =============================================================================
// Tawseela (توصيله) Admin Dashboard Client
// Enterprise Platform for Najaf Governorate
// =============================================================================
const API_BASE = '/api/admin';

function authHeaders() {
    const token = localStorage.getItem('admin_token') || localStorage.getItem('token') || '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
}

let currentDocId = null;
let currentDriverId = null;
let currentDriverData = null;
let currentDocData = null;
let isRejectionOpen = false;

// -----------------------------------------------------------------------------
// 0. Authentication & Initialization
// -----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    checkAdminAuth();
    if (typeof initBackupDropzoneEvents === 'function') initBackupDropzoneEvents();
});

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function normalizeDigits(str) {
    if (!str) return '';
    const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    return str.toString().replace(/[٠-٩]/g, d => arabicDigits.indexOf(d));
}

function checkAdminAuth() {
    const isAuth = localStorage.getItem('tawseela_admin_auth') === 'true';
    const overlay = document.getElementById('login-overlay');
    if (isAuth) {
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        } else if (overlay) {
            overlay.style.display = 'none';
            overlay.style.pointerEvents = 'none';
            overlay.classList.add('hidden');
        }
        try { loadDashboardStats(); } catch(e) { console.warn(e); }
        try { loadDrivers(); } catch(e) { console.warn(e); }
        try { loadCustomers(); } catch(e) { console.warn(e); }
        try { loadVerifications(); } catch(e) { console.warn(e); }
        try { loadRoutes(); } catch(e) { console.warn(e); }
        try { loadMatchingSettings(); } catch(e) { console.warn(e); }
        try { loadCustomizationSettings(); } catch(e) { console.warn(e); }
        // Auto-refresh stats & cancellation badge every 30 seconds
        setInterval(() => { try { loadDashboardStats(); } catch(e) {} }, 30000);
    } else {
        if (overlay) {
            overlay.classList.add('active');
            overlay.classList.remove('hidden');
            overlay.classList.remove('pointer-events-none');
            overlay.style.display = 'flex';
            overlay.style.pointerEvents = 'auto';
            overlay.style.visibility = 'visible';
        }
    }
}

function handleAdminLogin(event) {
    if (event) {
        try { event.preventDefault(); } catch(_) {}
    }
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const errorBox = document.getElementById('login-error');

    const username = (usernameInput ? usernameInput.value : '').trim().toLowerCase();
    const rawPassword = (passwordInput ? passwordInput.value : '').trim();
    const password = normalizeDigits(rawPassword);

    const isUserValid = (username === 'admin' || username === 'admin@taxiwisam.com' || username === 'مدير' || username === 'الادارة');
    const isPassValid = (password === '1122' || rawPassword === '1122' || rawPassword === '١١٢٢');

    if (isUserValid && isPassValid) {
        localStorage.setItem('tawseela_admin_auth', 'true');
        if (errorBox) errorBox.classList.add('hidden');
        const overlay = document.getElementById('login-overlay');
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        } else if (overlay) {
            overlay.style.display = 'none';
            overlay.style.pointerEvents = 'none';
            overlay.classList.add('hidden');
        }
        showToast('مرحباً بك في لوحة تحكم منصة توصيله! 🚖');

        // Audit login on server
        try {
            fetch(`${API_BASE}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            }).catch(() => {});
        } catch (_) {}

        try { loadDashboardStats(); } catch(e) { console.warn(e); }
        try { loadDrivers(); } catch(e) { console.warn(e); }
        try { loadCustomers(); } catch(e) { console.warn(e); }
        try { loadVerifications(); } catch(e) { console.warn(e); }
        try { loadRoutes(); } catch(e) { console.warn(e); }
        try { loadMatchingSettings(); } catch(e) { console.warn(e); }
        try { loadCustomizationSettings(); } catch(e) { console.warn(e); }
    } else {
        // Audit failed login attempt on server
        try {
            fetch(`${API_BASE}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            }).catch(() => {});
        } catch (_) {}

        if (errorBox) {
            errorBox.innerText = 'بيانات الدخول غير صحيحة! يرجى إدخال اسم المستخدم admin وكلمة المرور 1122 أو ١١٢٢';
            errorBox.classList.remove('hidden');
        }
        if (passwordInput) passwordInput.focus();
    }
}

async function logoutAdmin() {
    try {
        await fetch(`${API_BASE}/auth/logout`, { method: 'POST' }).catch(() => {});
    } catch (_) {}
    localStorage.removeItem('tawseela_admin_auth');
    location.reload();
}

// -----------------------------------------------------------------------------
// Mobile Sidebar Off-Canvas Navigation
// -----------------------------------------------------------------------------
function toggleMobileSidebar(force) {
    const drawer = document.getElementById('sidebar-drawer');
    const backdrop = document.getElementById('mobile-sidebar-backdrop');
    if (!drawer) return;

    const isOpen = !drawer.classList.contains('translate-x-full');
    const target = force !== undefined ? force : !isOpen;

    if (target) {
        drawer.classList.remove('translate-x-full');
        if (backdrop) {
            backdrop.classList.add('active');
            backdrop.classList.remove('hidden');
            backdrop.classList.remove('pointer-events-none');
            backdrop.style.display = 'block';
            backdrop.style.pointerEvents = 'auto';
        }
    } else {
        drawer.classList.add('translate-x-full');
        if (backdrop) {
            backdrop.classList.remove('active');
            backdrop.classList.add('hidden');
            backdrop.classList.add('pointer-events-none');
            backdrop.style.display = 'none';
            backdrop.style.pointerEvents = 'none';
        }
    }
}

// -----------------------------------------------------------------------------
// Tab Switching
// -----------------------------------------------------------------------------
function switchTab(tabName) {
    // Close mobile drawer if open
    toggleMobileSidebar(false);

    // Clear any active cancellations polling
    if (window._cancelTabInterval) { clearInterval(window._cancelTabInterval); window._cancelTabInterval = null; }

    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.add('hidden');
        content.style.display = 'none';
    });

    const btn = document.getElementById(`tab-btn-${tabName}`);
    if (btn) btn.classList.add('active');

    const content = document.getElementById(`tab-${tabName}`);
    if (content) {
        content.classList.remove('hidden');
        content.style.display = 'block';
    }

    // Toggle full-canvas layout for fleet radar map
    const mainArea = document.getElementById('main-content-area') || document.querySelector('main');
    if (mainArea) {
        if (tabName === 'fleet-map') {
            mainArea.classList.remove('overflow-y-auto', 'p-4', 'md:p-8', 'pb-24', 'md:pb-8');
            mainArea.classList.add('overflow-hidden', 'p-0');
        } else {
            mainArea.classList.remove('overflow-hidden', 'p-0');
            mainArea.classList.add('overflow-y-auto', 'p-4', 'md:p-8', 'pb-24', 'md:pb-8');
        }
    }

    // Update Breadcrumbs
    const tabTitles = {
        'overview': 'نظرة عامة والمؤشرات',
        'verifications': 'توثيق مستمسكات السائقين',
        'drivers': 'إدارة السائقين',
        'customers': 'إدارة الركاب',
        'routes': 'المسارات والحجوزات',
        'cancellations': 'طلبات إلغاء الركاب',
        'trip-ratings': 'تقييمات الرحلات والنقاط',
        'fleet-map': 'متابعة الأسطول والمسارات',
        'complaints': 'إدارة الشكاوى والبلاغات',
        'settings': 'إعدادات التسعير والمطابقة',
        'audit': 'سجل التدقيق الأمني',
        'backup': 'النسخ الاحتياطي وقاعدة البيانات',
        'customization': 'التخصيص والمظهر',
        'ui-management': 'إدارة الواجهة',
        'custom-buttons': 'أزرار مخصصة',
        'advertisements': 'الإعلانات',
        'telegram': 'بوت تيليجرام'
    };
    const bSection = document.getElementById('breadcrumb-section');
    if (bSection) bSection.textContent = tabTitles[tabName] || tabName;
    const bDivider = document.getElementById('breadcrumb-divider');
    const bSub = document.getElementById('breadcrumb-sub');
    if (bDivider && bSub) {
        if (tabName === 'routes') {
            bDivider.classList.remove('hidden');
            bSub.classList.remove('hidden');
            const isBookings = document.getElementById('sub-view-bookings') && !document.getElementById('sub-view-bookings').classList.contains('hidden');
            bSub.textContent = isBookings ? 'سجل الحجوزات' : 'خطوط السير';
        } else {
            bDivider.classList.add('hidden');
            bSub.classList.add('hidden');
        }
    }

    switch (tabName) {
        case 'overview':
            loadDashboardStats();
            break;
        case 'verifications':
            loadVerifications();
            break;
        case 'drivers':
            loadDrivers();
            break;
        case 'customers':
            loadCustomers();
            break;
        case 'routes':
            loadRoutes();
            break;
        case 'cancellations':
            loadCancellationRequests();
            // Live-refresh every 15s while tab is open
            window._cancelTabInterval = setInterval(() => { try { loadCancellationRequests(); } catch(e) {} }, 15000);
            break;
        case 'trip-ratings':
            loadTripRatings();
            break;
        case 'fleet-map':
            initFleetMapbox();
            setTimeout(() => { if (fleetMap) fleetMap.resize(); }, 150);
            setTimeout(() => { if (fleetMap) fleetMap.resize(); }, 400);
            break;
        case 'complaints':
            loadComplaints();
            break;
        case 'settings':
            loadMatchingSettings();
            break;
        case 'audit':
            loadAuditLogs();
            break;
        case 'backup':
            loadDashboardStats();
            loadDatabaseEngineStats();
            if (typeof initBackupDropzoneEvents === 'function') initBackupDropzoneEvents();
            break;
        case 'customization': loadCustomizationSettings(); break;
        case 'ui-management': loadCustomButtons(); loadAdvertisements(); break;
        case 'custom-buttons': loadCustomButtons(); break;
        case 'advertisements': loadAdvertisements(); break;
        case 'telegram': break;
    }
}

function switchSubRouteTab(subTab) {
    const btnRoutes = document.getElementById('sub-btn-routes');
    const btnBookings = document.getElementById('sub-btn-bookings');
    const viewRoutes = document.getElementById('sub-view-routes');
    const viewBookings = document.getElementById('sub-view-bookings');
    const bSub = document.getElementById('breadcrumb-sub');
    const bDivider = document.getElementById('breadcrumb-divider');

    if (bDivider) bDivider.classList.remove('hidden');

    if (subTab === 'routes-list') {
        if (btnRoutes) btnRoutes.className = 'px-3.5 py-1.5 rounded-lg text-xs font-bold bg-[#1B4965] text-white shadow-xs transition-all';
        if (btnBookings) btnBookings.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition-all';
        if (viewRoutes) viewRoutes.classList.remove('hidden');
        if (viewBookings) viewBookings.classList.add('hidden');
        if (bSub) {
            bSub.classList.remove('hidden');
            bSub.textContent = 'خطوط السير';
        }
        loadRoutes();
    } else {
        if (btnBookings) btnBookings.className = 'px-3.5 py-1.5 rounded-lg text-xs font-bold bg-[#1B4965] text-white shadow-xs transition-all';
        if (btnRoutes) btnRoutes.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition-all';
        if (viewBookings) viewBookings.classList.remove('hidden');
        if (viewRoutes) viewRoutes.classList.add('hidden');
        if (bSub) {
            bSub.classList.remove('hidden');
            bSub.textContent = 'سجل الحجوزات';
        }
        loadBookings();
    }
}

// -----------------------------------------------------------------------------
// 1. Dashboard Overview Stats & Notifications Link
// -----------------------------------------------------------------------------
async function loadDashboardStats() {
    try {
        const res = await fetch(`${API_BASE}/stats`);
        if (!res.ok) return;
        const data = await res.json();

        document.getElementById('stat-total-drivers').innerText = data.totalDrivers ?? 0;
        document.getElementById('stat-verified-drivers').innerText = data.verifiedDrivers ?? 0;
        document.getElementById('stat-pending-verifications').innerText = data.pendingVerifications ?? 0;
        document.getElementById('stat-active-routes').innerText = data.activeRoutes ?? 0;
        document.getElementById('stat-total-bookings').innerText = data.totalBookings ?? 0;
        document.getElementById('stat-total-revenue').innerText = Number(data.totalRevenue ?? 0).toLocaleString();

        const badgeVerif = document.getElementById('badge-verifications');
        const mobileBadgeVerif = document.getElementById('mobile-badge-verif');
        if (data.pendingVerifications > 0) {
            if (badgeVerif) {
                badgeVerif.innerText = data.pendingVerifications;
                badgeVerif.classList.remove('hidden');
            }
            if (mobileBadgeVerif) mobileBadgeVerif.classList.remove('hidden');
        } else {
            if (badgeVerif) badgeVerif.classList.add('hidden');
            if (mobileBadgeVerif) mobileBadgeVerif.classList.add('hidden');
        }

        const badgeComp = document.getElementById('badge-complaints');
        if (badgeComp) {
            if (data.pendingComplaints > 0) {
                badgeComp.innerText = data.pendingComplaints;
                badgeComp.classList.remove('hidden');
            } else {
                badgeComp.classList.add('hidden');
            }
        }

        try {
            const resCan = await fetch(`${API_BASE}/cancellation-requests`);
            if (resCan.ok) {
                const dataCan = await resCan.json();
                const pendingCan = (dataCan.requests || []).filter(r => r.status === 'Pending').length;
                const badgeCan = document.getElementById('badge-cancellations');
                if (badgeCan) {
                    if (pendingCan > 0) {
                        badgeCan.innerText = pendingCan;
                        badgeCan.classList.remove('hidden');
                    } else {
                        badgeCan.classList.add('hidden');
                    }
                }
            }
        } catch (_) {}

        // Keep real-time header notification bell synchronized
        loadDynamicNotifications();
    } catch (err) {
        console.warn('Dashboard stats offline/mock', err);
    }
}

// -----------------------------------------------------------------------------
// 2. Driver Verifications Queue & Signed URL Previews
// -----------------------------------------------------------------------------
// 2. Driver Verifications (Full 4-Document Direct Inspection)
// -----------------------------------------------------------------------------
window.pendingDriversMap = {};
window.currentDriverDocUrls = {};

async function loadVerifications() {
    const loading = document.getElementById('verifications-loading');
    const empty = document.getElementById('verifications-empty');
    const table = document.getElementById('verifications-table');
    const tbody = document.getElementById('verifications-body');

    if (loading) loading.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
    if (table) table.classList.add('hidden');
    if (tbody) tbody.innerHTML = '';

    try {
        const res = await fetch(`${API_BASE}/drivers/pending-verifications`);
        const drivers = await res.json();
        if (loading) loading.classList.add('hidden');

        if (!drivers || drivers.length === 0) {
            if (empty) empty.classList.remove('hidden');
            return;
        }

        if (table) table.classList.remove('hidden');

        drivers.forEach(d => {
            window.pendingDriversMap[d.driverId] = d;

            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50/80 transition-colors border-b border-slate-100/80 text-xs md:text-sm';

            const vehicleInfo = d.vehicles && d.vehicles.length > 0 
                ? `${d.vehicles[0].make} ${d.vehicles[0].model} (${d.vehicles[0].plateNumber || 'النجف'})`
                : '<span class="text-slate-400">لم تُسجل مركبة</span>';

            const docs = d.documents || [];
            const hasIdFront = docs.some(x => x.documentType === 'NationalIdFront');
            const hasIdBack = docs.some(x => x.documentType === 'NationalIdBack');
            const hasLicFront = docs.some(x => x.documentType === 'DrivingLicenseFront');
            const hasLicBack = docs.some(x => x.documentType === 'DrivingLicenseBack');

            const docsHtml = `
                <div class="space-y-1">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${hasIdFront ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60' : 'bg-rose-50 text-rose-700 border border-rose-200/60'}">
                            <i class="fa-solid ${hasIdFront ? 'fa-check' : 'fa-xmark'} text-[9px]"></i> بطاقة (وجه)
                        </span>
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${hasIdBack ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60' : 'bg-rose-50 text-rose-700 border border-rose-200/60'}">
                            <i class="fa-solid ${hasIdBack ? 'fa-check' : 'fa-xmark'} text-[9px]"></i> بطاقة (ظهر)
                        </span>
                    </div>
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${hasLicFront ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60' : 'bg-rose-50 text-rose-700 border border-rose-200/60'}">
                            <i class="fa-solid ${hasLicFront ? 'fa-check' : 'fa-xmark'} text-[9px]"></i> رخصة (وجه)
                        </span>
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${hasLicBack ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60' : 'bg-rose-50 text-rose-700 border border-rose-200/60'}">
                            <i class="fa-solid ${hasLicBack ? 'fa-check' : 'fa-xmark'} text-[9px]"></i> رخصة (ظهر)
                        </span>
                    </div>
                </div>
            `;

            const phoneHtml = d.phoneNumber 
                ? `<a href="tel:${escapeHtml(d.phoneNumber)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs transition-colors" dir="ltr" title="اتصال بالكابتن"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(d.phoneNumber)}</span></a>`
                : '<span class="text-slate-400">-</span>';

            tr.innerHTML = `
                <td class="py-3.5 px-4 font-bold text-slate-900">${escapeHtml(d.fullName || 'كابتن مسجل')}</td>
                <td class="py-3.5 px-4">${phoneHtml}</td>
                <td class="py-3.5 px-4 text-slate-600 font-mono text-xs">${escapeHtml(d.licenseNumber || '-')}</td>
                <td class="py-3.5 px-4 text-slate-700 text-xs">${vehicleInfo}</td>
                <td class="py-3.5 px-4 min-w-[220px]">${docsHtml}</td>
                <td class="py-3.5 px-4 text-center">
                    <button type="button" onclick="viewFullDriver('${d.driverId}')" class="px-3 py-1.5 bg-primary hover:bg-slate-800 active:scale-95 text-white font-medium rounded-lg text-xs transition shadow-xs flex items-center justify-center gap-1.5 mx-auto cursor-pointer">
                        <i class="fa-solid fa-id-card text-[11px]"></i>
                        <span>فحص المستمسكات والاعتماد</span>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

    } catch (err) {
        if (loading) loading.classList.add('hidden');
        console.error('Error fetching verifications', err);
    }
}

// Inspect full driver documents & route directly (Simultaneous 4-doc view)
async function viewFullDriver(driverId) {
    try {
        currentDriverId = driverId;
        isRejectionOpen = false;

        const rejBox = document.getElementById('rejection-box');
        if (rejBox) rejBox.classList.add('hidden');
        const rejInput = document.getElementById('rejection-reason-input');
        if (rejInput) rejInput.value = '';

        // Open modal immediately
        const modal = document.getElementById('document-modal');
        if (modal) {
            modal.classList.add('active');
            modal.classList.remove('hidden');
            modal.classList.remove('pointer-events-none');
            modal.style.display = 'flex';
            modal.style.pointerEvents = 'auto';
        }

        // 1. Populate from local memory map if available (zero wait)
        let driver = window.pendingDriversMap ? window.pendingDriversMap[driverId] : null;
        if (driver) {
            populateDriverModalData(driver);
        }

        // 2. Fetch fresh from API to ensure complete relations (vehicles, routes, documents)
        try {
            const res = await fetch(`${API_BASE}/drivers/${driverId}`);
            if (res.ok) {
                const fresh = await res.json();
                if (fresh) {
                    driver = fresh;
                    window.pendingDriversMap[driverId] = fresh;
                    populateDriverModalData(fresh);
                }
            }
        } catch (fetchErr) {
            console.warn('Background driver fetch notice:', fetchErr);
        }

        if (!driver) {
            showToast('تعذر العثور على بيانات السائق', true);
            closeDocumentModal();
        }

    } catch (err) {
        console.error('Error viewing full driver:', err);
        showToast('فشل في فتح نافذة تدقيق المستمسكات', true);
    }
}

// Populate Driver, Vehicle, Route & 4 Documents Grid
function populateDriverModalData(driver) {
    currentDriverData = driver;

    // 1. Driver Name, Phone, License, Status
    const nameEl = document.getElementById('modal-driver-name');
    if (nameEl) nameEl.innerText = driver.fullName || 'كابتن مسجل';

    const phoneEl = document.getElementById('modal-driver-phone');
    if (phoneEl) phoneEl.innerText = driver.phoneNumber ? `📞 ${driver.phoneNumber}` : '-';

    const licNumEl = document.getElementById('modal-driver-license-num');
    if (licNumEl) licNumEl.innerText = driver.licenseNumber ? `رقم الرخصة: ${driver.licenseNumber}` : '';

    const badgeEl = document.getElementById('modal-driver-status-badge');
    if (badgeEl) {
        if (driver.status === 'Approved') {
            badgeEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800';
            badgeEl.innerText = 'معتمد وموثق ✅';
        } else if (driver.status === 'Rejected') {
            badgeEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800';
            badgeEl.innerText = 'مرفوض ❌';
        } else {
            badgeEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800';
            badgeEl.innerText = 'قيد المراجعة ⏳';
        }
    }

    // 2. Vehicle Info
    const v = (driver.vehicles && driver.vehicles.length > 0) ? driver.vehicles[0] : null;
    const vehEl = document.getElementById('modal-driver-vehicle');
    const plateEl = document.getElementById('modal-driver-plate');
    if (vehEl) {
        vehEl.innerText = v ? `🚗 ${v.make} ${v.model} (${v.year || ''})` : 'لم تُسجل مركبة';
    }
    if (plateEl) {
        plateEl.innerText = v ? `لوحة: ${v.plateNumber || 'النجف الأشرف'}` : '-';
    }

    // 3. Route Info
    const routeEl = document.getElementById('modal-driver-route');
    if (routeEl) {
        const r = (driver.routes && driver.routes.length > 0) ? driver.routes[0] : null;
        if (r) {
            routeEl.innerHTML = `
                <div class="flex items-center gap-1.5 flex-wrap font-bold">
                    <span class="text-amber-700">من: ${r.startName}</span>
                    <i class="fa-solid fa-arrow-left text-[10px] text-slate-400"></i>
                    <span class="text-emerald-700">إلى: ${r.endName}</span>
                </div>
                <div class="text-[11px] text-slate-600 mt-1 flex items-center gap-3 flex-wrap font-semibold">
                    <span>⏰ ${r.departureTime || '08:00 ص'}</span>
                    <span>💺 ${r.availableSeats || 4} مقاعد</span>
                    <span class="text-emerald-700 font-bold">💰 ${Number(r.fare || 0).toLocaleString()} د.ع</span>
                </div>
            `;
        } else {
            routeEl.innerHTML = '<span class="text-slate-400">لم يتم تحديد خط يومي بعد</span>';
        }
    }

    // 4. Populate 4 Documents simultaneously
    const docs = driver.documents || [];
    const docItems = [
        { key: 'NationalIdFront', prefix: 'id-front', title: 'البطاقة الوطنية (الوجه الأمامي)' },
        { key: 'NationalIdBack', prefix: 'id-back', title: 'البطاقة الوطنية (الوجه الخلفي)' },
        { key: 'DrivingLicenseFront', prefix: 'lic-front', title: 'إجازة السوق (الوجه الأمامي)' },
        { key: 'DrivingLicenseBack', prefix: 'lic-back', title: 'إجازة السوق (الوجه الخلفي)' }
    ];

    window.currentDriverDocUrls = {};

    docItems.forEach(item => {
        const found = docs.find(d => d.documentType === item.key);
        const imgEl = document.getElementById(`doc-img-${item.prefix}`);
        const placeholderEl = document.getElementById(`doc-placeholder-${item.prefix}`);
        const badgeEl = document.getElementById(`doc-badge-${item.prefix}`);
        const btnZoom = document.getElementById(`btn-zoom-${item.prefix}`);
        const btnDl = document.getElementById(`btn-dl-${item.prefix}`);

        const fileUrl = found ? (found.fileUrl || found.filePath) : null;
        window.currentDriverDocUrls[item.prefix] = fileUrl;

        if (fileUrl) {
            if (imgEl) {
                imgEl.src = fileUrl;
                imgEl.classList.remove('hidden');
            }
            if (placeholderEl) placeholderEl.classList.add('hidden');
            if (badgeEl) {
                badgeEl.className = 'text-[10px] px-2 py-0.5 rounded font-bold bg-emerald-100 text-emerald-800';
                badgeEl.innerText = 'مرفوع وجاهز ✅';
            }
            if (btnZoom) btnZoom.disabled = false;
            if (btnDl) btnDl.disabled = false;
        } else {
            if (imgEl) {
                imgEl.src = '';
                imgEl.classList.add('hidden');
            }
            if (placeholderEl) placeholderEl.classList.remove('hidden');
            if (badgeEl) {
                badgeEl.className = 'text-[10px] px-2 py-0.5 rounded font-bold bg-rose-100 text-rose-800';
                badgeEl.innerText = 'غير مرفوع ❌';
            }
            if (btnZoom) btnZoom.disabled = true;
            if (btnDl) btnDl.disabled = true;
        }
    });
}

// Zoom helper for individual document
function zoomDoc(prefix) {
    const url = window.currentDriverDocUrls ? window.currentDriverDocUrls[prefix] : null;
    if (!url) {
        showToast('لم يتم رفع هذه الوثيقة', true);
        return;
    }
    const titles = {
        'id-front': 'البطاقة الوطنية (الوجه الأمامي)',
        'id-back': 'البطاقة الوطنية (الوجه الخلفي)',
        'lic-front': 'إجازة السوق (الوجه الأمامي)',
        'lic-back': 'إجازة السوق (الوجه الخلفي)'
    };
    openZoomImage(url, titles[prefix] || 'معاينة الوثيقة');
}

function openZoomImage(url, title = 'معاينة الوثيقة') {
    if (!url) return;
    const modal = document.getElementById('image-zoom-modal');
    const img = document.getElementById('zoom-modal-img');
    const titleEl = document.getElementById('zoom-modal-title');
    if (img) img.src = url;
    if (titleEl) titleEl.innerText = title;
    if (modal) {
        modal.classList.add('active');
        modal.classList.remove('hidden');
        modal.classList.remove('pointer-events-none');
        modal.style.display = 'flex';
        modal.style.pointerEvents = 'auto';
    }
}

function closeZoomModal() {
    const modal = document.getElementById('image-zoom-modal');
    if (modal) {
        modal.classList.remove('active');
        modal.classList.add('hidden');
        modal.classList.add('pointer-events-none');
        modal.style.display = 'none';
        modal.style.pointerEvents = 'none';
    }
}

// Download single document by card prefix
function downloadSingleDocById(prefix, filename) {
    const url = window.currentDriverDocUrls ? window.currentDriverDocUrls[prefix] : null;
    if (!url) {
        showToast('لا توجد صورة لتحميلها', true);
        return;
    }
    downloadDocumentByUrl(url, filename);
}

async function downloadDocumentByUrl(url, filename) {
    try {
        showToast('جاري بدء حفظ الوثيقة...');
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        const driverName = (currentDriverData && currentDriverData.fullName ? currentDriverData.fullName.replace(/\s+/g, '_') : 'driver');
        a.download = `توصيله_${driverName}_${filename}.jpg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(blobUrl);
        showToast('تم حفظ الوثيقة بنجاح على جهازك ✅');
    } catch (err) {
        window.open(url, '_blank');
    }
}

// Print unified official sheet with all 4 documents and driver info
function printAllDocuments() {
    if (!currentDriverData) {
        showToast('لا توجد بيانات كابتن لطباعتها', true);
        return;
    }

    const d = currentDriverData;
    const v = (d.vehicles && d.vehicles[0]) ? d.vehicles[0] : null;
    const r = (d.routes && d.routes[0]) ? d.routes[0] : null;
    const printDate = new Date().toLocaleString('ar-IQ');
    const urls = window.currentDriverDocUrls || {};

    const printWindow = window.open('', '_blank', 'width=1000,height=850');
    if (!printWindow) {
        showToast('يرجى السماح بالنوافذ المنبثقة للطباعة', true);
        return;
    }

    printWindow.document.write(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <title>استمارة تدقيق واعتماد كابتن - منصة توصيله</title>
            <style>
                body { font-family: 'Cairo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif; padding: 25px; color: #0f172a; direction: rtl; }
                .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; }
                .brand { font-size: 24px; font-weight: 900; color: #0f172a; }
                .brand span { color: #f59e0b; }
                .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
                .meta-table td { padding: 8px 12px; border: 1px solid #cbd5e1; font-size: 13px; }
                .meta-table .label { background-color: #f8fafc; font-weight: bold; width: 22%; color: #475569; }
                .docs-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin: 15px 0; }
                .doc-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px; text-align: center; background: #fafafa; }
                .doc-card h4 { margin: 0 0 6px 0; font-size: 12px; color: #334155; }
                .doc-card img { max-width: 100%; max-height: 220px; object-fit: contain; border-radius: 4px; border: 1px solid #e2e8f0; }
                .footer { margin-top: 25px; display: flex; justify-content: space-between; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 12px; }
                .stamp-box { border: 2px dashed #cbd5e1; border-radius: 8px; width: 140px; height: 70px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #94a3b8; }
                @media print {
                    body { padding: 5px; }
                    @page { margin: 10mm; }
                }
            </style>
        </head>
        <body>
            <div class="header">
                <div>
                    <div class="brand">منصة <span>توصيله</span> 🚖</div>
                    <div style="font-size: 12px; color: #64748b; margin-top: 3px;">نظام إدارة النقل الذكي الموحد - محافظة النجف الأشرف</div>
                </div>
                <div style="text-align: left; font-size: 12px;">
                    <div><strong>استمارة فحص واعتماد وثائق الكابتن</strong></div>
                    <div style="color: #64748b; margin-top: 3px;">تاريخ المعاينة: ${printDate}</div>
                </div>
            </div>

            <table class="meta-table">
                <tr>
                    <td class="label">اسم الكابتن:</td>
                    <td><strong>${d.fullName || '-'}</strong></td>
                    <td class="label">رقم الهاتف:</td>
                    <td style="font-family: monospace;">${d.phoneNumber || '-'}</td>
                </tr>
                <tr>
                    <td class="label">رقم إجازة السوق:</td>
                    <td style="font-family: monospace;">${d.licenseNumber || '-'}</td>
                    <td class="label">بيانات المركبة:</td>
                    <td>${v ? `${v.make} ${v.model} (${v.year || ''}) - لوحة: ${v.plateNumber}` : '-'}</td>
                </tr>
                <tr>
                    <td class="label">مسار الخط المحدد:</td>
                    <td colspan="3">${r ? `من: ${r.startName} إلى: ${r.endName} (الأجرة: ${r.fare} د.ع - المقاعد: ${r.availableSeats})` : 'النجف الأشرف'}</td>
                </tr>
                <tr>
                    <td class="label">الحالة الحالية:</td>
                    <td><strong>${d.status || 'قيد المراجعة'}</strong></td>
                    <td class="label">المنطقة الجغرافية:</td>
                    <td>محافظة النجف الأشرف</td>
                </tr>
            </table>

            <div class="docs-grid">
                <div class="doc-card">
                    <h4>البطاقة الوطنية (الوجه الأمامي)</h4>
                    ${urls['id-front'] ? `<img src="${urls['id-front']}" />` : '<p style="color:#94a3b8; font-size:12px;">غير مرفوع</p>'}
                </div>
                <div class="doc-card">
                    <h4>البطاقة الوطنية (الوجه الخلفي)</h4>
                    ${urls['id-back'] ? `<img src="${urls['id-back']}" />` : '<p style="color:#94a3b8; font-size:12px;">غير مرفوع</p>'}
                </div>
                <div class="doc-card">
                    <h4>إجازة السوق (الوجه الأمامي)</h4>
                    ${urls['lic-front'] ? `<img src="${urls['lic-front']}" />` : '<p style="color:#94a3b8; font-size:12px;">غير مرفوع</p>'}
                </div>
                <div class="doc-card">
                    <h4>إجازة السوق (الوجه الخلفي)</h4>
                    ${urls['lic-back'] ? `<img src="${urls['lic-back']}" />` : '<p style="color:#94a3b8; font-size:12px;">غير مرفوع</p>'}
                </div>
            </div>

            <div class="footer">
                <div>
                    <div>المشرف الإداري: <strong>Admin Root</strong></div>
                    <div style="margin-top: 4px;">توصيله v2.0 • سجل رقابة إداري معتمد</div>
                </div>
                <div class="stamp-box">
                    ختم الاعتماد والتوثيق
                </div>
            </div>
        </body>
        </html>
    `);
    printWindow.document.close();
    setTimeout(() => {
        printWindow.print();
    }, 600);
}

function closeDocumentModal() {
    const modal = document.getElementById('document-modal');
    if (modal) {
        modal.classList.remove('active');
        modal.classList.add('hidden');
        modal.classList.add('pointer-events-none');
        modal.style.display = 'none';
        modal.style.pointerEvents = 'none';
    }
    currentDriverId = null;
    currentDriverData = null;
    window.currentDriverDocUrls = {};
}

function toggleRejectionBox() {
    isRejectionOpen = !isRejectionOpen;
    const box = document.getElementById('rejection-box');
    if (box) {
        if (isRejectionOpen) {
            box.classList.remove('hidden');
            const inp = document.getElementById('rejection-reason-input');
            if (inp) inp.focus();
        } else {
            box.classList.add('hidden');
        }
    }
}

// Direct Driver Approve Action
async function confirmApproveDriver() {
    if (!currentDriverId) {
        showToast('يرجى تحديد السائق أولاً', true);
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/drivers/${currentDriverId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Approved' })
        });

        if (res.ok) {
            showToast('تم قبول وتفعيل الكابتن بنجاح! ✅');
            closeDocumentModal();
            loadVerifications();
            loadDrivers();
            loadDashboardStats();
        } else {
            showToast('حدث خطأ أثناء اعتماد الكابتن', true);
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

// Direct Driver Reject Action
async function confirmRejectDriver() {
    if (!currentDriverId) {
        showToast('يرجى تحديد السائق أولاً', true);
        return;
    }

    const reason = document.getElementById('rejection-reason-input').value.trim();
    if (!reason) {
        showToast('يرجى كتابة سبب الرفض أولاً', true);
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/drivers/${currentDriverId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Rejected', reason: reason })
        });

        if (res.ok) {
            showToast('تم رفض طلب الكابتن وتسجيل السبب بنجاح ❌');
            closeDocumentModal();
            loadVerifications();
            loadDrivers();
            loadDashboardStats();
        } else {
            showToast('فشل تسجيل رفض طلب الكابتن', true);
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

async function approveCurrentDocument() {
    return confirmApproveDriver();
}

async function rejectCurrentDocument() {
    return confirmRejectDriver();
}

// -----------------------------------------------------------------------------
// 3. Drivers Directory
// -----------------------------------------------------------------------------
async function loadDrivers(search = '') {
    const tbody = document.getElementById('drivers-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/drivers?search=${encodeURIComponent(search)}`);
        const data = await res.json();
        tbody.innerHTML = '';

        if (!data.drivers || data.drivers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="p-8 text-center text-slate-400">لا يوجد سائقون مطابقون</td></tr>';
            return;
        }

        window.driversMap = window.driversMap || {};
        data.drivers.forEach(d => {
            window.driversMap[d.driverId] = d;
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50/80 transition-colors border-b border-slate-100/80';

            let statusBadge = '';
            if (d.isBlocked || d.status === 'Suspended') {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-rose-50 text-rose-700 border border-rose-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>معلق / محظور</span>';
            } else if (d.status === 'Approved' || d.status === 'Online') {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>معتمد ✓</span>';
            } else if (d.status === 'Rejected') {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-rose-50 text-rose-700 border border-rose-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>مرفوض ✕</span>';
            } else {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>بانتظار التدقيق ⏳</span>';
            }

            const verifBadge = d.isVerified || d.status === 'Approved' || d.status === 'Online'
                ? '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60"><i class="fa-solid fa-circle-check text-[10px]"></i> موثق</span>'
                : (d.status === 'Rejected'
                    ? '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-rose-50 text-rose-700 border border-rose-200/60">مرفوض</span>'
                    : '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200/60">قيد الفحص</span>');

            // Lifecycle Buttons
            let lifecycleButtons = '';
            if (d.status === 'Pending' || (!d.isVerified && d.status !== 'Rejected' && d.status !== 'Suspended')) {
                lifecycleButtons = `
                    <button onclick="updateDriverStatus('${d.driverId}', 'Approved')" title="قبول وتوثيق الكابتن" class="px-2 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-1 shadow-xs cursor-pointer">
                        <i class="fa-solid fa-check text-xs"></i>
                        <span>قبول</span>
                    </button>
                    <button onclick="promptRejectDriver('${d.driverId}')" title="رفض طلب الكابتن" class="px-2 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-1 shadow-xs cursor-pointer">
                        <i class="fa-solid fa-xmark text-xs"></i>
                        <span>رفض</span>
                    </button>
                `;
            } else if (d.status === 'Approved' || d.status === 'Online' || (!d.isBlocked && d.isVerified)) {
                lifecycleButtons = `
                    <button onclick="updateDriverStatus('${d.driverId}', 'Suspended', 'تعليق إداري')" title="تعليق حساب الكابتن" class="px-2 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200/60 rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer">
                        <i class="fa-solid fa-pause text-xs"></i>
                        <span>تعليق</span>
                    </button>
                `;
            } else {
                // Suspended or Rejected -> Reactivate
                lifecycleButtons = `
                    <button onclick="updateDriverStatus('${d.driverId}', 'Approved')" title="إعادة تفعيل واعتماد الكابتن" class="px-2 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-1 shadow-xs cursor-pointer">
                        <i class="fa-solid fa-play text-xs"></i>
                        <span>تنشيط</span>
                    </button>
                `;
            }

            if (!d.isApproved) {
                lifecycleButtons = `
                    <button onclick="approveDriver('${d.driverId}')" title="موافقة ظهور على الخريطة" class="px-2 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-1 shadow-xs cursor-pointer">
                        <i class="fa-solid fa-check text-xs"></i>
                        <span>موافقة</span>
                    </button>
                ` + lifecycleButtons;
            }

            const approveBadge = d.isApproved 
                ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60 ml-1">موافق عليه</span>' 
                : '<span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200/60 ml-1">غير موافق</span>';

            const driverPhoneHtml = d.phoneNumber
                ? `<a href="tel:${escapeHtml(d.phoneNumber)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs transition-colors" dir="ltr" title="اتصال بالكابتن"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(d.phoneNumber)}</span></a>`
                : '-';

            tr.innerHTML = `
                <td class="py-3.5 px-4 font-bold text-slate-900 flex items-center gap-1.5">
                    ${escapeHtml(d.fullName)}
                    ${d.isBlocked ? '<span class="px-1.5 py-0.5 text-[10px] bg-rose-50 text-rose-700 border border-rose-200/60 rounded font-bold">معلق</span>' : ''}
                </td>
                <td class="py-3.5 px-4 font-mono text-xs">${driverPhoneHtml}</td>
                <td class="py-3.5 px-4">
                    <span class="inline-flex items-center px-2 py-0.5 bg-slate-100 text-slate-700 border border-slate-200/60 rounded-md text-xs font-medium">${escapeHtml(d.workMode || 'مشوار قصير')}</span> 
                    <span class="inline-flex items-center px-2 py-0.5 text-xs rounded-md font-semibold ${d.vehicleType === 'vip' ? 'bg-amber-50 text-amber-800 border border-amber-200/60' : 'bg-slate-100 text-slate-700 border border-slate-200/60'}">${d.vehicleType === 'vip' ? '👑 VIP' : '🚕 توفير'}</span>
                </td>
                <td class="py-3.5 px-4"><span class="px-2 py-1 bg-slate-50 text-slate-700 font-mono text-xs rounded border border-slate-200 font-medium select-all" title="كلمة المرور">${escapeHtml(d.password || '••••••••')}</span></td>
                <td class="py-3.5 px-4">
                    <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200/60 shadow-2xs">
                        <i class="fa-solid fa-star text-amber-500 text-[10px]"></i>
                        <span>${d.points || d.rewardScore || 0}</span>
                    </span>
                </td>
                <td class="py-3.5 px-4 text-center">${statusBadge}</td>
                <td class="py-3.5 px-4 text-center">${verifBadge}${approveBadge}</td>
                <td class="py-3.5 px-4">
                    <div class="flex items-center justify-center gap-1.5 flex-wrap">
                        <button onclick="openEditDriverModal('${d.driverId}')" title="تعديل بيانات الكابتن والمسار وكلمة المرور" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200/80 rounded-lg text-xs font-semibold transition flex items-center gap-1 cursor-pointer">
                            <i class="fa-solid fa-pen-to-square text-xs"></i>
                            <span>تعديل</span>
                        </button>
                        <button onclick="viewFullDriver('${d.driverId}')" title="فحص المستمسكات والوثائق" class="px-2.5 py-1.5 bg-[#1B4965] hover:bg-[#143a50] text-white rounded-lg text-xs font-semibold transition flex items-center gap-1 shadow-xs cursor-pointer">
                            <i class="fa-solid fa-id-card text-xs"></i>
                            <span>فحص</span>
                        </button>
                        ${lifecycleButtons}
                        <button onclick="deleteDriverPermanently('${d.driverId}')" title="حذف السائق نهائياً من قاعدة البيانات" class="px-2 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200/60 rounded-lg text-xs font-semibold transition flex items-center gap-1 cursor-pointer">
                            <i class="fa-solid fa-trash-can text-xs"></i>
                            <span>حذف</span>
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-rose-500">فشل في الاتصال بقاعدة البيانات</td></tr>';
    }
}

async function toggleDriverBlock(driverId, block) {
    const driver = (window.driversMap && window.driversMap[driverId]) || {};
    const driverName = driver.fullName || 'الكابتن';
    const actionText = block ? 'حظر' : 'إلغاء حظر';
    if (!confirm(`هل أنت متأكد من ${actionText} الكابتن "${driverName}" ومنعه من دخول التطبيق واستقبال المشاوير؟`)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/drivers/${driverId}/block`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ block })
        });

        if (res.ok) {
            showToast(`تم ${actionText} الكابتن بنجاح`);
            loadDrivers();
            loadDashboardStats();
            if (fleetMap) refreshFleetLocations();
        } else {
            showToast(`فشل في ${actionText} الكابتن`, true);
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

async function deleteDriverPermanently(driverId) {
    const driver = (window.driversMap && window.driversMap[driverId]) || {};
    const driverName = driver.fullName || 'الكابتن';
    if (!confirm(`تحذير نهائي:\nهل أنت متأكد من حذف الكابتن "${driverName}" نهائياً من النظام؟\nسيتم مسح حسابه ووثائقه ومساراته ولا يمكن استرجاعها!`)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/drivers/${driverId}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            showToast(`تم حذف الكابتن "${driverName}" نهائياً من النظام ✅`);
            loadDrivers();
            loadVerifications();
            loadDashboardStats();
            if (fleetMap) refreshFleetLocations();
        } else {
            showToast('فشل حذف السائق من الخادم', true);
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

let driverSearchTimer;
function debounceDriverSearch() {
    clearTimeout(driverSearchTimer);
    driverSearchTimer = setTimeout(() => {
        const query = document.getElementById('drivers-search-input').value;
        loadDrivers(query);
    }, 300);
}

// -----------------------------------------------------------------------------
// 4. Customers Directory
// -----------------------------------------------------------------------------
async function loadCustomers(search = '') {
    const tbody = document.getElementById('customers-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/customers?search=${encodeURIComponent(search)}`);
        const data = await res.json();
        tbody.innerHTML = '';

        if (!data.customers || data.customers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">لا يوجد ركاب مسجلون</td></tr>';
            return;
        }

        window.customersMap = window.customersMap || {};
        data.customers.forEach(c => {
            window.customersMap[c.customerId] = c;
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50/80 transition-colors border-b border-slate-100/80';

            let activeBadge;
            if (c.isBlocked) {
                activeBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-rose-50 text-rose-700 border border-rose-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>محظور ✕</span>';
            } else if (c.isActive) {
                activeBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>نشط ✓</span>';
            } else {
                activeBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-slate-100 text-slate-600 border border-slate-200">معطل</span>';
            }

            const blockBtn = c.isBlocked
                ? `<button onclick="toggleCustomerBlock('${c.customerId}', false)" title="فك حظر الراكب" class="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1 shadow-xs cursor-pointer">
                     <i class="fa-solid fa-unlock text-xs"></i>
                     <span>فك الحظر</span>
                   </button>`
                : `<button onclick="toggleCustomerBlock('${c.customerId}', true)" title="حظر الراكب ومنعه من حجز الرحلات" class="px-2.5 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200/60 rounded-lg text-xs font-semibold transition flex items-center gap-1 cursor-pointer">
                     <i class="fa-solid fa-ban text-xs"></i>
                     <span>حظر</span>
                   </button>`;

            const customerPhoneHtml = c.phoneNumber
                ? `<a href="tel:${escapeHtml(c.phoneNumber)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs transition-colors" dir="ltr" title="اتصال بالراكب"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(c.phoneNumber)}</span></a>`
                : '-';

            tr.innerHTML = `
                <td class="py-3.5 px-4 font-bold text-slate-900 flex items-center gap-1.5">
                    ${escapeHtml(c.fullName)}
                    ${c.isBlocked ? '<span class="px-1.5 py-0.5 text-[10px] bg-rose-50 text-rose-700 border border-rose-200/60 rounded font-bold">محظور</span>' : ''}
                    ${c.telegramChatId ? '<span title="مسجل عبر تيليجرام" class="px-1.5 py-0.5 text-[10px] bg-sky-50 text-sky-700 border border-sky-200/60 rounded font-bold">📱 تيليجرام</span>' : ''}
                </td>
                <td class="py-3.5 px-4 font-mono text-xs">${customerPhoneHtml}</td>
                <td class="py-3.5 px-4"><span class="inline-flex items-center px-2.5 py-0.5 bg-slate-100 text-slate-700 border border-slate-200/60 rounded-md text-xs font-medium">${escapeHtml(c.route || c.area || 'غير محدد')}</span></td>
                <td class="py-3.5 px-4 text-slate-600 text-xs">${escapeHtml(c.address || c.area || '-')}</td>
                <td class="py-3.5 px-4"><span class="px-2 py-1 bg-slate-50 text-slate-700 font-mono text-xs rounded border border-slate-200 font-medium select-all" title="كلمة المرور">${escapeHtml(c.password || '••••••••')}</span></td>
                <td class="py-3.5 px-4 text-center">${activeBadge}</td>
                <td class="py-3.5 px-4">
                    <div class="flex items-center justify-center gap-1.5 flex-wrap">
                        <button onclick="openEditCustomerModal('${c.customerId}')" title="تعديل بيانات الراكب والمسار وكلمة المرور" class="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200/80 rounded-lg text-xs font-semibold transition flex items-center gap-1 cursor-pointer">
                            <i class="fa-solid fa-pen-to-square text-xs"></i>
                            <span>تعديل</span>
                        </button>
                        ${blockBtn}
                        <button onclick="deleteCustomerPermanently('${c.customerId}')" title="حذف الراكب وسجلاته نهائياً" class="px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200/60 rounded-lg text-xs font-semibold transition flex items-center gap-1 cursor-pointer">
                            <i class="fa-solid fa-trash-can text-xs"></i>
                            <span>حذف</span>
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500">فشل في الاتصال</td></tr>';
    }
}

async function toggleCustomerBlock(customerId, block) {
    const customer = (window.customersMap && window.customersMap[customerId]) || {};
    const customerName = customer.fullName || 'الراكب';
    const actionText = block ? 'حظر' : 'إلغاء حظر';
    if (!confirm(`هل أنت متأكد من ${actionText} الراكب "${customerName}" ومنعه من تسجيل الدخول وحجز المشاوير؟`)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/customers/${customerId}/block`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ block })
        });

        if (res.ok) {
            showToast(`تم ${actionText} الراكب بنجاح`);
            loadCustomers();
            loadDashboardStats();
        } else {
            showToast(`فشل في ${actionText} الراكب`, true);
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

async function deleteCustomerPermanently(customerId) {
    const customer = (window.customersMap && window.customersMap[customerId]) || {};
    const customerName = customer.fullName || 'الراكب';
    if (!confirm(`تحذير نهائي:\nهل أنت متأكد من حذف الراكب "${customerName}" نهائياً من النظام؟\nسيتم مسح حسابه وسجل حجوزاته ولا يمكن استرجاعها!`)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/customers/${customerId}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            showToast(`تم حذف الراكب "${customerName}" نهائياً من النظام ✅`);
            loadCustomers();
            loadDashboardStats();
        } else {
            showToast('فشل حذف الراكب من الخادم', true);
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

let customerSearchTimer;
function debounceCustomerSearch() {
    clearTimeout(customerSearchTimer);
    customerSearchTimer = setTimeout(() => {
        const query = document.getElementById('customers-search-input').value;
        loadCustomers(query);
    }, 300);
}

// -----------------------------------------------------------------------------
// 5. Routes & Bookings
// -----------------------------------------------------------------------------
async function loadRoutes() {
    const tbody = document.getElementById('routes-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/routes`);
        const data = await res.json();
        tbody.innerHTML = '';

        const routesList = Array.isArray(data) ? data : (data.routes || []);
        if (routesList.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">لا توجد مسارات مسجلة</td></tr>';
            return;
        }

        routesList.forEach(r => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50/80 transition-colors border-b border-slate-100/80';

            const rawPrice = Number(r.pricePerSeat || r.fare || 3000);
            const isAct = !r.status || r.status === 'Active' || r.status === 'متاح' || r.status === 'نشط';
            const driverPhoneHtml = r.driverPhone
                ? `<a href="tel:${escapeHtml(r.driverPhone)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs mt-0.5 transition-colors" dir="ltr" title="اتصال بالسائق"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(r.driverPhone)}</span></a>`
                : '';

            tr.innerHTML = `
                <td class="py-3.5 px-4 font-bold text-slate-900">${escapeHtml(r.routeName || r.name || 'مسار معتمد')}</td>
                <td class="py-3.5 px-4">
                    <div class="font-bold text-slate-900 text-xs">${escapeHtml(r.driverName || 'كابتن')}</div>
                    ${driverPhoneHtml}
                </td>
                <td class="py-3.5 px-4">
                    <div class="text-xs text-slate-600 flex items-center gap-1.5">
                        <span class="font-semibold text-slate-800">${escapeHtml(r.startName || 'البداية')}</span>
                        <i class="fa-solid fa-arrow-left text-[10px] text-slate-400"></i>
                        <span class="font-semibold text-slate-800">${escapeHtml(r.endName || 'النهاية')}</span>
                    </div>
                </td>
                <td class="py-3.5 px-4 font-mono text-xs text-slate-600">
                    <span class="inline-flex items-center gap-1"><i class="fa-regular fa-clock text-slate-400"></i>${escapeHtml(r.departureTime || '08:00 AM')}</span>
                </td>
                <td class="py-3.5 px-4 text-center">
                    <span class="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">${r.availableSeats || 4} مقاعد</span>
                </td>
                <td class="py-3.5 px-4">
                    <span class="font-bold text-slate-900">${rawPrice.toLocaleString()}</span> <span class="text-xs font-normal text-slate-500 mr-0.5">د.ع</span>
                </td>
                <td class="py-3.5 px-4 text-center">
                    <span class="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-semibold rounded-full ${isAct ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60 shadow-xs' : 'bg-slate-100 text-slate-600 border border-slate-200'}">
                        ${isAct ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>نشط ✓' : escapeHtml(r.status)}
                    </span>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500 font-semibold">فشل في الاتصال بالخادم</td></tr>';
    }
}

async function loadBookings() {
    const tbody = document.getElementById('bookings-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-slate-400 text-xs font-semibold">جاري تحميل سجل الحجوزات...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/bookings`);
        const data = await res.json();
        tbody.innerHTML = '';

        const bookingsList = Array.isArray(data) ? data : (data.bookings || []);
        if (bookingsList.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-slate-400 text-xs">لا توجد حجوزات مسجلة</td></tr>';
            return;
        }

        bookingsList.forEach(b => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50/80 transition-colors border-b border-slate-100/80';

            const status = b.status || 'Pending';
            let statusBadge = '';
            let actionBtn = '';

            const isPendingCancel = status === 'cancellation_pending' || Boolean(b.cancellationPending) || Boolean(b.cancellation_requested) || b.cancellation_status === 'pending';

            if (isPendingCancel) {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>طلب إلغاء معلق ⚠️</span>';
                actionBtn = '<button onclick="switchTab(\'cancellations\')" class="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-bold transition shadow-xs cursor-pointer">مراجعة الإلغاء</button>';
            } else if (status === 'Confirmed' || status === 'Accepted') {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>مؤكد ✓</span>';
                actionBtn = '<span class="inline-flex items-center gap-1 text-xs text-emerald-700 font-semibold bg-emerald-50/60 px-2 py-0.5 rounded-md"><i class="fa-solid fa-check text-[10px]"></i> تمت الموافقة</span>';
            } else if (status === 'Cancelled') {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-slate-100 text-slate-600 border border-slate-200 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span>ملغي</span>';
                actionBtn = '<span class="text-xs text-slate-400 font-medium">ملغي</span>';
            } else if (status === 'Declined' || status === 'Rejected') {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-rose-50 text-rose-700 border border-rose-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>مرفوض ✕</span>';
                actionBtn = '<span class="text-xs text-slate-400 font-medium">مرفوض</span>';
            } else {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200/60 shadow-xs"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>قيد الانتظار ⏳</span>';
                actionBtn = `
                    <div class="flex items-center justify-center gap-1.5">
                        <button onclick="acceptBookingFromAdmin('${b.id || b.bookingId}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition shadow-xs flex items-center gap-1 cursor-pointer">
                            <span>موافقة</span>
                            <i class="fa-solid fa-check text-[10px]"></i>
                        </button>
                        <button onclick="declineBookingFromAdmin('${b.id || b.bookingId}')" class="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold transition shadow-xs flex items-center gap-1 cursor-pointer">
                            <span>رفض</span>
                            <i class="fa-solid fa-xmark text-[10px]"></i>
                        </button>
                    </div>
                `;
            }

            const pickup = b.pickupName || b.pickupLocation || 'نقطة الانطلاق';
            const dropoff = b.dropoffName || b.dropoffLocation || 'جامعة الكوفة';
            const rawFare = Number(b.fareAmount || b.totalFare || b.fare || 0);
            const dateStr = b.bookingDate || (b.createdAt ? new Date(b.createdAt).toLocaleDateString('ar-IQ') : '-');

            const customerPhoneHtml = b.customerPhone
                ? `<a href="tel:${escapeHtml(b.customerPhone)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs mt-0.5 transition-colors" dir="ltr" title="اتصال بالراكب"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(b.customerPhone)}</span></a>`
                : '';

            const driverPhoneHtml = b.driverPhone
                ? `<a href="tel:${escapeHtml(b.driverPhone)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs mt-0.5 transition-colors" dir="ltr" title="اتصال بالسائق"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(b.driverPhone)}</span></a>`
                : '';

            tr.innerHTML = `
                <td class="py-3.5 px-4">
                    <div class="font-bold text-slate-900">${escapeHtml(b.customerName || 'راكب')}</div>
                    ${customerPhoneHtml}
                </td>
                <td class="py-3.5 px-4">
                    <div class="font-bold text-slate-900 text-xs">${escapeHtml(b.driverName || 'كابتن توصيله')}</div>
                    ${driverPhoneHtml}
                </td>
                <td class="py-3.5 px-4">
                    <div class="text-xs text-slate-600 flex items-center gap-1.5">
                        <span class="font-semibold text-slate-800">${escapeHtml(pickup)}</span>
                        <i class="fa-solid fa-arrow-left text-[10px] text-slate-400"></i>
                        <span class="font-semibold text-slate-800">${escapeHtml(dropoff)}</span>
                    </div>
                </td>
                <td class="py-3.5 px-4 font-mono text-xs text-slate-500">${escapeHtml(dateStr)}</td>
                <td class="py-3.5 px-4 text-center">
                    <span class="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700">${b.seatsBooked || 1}</span>
                </td>
                <td class="py-3.5 px-4">
                    <span class="font-bold text-slate-900">${rawFare.toLocaleString()}</span> <span class="text-xs font-normal text-slate-500 mr-0.5">د.ع</span>
                </td>
                <td class="py-3.5 px-4 text-center">${statusBadge}</td>
                <td class="py-3.5 px-4 text-center">${actionBtn}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-rose-500 font-semibold">فشل في الاتصال بالخادم</td></tr>';
    }
}

async function acceptBookingFromAdmin(bookingId) {
    try {
        const res = await fetch(`/api/bookings/${bookingId}/accept`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('تمت موافقة السائق على الحجز وأصبح الزبون ضمن الركاب بنجاح! ✅');
            loadBookings();
            loadDashboardStats();
        } else {
            showToast(data.error || 'فشل قبول الحجز', true);
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

async function declineBookingFromAdmin(bookingId) {
    try {
        const res = await fetch(`/api/bookings/${bookingId}/decline`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('تم رفض طلب الحجز.');
            loadBookings();
            loadDashboardStats();
        } else {
            showToast(data.error || 'فشل رفض الحجز', true);
        }
    } catch (e) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

// -----------------------------------------------------------------------------
// 6. Complaints & Reports Management (Modern SaaS System)
// -----------------------------------------------------------------------------
window._allComplaintsList = [];
window._currentComplaintsFilter = 'all';

async function loadComplaints() {
    const tbody = document.getElementById('complaints-table-body');
    const badge = document.getElementById('complaints-counter-badge');
    const sideBadge = document.getElementById('badge-complaints');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400 font-bold"><i class="fa-solid fa-spinner fa-spin text-red-500 text-lg mb-2 block"></i>جاري تحميل سجل البلاغات والشكاوى...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/complaints?limit=200`);
        const data = await res.json();

        if (!data || !data.complaints) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500 font-bold">تعذر تحميل بيانات البلاغات</td></tr>';
            return;
        }

        window._allComplaintsList = data.complaints;

        // Update badges
        const pendingCount = data.pendingCount !== undefined ? data.pendingCount : window._allComplaintsList.filter(c => c.status === 'pending' || c.status === 'investigating').length;
        if (badge) {
            badge.innerText = `${window._allComplaintsList.length} بلاغ (${pendingCount} معلق)`;
        }
        if (sideBadge) {
            if (pendingCount > 0) {
                sideBadge.innerText = pendingCount;
                sideBadge.classList.remove('hidden');
            } else {
                sideBadge.classList.add('hidden');
            }
        }

        filterComplaintsLocally();
    } catch (err) {
        console.error('Error loading complaints:', err);
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500 font-bold">خطأ في الاتصال بالخادم</td></tr>';
    }
}

function setComplaintsFilter(filter) {
    window._currentComplaintsFilter = filter;

    // Update pill styles
    const pills = document.querySelectorAll('.complaint-filter-pill');
    pills.forEach(p => {
        p.classList.remove('bg-[#1B4965]', 'text-white', 'active');
        p.classList.add('bg-slate-100', 'text-slate-700');
    });

    const activeBtn = document.getElementById(`complaint-pill-${filter === 'low_rating' ? 'low-rating' : filter}`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-slate-100', 'text-slate-700');
        activeBtn.classList.add('bg-[#1B4965]', 'text-white', 'active');
    }

    filterComplaintsLocally();
}

function filterComplaintsLocally() {
    const tbody = document.getElementById('complaints-table-body');
    if (!tbody) return;

    const query = (document.getElementById('complaints-search-input')?.value || '').trim().toLowerCase();
    const filter = window._currentComplaintsFilter || 'all';

    let filtered = window._allComplaintsList || [];

    // Filter by Tab
    if (filter === 'pending') {
        filtered = filtered.filter(c => c.status === 'pending' || c.status === 'investigating' || !c.status);
    } else if (filter === 'resolved') {
        filtered = filtered.filter(c => c.status === 'resolved' || c.status === 'action_taken' || c.status === 'Resolved' || c.status === 'محلولة');
    } else if (filter === 'low_rating') {
        filtered = filtered.filter(c => {
            const cat = String(c.category || c.subject || '');
            const txt = String(c.complaint_text || c.complaintText || c.details || '');
            return cat.includes('تقييم') || txt.includes('تقييم');
        });
    }

    // Filter by Search Query
    if (query) {
        filtered = filtered.filter(c => {
            const id = String(c.id || c.complaintId || '').toLowerCase();
            const cName = String(c.complainant_name || c.complainantName || c.user_name || '').toLowerCase();
            const cPhone = String(c.complainant_phone || c.complainantPhone || '').toLowerCase();
            const aName = String(c.accused_name || c.accusedName || c.target_name || '').toLowerCase();
            const aPhone = String(c.accused_phone || c.accusedPhone || '').toLowerCase();
            const text = String(c.complaint_text || c.complaintText || c.details || c.description || '').toLowerCase();
            const rideId = String(c.ride_id || c.rideId || '').toLowerCase();

            return id.includes(query) || cName.includes(query) || cPhone.includes(query) ||
                   aName.includes(query) || aPhone.includes(query) || text.includes(query) || rideId.includes(query);
        });
    }

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400 font-bold">لا توجد شكاوى مطابقة للبحث أو الفلتر المحدد</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    filtered.forEach(c => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50/80 transition-colors border-b border-slate-100 text-xs text-slate-700';

        const id = c.id || c.complaintId || '';
        const rawCreatedAt = c.created_at || c.createdAt;
        let formattedDate = '--';
        try {
            if (rawCreatedAt) {
                const d = new Date(rawCreatedAt);
                formattedDate = d.toLocaleString('ar-IQ', {
                    timeZone: 'Asia/Baghdad',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true
                });
            }
        } catch (_) { formattedDate = rawCreatedAt; }

        const cName = c.complainant_name || c.complainantName || c.user_name || 'راكب';
        const cPhone = c.complainant_phone || c.complainantPhone || '';
        const aName = c.accused_name || c.accusedName || c.target_name || 'سائق / كابتن';
        const aPhone = c.accused_phone || c.accusedPhone || '';
        const rideId = c.ride_id || c.rideId || '';
        const category = c.category || c.subject || 'عام';
        const text = c.complaint_text || c.complaintText || c.details || c.description || 'لا توجد تفاصيل';
        const status = c.status || 'pending';

        // Status badge
        let statusBadge = '';
        if (status === 'resolved' || status === 'Resolved' || status === 'محلولة') {
            statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>تم الحل ✅</span>';
        } else if (status === 'action_taken') {
            statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200"><span class="w-1.5 h-1.5 rounded-full bg-rose-600"></span>إجراء وعقوبة ⚠️</span>';
        } else if (status === 'investigating') {
            statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200"><span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>جاري التحقيق 🔍</span>';
        } else if (status === 'dismissed') {
            statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200">مرفوضة / كيدية ✕</span>';
        } else {
            statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>قيد المراجعة ⏳</span>';
        }

        // Category badge
        let catBadge = '';
        if (category.includes('تقييم')) {
            catBadge = `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-black bg-red-100 text-red-800 border border-red-200"><i class="fa-solid fa-star text-amber-500"></i> ${escapeHtml(category)}</span>`;
        } else if (category.includes('سلوك') || category.includes('القيادة المتهورة')) {
            catBadge = `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-red-50 text-red-700 border border-red-200"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(category)}</span>`;
        } else if (category.includes('سير') || category.includes('مسار')) {
            catBadge = `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200"><i class="fa-solid fa-route"></i> ${escapeHtml(category)}</span>`;
        } else if (category.includes('أجرة') || category.includes('مبالغ')) {
            catBadge = `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200"><i class="fa-solid fa-money-bill-wave"></i> ${escapeHtml(category)}</span>`;
        } else {
            catBadge = `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-200">${escapeHtml(category)}</span>`;
        }

        tr.innerHTML = `
            <td class="py-3 px-4 font-mono text-[11px] text-slate-600">
                <span class="font-bold text-slate-900 block font-sans">${escapeHtml(id)}</span>
                <span class="text-slate-400 block">${formattedDate}</span>
            </td>
            <td class="py-3 px-4">
                <span class="font-bold text-slate-900 block">${escapeHtml(cName)}</span>
                ${cPhone ? `<a href="tel:${escapeHtml(cPhone)}" class="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-emerald-600 hover:underline mt-0.5" dir="ltr"><i class="fa-solid fa-phone text-[9px]"></i>${escapeHtml(cPhone)}</a>` : '<span class="text-[10px] text-slate-400">بدون هاتف</span>'}
            </td>
            <td class="py-3 px-4">
                <span class="font-bold text-slate-900 block">${escapeHtml(aName)}</span>
                <div class="flex items-center gap-2 mt-0.5">
                    ${aPhone ? `<a href="tel:${escapeHtml(aPhone)}" class="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-blue-600 hover:underline" dir="ltr"><i class="fa-solid fa-phone text-[9px]"></i>${escapeHtml(aPhone)}</a>` : ''}
                    ${rideId ? `<span class="font-mono text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded" title="رقم المشوار">#${escapeHtml(rideId.slice(0, 8))}</span>` : ''}
                </div>
            </td>
            <td class="py-3 px-4">${catBadge}</td>
            <td class="py-3 px-4 max-w-xs">
                <p class="text-xs text-slate-700 line-clamp-2 leading-relaxed" title="${escapeHtml(text)}">${escapeHtml(text)}</p>
                ${c.admin_notes || c.adminNotes ? `<span class="inline-block mt-1 text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100">📝 تم الرد: ${escapeHtml(c.admin_notes || c.adminNotes)}</span>` : ''}
            </td>
            <td class="py-3 px-4 text-center">${statusBadge}</td>
            <td class="py-3 px-4 text-center">
                <button onclick="openResolveComplaintModal('${escapeHtml(id)}')" class="px-3 py-1.5 bg-[#1B4965] hover:bg-[#14364A] text-white rounded-xl text-xs font-bold transition cursor-pointer shadow-xs inline-flex items-center gap-1">
                    <i class="fa-solid fa-gear text-amber-400"></i>
                    <span>معالجة</span>
                </button>
            </td>
        `;

        tbody.appendChild(tr);
    });
}

function openResolveComplaintModal(complaintId) {
    const complaint = (window._allComplaintsList || []).find(c => (c.id === complaintId || c.complaintId === complaintId));
    if (!complaint) {
        showToast('تعذر العثور على بيانات الشكوى', true);
        return;
    }

    const modal = document.getElementById('modal-resolve-complaint');
    if (!modal) return;

    document.getElementById('resolve-complaint-id').value = complaint.id || complaint.complaintId || '';
    document.getElementById('resolve-modal-subtitle').innerText = `بلاغ #${complaint.id || complaint.complaintId || ''}`;
    document.getElementById('resolve-modal-category').innerText = complaint.category || complaint.subject || 'عام';
    document.getElementById('resolve-modal-ride-id').innerText = complaint.ride_id || complaint.rideId || 'بدون مشوار محدد';

    const cName = complaint.complainant_name || complaint.complainantName || complaint.user_name || 'الراكب';
    const cPhone = complaint.complainant_phone || complaint.complainantPhone || 'لا يوجد';
    document.getElementById('resolve-modal-complainant').innerText = cName;
    document.getElementById('resolve-modal-complainant-phone').innerText = cPhone;
    const cCall = document.getElementById('resolve-modal-complainant-call');
    if (cCall) cCall.href = cPhone && cPhone !== 'لا يوجد' ? `tel:${cPhone}` : '#';

    const aName = complaint.accused_name || complaint.accusedName || complaint.target_name || 'الكابتن';
    const aPhone = complaint.accused_phone || complaint.accusedPhone || 'لا يوجد';
    document.getElementById('resolve-modal-accused').innerText = aName;
    document.getElementById('resolve-modal-accused-phone').innerText = aPhone;
    const aCall = document.getElementById('resolve-modal-accused-call');
    if (aCall) aCall.href = aPhone && aPhone !== 'لا يوجد' ? `tel:${aPhone}` : '#';

    document.getElementById('resolve-modal-text').innerText = complaint.complaint_text || complaint.complaintText || complaint.details || complaint.description || 'لا توجد تفاصيل';

    const statusSelect = document.getElementById('resolve-complaint-status');
    if (statusSelect) {
        statusSelect.value = complaint.status || 'pending';
    }

    const notesInput = document.getElementById('resolve-complaint-notes');
    if (notesInput) {
        notesInput.value = complaint.admin_notes || complaint.adminNotes || '';
    }

    // Reset disciplinary inputs
    const penaltyInput = document.getElementById('resolve-penalty-points');
    if (penaltyInput) penaltyInput.value = '0';

    const radioNone = document.querySelector('input[name="disciplinary_action"][value="none"]');
    if (radioNone) radioNone.checked = true;

    modal.style.display = 'flex';
}

function closeResolveComplaintModal() {
    const modal = document.getElementById('modal-resolve-complaint');
    if (modal) modal.style.display = 'none';
}

async function submitResolveComplaint(event) {
    if (event) event.preventDefault();

    const id = document.getElementById('resolve-complaint-id')?.value;
    const status = document.getElementById('resolve-complaint-status')?.value;
    const adminNotes = document.getElementById('resolve-complaint-notes')?.value;
    const penaltyPoints = parseInt(document.getElementById('resolve-penalty-points')?.value || '0', 10);
    const actionRadio = document.querySelector('input[name="disciplinary_action"]:checked')?.value || 'none';

    if (!id) {
        showToast('معرف الشكوى غير صحيح', true);
        return;
    }

    const btn = document.getElementById('btn-save-complaint-resolve');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>جاري الحفظ...</span>';
    }

    try {
        const payload = {
            id,
            status,
            adminNotes,
            actionTaken: actionRadio !== 'none' ? actionRadio : undefined,
            penaltyPoints: penaltyPoints > 0 ? penaltyPoints : undefined,
            actor: 'المشرف العام (Admin)'
        };

        const res = await fetch(`${API_BASE}/complaints/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
            showToast('تم حفظ إجراء ومعالجة الشكوى بنجاح ✅');
            closeResolveComplaintModal();
            loadComplaints();
            loadDashboardStats();
        } else {
            showToast(data.error || 'فشل في حفظ معالجة الشكوى', true);
        }
    } catch (err) {
        console.error('Error submitting complaint resolution:', err);
        showToast('خطأ في الاتصال بالخادم', true);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-check"></i><span>حفظ الإجراء والمعالجة</span>';
        }
    }
}

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// 7. System Settings & Dynamic Surge Pricing Engine (Baly-like Taxi Engine)
// -----------------------------------------------------------------------------
let currentPricingConfig = {
    baseFare: 2000,
    kmRate: 450,
    minuteRate: 100,
    minFare: 2500,
    enableDynamicSurge: true,
    maxSurgeMultiplier: 2.0,
    nightSurgePercent: 25,
    demandSensitivity: 1.0,
    manualOverrideMultiplier: 1.0,
    manualOverrideLabel: 'وضع طبيعي (1.0x)',
    discountPercent: 0,
    discountFixed: 0
};

async function loadPricingSettings() {
    try {
        const res = await fetch(`${API_BASE}/pricing`);
        let data = null;
        if (res.ok) {
            data = await res.json();
            if (data.settings) currentPricingConfig = { ...currentPricingConfig, ...data.settings };
        } else {
            // fallback to general settings
            const sRes = await fetch(`${API_BASE}/settings`);
            if (sRes.ok) {
                const sList = await sRes.json();
                const p = (Array.isArray(sList) ? sList : []).find(s => s.key === 'PricingParameters' || s.key === 'pricing_settings');
                if (p && p.valueJson) {
                    const parsed = typeof p.valueJson === 'string' ? JSON.parse(p.valueJson) : p.valueJson;
                    currentPricingConfig = { ...currentPricingConfig, ...parsed };
                }
            }
        }

        // Populate Form Fields
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
        };

        setVal('setting-base-fare', currentPricingConfig.baseFare || 2000);
        setVal('setting-per-km', currentPricingConfig.kmRate || 450);
        setVal('setting-per-minute', currentPricingConfig.minuteRate || 100);
        setVal('setting-min-fare', currentPricingConfig.minFare || 2500);
        setVal('setting-surge-max', currentPricingConfig.maxSurgeMultiplier || 2.0);
        setVal('setting-night-surge', currentPricingConfig.nightSurgePercent || 25);
        setVal('setting-demand-sensitivity', String(currentPricingConfig.demandSensitivity || 1.0));
        setVal('setting-manual-multiplier', currentPricingConfig.manualOverrideMultiplier || 1.0);
        setVal('setting-manual-label', currentPricingConfig.manualOverrideLabel || 'وضع طبيعي (1.0x)');

        const surgeToggle = document.getElementById('setting-enable-surge');
        if (surgeToggle) {
            surgeToggle.checked = currentPricingConfig.enableDynamicSurge !== false;
        }

        // Update live status pill & manual override badge
        updatePricingUIBadges();

        // Run live fare simulator with loaded settings
        runLiveFareSimulator();
    } catch (err) {
        console.warn('[Pricing] Could not fetch pricing settings:', err);
    }
}

function updatePricingUIBadges() {
    const isSurgeEnabled = document.getElementById('setting-enable-surge')?.checked !== false;
    const livePill = document.getElementById('pricing-live-status-pill');
    if (livePill) {
        if (isSurgeEnabled) {
            livePill.className = 'px-2.5 py-0.5 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-full border border-emerald-200';
            livePill.innerHTML = '⚡ الذروة الذكية: مفعّلة';
        } else {
            livePill.className = 'px-2.5 py-0.5 bg-slate-100 text-slate-600 font-bold text-xs rounded-full border border-slate-200';
            livePill.innerHTML = '⏸️ الذروة الذكية: معطلة';
        }
    }

    const stateText = document.getElementById('surge-engine-state-text');
    if (stateText) {
        if (isSurgeEnabled) {
            stateText.className = 'text-emerald-600 font-bold';
            stateText.textContent = 'نشط وجاهز للرحلات الفورية';
        } else {
            stateText.className = 'text-slate-400 font-bold';
            stateText.textContent = 'متوقف (تسعير ثابت فقط)';
        }
    }

    const manualMult = Number(document.getElementById('setting-manual-multiplier')?.value) || 1.0;
    const manualLabel = document.getElementById('setting-manual-label')?.value || 'وضع طبيعي (1.0x)';
    const manualBadge = document.getElementById('manual-override-current-badge');
    if (manualBadge) {
        manualBadge.textContent = manualLabel;
        if (manualMult > 1.05) {
            manualBadge.className = 'px-2.5 py-0.5 bg-amber-100 text-amber-800 font-bold text-xs rounded-full border border-amber-300';
        } else if (manualMult < 0.95) {
            manualBadge.className = 'px-2.5 py-0.5 bg-emerald-100 text-emerald-800 font-bold text-xs rounded-full border border-emerald-300';
        } else {
            manualBadge.className = 'px-2.5 py-0.5 bg-slate-100 text-slate-700 font-bold text-xs rounded-full border border-slate-200';
        }
    }
}

async function savePricingSettings() {
    const payload = {
        baseFare: Number(document.getElementById('setting-base-fare')?.value) || 2000,
        kmRate: Number(document.getElementById('setting-per-km')?.value) || 450,
        minuteRate: Number(document.getElementById('setting-per-minute')?.value) || 100,
        minFare: Number(document.getElementById('setting-min-fare')?.value) || 2500,
        enableDynamicSurge: Boolean(document.getElementById('setting-enable-surge')?.checked),
        maxSurgeMultiplier: Number(document.getElementById('setting-surge-max')?.value) || 2.0,
        nightSurgePercent: Number(document.getElementById('setting-night-surge')?.value) || 25,
        demandSensitivity: Number(document.getElementById('setting-demand-sensitivity')?.value) || 1.0,
        manualOverrideMultiplier: Number(document.getElementById('setting-manual-multiplier')?.value) || 1.0,
        manualOverrideLabel: document.getElementById('setting-manual-label')?.value || 'وضع طبيعي (1.0x)'
    };

    try {
        const res = await fetch(`${API_BASE}/pricing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            currentPricingConfig = { ...currentPricingConfig, ...payload };
            updatePricingUIBadges();
            runLiveFareSimulator();
            showToast('تم حفظ وتحديث إعدادات التسعير والذروة بنجاح! ⚡💰');
        } else {
            showToast('تعذر حفظ إعدادات التسعير على الخادم', true);
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

async function applyQuickEmergencyOverride(multiplier, label) {
    const mInput = document.getElementById('setting-manual-multiplier');
    const lInput = document.getElementById('setting-manual-label');
    if (mInput) mInput.value = multiplier;
    if (lInput) lInput.value = label;

    try {
        const res = await fetch(`${API_BASE}/pricing/emergency-override`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ multiplier, label })
        });
        if (res.ok) {
            currentPricingConfig.manualOverrideMultiplier = multiplier;
            currentPricingConfig.manualOverrideLabel = label;
            updatePricingUIBadges();
            runLiveFareSimulator();
            showToast(`تم تفعيل: ${label} ⚡`);
        } else {
            showToast('تعذر تطبيق التدخل اليدوي', true);
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

function runLiveFareSimulator() {
    const baseFare = Number(document.getElementById('setting-base-fare')?.value) || 2000;
    const kmRate = Number(document.getElementById('setting-per-km')?.value) || 450;
    const minuteRate = Number(document.getElementById('setting-per-minute')?.value) || 100;
    const minFare = Number(document.getElementById('setting-min-fare')?.value) || 2500;
    const isSurgeEnabled = document.getElementById('setting-enable-surge')?.checked !== false;
    const maxSurge = Number(document.getElementById('setting-surge-max')?.value) || 2.0;
    const nightSurgePercent = Number(document.getElementById('setting-night-surge')?.value) || 25;
    const manualMultiplier = Number(document.getElementById('setting-manual-multiplier')?.value) || 1.0;

    // Simulator inputs
    const distKm = Math.max(0.5, Number(document.getElementById('sim-distance')?.value) || 4.5);
    const durMins = Math.max(2, Number(document.getElementById('sim-duration')?.value) || 12);
    const tier = document.getElementById('sim-tier')?.value || 'super';
    const demandMultiplier = Number(document.getElementById('sim-demand')?.value) || 1.0;
    const isNight = Boolean(document.getElementById('sim-is-night')?.checked);

    // Tier factor
    let tierFactor = 1.0;
    if (tier === 'eco') tierFactor = 0.90;
    if (tier === 'vip') tierFactor = 1.20;

    // Base math
    const base = baseFare * tierFactor;
    const distCost = distKm * kmRate * tierFactor;
    const timeCost = durMins * minuteRate * tierFactor;
    const rawStandard = base + distCost + timeCost;

    // Surge calculation
    let nightFactor = 1.0;
    if (isSurgeEnabled && isNight && nightSurgePercent > 0) {
        nightFactor = 1.0 + (nightSurgePercent / 100);
    }

    let trafficFactor = 1.0;
    const avgSpeed = distKm / (durMins / 60);
    if (isSurgeEnabled && avgSpeed < 18 && durMins > 10) {
        trafficFactor = avgSpeed < 10 ? 1.20 : 1.10;
    }

    let combined = 1.0;
    if (isSurgeEnabled) {
        combined = manualMultiplier * (1.0 + (demandMultiplier - 1.0) + (nightFactor - 1.0) + (trafficFactor - 1.0));
    } else {
        combined = manualMultiplier;
    }

    const capped = Math.min(maxSurge, Math.max(0.7, combined));
    let preFare = rawStandard * capped;

    // Min fare floor
    preFare = Math.max(minFare, preFare);

    // Round to nearest 250 IQD
    const finalFare = Math.round(preFare / 250) * 250;

    // Update Simulator Output
    const fareEl = document.getElementById('sim-result-fare');
    if (fareEl) fareEl.textContent = finalFare.toLocaleString();

    const baseEl = document.getElementById('sim-out-base');
    if (baseEl) baseEl.textContent = `${Math.round(base).toLocaleString()} د.ع`;

    const distEl = document.getElementById('sim-out-dist');
    if (distEl) distEl.textContent = `${Math.round(distCost).toLocaleString()} د.ع`;

    const timeEl = document.getElementById('sim-out-time');
    if (timeEl) timeEl.textContent = `${Math.round(timeCost).toLocaleString()} د.ع`;

    const multEl = document.getElementById('sim-out-multiplier');
    if (multEl) multEl.textContent = `${capped.toFixed(2)}x`;

    const badgeContainer = document.getElementById('sim-result-badge-container');
    if (badgeContainer) {
        let badgeHtml = '';
        if (capped > 1.05) {
            const p = Math.round((capped - 1.0) * 100);
            if (manualMultiplier > 1.05) {
                badgeHtml = `<span class="px-2.5 py-1 bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold text-xs rounded-lg inline-flex items-center gap-1.5">⚡ ذروة استثنائية (+${p}%)</span>`;
            } else if (demandMultiplier > 1.05) {
                badgeHtml = `<span class="px-2.5 py-1 bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold text-xs rounded-lg inline-flex items-center gap-1.5">⚡ زيادة لقلة السائقين (+${p}%)</span>`;
            } else if (isNight) {
                badgeHtml = `<span class="px-2.5 py-1 bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 font-bold text-xs rounded-lg inline-flex items-center gap-1.5">🌙 تعرفة ليلية (+${p}%)</span>`;
            } else {
                badgeHtml = `<span class="px-2.5 py-1 bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold text-xs rounded-lg inline-flex items-center gap-1.5">⚡ تعرفة ذروة (+${p}%)</span>`;
            }
        } else if (capped < 0.95) {
            badgeHtml = `<span class="px-2.5 py-1 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold text-xs rounded-lg inline-flex items-center gap-1.5">🏷️ خصم مفعّل (-10%)</span>`;
        } else {
            badgeHtml = `<span class="px-2.5 py-1 bg-slate-800 text-slate-300 border border-slate-700 font-bold text-xs rounded-lg inline-flex items-center gap-1.5">⚡ تعرفة قياسية (1.0x)</span>`;
        }
        badgeContainer.innerHTML = badgeHtml;
    }
}

async function loadMatchingSettings() {
    try {
        // Load Pricing Parameters first
        await loadPricingSettings();

        // Load Spatial Matching Parameters
        const res = await fetch(`${API_BASE}/settings`);
        if (!res.ok) return;
        let settings = await res.json();
        if (!Array.isArray(settings)) settings = [];

        const matchConfig = settings.find(s => s.key === 'matching_settings' || s.key === 'SpatialMatching') || {};
        let matchVals = {
            MaxDetourMeters: 2000,
            MinOverlapPercentage: 60,
            SearchRadiusMeters: 5000,
            TimeWindowMinutes: 30
        };
        try {
            if (matchConfig.valueJson) {
                const parsed = typeof matchConfig.valueJson === 'string' ? JSON.parse(matchConfig.valueJson) : matchConfig.valueJson;
                matchVals = {
                    MaxDetourMeters: parsed.max_detour_meters ?? parsed.MaxDetourMeters ?? 2000,
                    MinOverlapPercentage: parsed.min_overlap_percentage ?? parsed.MinOverlapPercentage ?? 60,
                    SearchRadiusMeters: parsed.search_radius_meters ?? parsed.SearchRadiusMeters ?? 5000,
                    TimeWindowMinutes: parsed.time_window_minutes ?? parsed.TimeWindowMinutes ?? 30
                };
            }
        } catch(_) {}

        if (document.getElementById('setting-max-detour')) document.getElementById('setting-max-detour').value = matchVals.MaxDetourMeters ?? 2000;
        if (document.getElementById('setting-min-overlap')) document.getElementById('setting-min-overlap').value = matchVals.MinOverlapPercentage ?? 60;
        if (document.getElementById('setting-search-radius')) document.getElementById('setting-search-radius').value = matchVals.SearchRadiusMeters ?? 5000;
        if (document.getElementById('setting-time-window')) document.getElementById('setting-time-window').value = matchVals.TimeWindowMinutes ?? 30;

    } catch (err) {
        console.warn('Could not fetch settings', err);
    }
}

async function saveMatchingSettings() {
    const payload = {
        valueJson: JSON.stringify({
            MaxDetourMeters: Number(document.getElementById('setting-max-detour')?.value) || 2000,
            MinOverlapPercentage: Number(document.getElementById('setting-min-overlap')?.value) || 60,
            SearchRadiusMeters: Number(document.getElementById('setting-search-radius')?.value) || 5000,
            TimeWindowMinutes: Number(document.getElementById('setting-time-window')?.value) || 30
        })
    };

    try {
        const res = await fetch(`${API_BASE}/settings/SpatialMatching`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            showToast('تم حفظ معايير محرك المطابقة الجغرافي بنجاح! 📍');
        } else {
            showToast('تعذر حفظ معايير المطابقة', true);
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

// -----------------------------------------------------------------------------
// 8. Audit Logs (Enterprise Security Monitoring)
// -----------------------------------------------------------------------------
let currentAuditCategory = 'all';
let currentAuditSearch = '';
let auditSearchDebounceTimer = null;
let currentAuditLogsCache = [];

function setAuditCategoryFilter(category, btn) {
    currentAuditCategory = category;
    const container = document.getElementById('audit-category-filters');
    if (container) {
        const pills = container.querySelectorAll('.audit-filter-pill');
        pills.forEach(p => {
            p.className = 'audit-filter-pill px-3 py-1.5 rounded-xl text-xs font-bold transition bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer';
        });
    }
    if (btn) {
        btn.className = 'audit-filter-pill px-3 py-1.5 rounded-xl text-xs font-bold transition bg-amber-500 text-slate-950 shadow-xs cursor-pointer';
    }
    loadAuditLogs();
}

function debounceAuditSearch(val) {
    if (auditSearchDebounceTimer) clearTimeout(auditSearchDebounceTimer);
    auditSearchDebounceTimer = setTimeout(() => {
        currentAuditSearch = (val || '').trim();
        loadAuditLogs();
    }, 250);
}

function getAuditActionBadge(action) {
    const act = (action || '').trim();

    // 1. Red / Rose: Deletions, Bans, Database Restores, Failed Attempts
    if (/restored/i.test(act) || /delete/i.test(act) || /ban|block/i.test(act) || /failed|rejected/i.test(act) || /decline/i.test(act)) {
        let label = act;
        let icon = 'fa-solid fa-triangle-exclamation';
        if (act === 'SystemDatabaseRestored') { label = 'استعادة قاعدة البيانات ⚠️'; icon = 'fa-solid fa-rotate-left'; }
        else if (act === 'DriverBanned' || act === 'DriverBlocked') { label = 'حظر كابتن'; icon = 'fa-solid fa-ban'; }
        else if (act === 'DriverRejected') { label = 'رفض كابتن'; icon = 'fa-solid fa-user-xmark'; }
        else if (act === 'DriverDocumentRejected') { label = 'رفض وثيقة رسمية'; icon = 'fa-solid fa-file-circle-xmark'; }
        else if (act === 'DriverDeletedPermanently') { label = 'حذف كابتن نهائياً'; icon = 'fa-solid fa-trash-can'; }
        else if (act === 'CustomerBanned' || act === 'CustomerBlocked') { label = 'حظر راكب'; icon = 'fa-solid fa-user-slash'; }
        else if (act === 'CustomerDeletedPermanently') { label = 'حذف راكب نهائياً'; icon = 'fa-solid fa-trash-can'; }
        else if (act === 'AdminLoginFailed') { label = 'محاولة دخول فاشلة ⚠️'; icon = 'fa-solid fa-shield-halved'; }
        else if (act === 'RouteCancellationRejected') { label = 'رفض إلغاء الخط'; icon = 'fa-solid fa-circle-xmark'; }
        else if (act === 'RouteCancellationDeclinedByDriver' || act === 'BookingDeclined') { label = 'اعتذار عن الطلب'; icon = 'fa-solid fa-thumbs-down'; }

        return `
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200 shadow-2xs">
                <i class="${icon} text-[11px]"></i>
                <span>${escapeHtml(label)}</span>
            </span>
            <span class="block font-mono text-[10px] text-slate-400 mt-0.5" dir="ltr">${escapeHtml(act)}</span>
        `;
    }

    // 2. Amber: Pricing, Settings, Changes, Suspensions, Pending Requests
    if (/price|pricing|setting|status|suspend|request/i.test(act)) {
        let label = act;
        let icon = 'fa-solid fa-sliders';
        if (act === 'PricingParametersUpdated') { label = 'تعديل أسعار المشاوير'; icon = 'fa-solid fa-money-bill-wave'; }
        else if (act === 'SystemSettingUpdated') { label = 'تعديل إعدادات النظام'; icon = 'fa-solid fa-gear'; }
        else if (act === 'DriverStatusChanged') { label = 'تغيير حالة الكابتن'; icon = 'fa-solid fa-user-pen'; }
        else if (act === 'DriverSuspended') { label = 'تعليق حساب كابتن'; icon = 'fa-solid fa-pause'; }
        else if (act === 'RouteCancellationRequested') { label = 'طلب إلغاء اشتراك'; icon = 'fa-solid fa-file-circle-exclamation'; }

        return `
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200 shadow-2xs">
                <i class="${icon} text-[11px] text-amber-600"></i>
                <span>${escapeHtml(label)}</span>
            </span>
            <span class="block font-mono text-[10px] text-slate-400 mt-0.5" dir="ltr">${escapeHtml(act)}</span>
        `;
    }

    // 3. Emerald: Approvals, Verifications, Successful Logins, Positive Confirmations
    if (/approved|verified|success|accepted/i.test(act)) {
        let label = act;
        let icon = 'fa-solid fa-check';
        if (act === 'DriverApproved') { label = 'اعتماد وتفعيل كابتن'; icon = 'fa-solid fa-circle-check'; }
        else if (act === 'DriverVerified') { label = 'توثيق وثائق الكابتن'; icon = 'fa-solid fa-id-card'; }
        else if (act === 'DriverDocumentApproved') { label = 'قبول وثيقة رسمية'; icon = 'fa-solid fa-file-circle-check'; }
        else if (act === 'AdminLoginSuccess') { label = 'دخول ناجح للمشرف'; icon = 'fa-solid fa-key'; }
        else if (act === 'RouteCancellationApproved' || act === 'PassengerCancellationApproved') { label = 'الموافقة على إلغاء الخط'; icon = 'fa-solid fa-circle-check'; }
        else if (act === 'RouteCancellationAcceptedByDriver' || act === 'BookingAccepted') { label = 'قبول طلب الحجز'; icon = 'fa-solid fa-thumbs-up'; }

        return `
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-2xs">
                <i class="${icon} text-[11px] text-emerald-600"></i>
                <span>${escapeHtml(label)}</span>
            </span>
            <span class="block font-mono text-[10px] text-slate-400 mt-0.5" dir="ltr">${escapeHtml(act)}</span>
        `;
    }

    // 4. Indigo / Slate / Default: Registrations, Bookings, Exports, Logouts
    let label = act;
    let icon = 'fa-solid fa-receipt';
    if (act === 'SystemBackupExported') { label = 'تصدير نسخة احتياطية'; icon = 'fa-solid fa-cloud-arrow-down'; }
    else if (act === 'AdminCreatedDriver' || act === 'DriverRegisteredByAdmin') { label = 'تسجيل كابتن من الإدارة'; icon = 'fa-solid fa-user-plus'; }
    else if (act === 'DriverRegistered') { label = 'تسجيل كابتن جديد'; icon = 'fa-solid fa-car-side'; }
    else if (act === 'PassengerRegistered' || act === 'CustomerCreatedByAdmin') { label = 'تسجيل راكب جديد'; icon = 'fa-solid fa-user-check'; }
    else if (act === 'SeatBooked') { label = 'حجز مقعد في خط'; icon = 'fa-solid fa-ticket'; }
    else if (act === 'AdminLogout') { label = 'تسجيل خروج المشرف'; icon = 'fa-solid fa-right-from-bracket'; }

    return `
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200 shadow-2xs">
            <i class="${icon} text-[11px] text-slate-500"></i>
            <span>${escapeHtml(label)}</span>
        </span>
        <span class="block font-mono text-[10px] text-slate-400 mt-0.5" dir="ltr">${escapeHtml(act)}</span>
    `;
}

function copyTextToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => showToast(`تم النسخ: ${text}`))
            .catch(() => showToast(`تعذر النسخ`, true));
    } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast(`تم النسخ: ${text}`);
    }
}

async function loadAuditLogs() {
    const tbody = document.getElementById('audit-table-body');
    const refreshIcon = document.getElementById('audit-refresh-icon');
    const totalBadge = document.getElementById('audit-total-badge');

    if (refreshIcon) refreshIcon.classList.add('fa-spin');
    if (tbody) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="p-8 text-center text-slate-400">
                    <div class="flex items-center justify-center gap-2">
                        <i class="fa-solid fa-spinner fa-spin text-amber-500"></i>
                        <span>جاري قراءة سجلات التدقيق الأمني من PostgreSQL...</span>
                    </div>
                </td>
            </tr>
        `;
    }

    try {
        const queryParams = new URLSearchParams({
            action: currentAuditCategory || 'all',
            search: currentAuditSearch || '',
            limit: '200'
        });

        const res = await fetch(`${API_BASE}/audit-logs?${queryParams.toString()}`);
        if (!res.ok) throw new Error('تعذر جلب سجلات التدقيق');
        const data = await res.json();

        const logs = Array.isArray(data) ? data : (data.logs || []);
        currentAuditLogsCache = logs;

        if (totalBadge) {
            const count = data.total != null ? data.total : logs.length;
            totalBadge.textContent = `${Number(count).toLocaleString('en-US')} سجل`;
        }

        if (!tbody) return;
        tbody.innerHTML = '';

        if (logs.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="p-8 text-center text-slate-400">
                        <i class="fa-solid fa-clipboard-check text-3xl mb-2 text-slate-300 block"></i>
                        لا توجد سجلات تدقيق مطابقة لمعايير البحث الحالية
                    </td>
                </tr>
            `;
            return;
        }

        logs.forEach((l, idx) => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50/80 transition-colors border-b border-slate-100/80 text-xs md:text-sm';

            // 1. Iraqi Local Time Formatting (Day, Date, Exact Time with Seconds)
            const rawTime = l.createdAt || l.created_at || l.timestamp;
            let dateStr = '--';
            let timeStr = '--';
            if (rawTime) {
                const dateObj = new Date(rawTime);
                try {
                    dateStr = dateObj.toLocaleDateString('ar-IQ', {
                        weekday: 'short',
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        timeZone: 'Asia/Baghdad'
                    });
                    timeStr = dateObj.toLocaleTimeString('ar-IQ', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: true,
                        timeZone: 'Asia/Baghdad'
                    });
                } catch (_) {
                    dateStr = dateObj.toLocaleDateString();
                    timeStr = dateObj.toLocaleTimeString();
                }
            }

            // 2. Parse Payload & Actor
            let payload = {};
            let payloadSummary = '-';
            const rawPayload = l.newValuesJson || l.new_values_json;
            if (rawPayload) {
                try {
                    payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
                    const keys = Object.keys(payload).filter(k => k !== 'actor' && k !== 'userAgent' && k !== 'timestamp');
                    if (keys.length > 0) {
                        payloadSummary = keys.slice(0, 3).map(k => {
                            const val = typeof payload[k] === 'object' ? JSON.stringify(payload[k]) : String(payload[k]);
                            return `${k}: ${val}`;
                        }).join(' | ');
                    } else if (payload.filename) {
                        payloadSummary = `الملف: ${payload.filename}`;
                    } else {
                        payloadSummary = JSON.stringify(payload);
                    }
                } catch (_) {
                    payloadSummary = String(rawPayload);
                }
            }

            // Actor
            let actorName = payload.actor;
            if (!actorName) {
                const ent = l.entityName || l.entity_name;
                if (ent === 'Admin' || (l.action && l.action.startsWith('Admin'))) actorName = 'المشرف العام (Admin)';
                else if (ent === 'Driver') actorName = 'كابتن';
                else if (ent === 'Customer') actorName = 'راكب';
                else actorName = 'النظام الآلي (System)';
            }

            // 3. Action badge
            const actionBadge = getAuditActionBadge(l.action);

            // 4. Entity & ID
            const entityName = l.entityName || l.entity_name || 'System';
            const entityId = l.entityId || l.entity_id || '-';

            // 5. IP Address
            const ip = l.ipAddress || l.ip_address || '127.0.0.1';

            tr.innerHTML = `
                <td class="py-3 px-4 whitespace-nowrap">
                    <div class="font-bold text-slate-800 text-xs">${escapeHtml(dateStr)}</div>
                    <div class="font-mono text-[11px] text-slate-500 flex items-center gap-1 mt-0.5" dir="ltr">
                        <i class="fa-regular fa-clock text-amber-500 text-[10px]"></i>
                        <span>${escapeHtml(timeStr)}</span>
                    </div>
                </td>
                <td class="py-3 px-4 whitespace-nowrap">
                    <div class="flex items-center gap-1.5 font-bold text-slate-800 text-xs">
                        <div class="w-6 h-6 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 text-xs">
                            <i class="fa-solid fa-user-shield"></i>
                        </div>
                        <span>${escapeHtml(actorName)}</span>
                    </div>
                </td>
                <td class="py-3 px-4">
                    ${actionBadge}
                </td>
                <td class="py-3 px-4">
                    <div class="font-bold text-slate-800 text-xs">${escapeHtml(entityName)}</div>
                    <div class="font-mono text-[11px] text-slate-500 max-w-[140px] truncate" dir="ltr" title="${escapeHtml(entityId)}">
                        ${escapeHtml(entityId)}
                    </div>
                </td>
                <td class="py-3 px-4">
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-slate-600 truncate max-w-[180px] lg:max-w-[260px] block" title="${escapeHtml(payloadSummary)}">
                            ${escapeHtml(payloadSummary)}
                        </span>
                        <button type="button" onclick="openAuditPayloadModal(${idx})" class="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-[11px] flex items-center gap-1 transition cursor-pointer whitespace-nowrap shrink-0">
                            <i class="fa-solid fa-code text-amber-500"></i>
                            <span>التفاصيل</span>
                        </button>
                    </div>
                </td>
                <td class="py-3 px-4 whitespace-nowrap">
                    <div class="inline-flex items-center gap-1.5 bg-slate-100/80 px-2 py-1 rounded-lg border border-slate-200/80">
                        <span class="font-mono text-xs text-slate-700" dir="ltr">${escapeHtml(ip)}</span>
                        <button type="button" onclick="copyTextToClipboard('${escapeHtml(ip)}')" title="نسخ عنوان IP" class="text-slate-400 hover:text-slate-800 transition cursor-pointer">
                            <i class="fa-regular fa-copy text-xs"></i>
                        </button>
                    </div>
                </td>
            `;

            tbody.appendChild(tr);
        });

    } catch (err) {
        console.warn('loadAuditLogs error:', err);
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="p-8 text-center text-rose-500">
                        <i class="fa-solid fa-circle-exclamation text-2xl mb-1 block"></i>
                        فشل في الاتصال بجلب سجلات التدقيق: ${escapeHtml(err.message)}
                    </td>
                </tr>
            `;
        }
    } finally {
        if (refreshIcon) refreshIcon.classList.remove('fa-spin');
    }
}

// -----------------------------------------------------------------------------
// Audit Log Payload Details Modal
// -----------------------------------------------------------------------------
let activeAuditLogModalPayload = null;

function openAuditPayloadModal(idx) {
    const log = currentAuditLogsCache[idx];
    if (!log) return;

    const modal = document.getElementById('modal-audit-payload');
    const title = document.getElementById('audit-modal-title');
    const subtitle = document.getElementById('audit-modal-subtitle');
    const actorEl = document.getElementById('audit-modal-actor');
    const ipEl = document.getElementById('audit-modal-ip');
    const jsonContainer = document.getElementById('audit-modal-json');

    const rawPayload = log.newValuesJson || log.new_values_json;
    let parsedPayload = {};
    try {
        parsedPayload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : (rawPayload || {});
    } catch (_) {
        parsedPayload = { raw: rawPayload };
    }
    activeAuditLogModalPayload = parsedPayload;

    if (title) title.textContent = `تفاصيل: ${log.action}`;
    if (subtitle) subtitle.textContent = `${log.entityName || log.entity_name} (ID: ${log.entityId || log.entity_id})`;
    if (actorEl) actorEl.textContent = parsedPayload.actor || 'المشرف العام (Admin)';
    if (ipEl) ipEl.textContent = log.ipAddress || log.ip_address || '127.0.0.1';
    if (jsonContainer) {
        jsonContainer.textContent = JSON.stringify(parsedPayload, null, 2);
    }

    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
}

function closeAuditPayloadModal() {
    const modal = document.getElementById('modal-audit-payload');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
}

function copyAuditPayloadToClipboard() {
    if (!activeAuditLogModalPayload) return;
    const text = JSON.stringify(activeAuditLogModalPayload, null, 2);
    copyTextToClipboard(text);
    const copyText = document.getElementById('audit-copy-text');
    if (copyText) {
        copyText.textContent = 'تم النسخ بنجاح! ✅';
        setTimeout(() => { copyText.textContent = 'نسخ البيانات'; }, 2000);
    }
}

// -----------------------------------------------------------------------------
// Helper Utilities
// -----------------------------------------------------------------------------
function translateDocType(type) {
    const map = {
        'NationalIdFront': 'البطاقة الوطنية (الوجه الأمامي)',
        'NationalIdBack': 'البطاقة الوطنية (الوجه الخلفي)',
        'DrivingLicenseFront': 'إجازة السوق (الوجه الأمامي)',
        'DrivingLicenseBack': 'إجازة السوق (الوجه الخلفي)',
        'NationalId': 'البطاقة الوطنية / الهوية',
        'DrivingLicense': 'إجازة السوق / رخصة القيادة',
        'VehicleRegistration': 'سنوية المركبة (الملكية)',
        'BackgroundCheck': 'شهادة عدم محكومية',
        0: 'البطاقة الوطنية',
        1: 'إجازة السوق',
        2: 'سنوية المركبة',
        3: 'شهادة عدم محكومية'
    };
    return map[type] || type || 'وثيقة رسمية';
}

function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-msg');
    const toastInner = document.getElementById('toast-inner');
    const icon = document.getElementById('toast-icon');
    if (!toast || !toastMsg || !toastInner || !icon) return;

    toastMsg.innerText = msg;
    if (isError) {
        toastInner.className = 'px-5 py-3 rounded-2xl text-white font-semibold text-sm shadow-xl flex items-center space-x-2 space-x-reverse bg-rose-600';
        icon.className = 'fa-solid fa-circle-exclamation text-white';
    } else {
        toastInner.className = 'px-5 py-3 rounded-2xl text-white font-semibold text-sm shadow-xl flex items-center space-x-2 space-x-reverse bg-slate-900';
        icon.className = 'fa-solid fa-circle-check text-emerald-400';
    }

    toast.classList.remove('translate-y-20', 'opacity-0');
    setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
    }, 3500);
}

// =============================================================================
// Mapbox GL JS Fleet Tracking & Interactive Route Drawing Tool
const DEFAULT_MAPBOX_TOKEN = 'pk.eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9._J6DYjYBDhsdcidErQrblA';
let MAPBOX_PUBLIC_TOKEN = window.__MAPBOX_TOKEN || DEFAULT_MAPBOX_TOKEN;

// Load public runtime secrets from server environment only
async function initServerConfig() {
    try {
        const res = await fetch('/api/config/public');
        if (res.ok) {
            const data = await res.json();
            if (data.mapboxToken) {
                MAPBOX_PUBLIC_TOKEN = data.mapboxToken;
                window.__MAPBOX_TOKEN = data.mapboxToken;
                if (typeof mapboxgl !== 'undefined') {
                    mapboxgl.accessToken = data.mapboxToken;
                }
            }
        }
    } catch (_) {}
}
initServerConfig();

function ensureMapboxRTL() {
    if (typeof mapboxgl !== 'undefined' && typeof mapboxgl.setRTLTextPlugin === 'function') {
        try {
            if (mapboxgl.getRTLTextPluginStatus() === 'unavailable') {
                mapboxgl.setRTLTextPlugin(
                    'https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js',
                    null,
                    true
                );
            }
        } catch (e) {
            console.warn('[Mapbox] RTL plugin status:', e);
        }
    }
}

// =============================================================================
// 5.5 Full-Canvas Fleet Radar & Live Tracking Engine (Human-Crafted SaaS)
// =============================================================================
let fleetMap = null;
let fleetMarkers = {};
let radarDriversList = [];
let radarCurrentFilter = 'all';
let fleetPollingInterval = null;

function initFleetMapbox() {
    if (typeof mapboxgl === 'undefined') {
        console.error('Mapbox GL JS is not loaded yet');
        return;
    }

    ensureMapboxRTL();
    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN || DEFAULT_MAPBOX_TOKEN;

    const mapContainer = document.getElementById('mapbox-fleet-map');
    if (!mapContainer) return;

    if (!fleetMap) {
        try {
            fleetMap = new mapboxgl.Map({
                container: 'mapbox-fleet-map',
                style: 'mapbox://styles/mapbox/streets-v12', // Clean, crisp vector map with muted roads
                center: [44.3168, 31.9961], // Najaf Center [lon, lat]
                zoom: 13.5,
                pitch: 0,
                attributionControl: false
            });

            // Add subtle navigation controls to bottom-left
            fleetMap.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'bottom-left');

            fleetMap.on('load', () => {
                setTimeout(() => { if (fleetMap) fleetMap.resize(); }, 60);
                setTimeout(() => { if (fleetMap) fleetMap.resize(); }, 300);
                refreshFleetLocations();
            });
        } catch (mapErr) {
            console.error('[FleetRadar] Map initialization failed:', mapErr);
        }
    } else {
        setTimeout(() => { if (fleetMap) fleetMap.resize(); }, 80);
        setTimeout(() => { if (fleetMap) fleetMap.resize(); }, 300);
        refreshFleetLocations();
    }

    // Set polling interval every 3 seconds for real-time tracking
    if (!fleetPollingInterval) {
        fleetPollingInterval = setInterval(() => {
            const fleetTab = document.getElementById('tab-fleet-map');
            if (fleetTab && !fleetTab.classList.contains('hidden')) {
                refreshFleetLocations();
            }
        }, 3000);
    }
}

function isDriverOnline(driver) {
    if (!driver) return false;
    if (driver.isBlocked === true) return false;
    const workMode = String(driver.workMode || driver.work_mode || '').trim();
    if (workMode === 'خمول' || workMode === 'idle') return false;
    const workStatus = String(driver.workStatus || '').trim().toLowerCase();
    if (workStatus === 'idle') return false;
    if (driver.isOnline === true) return true;
    const s = String(driver.status || '').toLowerCase();
    return s === 'online' || s === 'on_trip' || s === 'available' || s === 'active' || s === 'in_ride';
}

async function refreshFleetLocations() {
    try {
        const [liveRes, allDriversRes] = await Promise.all([
            fetch('/api/admin/fleet/live', { headers: authHeaders() }).then(r => r.ok ? r.json() : []).catch(() => []),
            fetch('/api/admin/drivers', { headers: authHeaders() }).then(r => r.ok ? r.json() : { drivers: [] }).catch(() => ({ drivers: [] }))
        ]);

        const liveList = Array.isArray(liveRes) ? liveRes : [];
        const allDrivers = allDriversRes.drivers || [];

        // Build unified radar driver map
        const unifiedMap = new Map();

        // 1. Add all drivers from registry
        allDrivers.forEach(d => {
            const id = d.driverId || d.id;
            if (!id) return;
            const vMake = d.vehicleMake || '';
            const vModel = d.vehicleModel || '';
            const vPlate = d.vehiclePlate || 'النجف';
            const online = d.isOnline === true || ['online', 'active', 'available', 'on_trip', 'in_ride'].includes(String(d.status || '').toLowerCase());
            const wm = d.work_mode || d.workMode || (d.workStatus === 'permanent' ? 'خط دائمي' : (online ? 'مشوار قصير' : 'خمول'));
            unifiedMap.set(id, {
                driverId: id,
                driverName: d.fullName || 'كابتن توصيله',
                fullName: d.fullName || 'كابتن توصيله',
                phone: d.phoneNumber || d.phone || '07800000000',
                carModel: `${vMake} ${vModel}`.trim() || 'مركبة كابتن',
                plateNumber: vPlate,
                latitude: parseFloat(d.latitude || d.currentLat || 31.9961),
                longitude: parseFloat(d.longitude || d.currentLon || 44.3168),
                heading: d.heading || 0,
                status: online ? (d.status || 'Online') : 'offline',
                isOnline: online && wm !== 'خمول',
                serviceType: d.serviceType || 'Both',
                workMode: wm,
                speedKmh: 0,
                rating: d.ratingAverage || 5.0
            });
        });

        // 2. Overlay live coordinates & active statuses from live tracking
        liveList.forEach(ld => {
            const id = ld.driverId;
            if (!id) return;
            const existing = unifiedMap.get(id) || {};
            const online = ld.isOnline !== undefined ? Boolean(ld.isOnline) : ['online', 'active', 'available', 'on_trip', 'in_ride'].includes(String(ld.status || '').toLowerCase());
            const wm = ld.work_mode || ld.workMode || existing.workMode || 'مشوار قصير';
            unifiedMap.set(id, {
                ...existing,
                ...ld,
                driverId: id,
                driverName: ld.driverName || ld.fullName || existing.driverName || 'كابتن توصيله',
                phone: ld.phone || ld.phoneNumber || existing.phone || '07800000000',
                carModel: ld.carModel || ld.vehicleInfo || existing.carModel || 'مركبة كابتن',
                plateNumber: ld.plateNumber || existing.plateNumber || 'النجف',
                latitude: parseFloat(ld.latitude || existing.latitude || 31.9961),
                longitude: parseFloat(ld.longitude || existing.longitude || 44.3168),
                heading: ld.heading !== undefined ? ld.heading : (existing.heading || 0),
                status: online ? (ld.status || existing.status || 'Online') : 'offline',
                isOnline: online && wm !== 'خمول',
                serviceType: ld.serviceType || existing.serviceType || 'Both',
                workMode: wm,
                speedKmh: ld.speedKmh || 0
            });
        });

        radarDriversList = Array.from(unifiedMap.values());

        // Update live counter badge
        const onlineCount = radarDriversList.filter(d => isDriverOnline(d)).length;
        const countBadge = document.getElementById('radar-drivers-count');
        if (countBadge) {
            countBadge.innerText = `${onlineCount} متصل (${radarDriversList.length} كلي)`;
        }

        renderRadarMarkers();
    } catch (err) {
        console.warn('Error refreshing radar fleet locations:', err);
    }
}
window.fetchFleetDrivers = refreshFleetLocations;

function renderRadarMarkers() {
    if (!fleetMap) return;

    const query = (document.getElementById('fleet-radar-search-input')?.value || '').trim().toLowerCase();
    const filter = radarCurrentFilter;

    // Filter drivers according to active filter pill and search query
    const visibleDrivers = radarDriversList.filter(d => {
        // Tab Filter
        if (filter === 'taxi_available') {
            if (!isDriverOnline(d) || d.status === 'on_trip' || d.status === 'in_ride') return false;
            const wm = String(d.workMode || d.serviceType || '');
            if (wm === 'خط دائمي' || wm === 'PermanentLine') return false;
        } else if (filter === 'permanent') {
            const wm = String(d.workMode || d.serviceType || '');
            const isPerm = wm === 'خط دائمي' || wm === 'Both' || wm === 'PermanentLine' || (d.route && d.route.length > 0);
            if (!isPerm) return false;
        } else if (filter === 'on_trip') {
            if (d.status !== 'on_trip' && d.status !== 'in_ride') return false;
        } else if (filter === 'offline') {
            if (isDriverOnline(d)) return false;
        }

        // Search Query Filter
        if (query) {
            const name = String(d.driverName || '').toLowerCase();
            const phone = String(d.phone || '').toLowerCase();
            const plate = String(d.plateNumber || '').toLowerCase();
            const car = String(d.carModel || '').toLowerCase();
            if (!name.includes(query) && !phone.includes(query) && !plate.includes(query) && !car.includes(query)) {
                return false;
            }
        }

        return true;
    });

    const activeIds = new Set(visibleDrivers.map(d => d.driverId));

    // Remove markers that are no longer visible
    Object.keys(fleetMarkers).forEach(id => {
        if (!activeIds.has(id)) {
            fleetMarkers[id].remove();
            delete fleetMarkers[id];
        }
    });

    // Add or update markers for visible drivers
    visibleDrivers.forEach(driver => {
        const id = driver.driverId;
        const lat = parseFloat(driver.latitude);
        const lon = parseFloat(driver.longitude);
        if (isNaN(lat) || isNaN(lon)) return;

        const lngLat = [lon, lat];
        const heading = Number(driver.heading) || 0;

        // Visual theme based on status
        let accentColor = '#059669'; // Emerald (Taxi Available)
        let statusText = 'متاح للطلب';
        let statusPillClass = 'bg-emerald-50 text-emerald-700 border border-emerald-200';

        if (driver.status === 'on_trip' || driver.status === 'in_ride') {
            accentColor = '#2563eb'; // Blue (In Trip)
            statusText = 'في رحلة 🟢';
            statusPillClass = 'bg-blue-50 text-blue-700 border border-blue-200';
        } else if (driver.workMode === 'خط دائمي' || driver.serviceType === 'PermanentLine') {
            accentColor = '#d97706'; // Amber (Permanent Line)
            statusText = 'خط دائمي 🚐';
            statusPillClass = 'bg-amber-50 text-amber-700 border border-amber-200';
        } else if (!isDriverOnline(driver)) {
            accentColor = '#94a3b8'; // Slate (Offline)
            statusText = 'غير متصل ⚪';
            statusPillClass = 'bg-slate-100 text-slate-600 border border-slate-200';
        }

        // Clean Minimal Human-Crafted Popup
        const popupHtml = `
            <div class="p-3 text-right font-sans" dir="rtl" style="min-width: 195px;">
                <div class="flex items-center justify-between gap-3 pb-2 border-b border-slate-100">
                    <div>
                        <h4 class="font-bold text-xs text-slate-900 leading-tight">${escapeHtml(driver.driverName)}</h4>
                        <p class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(driver.carModel)} • <span class="font-mono">${escapeHtml(driver.plateNumber)}</span></p>
                    </div>
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${statusPillClass}">
                        ${statusText}
                    </span>
                </div>
                <div class="pt-2 flex items-center justify-between text-xs">
                    <a href="tel:${escapeHtml(driver.phone)}" class="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold text-emerald-600 hover:text-emerald-700 hover:underline" dir="ltr">
                        <i class="fa-solid fa-phone text-[9px]"></i>
                        <span>${escapeHtml(driver.phone)}</span>
                    </a>
                    ${driver.speedKmh ? `<span class="text-[10px] text-slate-400 font-mono">${Math.round(driver.speedKmh)} كم/س</span>` : ''}
                </div>
            </div>
        `;

        if (fleetMarkers[id]) {
            // Update existing marker smoothly
            fleetMarkers[id].setLngLat(lngLat);
            const el = fleetMarkers[id].getElement();
            const iconWrap = el.querySelector('.radar-car-icon-wrap');
            if (iconWrap) {
                iconWrap.style.transform = `rotate(${heading}deg)`;
                iconWrap.style.backgroundColor = accentColor;
            }
            const labelEl = el.querySelector('.radar-driver-label');
            if (labelEl) labelEl.innerText = driver.driverName;

            const existingPopup = fleetMarkers[id].getPopup();
            if (existingPopup) {
                existingPopup.setHTML(popupHtml);
            }
        } else {
            // Create fresh minimal SVG car marker
            const el = document.createElement('div');
            el.className = 'radar-car-marker cursor-pointer flex flex-col items-center group transition-transform duration-150';
            el.innerHTML = `
                <div class="radar-car-icon-wrap w-8 h-8 rounded-full flex items-center justify-center shadow-xs border-2 border-white transition-all duration-300"
                     style="background-color: ${accentColor}; transform: rotate(${heading}deg);">
                    <svg viewBox="0 0 32 32" width="20" height="20" fill="white">
                        <rect x="9" y="4" width="14" height="24" rx="4" ry="4"/>
                        <path d="M11 9 h10 v4 c0 1 -1 2 -2 2 h-6 c-1 0 -2 -1 -2 -2 z" fill="rgba(255,255,255,0.9)"/>
                        <path d="M12 21 h8 v2 c0 1 -1 1.5 -1.5 1.5 h-5 c-.5 0-1.5 -.5 -1.5 -1.5 z" fill="rgba(255,255,255,0.8)"/>
                        <rect x="10.5" y="14" width="11" height="5" rx="1" fill="rgba(255,255,255,0.4)"/>
                        <rect x="10" y="3.5" width="2.5" height="1.5" rx="0.5" fill="#fef08a"/>
                        <rect x="19.5" y="3.5" width="2.5" height="1.5" rx="0.5" fill="#fef08a"/>
                    </svg>
                </div>
                <div class="radar-driver-label bg-white/95 text-slate-800 text-[10px] font-bold px-2 py-0.5 rounded-md border border-slate-200/80 shadow-2xs whitespace-nowrap mt-1 pointer-events-none">
                    ${escapeHtml(driver.driverName)}
                </div>
            `;

            const popup = new mapboxgl.Popup({ offset: 18, closeButton: true, focusAfterOpen: false })
                .setHTML(popupHtml);

            const marker = new mapboxgl.Marker({ element: el })
                .setLngLat(lngLat)
                .setPopup(popup)
                .addTo(fleetMap);

            fleetMarkers[id] = marker;
        }
    });
}

function setRadarFilter(filter) {
    radarCurrentFilter = filter;

    const pills = document.querySelectorAll('.radar-pill');
    pills.forEach(p => {
        p.classList.remove('bg-[#1B4965]/10', 'text-[#1B4965]', 'border-[#1B4965]/30', 'shadow-2xs', 'active');
        p.classList.add('bg-slate-100', 'text-slate-600', 'border-slate-200/50');
    });

    const activePill = document.getElementById({
        'all': 'radar-pill-all',
        'taxi_available': 'radar-pill-taxi',
        'permanent': 'radar-pill-perm',
        'on_trip': 'radar-pill-trip',
        'offline': 'radar-pill-offline'
    }[filter]);

    if (activePill) {
        activePill.classList.remove('bg-slate-100', 'text-slate-600', 'border-slate-200/50');
        activePill.classList.add('bg-[#1B4965]/10', 'text-[#1B4965]', 'border-[#1B4965]/30', 'shadow-2xs', 'active');
    }

    renderRadarMarkers();
}

function handleRadarSearchInput(val) {
    const clearBtn = document.getElementById('btn-clear-radar-search');
    const resultsContainer = document.getElementById('radar-search-results');
    const q = (val || '').trim().toLowerCase();

    if (clearBtn) {
        if (q) clearBtn.classList.remove('hidden');
        else clearBtn.classList.add('hidden');
    }

    if (!q) {
        if (resultsContainer) resultsContainer.classList.add('hidden');
        renderRadarMarkers();
        return;
    }

    // Filter matching drivers
    const matches = radarDriversList.filter(d => {
        const name = String(d.driverName || '').toLowerCase();
        const phone = String(d.phone || '').toLowerCase();
        const plate = String(d.plateNumber || '').toLowerCase();
        const car = String(d.carModel || '').toLowerCase();
        return name.includes(q) || phone.includes(q) || plate.includes(q) || car.includes(q);
    });

    if (resultsContainer) {
        if (matches.length === 0) {
            resultsContainer.innerHTML = '<div class="p-3 text-center text-xs text-slate-400 font-medium">لا يوجد كابتن مطابق للبحث</div>';
            resultsContainer.classList.remove('hidden');
        } else {
            resultsContainer.innerHTML = matches.slice(0, 8).map(d => `
                <div onclick="focusDriverOnRadar('${escapeHtml(d.driverId)}')" class="p-2.5 hover:bg-slate-50 transition cursor-pointer flex items-center justify-between">
                    <div>
                        <span class="text-xs font-bold text-slate-800 block">${escapeHtml(d.driverName)}</span>
                        <span class="text-[11px] text-slate-500 font-mono block">${escapeHtml(d.carModel)} • ${escapeHtml(d.plateNumber)}</span>
                    </div>
                    <div class="text-left">
                        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${isDriverOnline(d) ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}">
                            ${isDriverOnline(d) ? (d.status === 'on_trip' ? 'في رحلة 🟢' : 'متصل 🚕') : 'غير متصل ⚪'}
                        </span>
                        <span class="text-[10px] text-slate-400 font-mono block mt-0.5" dir="ltr">${escapeHtml(d.phone)}</span>
                    </div>
                </div>
            `).join('');
            resultsContainer.classList.remove('hidden');
        }
    }

    renderRadarMarkers();
}

function clearRadarSearch() {
    const input = document.getElementById('fleet-radar-search-input');
    const resultsContainer = document.getElementById('radar-search-results');
    const clearBtn = document.getElementById('btn-clear-radar-search');
    if (input) input.value = '';
    if (resultsContainer) resultsContainer.classList.add('hidden');
    if (clearBtn) clearBtn.classList.add('hidden');
    renderRadarMarkers();
}

function focusDriverOnRadar(driverId) {
    const driver = radarDriversList.find(d => d.driverId === driverId);
    if (!driver || !fleetMap) return;

    const resultsContainer = document.getElementById('radar-search-results');
    if (resultsContainer) resultsContainer.classList.add('hidden');

    const lat = parseFloat(driver.latitude);
    const lon = parseFloat(driver.longitude);
    if (isNaN(lat) || isNaN(lon)) return;

    fleetMap.flyTo({
        center: [lon, lat],
        zoom: 16.5,
        speed: 1.4,
        curve: 1.2,
        essential: true
    });

    // Open popup for this driver
    const marker = fleetMarkers[driverId];
    if (marker) {
        marker.togglePopup();
    }
}

// -----------------------------------------------------------------------------
// Driver Lifecycle Controls
// -----------------------------------------------------------------------------
function translateDriverStatus(s) {
    switch (s) {
        case 'Approved': return 'معتمد';
        case 'Rejected': return 'مرفوض';
        case 'Suspended': return 'معلق';
        case 'Pending': return 'قيد التدقيق';
        case 'Online': return 'متصل';
        case 'Offline': return 'غير متصل';
        default: return s;
    }
}

async function approveDriver(driverId) {
    if (!confirm('هل أنت متأكد من الموافقة على هذا الكابتن لكي يظهر على الخريطة للركاب؟')) return;
    try {
        const res = await fetch(`${API_BASE}/drivers/${driverId}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approve: true })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`تم الموافقة على الكابتن بنجاح وأصبح متاحاً للركاب ✅`);
            loadDrivers();
            if (fleetMap) refreshFleetLocations();
        } else {
            showToast(data.error || 'فشل الموافقة على الكابتن', true);
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

async function updateDriverStatus(driverId, newStatus, reason = null) {
    try {
        const res = await fetch(`${API_BASE}/drivers/${driverId}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus, reason: reason })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`تم تغيير حالة الكابتن إلى (${translateDriverStatus(newStatus)}) بنجاح ✅`);
            loadDrivers();
            loadVerifications();
            loadDashboardStats();
            loadDynamicNotifications();
            if (fleetMap) refreshFleetLocations();
        } else {
            showToast(data.error || 'فشل تحديث حالة السائق', true);
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

function promptRejectDriver(driverId, driverName) {
    const reason = prompt(`يرجى كتابة سبب رفض طلب الكابتن "${driverName}":`, 'المستمسكات غير واضحة أو غير مطابقة');
    if (reason !== null && reason.trim() !== '') {
        updateDriverStatus(driverId, 'Rejected', reason.trim());
    }
}

// -----------------------------------------------------------------------------
// Real-Time Dynamic Notifications System
// -----------------------------------------------------------------------------
let isNotificationsOpen = false;

function toggleNotificationsDropdown(force) {
    const dropdown = document.getElementById('notifications-dropdown');
    if (!dropdown) return;
    isNotificationsOpen = force !== undefined ? force : !isNotificationsOpen;
    if (isNotificationsOpen) {
        dropdown.classList.remove('hidden');
        loadDynamicNotifications();
    } else {
        dropdown.classList.add('hidden');
    }
}

// Close notifications dropdown on outside click
document.addEventListener('click', (e) => {
    const btn = document.getElementById('btn-notification-bell');
    const dropdown = document.getElementById('notifications-dropdown');
    if (dropdown && !dropdown.classList.contains('hidden') && btn && !btn.contains(e.target) && !dropdown.contains(e.target)) {
        toggleNotificationsDropdown(false);
    }
});

async function loadDynamicNotifications() {
    const list = document.getElementById('notifications-list');
    const badge = document.getElementById('header-notif-badge');
    const countSpan = document.getElementById('dropdown-notif-count');
    if (!list) return;

    try {
        const res = await fetch(`${API_BASE}/notifications`);
        if (!res.ok) return;
        const data = await res.json();
        const notifs = data.notifications || [];

        if (countSpan) countSpan.innerText = `${notifs.length} تنبيه`;

        if (notifs.length > 0) {
            if (badge) {
                badge.innerText = notifs.length;
                badge.classList.remove('hidden');
            }
            list.innerHTML = notifs.map(n => `
                <div class="p-3 hover:bg-slate-800 transition flex items-start justify-between gap-3 text-right">
                    <div class="flex-1">
                        <div class="flex items-center gap-1.5 font-bold text-xs text-white mb-1">
                            <span class="w-2 h-2 rounded-full ${n.type === 'Complaint' ? 'bg-rose-500' : 'bg-amber-400'}"></span>
                            <span>${n.title}</span>
                        </div>
                        <p class="text-[11px] text-slate-300 leading-relaxed">${n.message}</p>
                        <div class="text-[10px] text-slate-500 mt-1 font-mono">${new Date(n.createdAt).toLocaleTimeString('ar-IQ')}</div>
                    </div>
                    <button onclick="switchTab('${n.actionUrl || 'verifications'}'); toggleNotificationsDropdown(false);" 
                            class="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg text-[11px] font-bold transition shrink-0">
                        معاينة
                    </button>
                </div>
            `).join('');
        } else {
            if (badge) badge.classList.add('hidden');
            list.innerHTML = '<div class="p-6 text-center text-xs text-slate-500">لا توجد تنبيهات جديدة حالياً ✅</div>';
        }
    } catch (err) {
        console.warn('Notifications fetch warning:', err);
    }
}

// -----------------------------------------------------------------------------
// PostgreSQL Database Health & Engine Stats
// -----------------------------------------------------------------------------
async function loadDatabaseEngineStats() {
    const icon = document.getElementById('btn-refresh-db-icon');
    if (icon) icon.classList.add('fa-spin');

    try {
        const res = await fetch(`${API_BASE}/backup/stats`);
        if (!res.ok) throw new Error('فشل جلب إحصائيات قاعدة البيانات');
        const data = await res.json();

        // 1. Connection status
        const statusEl = document.getElementById('db-stat-status');
        const pingEl = document.getElementById('db-status-ping');
        const dotEl = document.getElementById('db-status-dot');
        if (statusEl) {
            if (data.isOnline) {
                statusEl.textContent = 'متصل حي (Online)';
                statusEl.className = 'text-sm font-extrabold text-emerald-600';
                if (pingEl) pingEl.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75';
                if (dotEl) dotEl.className = 'relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500';
            } else {
                statusEl.textContent = 'غير متصل (Offline)';
                statusEl.className = 'text-sm font-extrabold text-rose-600';
                if (pingEl) pingEl.className = 'hidden';
                if (dotEl) dotEl.className = 'relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500';
            }
        }

        // 2. Engine and version
        const engineEl = document.getElementById('db-stat-engine');
        if (engineEl) {
            engineEl.textContent = data.engine || `${data.pgVersion} + ${data.postgisVersion}`;
            engineEl.title = data.engine || 'PostgreSQL Engine';
        }

        // 3. Disk size
        const sizeEl = document.getElementById('db-stat-size');
        if (sizeEl) {
            sizeEl.textContent = data.diskSize || '8.7 MB';
        }

        // 4. Tables and Row Counts
        const tablesEl = document.getElementById('db-stat-tables');
        const rowsEl = document.getElementById('db-stat-rows');
        if (tablesEl) tablesEl.textContent = data.tablesCount != null ? data.tablesCount : 11;
        if (rowsEl) rowsEl.textContent = data.totalRows != null ? Number(data.totalRows).toLocaleString('en-US') : '0';

        // 5. Last backup info
        const lastBackupNameEl = document.getElementById('last-backup-name');
        if (lastBackupNameEl) {
            if (data.lastBackupFilename) {
                const dateText = data.lastExportAt ? ` (${new Date(data.lastExportAt).toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' })})` : '';
                lastBackupNameEl.textContent = `${data.lastBackupFilename}${dateText}`;
            } else {
                lastBackupNameEl.textContent = 'لا توجد نسخ سابقة على الخادم';
            }
        }
    } catch (err) {
        console.warn('loadDatabaseEngineStats warning:', err);
    } finally {
        if (icon) icon.classList.remove('fa-spin');
    }
}

// -----------------------------------------------------------------------------
// Staged Backup File & Drag-and-Drop Handlers
// -----------------------------------------------------------------------------
let stagedBackupFile = null;

function handleBackupFileSelect(files) {
    if (!files || files.length === 0) return;
    const file = files[0];

    // Check extension
    if (!file.name.toLowerCase().endsWith('.json')) {
        showToast('يرجى اختيار ملف بصيغة JSON فقط (.json)', true);
        const input = document.getElementById('backup-file-input');
        if (input) input.value = '';
        return;
    }

    // Check size (< 50MB)
    const MAX_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
        showToast('حجم الملف يتجاوز الحد الأقصى المسموح به (50 ميغابايت)', true);
        const input = document.getElementById('backup-file-input');
        if (input) input.value = '';
        return;
    }

    stagedBackupFile = file;

    // Update Dropzone UI
    const dropzone = document.getElementById('backup-dropzone');
    const label = document.getElementById('backup-file-label');
    const details = document.getElementById('backup-file-details');
    const icon = document.getElementById('dropzone-icon');

    if (dropzone) {
        dropzone.classList.remove('border-slate-300', 'bg-slate-50/70');
        dropzone.classList.add('border-emerald-500', 'bg-emerald-50/40');
    }
    if (icon) {
        icon.className = 'fa-solid fa-file-circle-check text-emerald-600';
    }
    if (label) {
        label.innerHTML = `<span class="text-emerald-700 font-mono font-bold" dir="ltr">${file.name}</span>`;
    }
    if (details) {
        const sizeFormatted = file.size > 1024 * 1024 
            ? `${(file.size / (1024 * 1024)).toFixed(2)} MB` 
            : `${(file.size / 1024).toFixed(1)} KB`;
        details.innerHTML = `<span class="text-emerald-600 font-semibold">جاهز للاستعادة (${sizeFormatted}) • اضغط لتغيير الملف</span>`;
    }
}

function initBackupDropzoneEvents() {
    const dropzone = document.getElementById('backup-dropzone');
    if (!dropzone || dropzone.dataset.eventsBound) return;
    dropzone.dataset.eventsBound = 'true';

    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('border-blue-500', 'bg-blue-50/50');
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (eventName === 'dragleave') {
                dropzone.classList.remove('border-blue-500', 'bg-blue-50/50');
            }
        });
    });

    dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
            handleBackupFileSelect(dt.files);
        }
    });
}

// -----------------------------------------------------------------------------
// Full System Backup Export
// -----------------------------------------------------------------------------
async function exportSystemBackup() {
    const btn = document.getElementById('btn-export-backup');
    const icon = document.getElementById('btn-export-icon');
    const text = document.getElementById('btn-export-text');

    if (btn) btn.disabled = true;
    if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
    if (text) text.textContent = 'جاري استخراج الجداول وبناء النسخة...';

    try {
        showToast('جاري سحب كافة الجداول والبيانات من PostgreSQL...');
        const res = await fetch(`${API_BASE}/backup/export`);
        if (!res.ok) throw new Error('تعذر تصدير النسخة الاحتياطية من السيرفر');
        const data = await res.json();

        if (!data || (!data.data && !data.backupPayload)) {
            throw new Error(data.error || 'استجابة التصدير غير صالحة');
        }

        const exportPayload = data.backupPayload || { meta: data.meta, data: data.data };
        const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = data.filename || `tawseela-backup-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        showToast('تم تصدير وتحميل النسخة الاحتياطية الشاملة بنجاح ✅');
        
        // Refresh local stats
        loadDatabaseEngineStats();
        loadAuditLogs();
    } catch (err) {
        showToast(err.message || 'فشل تصدير النسخة الاحتياطية', true);
    } finally {
        if (btn) btn.disabled = false;
        if (icon) icon.className = 'fa-solid fa-download';
        if (text) text.textContent = 'تصدير وتحميل النسخة الاحتياطية الآن';
    }
}

// -----------------------------------------------------------------------------
// Double Confirmation Security Restore Modal
// -----------------------------------------------------------------------------
function openRestoreConfirmation() {
    if (!stagedBackupFile) {
        showToast('يرجى اختيار أو سحب ملف النسخة الاحتياطية (.json) أولاً', true);
        return;
    }

    const modal = document.getElementById('modal-confirm-restore');
    const filenameEl = document.getElementById('restore-modal-filename');
    const filesizeEl = document.getElementById('restore-modal-filesize');
    const keywordInput = document.getElementById('restore-confirmation-keyword');
    const confirmBtn = document.getElementById('btn-execute-restore-confirm');

    if (filenameEl) filenameEl.textContent = stagedBackupFile.name;
    if (filesizeEl) {
        const sz = stagedBackupFile.size > 1024 * 1024
            ? `${(stagedBackupFile.size / (1024 * 1024)).toFixed(2)} MB`
            : `${(stagedBackupFile.size / 1024).toFixed(1)} KB`;
        filesizeEl.textContent = sz;
    }

    if (keywordInput) keywordInput.value = '';
    if (confirmBtn) confirmBtn.disabled = true;

    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }

    setTimeout(() => {
        if (keywordInput) keywordInput.focus();
    }, 100);
}

function closeRestoreModal() {
    const modal = document.getElementById('modal-confirm-restore');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.add('hidden');
    }
}

function checkRestoreConfirmationKeyword(val) {
    const clean = (val || '').trim().toLowerCase();
    const confirmBtn = document.getElementById('btn-execute-restore-confirm');
    if (confirmBtn) {
        const isValid = clean === 'restore' || clean === 'استعادة';
        confirmBtn.disabled = !isValid;
    }
}

async function executeConfirmedRestore() {
    if (!stagedBackupFile) {
        showToast('لم يتم العثور على ملف النسخة للاستعادة', true);
        closeRestoreModal();
        return;
    }

    const confirmBtn = document.getElementById('btn-execute-restore-confirm');
    const spinner = document.getElementById('restore-spinner-icon');
    const btnText = document.getElementById('restore-btn-text');

    if (confirmBtn) confirmBtn.disabled = true;
    if (spinner) spinner.className = 'fa-solid fa-spinner fa-spin';
    if (btnText) btnText.textContent = 'جاري المعالجة الذرية...';

    try {
        showToast('جاري قراءة الملف وتطبيق المعاملة الذرية (BEGIN / COMMIT)...');
        const text = await stagedBackupFile.text();
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (_) {
            throw new Error('الملف غير صالح أو تالف: ليس بصيغة JSON صحيحة');
        }

        const res = await fetch(`${API_BASE}/backup/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await res.json();
        if (result.success) {
            showToast('تمت استعادة النسخة الاحتياطية وقاعدة البيانات بنجاح تام! 🎉');
            closeRestoreModal();

            // Reset staged file and dropzone UI
            stagedBackupFile = null;
            const fileInput = document.getElementById('backup-file-input');
            if (fileInput) fileInput.value = '';

            const dropzone = document.getElementById('backup-dropzone');
            const label = document.getElementById('backup-file-label');
            const details = document.getElementById('backup-file-details');
            const icon = document.getElementById('dropzone-icon');

            if (dropzone) {
                dropzone.classList.remove('border-emerald-500', 'bg-emerald-50/40');
                dropzone.classList.add('border-slate-300', 'bg-slate-50/70');
            }
            if (icon) icon.className = 'fa-solid fa-file-arrow-up text-slate-400';
            if (label) label.textContent = 'اسحب وأفلت ملف النسخة (.json) هنا، أو اضغط للاختيار';
            if (details) details.textContent = 'الملفات المدعومة: JSON فقط • الحجم الأقصى: 50MB';

            // Reload all dashboard sections
            loadDatabaseEngineStats();
            loadDashboardStats();
            loadDrivers();
            loadCustomers();
            loadVerifications();
            loadAuditLogs();
            loadDynamicNotifications();
        } else {
            showToast(result.error || 'فشلت عملية الاستعادة', true);
            if (confirmBtn) confirmBtn.disabled = false;
        }
    } catch (err) {
        showToast('خطأ أثناء الاستعادة: ' + err.message, true);
        if (confirmBtn) confirmBtn.disabled = false;
    } finally {
        if (spinner) spinner.className = 'fa-solid fa-rotate-left';
        if (btnText) btnText.textContent = 'تأكيد الاستعادة والبدء فوراً';
    }
}

// =============================================================================
// ADMIN: REGISTER CAPTAIN & DRAW ROUTE (Full Interactive Feature)
// =============================================================================

let adminCaptainMap = null;
let adminCaptainStartMarker = null;
let adminCaptainDestMarker = null;
let adminPickMode = null; // 'start' | 'dest' | null
let createdCaptainData = null;

const ADMIN_NAJAF_PLACES = [
    
    { name: "مرقد الإمام علي (ع) - المدينة القديمة", lat: 31.9957, lon: 44.3143 },
    
    { name: "جامعة الكوفة - كلية الطب ومستشفى الصدر", lat: 32.0285, lon: 44.3650 },
    { name: "مطار النجف الأشرف الدولي", lat: 31.9897, lon: 44.4042 },
    { name: "حي الحنانة", lat: 32.0100, lon: 44.3400 },
    { name: "حي الجامعة", lat: 32.0220, lon: 44.3550 },
    { name: "حي الغدير", lat: 32.0350, lon: 44.3300 },
    { name: "حي الأمير", lat: 32.0180, lon: 44.3250 },
    { name: "حي السلام", lat: 32.0400, lon: 44.3420 },
    { name: "حي السعد", lat: 32.0050, lon: 44.3220 },
    { name: "حي العروبة", lat: 32.0150, lon: 44.3350 },
    { name: "حي النداء", lat: 32.0450, lon: 44.3200 },
    { name: "حي الفرات", lat: 32.0250, lon: 44.3600 },
    { name: "حي الوفاء", lat: 32.0300, lon: 44.3150 },
    { name: "حي المعلمين", lat: 32.0200, lon: 44.3300 },
    { name: "حي القدس", lat: 32.0260, lon: 44.3380 },
    { name: "حي الأنصار", lat: 32.0080, lon: 44.3290 },
    { name: "حي الشعراء", lat: 32.0420, lon: 44.3500 },
    { name: "حي الإسكان", lat: 32.0120, lon: 44.3280 },
    { name: "حي العدالة", lat: 32.0280, lon: 44.3450 },
    { name: "شارع الروان", lat: 32.0205, lon: 44.3355 },
    { name: "شارع المدينة", lat: 32.0020, lon: 44.3200 },
    { name: "شارع الكوفة الرئيسي", lat: 32.0180, lon: 44.3520 }
];

function openAddCaptainModal() {
    const modal = document.getElementById('modal-add-captain');
    if (!modal) return;
    modal.classList.add('active');
    modal.classList.remove('hidden');
    modal.classList.remove('pointer-events-none');
    modal.style.display = 'flex';
    modal.style.pointerEvents = 'auto';
    document.getElementById('form-add-captain').style.display = 'block';
    document.getElementById('admin-captain-success-box').style.display = 'none';

    setTimeout(() => {
        initAdminCaptainRouteMap();
    }, 200);
}

function closeAddCaptainModal() {
    const modal = document.getElementById('modal-add-captain');
    if (modal) {
        modal.classList.remove('active');
        modal.classList.add('hidden');
        modal.classList.add('pointer-events-none');
        modal.style.display = 'none';
        modal.style.pointerEvents = 'none';
    }
    adminPickMode = null;
}

// Unique non-repeating password generator
function generateUniquePassword() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
    // Generate unique pattern, e.g. Tw# + 4 digits + 2 chars
    let pass = 'Tw#' + Math.floor(1000 + Math.random() * 9000);
    for (let i = 0; i < 2; i++) {
        pass += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return pass;
}

function generateCaptainPassword() {
    const pass = generateUniquePassword();
    const input = document.getElementById('admin-drv-password');
    if (input) input.value = pass;
    showToast('تم توليد كلمة مرور فريدة وغير مكررة بنجاح 🔑');
}

function generateUniquePasswordToInput(inputId) {
    const pass = generateUniquePassword();
    const input = document.getElementById(inputId);
    if (input) input.value = pass;
    showToast('تم توليد كلمة مرور فريدة وغير مكررة 🔑');
}

// Live phone verification for Captain Registration
let adminPhoneCheckDebounce = null;
async function checkAdminCaptainPhone(val) {
    const statusEl = document.getElementById('admin-drv-phone-status');
    const phoneInput = document.getElementById('admin-drv-phone');
    if (!statusEl) return;

    const raw = (val || '').trim();
    if (!raw || raw.length < 5) {
        statusEl.innerHTML = '';
        statusEl.classList.add('hidden');
        if (phoneInput) phoneInput.classList.remove('border-rose-500', 'border-emerald-500');
        return;
    }

    clearTimeout(adminPhoneCheckDebounce);
    adminPhoneCheckDebounce = setTimeout(async () => {
        try {
            const res = await fetch(`${API_BASE}/auth/check-phone?phone=${encodeURIComponent(raw)}`);
            if (res.ok) {
                const data = await res.json();
                statusEl.classList.remove('hidden');
                if (data.exists) {
                    if (phoneInput) {
                        phoneInput.classList.add('border-rose-500');
                        phoneInput.classList.remove('border-emerald-500');
                    }
                    statusEl.innerHTML = `<span class="text-rose-600 bg-rose-50 px-2.5 py-1 rounded-lg border border-rose-200 block">⚠️ هذا الرقم مسجل مسبقاً لدى (${data.roleAr}): ${data.name || ''} - يرجى إدخال رقم آخر</span>`;
                } else {
                    if (phoneInput) {
                        phoneInput.classList.add('border-emerald-500');
                        phoneInput.classList.remove('border-rose-500');
                    }
                    statusEl.innerHTML = `<span class="text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200 block">✅ الرقم متاح وجاهز للتسجيل</span>`;
                }
            }
        } catch (_) {}
    }, 250);
}

function initAdminCaptainRouteMap() {
    const container = document.getElementById('admin-captain-route-map');
    if (!container || typeof mapboxgl === 'undefined') return;

    ensureMapboxRTL();

    if (!adminCaptainMap) {
        mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;
        adminCaptainMap = new mapboxgl.Map({
            container: 'admin-captain-route-map',
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [44.345, 32.015],
            zoom: 12
        });

        adminCaptainMap.addControl(new mapboxgl.NavigationControl(), 'top-left');

        adminCaptainMap.on('load', () => {
            adminCaptainMap.addSource('captain-route-source', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });

            adminCaptainMap.addLayer({
                id: 'captain-route-line',
                type: 'line',
                source: 'captain-route-source',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': '#f59e0b',
                    'line-width': 5,
                    'line-opacity': 0.95
                }
            });

            updateAdminCaptainRouteMap();
        });

        adminCaptainMap.on('click', (e) => {
            if (adminPickMode === 'start') {
                document.getElementById('admin-route-start-lat').value = e.lngLat.lat;
                document.getElementById('admin-route-start-lon').value = e.lngLat.lng;
                document.getElementById('admin-route-start-label').innerText = `إحداثيات [${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}]`;
                adminPickMode = null;
                resetAdminPickButtons();
                updateAdminCaptainRouteMap();
            } else if (adminPickMode === 'dest') {
                document.getElementById('admin-route-end-lat').value = e.lngLat.lat;
                document.getElementById('admin-route-end-lon').value = e.lngLat.lng;
                document.getElementById('admin-route-dest-label').innerText = `إحداثيات [${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}]`;
                adminPickMode = null;
                resetAdminPickButtons();
                updateAdminCaptainRouteMap();
            }
        });
    } else {
        setTimeout(() => adminCaptainMap.resize(), 100);
        updateAdminCaptainRouteMap();
    }
}

function setAdminMapPickMode(mode) {
    adminPickMode = mode;
    const btnStart = document.getElementById('btn-admin-pick-start');
    const btnDest = document.getElementById('btn-admin-pick-dest');

    if (mode === 'start') {
        if (btnStart) btnStart.className = 'px-3 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer ring-2 ring-emerald-400';
        if (btnDest) btnDest.className = 'px-3 py-2 bg-rose-100 border border-rose-300 text-rose-800 rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer';
        showToast('انقر على الخريطة لتثبيت نقطة الانطلاق 🟢');
    } else {
        if (btnDest) btnDest.className = 'px-3 py-2 bg-rose-600 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer ring-2 ring-rose-400';
        if (btnStart) btnStart.className = 'px-3 py-2 bg-emerald-100 border border-emerald-300 text-emerald-800 rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer';
        showToast('انقر على الخريطة لتثبيت نقطة الوصول 🔴');
    }
}

function resetAdminPickButtons() {
    const btnStart = document.getElementById('btn-admin-pick-start');
    const btnDest = document.getElementById('btn-admin-pick-dest');
    if (btnStart) btnStart.className = 'px-3 py-2 bg-emerald-100 border border-emerald-300 text-emerald-800 hover:bg-emerald-600 hover:text-white rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer';
    if (btnDest) btnDest.className = 'px-3 py-2 bg-rose-100 border border-rose-300 text-rose-800 hover:bg-rose-600 hover:text-white rounded-xl text-xs font-bold transition flex items-center gap-1 cursor-pointer';
}

const OTHER_GOVERNORATES = ['بغداد', 'كربلاء', 'بابل', 'البصرة', 'أربيل', 'الموصل', 'السليمانية', 'الأنبار', 'ديالى', 'كركوك', 'واسط', 'ميسان', 'المثنى', 'ذي قار', 'القادسية', 'صلاح الدين', 'دهوك', 'الديوانية', 'الحلة', 'الناصرية', 'العمارة', 'الكوت', 'السماوة'];

function isStrictlyNajafLocation(name, center) {
    if (!center || center.length < 2) return false;
    const lon = center[0];
    const lat = center[1];
    // Najaf Governorate Bounding Box (Lat ~ 31.6 to 32.35, Lon ~ 44.05 to 44.65)
    if (lon < 44.05 || lon > 44.65 || lat < 31.6 || lat > 32.35) {
        return false;
    }
    const lowerName = (name || '').toLowerCase();
    for (const gov of OTHER_GOVERNORATES) {
        if (lowerName.includes(gov) && !lowerName.includes('النجف') && !lowerName.includes('الكوفة')) {
            return false;
        }
    }
    return true;
}

let adminSearchDebounceTimer = null;
function searchAdminNajafPlace(type) {
    const input = document.getElementById(type === 'start' ? 'admin-route-start-input' : 'admin-route-dest-input');
    const box = document.getElementById(type === 'start' ? 'admin-start-results' : 'admin-dest-results');
    if (!input || !box) return;

    const q = input.value.trim();
    if (!q || q.length < 1) {
        box.innerHTML = '';
        box.classList.add('hidden');
        return;
    }

    const qLower = q.toLowerCase();

    // 1. Instant local landmark matches
    const localMatches = ADMIN_NAJAF_PLACES
        .filter(p => p.name.toLowerCase().includes(qLower))
        .map(p => ({
            name: p.name,
            displayName: p.name,
            category: 'معلم / منطقة في النجف',
            icon: '📍',
            lat: p.lat,
            lon: p.lon
        }));

    renderAdminSearchResults(localMatches, true);

    // 2. Debounced live query to Mapbox Geocoding (strictly bounded to Najaf Governorate)
    clearTimeout(adminSearchDebounceTimer);
    adminSearchDebounceTimer = setTimeout(async () => {
        try {
            const geocodeUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?country=iq&proximity=44.3168,31.9961&bbox=44.05,31.75,44.65,32.35&language=ar&types=poi,address,neighborhood,locality,place,district&limit=10&autocomplete=true&access_token=${MAPBOX_PUBLIC_TOKEN}`;
            const res = await fetch(geocodeUrl);
            let mbFeatures = [];
            if (res.ok) {
                const geoData = await res.json();
                mbFeatures = (geoData && geoData.features) ? geoData.features : [];
            }

            const combined = [...localMatches];
            const seenNames = new Set(localMatches.map(m => m.name.toLowerCase()));

            mbFeatures.forEach(feat => {
                const featName = (feat.place_name_ar || feat.place_name || feat.text_ar || feat.text || '').trim();
                const center = feat.center; // [lon, lat]
                if (!isStrictlyNajafLocation(featName, center)) return;
                if (featName && center && center.length >= 2) {
                    const simpleName = featName.split(',')[0].trim();
                    if (!seenNames.has(featName.toLowerCase()) && !seenNames.has(simpleName.toLowerCase())) {
                        seenNames.add(featName.toLowerCase());

                        let icon = '📍';
                        let category = 'موقع بالخريطة';
                        const pTypes = feat.place_type || [];
                        if (pTypes.includes('poi')) {
                            icon = '🏬';
                            category = 'محل / أسواق / مجمع';
                            if (featName.includes('جامعة') || featName.includes('كلية') || featName.includes('معهد')) {
                                icon = '🎓';
                                category = 'جامعة / صرح تعليمي';
                            } else if (featName.includes('مستشفى') || featName.includes('عيادة') || featName.includes('مركز صحي')) {
                                icon = '🏥';
                                category = 'مستشفى / مركز طبي';
                            } else if (featName.includes('مسجد') || featName.includes('حسينية') || featName.includes('مرقد') || featName.includes('مزار')) {
                                icon = '🕌';
                                category = 'معلم ديني / مزار';
                            }
                        } else if (pTypes.includes('address')) {
                            icon = '🏠';
                            category = 'بيت / عنوان دقيق';
                        } else if (pTypes.includes('neighborhood') || pTypes.includes('locality')) {
                            icon = '🏘️';
                            category = 'حي سكني / منطقة';
                        } else if (featName.includes('شارع') || featName.includes('طريق')) {
                            icon = '🛣️';
                            category = 'شارع / طريق رئيسي';
                        }

                        combined.push({
                            name: featName,
                            displayName: featName,
                            category,
                            icon,
                            lat: center[1],
                            lon: center[0]
                        });
                    }
                }
            });

            renderAdminSearchResults(combined, false);
        } catch (searchErr) {
            console.warn('[Mapbox Search] Error searching places:', searchErr);
            renderAdminSearchResults(localMatches, false);
        }
    }, 280);

    function renderAdminSearchResults(items, isLoading) {
        if (!items || items.length === 0) {
            if (isLoading) {
                box.innerHTML = '<div class="p-3 text-slate-500 text-center text-xs flex items-center justify-center gap-2"><i class="fa-solid fa-circle-notch fa-spin text-amber-500"></i> جاري البحث في خريطة النجف...</div>';
            } else {
                box.innerHTML = '<div class="p-3 text-slate-400 text-center text-xs">لم نجد نتائج مطابقة، يمكنك النقر على الخريطة لتثبيت الموقع 📍</div>';
            }
            box.classList.remove('hidden');
            return;
        }

        box.innerHTML = items.slice(0, 10).map(p => {
            const safeName = (p.displayName || p.name).replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const icon = p.icon || '📍';
            const cat = p.category || 'النجف الأشرف';
            return `
                <div onclick="selectAdminNajafPlace('${type}', '${safeName}', ${p.lat}, ${p.lon})"
                     class="p-2.5 hover:bg-amber-50 cursor-pointer border-b border-slate-100 last:border-0 flex items-center justify-between transition">
                    <div class="flex items-center gap-2 overflow-hidden">
                        <span class="text-base">${icon}</span>
                        <div class="text-right truncate">
                            <div class="font-bold text-slate-800 text-xs truncate">${p.name}</div>
                            <div class="text-[10px] text-slate-400 truncate">${cat}</div>
                        </div>
                    </div>
                    <span class="text-[10px] text-amber-600 font-semibold bg-amber-50 px-2 py-0.5 rounded-full whitespace-nowrap">اختيار</span>
                </div>
            `;
        }).join('') + (isLoading ? '<div class="p-1.5 text-center text-[10px] text-slate-400"><i class="fa-solid fa-circle-notch fa-spin text-amber-500"></i> جاري استكمال البحث بالخريطة...</div>' : '');
        box.classList.remove('hidden');
    }
}

function selectAdminNajafPlace(type, name, lat, lon) {
    const input = document.getElementById(type === 'start' ? 'admin-route-start-input' : 'admin-route-dest-input');
    const box = document.getElementById(type === 'start' ? 'admin-start-results' : 'admin-dest-results');
    if (input) input.value = name;
    if (box) box.classList.add('hidden');

    if (type === 'start') {
        document.getElementById('admin-route-start-lat').value = lat;
        document.getElementById('admin-route-start-lon').value = lon;
        document.getElementById('admin-route-start-label').innerText = name;
    } else {
        document.getElementById('admin-route-end-lat').value = lat;
        document.getElementById('admin-route-end-lon').value = lon;
        document.getElementById('admin-route-dest-label').innerText = name;
    }

    if (adminCaptainMap) {
        adminCaptainMap.flyTo({
            center: [lon, lat],
            zoom: 14,
            essential: true
        });
    }

    updateAdminCaptainRouteMap();
}

async function updateAdminCaptainRouteMap() {
    if (!adminCaptainMap) return;

    const sLat = parseFloat(document.getElementById('admin-route-start-lat').value || 31.9961);
    const sLon = parseFloat(document.getElementById('admin-route-start-lon').value || 44.3168);
    const eLat = parseFloat(document.getElementById('admin-route-end-lat').value || 32.0321);
    const eLon = parseFloat(document.getElementById('admin-route-end-lon').value || 44.3725);

    // Update start marker
    if (adminCaptainStartMarker) adminCaptainStartMarker.remove();
    const startEl = document.createElement('div');
    startEl.style.width = '24px';
    startEl.style.height = '24px';
    startEl.style.borderRadius = '50%';
    startEl.style.backgroundColor = '#10b981';
    startEl.style.border = '2px solid white';
    startEl.style.boxShadow = '0 0 10px rgba(16,185,129,0.8)';
    startEl.style.display = 'flex';
    startEl.style.alignItems = 'center';
    startEl.style.justifyContent = 'center';
    startEl.style.color = 'white';
    startEl.style.fontSize = '12px';
    startEl.innerText = '🟢';

    adminCaptainStartMarker = new mapboxgl.Marker(startEl)
        .setLngLat([sLon, sLat])
        .addTo(adminCaptainMap);

    // Update dest marker
    if (adminCaptainDestMarker) adminCaptainDestMarker.remove();
    const destEl = document.createElement('div');
    destEl.style.width = '24px';
    destEl.style.height = '24px';
    destEl.style.borderRadius = '50%';
    destEl.style.backgroundColor = '#ef4444';
    destEl.style.border = '2px solid white';
    destEl.style.boxShadow = '0 0 10px rgba(239,68,68,0.8)';
    destEl.style.display = 'flex';
    destEl.style.alignItems = 'center';
    destEl.style.justifyContent = 'center';
    destEl.style.color = 'white';
    destEl.style.fontSize = '12px';
    destEl.innerText = '🏁';

    adminCaptainDestMarker = new mapboxgl.Marker(destEl)
        .setLngLat([eLon, eLat])
        .addTo(adminCaptainMap);

    // Calculate directions route
    try {
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${sLon},${sLat};${eLon},${eLat}?geometries=geojson&overview=full&access_token=${MAPBOX_PUBLIC_TOKEN}`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data.routes && data.routes[0]) {
                const route = data.routes[0];
                const distKm = (route.distance / 1000).toFixed(1);
                document.getElementById('admin-route-dist-label').innerText = `${distKm} كم`;

                const source = adminCaptainMap.getSource('captain-route-source');
                if (source) {
                    source.setData({
                        type: 'Feature',
                        geometry: route.geometry
                    });
                }
            }
        }
    } catch (err) {
        // Fallback straight line
        const source = adminCaptainMap.getSource('captain-route-source');
        if (source) {
            source.setData({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: [[sLon, sLat], [eLon, eLat]]
                }
            });
        }
    }

    // Fit bounds
    const bounds = new mapboxgl.LngLatBounds();
    bounds.extend([sLon, sLat]);
    bounds.extend([eLon, eLat]);
    adminCaptainMap.fitBounds(bounds, { padding: 45, maxZoom: 14 });
}

async function submitAdminAddCaptain(event) {
    event.preventDefault();
    const btn = document.getElementById('btn-submit-add-captain');
    btn.disabled = true;
    btn.innerText = 'جاري الحفظ والتثبيت...';

    const fullName = document.getElementById('admin-drv-name').value.trim();
    const phoneNumber = document.getElementById('admin-drv-phone').value.trim();
    const email = document.getElementById('admin-drv-email').value.trim();
    const password = document.getElementById('admin-drv-password').value;

    const vehicleMake = document.getElementById('admin-drv-vehicle').value.trim();
    const vehiclePlate = document.getElementById('admin-drv-plate').value.trim();
    const vehicleColor = document.getElementById('admin-drv-color').value.trim();
    const availableSeats = parseInt(document.getElementById('admin-drv-seats').value, 10);
    const serviceType = document.getElementById('admin-drv-service').value;
    const vehicleType = document.getElementById('admin-drv-vehicle-type').value;

    const startName = document.getElementById('admin-route-start-label').innerText;
    const endName = document.getElementById('admin-route-dest-label').innerText;
    const startLat = parseFloat(document.getElementById('admin-route-start-lat').value);
    const startLon = parseFloat(document.getElementById('admin-route-start-lon').value);
    const endLat = parseFloat(document.getElementById('admin-route-end-lat').value);
    const endLon = parseFloat(document.getElementById('admin-route-end-lon').value);
    const fare = parseFloat(document.getElementById('admin-route-fare').value || 3000);

    const payload = {
        fullName,
        phoneNumber,
        email,
        password,
        vehicleMake,
        vehiclePlate,
        vehicleColor,
        availableSeats,
        serviceType,
        vehicleType,
        route: {
            startName,
            endName,
            startLat,
            startLon,
            endLat,
            endLon,
            fare,
            availableSeats,
            departureTime: '07:30 ص'
        }
    };

    try {
        const res = await fetch('/api/admin/drivers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resText = await res.text();
        let data = {};
        try {
            data = JSON.parse(resText);
        } catch (jsonErr) {
            console.error('Server returned non-JSON:', resText);
            throw new Error(`استجابة غير صالحة من السيرفر (${res.status})`);
        }

        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-check-double"></i> <span>حفظ واعتماد الكابتن وتثبيت مساره 🚀</span>';

        if (res.ok && data.success) {
            createdCaptainData = data.credentials;

            // Fill Success Box
            document.getElementById('succ-captain-name').innerText = fullName;
            document.getElementById('succ-captain-phone').innerText = phoneNumber;
            document.getElementById('succ-captain-pass').innerText = password;
            document.getElementById('succ-captain-route').innerText = `${startName} ➔ ${endName}`;

            // Configure WhatsApp link for direct sharing
            const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
            const intlPhone = cleanPhone.startsWith('0') ? '964' + cleanPhone.substring(1) : cleanPhone;
            const msg = `مرحباً كابتن ${fullName}،\nتم اعتماد وتفعيل حسابك بنجاح في منصة توصيلة (النجف الأشرف) 🚖\n\nبيانات تسجيل الدخول لتطبيق السائقين:\n🔹 اسم المستخدم / الهاتف: ${phoneNumber}\n🔹 كلمة المرور (الباسوورد): ${password}\n🔹 خط السير المعتمد: ${startName} ➔ ${endName}\n🔹 رابط تسجيل دخول الكباتن:\nhttps://tawseelaiq.app/captain-login\n\nيمكنك الآن تسجيل الدخول والمباشرة بالعمل واستقبال الركاب!`;
            
            const waLink = document.getElementById('succ-whatsapp-link');
            if (waLink) {
                waLink.href = `https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`;
            }

            document.getElementById('form-add-captain').style.display = 'none';
            document.getElementById('admin-captain-success-box').style.display = 'flex';

            showToast(`تم تسجيل واعتماد الكابتن ${fullName} بنجاح! 🎉`);
            loadDrivers();
            loadDashboardStats();
            loadVerifications();
        } else {
            alert(data.error || 'فشل تسجيل الكابتن، يرجى التحقق من صحة البيانات والمحاولة مجدداً.');
        }
    } catch (err) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-check-double"></i> <span>حفظ واعتماد الكابتن وتثبيت مساره 🚀</span>';
        alert('حدث خطأ في الاتصال بالخادم: ' + err.message);
    }
}

function copyCaptainCredentials() {
    if (!createdCaptainData) return;
    const text = `بيانات دخول الكابتن في منصة توصيلة 🚖\nالاسم: ${createdCaptainData.fullName}\nرقم الهاتف (اسم المستخدم): ${createdCaptainData.phoneNumber}\nكلمة المرور: ${createdCaptainData.password}\nرابط تسجيل دخول الكباتن: https://tawseelaiq.app/captain-login`;
    navigator.clipboard.writeText(text).then(() => {
        showToast('تم نسخ بيانات الدخول إلى الحافظة بنجاح! 📋');
    }).catch(() => {
        alert(text);
    });
}

function finishCaptainCreation() {
    closeAddCaptainModal();
    loadDrivers();
    loadVerifications();
    switchTab('drivers');
}

// Customer Creation
function openAddCustomerModal() {
    const modal = document.getElementById('modal-add-customer');
    if (modal) {
        modal.classList.add('active');
        modal.classList.remove('hidden', 'pointer-events-none');
        modal.style.display = 'flex';
        modal.style.pointerEvents = 'auto';
    }
}

function closeAddCustomerModal() {
    const modal = document.getElementById('modal-add-customer');
    if (modal) {
        modal.classList.remove('active');
        modal.classList.add('hidden', 'pointer-events-none');
        modal.style.display = 'none';
        modal.style.pointerEvents = 'none';
    }
}

async function submitAdminAddCustomer(event) {
    event.preventDefault();
    const fullName = document.getElementById('add-cust-name').value.trim();
    const phoneNumber = document.getElementById('add-cust-phone').value.trim();
    const route = document.getElementById('add-cust-route').value.trim();
    const address = document.getElementById('add-cust-address').value.trim();
    const password = document.getElementById('add-cust-password').value.trim();

    try {
        const res = await fetch(`${API_BASE}/customers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName, phoneNumber, route, address, password })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showToast('تم إنشاء وتفعيل حساب الراكب بنجاح! ✅');
            closeAddCustomerModal();
            const form = document.getElementById('form-add-customer');
            if (form) form.reset();
            loadCustomers();
        } else {
            alert(data.error || 'فشل إنشاء حساب الراكب');
        }
    } catch (e) {
        alert('خطأ في الاتصال بالخادم.');
    }
}

// =============================================================================
// Interactive Maps in Customer & Driver Edit Modals
// =============================================================================
let editCustMap = null;
let editCustPickupMarker = null;
let editCustDropoffMarker = null;
let editCustMode = 'pickup';

let editDrvMap = null;
let editDrvPickupMarker = null;
let editDrvDropoffMarker = null;
let editDrvMode = 'pickup';

function setEditMapMode(type, mode) {
    if (type === 'customer') {
        editCustMode = mode;
        const btnPickup = document.getElementById('btn-mode-cust-pickup');
        const btnDropoff = document.getElementById('btn-mode-cust-dropoff');
        if (btnPickup && btnDropoff) {
            if (mode === 'pickup') {
                btnPickup.className = 'px-2.5 py-1 text-xs font-bold rounded-lg bg-emerald-600 text-white transition shadow-sm';
                btnDropoff.className = 'px-2.5 py-1 text-xs font-bold rounded-lg text-slate-600 hover:text-slate-900 transition';
            } else {
                btnPickup.className = 'px-2.5 py-1 text-xs font-bold rounded-lg text-slate-600 hover:text-slate-900 transition';
                btnDropoff.className = 'px-2.5 py-1 text-xs font-bold rounded-lg bg-rose-600 text-white transition shadow-sm';
            }
        }
    } else {
        editDrvMode = mode;
        const btnPickup = document.getElementById('btn-mode-drv-pickup');
        const btnDropoff = document.getElementById('btn-mode-drv-dropoff');
        if (btnPickup && btnDropoff) {
            if (mode === 'pickup') {
                btnPickup.className = 'px-2.5 py-1 text-xs font-bold rounded-lg bg-emerald-600 text-white transition shadow-sm';
                btnDropoff.className = 'px-2.5 py-1 text-xs font-bold rounded-lg text-slate-600 hover:text-slate-900 transition';
            } else {
                btnPickup.className = 'px-2.5 py-1 text-xs font-bold rounded-lg text-slate-600 hover:text-slate-900 transition';
                btnDropoff.className = 'px-2.5 py-1 text-xs font-bold rounded-lg bg-rose-600 text-white transition shadow-sm';
            }
        }
    }
}

function createPinElement(color, label) {
    const el = document.createElement('div');
    el.style.cssText = `background:${color};width:24px;height:24px;border-radius:50%;border:2px solid white;box-shadow:0 3px 8px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:bold;cursor:pointer;`;
    el.innerHTML = label;
    return el;
}

const DASHBOARD_IRAQ_GOVERNORATES = {
    najaf:        { name: 'النجف',       center: [44.3168, 31.9961], bbox: '44.05,31.75,44.65,32.35' },
    baghdad:      { name: 'بغداد',       center: [44.3661, 33.3152], bbox: '44.10,33.10,44.65,33.55' },
    basra:        { name: 'البصرة',      center: [47.7835, 30.5085], bbox: '47.30,29.90,48.60,31.20' },
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

window.onEditModalGovChange = function(type, govKey) {
    const gov = DASHBOARD_IRAQ_GOVERNORATES[govKey] || DASHBOARD_IRAQ_GOVERNORATES.najaf;
    const parts = gov.bbox.split(',').map(Number);
    const bounds = [[parts[0], parts[1]], [parts[2], parts[3]]];
    const targetMap = type === 'customer' ? editCustMap : editDrvMap;
    const searchInput = document.getElementById(type === 'customer' ? 'edit-cust-map-search' : 'edit-drv-map-search');
    if (searchInput) {
        searchInput.placeholder = `🔍 ابحث عن موقع في ${gov.name}...`;
        searchInput.value = '';
    }
    const resultsContainer = document.getElementById(type === 'customer' ? 'edit-cust-search-results' : 'edit-drv-search-results');
    if (resultsContainer) {
        resultsContainer.innerHTML = '';
        resultsContainer.classList.add('hidden');
    }

    if (targetMap) {
        try { targetMap.setMaxBounds(bounds); } catch(_) {}
        targetMap.flyTo({ center: gov.center, zoom: 13 });
    }
};

function initEditCustomerMap(customer) {
    const container = document.getElementById('edit-cust-mapbox-container');
    if (!container || typeof mapboxgl === 'undefined') return;

    ensureMapboxRTL();
    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;

    const govKey = (document.getElementById('edit-cust-gov') && document.getElementById('edit-cust-gov').value) || customer.governorate || 'najaf';
    const gov = DASHBOARD_IRAQ_GOVERNORATES[govKey] || DASHBOARD_IRAQ_GOVERNORATES.najaf;
    const parts = gov.bbox.split(',').map(Number);
    const bounds = [[parts[0], parts[1]], [parts[2], parts[3]]];

    const pLat = customer.permanentLat || (customer.routeLat || gov.center[1]);
    const pLon = customer.permanentLon || (customer.routeLon || gov.center[0]);

    document.getElementById('edit-cust-lat').value = customer.permanentLat || '';
    document.getElementById('edit-cust-lon').value = customer.permanentLon || '';
    document.getElementById('edit-cust-location-name').value = customer.permanentLocationName || '';
    document.getElementById('edit-cust-dropoff-lat').value = customer.permanentDropoffLat || '';
    document.getElementById('edit-cust-dropoff-lon').value = customer.permanentDropoffLon || '';
    document.getElementById('edit-cust-dropoff-name').value = customer.permanentDropoffName || '';

    document.getElementById('disp-edit-cust-pickup').textContent = customer.permanentLocationName || customer.address || (customer.permanentLat ? `${customer.permanentLat}, ${customer.permanentLon}` : 'لم يحدد');
    document.getElementById('disp-edit-cust-dropoff').textContent = customer.permanentDropoffName || customer.route || (customer.permanentDropoffLat ? `${customer.permanentDropoffLat}, ${customer.permanentDropoffLon}` : 'لم يحدد');

    if (!editCustMap) {
        editCustMap = new mapboxgl.Map({
            container: 'edit-cust-mapbox-container',
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [pLon, pLat],
            zoom: 13,
            maxBounds: bounds
        });
        editCustMap.addControl(new mapboxgl.NavigationControl(), 'top-left');

        editCustMap.on('click', async (e) => {
            const { lng, lat } = e.lngLat;
            await applyEditModalCoordinate('customer', editCustMode, lat, lng);
        });
    } else {
        try { editCustMap.setMaxBounds(bounds); } catch(_) {}
        editCustMap.setCenter([pLon, pLat]);
        editCustMap.resize();
    }

    setTimeout(() => {
        if (editCustMap) editCustMap.resize();
    }, 200);

    if (editCustPickupMarker) editCustPickupMarker.remove();
    if (editCustDropoffMarker) editCustDropoffMarker.remove();

    if (customer.permanentLat && customer.permanentLon) {
        editCustPickupMarker = new mapboxgl.Marker({ element: createPinElement('#10B981', '🟢') })
            .setLngLat([customer.permanentLon, customer.permanentLat])
            .addTo(editCustMap);
    }
    if (customer.permanentDropoffLat && customer.permanentDropoffLon) {
        editCustDropoffMarker = new mapboxgl.Marker({ element: createPinElement('#EF4444', '🔴') })
            .setLngLat([customer.permanentDropoffLon, customer.permanentDropoffLat])
            .addTo(editCustMap);
    }
}

function initEditDriverMap(driver) {
    const container = document.getElementById('edit-drv-mapbox-container');
    if (!container || typeof mapboxgl === 'undefined') return;

    ensureMapboxRTL();
    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;

    const govKey = (document.getElementById('edit-drv-gov') && document.getElementById('edit-drv-gov').value) || driver.governorate || 'najaf';
    const gov = DASHBOARD_IRAQ_GOVERNORATES[govKey] || DASHBOARD_IRAQ_GOVERNORATES.najaf;
    const parts = gov.bbox.split(',').map(Number);
    const bounds = [[parts[0], parts[1]], [parts[2], parts[3]]];

    const pLat = driver.permanentLat || (driver.latitude || gov.center[1]);
    const pLon = driver.permanentLon || (driver.longitude || gov.center[0]);

    document.getElementById('edit-drv-lat').value = driver.permanentLat || '';
    document.getElementById('edit-drv-lon').value = driver.permanentLon || '';
    document.getElementById('edit-drv-location-name').value = driver.permanentLocationName || '';
    document.getElementById('edit-drv-dropoff-lat').value = driver.permanentDropoffLat || '';
    document.getElementById('edit-drv-dropoff-lon').value = driver.permanentDropoffLon || '';
    document.getElementById('edit-drv-dropoff-name').value = driver.permanentDropoffName || '';

    document.getElementById('disp-edit-drv-pickup').textContent = driver.permanentLocationName || driver.route || (driver.permanentLat ? `${driver.permanentLat}, ${driver.permanentLon}` : 'لم يحدد');
    document.getElementById('disp-edit-drv-dropoff').textContent = driver.permanentDropoffName || (driver.permanentDropoffLat ? `${driver.permanentDropoffLat}, ${driver.permanentDropoffLon}` : 'لم يحدد');

    if (!editDrvMap) {
        editDrvMap = new mapboxgl.Map({
            container: 'edit-drv-mapbox-container',
            style: 'mapbox://styles/mapbox/navigation-night-v1',
            center: [pLon, pLat],
            zoom: 13,
            maxBounds: bounds
        });
        editDrvMap.addControl(new mapboxgl.NavigationControl(), 'top-left');

        editDrvMap.on('click', async (e) => {
            const { lng, lat } = e.lngLat;
            await applyEditModalCoordinate('driver', editDrvMode, lat, lng);
        });
    } else {
        try { editDrvMap.setMaxBounds(bounds); } catch(_) {}
        editDrvMap.setCenter([pLon, pLat]);
        editDrvMap.resize();
    }

    setTimeout(() => {
        if (editDrvMap) editDrvMap.resize();
    }, 200);

    if (editDrvPickupMarker) editDrvPickupMarker.remove();
    if (editDrvDropoffMarker) editDrvDropoffMarker.remove();

    if (driver.permanentLat && driver.permanentLon) {
        editDrvPickupMarker = new mapboxgl.Marker({ element: createPinElement('#10B981', '🟢') })
            .setLngLat([driver.permanentLon, driver.permanentLat])
            .addTo(editDrvMap);
    }
    if (driver.permanentDropoffLat && driver.permanentDropoffLon) {
        editDrvDropoffMarker = new mapboxgl.Marker({ element: createPinElement('#EF4444', '🔴') })
            .setLngLat([driver.permanentDropoffLon, driver.permanentDropoffLat])
            .addTo(editDrvMap);
    }
}

async function applyEditModalCoordinate(type, mode, lat, lon, customName) {
    let placeName = customName;
    if (!placeName) {
        try {
            const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?access_token=${MAPBOX_PUBLIC_TOKEN}&language=ar&types=poi,neighborhood,locality,place,address`);
            const data = await res.json();
            if (data.features && data.features.length > 0) {
                placeName = data.features[0].text || data.features[0].place_name;
            }
        } catch (_) {}
    }
    placeName = placeName || `موقع في النجف (${lat.toFixed(4)}, ${lon.toFixed(4)})`;

    if (type === 'customer') {
        if (mode === 'pickup') {
            document.getElementById('edit-cust-lat').value = lat;
            document.getElementById('edit-cust-lon').value = lon;
            document.getElementById('edit-cust-location-name').value = placeName;
            document.getElementById('disp-edit-cust-pickup').textContent = placeName;
            document.getElementById('edit-cust-address').value = placeName;
            if (editCustPickupMarker) editCustPickupMarker.remove();
            editCustPickupMarker = new mapboxgl.Marker({ element: createPinElement('#10B981', '🟢') })
                .setLngLat([lon, lat])
                .addTo(editCustMap);
        } else {
            document.getElementById('edit-cust-dropoff-lat').value = lat;
            document.getElementById('edit-cust-dropoff-lon').value = lon;
            document.getElementById('edit-cust-dropoff-name').value = placeName;
            document.getElementById('disp-edit-cust-dropoff').textContent = placeName;
            const pName = document.getElementById('edit-cust-location-name').value || 'النجف';
            document.getElementById('edit-cust-route').value = `${pName} → ${placeName}`;
            if (editCustDropoffMarker) editCustDropoffMarker.remove();
            editCustDropoffMarker = new mapboxgl.Marker({ element: createPinElement('#EF4444', '🔴') })
                .setLngLat([lon, lat])
                .addTo(editCustMap);
        }
    } else {
        if (mode === 'pickup') {
            document.getElementById('edit-drv-lat').value = lat;
            document.getElementById('edit-drv-lon').value = lon;
            document.getElementById('edit-drv-location-name').value = placeName;
            document.getElementById('disp-edit-drv-pickup').textContent = placeName;
            document.getElementById('edit-drv-route').value = placeName;
            if (editDrvPickupMarker) editDrvPickupMarker.remove();
            editDrvPickupMarker = new mapboxgl.Marker({ element: createPinElement('#10B981', '🟢') })
                .setLngLat([lon, lat])
                .addTo(editDrvMap);
        } else {
            document.getElementById('edit-drv-dropoff-lat').value = lat;
            document.getElementById('edit-drv-dropoff-lon').value = lon;
            document.getElementById('edit-drv-dropoff-name').value = placeName;
            document.getElementById('disp-edit-drv-dropoff').textContent = placeName;
            const pName = document.getElementById('edit-drv-location-name').value || 'النجف';
            document.getElementById('edit-drv-route').value = `${pName} → ${placeName}`;
            if (editDrvDropoffMarker) editDrvDropoffMarker.remove();
            editDrvDropoffMarker = new mapboxgl.Marker({ element: createPinElement('#EF4444', '🔴') })
                .setLngLat([lon, lat])
                .addTo(editDrvMap);
        }
    }
}

let editModalSearchDebounce = null;
async function searchEditModalPlace(query, type) {
    const resultsContainer = document.getElementById(type === 'customer' ? 'edit-cust-search-results' : 'edit-drv-search-results');
    if (!resultsContainer) return;
    if (!query || query.trim().length === 0) {
        resultsContainer.innerHTML = '';
        resultsContainer.classList.add('hidden');
        return;
    }

    clearTimeout(editModalSearchDebounce);
    editModalSearchDebounce = setTimeout(async () => {
        try {
            const govKey = (document.getElementById(type === 'customer' ? 'edit-cust-gov' : 'edit-drv-gov') || {}).value || 'najaf';
            const gov = DASHBOARD_IRAQ_GOVERNORATES[govKey] || DASHBOARD_IRAQ_GOVERNORATES.najaf;
            const bbox = gov.bbox;
            const prox = gov.center.join(',');
            const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query.trim())}.json?access_token=${MAPBOX_PUBLIC_TOKEN}&country=iq&bbox=${bbox}&proximity=${prox}&language=ar&types=poi,address,neighborhood,locality,place,district&limit=10&autocomplete=true`);
            const data = await res.json();
            if (!data.features || data.features.length === 0) {
                resultsContainer.innerHTML = `<div class="p-2 text-slate-400 text-center">لا توجد نتائج مطابقة في ${gov.name}</div>`;
                resultsContainer.classList.remove('hidden');
                return;
            }

            resultsContainer.innerHTML = '';
            data.features.forEach(f => {
                const item = document.createElement('div');
                item.className = 'p-2 hover:bg-slate-50 cursor-pointer font-medium text-slate-800 flex items-center justify-between';
                item.innerHTML = `<span>📍 ${f.place_name}</span>`;
                item.onclick = async () => {
                    const [lon, lat] = f.center;
                    const mode = type === 'customer' ? editCustMode : editDrvMode;
                    const targetMap = type === 'customer' ? editCustMap : editDrvMap;
                    await applyEditModalCoordinate(type, mode, lat, lon, f.text || f.place_name);
                    if (targetMap) {
                        targetMap.flyTo({ center: [lon, lat], zoom: 14 });
                    }
                    resultsContainer.innerHTML = '';
                    resultsContainer.classList.add('hidden');
                    const searchInput = document.getElementById(type === 'customer' ? 'edit-cust-map-search' : 'edit-drv-map-search');
                    if (searchInput) searchInput.value = '';
                };
                resultsContainer.appendChild(item);
            });
            resultsContainer.classList.remove('hidden');
        } catch (_) {}
    }, 250);
}

// Customer Editing
function openEditCustomerModal(customerId) {
    const customer = (window.customersMap && window.customersMap[customerId]) || {};
    document.getElementById('edit-cust-id').value = customerId;
    document.getElementById('edit-cust-name').value = customer.fullName || '';
    document.getElementById('edit-cust-phone').value = customer.phoneNumber || '';
    document.getElementById('edit-cust-route').value = customer.route || customer.area || '';
    document.getElementById('edit-cust-address').value = customer.address || customer.area || '';
    document.getElementById('edit-cust-password').value = '';

    const govKey = customer.governorate || 'najaf';
    const govEl = document.getElementById('edit-cust-gov');
    if (govEl) govEl.value = govKey;
    const govObj = DASHBOARD_IRAQ_GOVERNORATES[govKey] || DASHBOARD_IRAQ_GOVERNORATES.najaf;
    const searchInput = document.getElementById('edit-cust-map-search');
    if (searchInput) {
        searchInput.placeholder = `🔍 ابحث عن موقع في ${govObj.name}...`;
        searchInput.value = '';
    }

    setEditMapMode('customer', 'pickup');

    const modal = document.getElementById('modal-edit-customer');
    if (modal) {
        modal.classList.add('active');
        modal.classList.remove('hidden');
        modal.classList.remove('pointer-events-none');
        modal.style.display = 'flex';
        modal.style.pointerEvents = 'auto';
    }

    setTimeout(() => {
        initEditCustomerMap(customer);
    }, 100);
}

function closeEditCustomerModal() {
    const modal = document.getElementById('modal-edit-customer');
    if (modal) {
        modal.classList.remove('active');
        modal.classList.add('hidden');
        modal.classList.add('pointer-events-none');
        modal.style.display = 'none';
        modal.style.pointerEvents = 'none';
    }
}

async function submitEditCustomer(event) {
    event.preventDefault();
    const customerId = document.getElementById('edit-cust-id').value;
    const fullName = document.getElementById('edit-cust-name').value.trim();
    const phoneNumber = document.getElementById('edit-cust-phone').value.trim();
    const route = document.getElementById('edit-cust-route').value.trim();
    const address = document.getElementById('edit-cust-address').value.trim();
    const password = document.getElementById('edit-cust-password').value.trim();
    const governorate = (document.getElementById('edit-cust-gov') && document.getElementById('edit-cust-gov').value) || 'najaf';

    const permanentLat = document.getElementById('edit-cust-lat').value;
    const permanentLon = document.getElementById('edit-cust-lon').value;
    const permanentLocationName = document.getElementById('edit-cust-location-name').value;
    const permanentDropoffLat = document.getElementById('edit-cust-dropoff-lat').value;
    const permanentDropoffLon = document.getElementById('edit-cust-dropoff-lon').value;
    const permanentDropoffName = document.getElementById('edit-cust-dropoff-name').value;

    try {
        const payload = {
            fullName, phoneNumber, route, address, governorate,
            permanentLat: permanentLat || null,
            permanentLon: permanentLon || null,
            permanentLocationName: permanentLocationName || address,
            permanentDropoffLat: permanentDropoffLat || null,
            permanentDropoffLon: permanentDropoffLon || null,
            permanentDropoffName: permanentDropoffName || route
        };
        if (password) payload.password = password;

        const res = await fetch(`${API_BASE}/customers/${customerId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showToast('تم تحديث بيانات ومحافظة ومسار الراكب بنجاح! ✅');
            closeEditCustomerModal();
            loadCustomers();
            if (typeof refreshRoutesAndBookingsOnMap === 'function') refreshRoutesAndBookingsOnMap();
        } else {
            alert(data.error || 'فشل تحديث بيانات الراكب.');
        }
    } catch (e) {
        alert('خطأ في الاتصال بالخادم.');
    }
}

// Driver Editing
function openEditDriverModal(driverId) {
    const driver = (window.driversMap && window.driversMap[driverId]) || {};
    document.getElementById('edit-drv-id').value = driverId;
    document.getElementById('edit-drv-name').value = driver.fullName || '';
    document.getElementById('edit-drv-phone').value = driver.phoneNumber || '';
    document.getElementById('edit-drv-route').value = driver.route || '';
    document.getElementById('edit-drv-password').value = '';
    const vehicleTypeEl = document.getElementById('edit-drv-vehicle-type');
    if (vehicleTypeEl) vehicleTypeEl.value = driver.vehicleType === 'vip' ? 'vip' : 'eco';

    const govKey = driver.governorate || 'najaf';
    const govEl = document.getElementById('edit-drv-gov');
    if (govEl) govEl.value = govKey;
    const govObj = DASHBOARD_IRAQ_GOVERNORATES[govKey] || DASHBOARD_IRAQ_GOVERNORATES.najaf;
    const searchInput = document.getElementById('edit-drv-map-search');
    if (searchInput) {
        searchInput.placeholder = `🔍 ابحث عن موقع في ${govObj.name}...`;
        searchInput.value = '';
    }

    setEditMapMode('driver', 'pickup');

    const modal = document.getElementById('modal-edit-driver');
    if (modal) {
        modal.classList.add('active');
        modal.classList.remove('hidden');
        modal.classList.remove('pointer-events-none');
        modal.style.display = 'flex';
        modal.style.pointerEvents = 'auto';
    }

    setTimeout(() => {
        initEditDriverMap(driver);
    }, 100);
}

function closeEditDriverModal() {
    const modal = document.getElementById('modal-edit-driver');
    if (modal) {
        modal.classList.remove('active');
        modal.classList.add('hidden');
        modal.classList.add('pointer-events-none');
        modal.style.display = 'none';
        modal.style.pointerEvents = 'none';
    }
}

async function submitEditDriver(event) {
    event.preventDefault();
    const driverId = document.getElementById('edit-drv-id').value;
    const fullName = document.getElementById('edit-drv-name').value.trim();
    const phoneNumber = document.getElementById('edit-drv-phone').value.trim();
    const route = document.getElementById('edit-drv-route').value.trim();
    const password = document.getElementById('edit-drv-password').value.trim();
    const governorate = (document.getElementById('edit-drv-gov') && document.getElementById('edit-drv-gov').value) || 'najaf';
    const vehicleType = (document.getElementById('edit-drv-vehicle-type') || {}).value || 'eco';

    const permanentLat = document.getElementById('edit-drv-lat').value;
    const permanentLon = document.getElementById('edit-drv-lon').value;
    const permanentLocationName = document.getElementById('edit-drv-location-name').value;
    const permanentDropoffLat = document.getElementById('edit-drv-dropoff-lat').value;
    const permanentDropoffLon = document.getElementById('edit-drv-dropoff-lon').value;
    const permanentDropoffName = document.getElementById('edit-drv-dropoff-name').value;

    try {
        const payload = {
            fullName, phoneNumber, route, governorate, vehicleType,
            permanentLat: permanentLat || null,
            permanentLon: permanentLon || null,
            permanentLocationName: permanentLocationName || route,
            permanentDropoffLat: permanentDropoffLat || null,
            permanentDropoffLon: permanentDropoffLon || null,
            permanentDropoffName: permanentDropoffName || ''
        };
        if (password) payload.password = password;

        const res = await fetch(`${API_BASE}/drivers/${driverId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showToast('تم تحديث بيانات ومحافظة ومسار الكابتن بنجاح! ✅');
            closeEditDriverModal();
            loadDrivers();
            if (typeof refreshRoutesAndBookingsOnMap === 'function') refreshRoutesAndBookingsOnMap();
        } else {
            alert(data.error || 'فشل تحديث بيانات الكابتن.');
        }
    } catch (e) {
        alert('خطأ في الاتصال بالخادم.');
    }
}

// Fleet Map Instant Search (Najaf Only - From 1st Character)
let fleetMapSearchDebounce = null;
let fleetMapSearchMarker = null;

async function searchFleetMapPlace(val) {
    const q = (val || '').trim();
    const box = document.getElementById('fleet-map-search-results');
    const clearBtn = document.getElementById('btn-clear-fleet-search');
    if (!box) return;

    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !q);
    }

    if (!q || q.length < 1) {
        box.innerHTML = '';
        box.classList.add('hidden');
        return;
    }

    const qLower = q.toLowerCase();
    const localMatches = ADMIN_NAJAF_PLACES
        .filter(p => p.name.toLowerCase().includes(qLower))
        .map(p => ({
            name: p.name,
            category: 'معلم / منطقة في النجف',
            icon: '📍',
            lat: p.lat,
            lon: p.lon
        }));

    renderFleetSearchResults(localMatches);

    clearTimeout(fleetMapSearchDebounce);
    fleetMapSearchDebounce = setTimeout(async () => {
        try {
            const geocodeUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?country=iq&proximity=44.345,32.015&bbox=44.05,31.75,44.65,32.35&language=ar&access_token=${MAPBOX_PUBLIC_TOKEN}`;
            const res = await fetch(geocodeUrl);
            if (res.ok) {
                const geoData = await res.json();
                const mbFeatures = geoData.features || [];
                const combined = [...localMatches];
                const seen = new Set(localMatches.map(m => m.name.toLowerCase()));

                mbFeatures.forEach(feat => {
                    const featName = (feat.place_name_ar || feat.place_name || feat.text || '').trim();
                    const center = feat.center;
                    if (isStrictlyNajafLocation(featName, center) && !seen.has(featName.toLowerCase())) {
                        seen.add(featName.toLowerCase());
                        combined.push({
                            name: featName,
                            category: 'موقع في النجف الأشرف',
                            icon: '📍',
                            lat: center[1],
                            lon: center[0]
                        });
                    }
                });
                renderFleetSearchResults(combined);
            }
        } catch (_) {}
    }, 150);
}

function renderFleetSearchResults(items) {
    const box = document.getElementById('fleet-map-search-results');
    if (!box) return;
    if (!items || items.length === 0) {
        box.innerHTML = '<div class="p-3 text-xs text-slate-400 text-center">لا توجد نتائج داخل محافظة النجف الأشرف</div>';
        box.classList.remove('hidden');
        return;
    }

    box.innerHTML = items.slice(0, 10).map((item, idx) => `
        <div onclick="selectFleetMapPlace(${item.lat}, ${item.lon}, '${item.name.replace(/'/g, "\\'")}')"
             class="p-2.5 hover:bg-amber-50 cursor-pointer flex items-center justify-between transition text-xs">
            <div class="flex items-center gap-2">
                <span>${item.icon || '📍'}</span>
                <div>
                    <div class="font-bold text-slate-800">${item.name}</div>
                    <div class="text-[10px] text-slate-400">${item.category}</div>
                </div>
            </div>
            <span class="text-[10px] bg-amber-100 text-amber-900 font-bold px-2 py-0.5 rounded-full">عرض بالخريطة</span>
        </div>
    `).join('');
    box.classList.remove('hidden');
}

function selectFleetMapPlace(lat, lon, name) {
    const box = document.getElementById('fleet-map-search-results');
    const input = document.getElementById('fleet-map-search-input');
    if (box) box.classList.add('hidden');
    if (input) input.value = name;

    if (fleetMapInstance) {
        fleetMapInstance.flyTo({ center: [lon, lat], zoom: 15, essential: true });

        if (fleetMapSearchMarker) fleetMapSearchMarker.remove();

        const el = document.createElement('div');
        el.className = 'w-8 h-8 rounded-full bg-rose-600 text-white flex items-center justify-center font-bold text-base shadow-xl ring-4 ring-white animate-bounce';
        el.innerHTML = '📍';

        fleetMapSearchMarker = new mapboxgl.Marker(el)
            .setLngLat([lon, lat])
            .setPopup(new mapboxgl.Popup({ offset: 25 }).setHTML(`<div class="font-bold p-1 text-slate-900">${name}</div>`))
            .addTo(fleetMapInstance);
        fleetMapSearchMarker.togglePopup();
    }
}

function clearFleetMapSearch() {
    const input = document.getElementById('fleet-map-search-input');
    const box = document.getElementById('fleet-map-search-results');
    const clearBtn = document.getElementById('btn-clear-fleet-search');
    if (input) input.value = '';
    if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
    if (clearBtn) clearBtn.classList.add('hidden');
    if (fleetMapSearchMarker) { fleetMapSearchMarker.remove(); fleetMapSearchMarker = null; }
}

// Window Global Exports
window.checkAdminAuth = checkAdminAuth;
window.handleAdminLogin = handleAdminLogin;
window.logoutAdmin = logoutAdmin;
window.switchTab = switchTab;
window.toggleMobileSidebar = toggleMobileSidebar;
function openDocumentModal() {}
window.openDocumentModal = openDocumentModal;
window.closeDocumentModal = closeDocumentModal;
window.openZoomImage = openZoomImage;
window.closeZoomModal = closeZoomModal;
window.openAddCaptainModal = openAddCaptainModal;
window.closeAddCaptainModal = closeAddCaptainModal;
window.generateCaptainPassword = generateCaptainPassword;
window.generateUniquePasswordToInput = generateUniquePasswordToInput;
window.checkAdminCaptainPhone = checkAdminCaptainPhone;
window.searchFleetMapPlace = searchFleetMapPlace;
window.selectFleetMapPlace = selectFleetMapPlace;
window.clearFleetMapSearch = clearFleetMapSearch;
window.initAdminCaptainRouteMap = initAdminCaptainRouteMap;
window.setAdminMapPickMode = setAdminMapPickMode;
window.searchAdminNajafPlace = searchAdminNajafPlace;
window.selectAdminNajafPlace = selectAdminNajafPlace;
window.updateAdminCaptainRouteMap = updateAdminCaptainRouteMap;
window.submitAdminAddCaptain = submitAdminAddCaptain;
window.copyCaptainCredentials = copyCaptainCredentials;
window.finishCaptainCreation = finishCaptainCreation;
window.openAddCustomerModal = openAddCustomerModal;
window.closeAddCustomerModal = closeAddCustomerModal;
window.submitAdminAddCustomer = submitAdminAddCustomer;
window.openEditCustomerModal = openEditCustomerModal;
window.closeEditCustomerModal = closeEditCustomerModal;
window.submitEditCustomer = submitEditCustomer;
window.openEditDriverModal = openEditDriverModal;
window.closeEditDriverModal = closeEditDriverModal;
window.submitEditDriver = submitEditDriver;
window.loadDashboardStats = loadDashboardStats;
window.loadMatchingSettings = loadMatchingSettings;
window.loadPricingSettings = loadPricingSettings;
window.savePricingSettings = savePricingSettings;
window.applyQuickEmergencyOverride = applyQuickEmergencyOverride;
window.runLiveFareSimulator = runLiveFareSimulator;
window.saveMatchingSettings = saveMatchingSettings;
window.acceptBookingFromAdmin = acceptBookingFromAdmin;
window.declineBookingFromAdmin = declineBookingFromAdmin;

// -----------------------------------------------------------------------------
// Passenger Cancellation Requests (Driver -> Admin Approval)
// -----------------------------------------------------------------------------
async function loadCancellationRequests() {
    const loading = document.getElementById('cancellations-loading');
    const empty = document.getElementById('cancellations-empty');
    const table = document.getElementById('cancellations-table');
    const body = document.getElementById('cancellations-body');
    const badge = document.getElementById('cancellations-count-badge');

    if (loading) loading.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
    if (table) table.classList.add('hidden');
    if (body) body.innerHTML = '';

    try {
        const res = await fetch(`${API_BASE}/cancellation-requests`);
        const data = await res.json();
        const requests = (data && data.requests) ? data.requests : [];

        if (loading) loading.classList.add('hidden');

        if (badge) badge.innerText = `${requests.length} طلب`;

        const pendingCount = requests.filter(r => r.status === 'Pending').length;
        const navBadge = document.getElementById('badge-cancellations');
        if (navBadge) {
            if (pendingCount > 0) {
                navBadge.innerText = pendingCount;
                navBadge.classList.remove('hidden');
            } else {
                navBadge.classList.add('hidden');
            }
        }

        if (requests.length === 0) {
            if (empty) empty.classList.remove('hidden');
            return;
        }

        if (table) table.classList.remove('hidden');

        requests.forEach(r => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50/80 transition-colors border-b border-slate-100/80 text-xs md:text-sm';

            let statusBadge = '';
            if (r.status === 'Approved') {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold badge-emerald shadow-xs"><span class="badge-dot"></span><span>تم الاعتماد ✓</span></span>';
            } else if (r.status === 'Rejected') {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold badge-rose shadow-xs"><span class="badge-dot"></span><span>مرفوض ✕</span></span>';
            } else {
                statusBadge = '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold badge-amber shadow-xs"><span class="badge-dot animate-pulse"></span><span>قيد المراجعة ⏳</span></span>';
            }

            let driverDecisionBadge = '';
            const dec = String(r.driverDecision || '').toLowerCase();
            if (dec === 'approved') {
                driverDecisionBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold badge-emerald shadow-xs"><span class="badge-dot"></span><span>موافقة ✓</span></span>';
            } else if (dec === 'rejected') {
                driverDecisionBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold badge-rose shadow-xs"><span class="badge-dot"></span><span>رفض ✕</span></span>';
            } else {
                driverDecisionBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold badge-amber shadow-xs"><span class="badge-dot animate-pulse"></span><span>في انتظار الرد ⏳</span></span>';
            }

            let actionButtons = '';
            if (r.status === 'Pending') {
                actionButtons = `
                    <div class="flex items-center justify-center gap-1.5 mt-1.5">
                        <button onclick="approveCancellationRequest('${r.id || r.requestId}')" 
                                class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium text-xs flex items-center gap-1 transition shadow-xs cursor-pointer" title="اعتماد الإلغاء وتحرير المقعد">
                            <i class="fa-solid fa-check text-[10px]"></i>
                            <span>اعتماد</span>
                        </button>
                        <button onclick="rejectCancellationRequest('${r.id || r.requestId}')" 
                                class="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-medium text-xs flex items-center gap-1 transition shadow-xs cursor-pointer" title="رفض طلب الإلغاء">
                            <i class="fa-solid fa-xmark text-[10px]"></i>
                            <span>رفض</span>
                        </button>
                    </div>
                `;
            }

            const pReason = r.passengerReason || r.reason || 'ظروف شخصية';
            const pDetails = r.passengerDetails ? `<div class="text-xs text-slate-400 mt-0.5 max-w-xs truncate" title="${escapeHtml(r.passengerDetails)}">${escapeHtml(r.passengerDetails)}</div>` : '';
            const drvReason = r.driverApprovalReason ? `<div class="text-xs font-medium text-slate-700 max-w-xs truncate" title="${escapeHtml(r.driverApprovalReason)}">${escapeHtml(r.driverApprovalReason)}</div>` : '<span class="text-slate-400 text-xs">—</span>';

            const custPhoneHtml = r.customerPhone
                ? `<a href="tel:${escapeHtml(r.customerPhone)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs mt-0.5 transition-colors" dir="ltr" title="اتصال بالراكب"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(r.customerPhone)}</span></a>`
                : '';

            const drvPhoneHtml = r.driverPhone
                ? `<a href="tel:${escapeHtml(r.driverPhone)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs mt-0.5 transition-colors" dir="ltr" title="اتصال بالسائق"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(r.driverPhone)}</span></a>`
                : '';

            tr.innerHTML = `
                <td class="py-3.5 px-4 font-mono font-bold text-slate-700 text-xs">${r.id || r.requestId || ''}</td>
                <td class="py-3.5 px-4">
                    <div class="font-bold text-slate-900">${escapeHtml(r.customerName || 'الراكب')}</div>
                    ${custPhoneHtml}
                </td>
                <td class="py-3.5 px-4">
                    <div class="font-bold text-slate-900">${escapeHtml(r.driverName || 'الكابتن')}</div>
                    ${drvPhoneHtml}
                </td>
                <td class="py-3.5 px-4 text-slate-700 font-semibold text-xs">${escapeHtml(r.route || 'مسار الرحلة')}</td>
                <td class="py-3.5 px-4">
                    <div class="font-bold text-slate-800 text-xs">${escapeHtml(pReason)}</div>
                    ${pDetails}
                </td>
                <td class="py-3.5 px-4 text-center">${driverDecisionBadge}</td>
                <td class="py-3.5 px-4">${drvReason}</td>
                <td class="py-3.5 px-4 text-center">
                    <div>${statusBadge}</div>
                    ${actionButtons}
                </td>
            `;
            body.appendChild(tr);
        });

    } catch (e) {
        if (loading) loading.classList.add('hidden');
        if (empty) {
            empty.innerText = 'حدث خطأ أثناء تحميل طلبات الإلغاء';
            empty.classList.remove('hidden');
        }
    }
}

async function approveCancellationRequest(requestId) {
    if (!confirm('هل أنت متأكد من قبول طلب الإلغاء؟ سيتم إلغاء حجز الراكب وتحرير المقعد فورياً للمسار.')) return;
    try {
        const res = await fetch(`${API_BASE}/cancellation-requests/${requestId}/approve`, {
            method: 'POST'
        });
        const data = await res.json();
        if (res.ok && data.success) {
            alert('تم قبول طلب الإلغاء بنجاح وتحرير المقعد!');
            loadCancellationRequests();
            loadDashboardStats();
            loadRoutes();
        } else {
            alert(data.error || 'فشل قبول طلب الإلغاء');
        }
    } catch (err) {
        alert('حدث خطأ في الاتصال بالخادم');
    }
}

async function rejectCancellationRequest(requestId) {
    const reason = prompt('يرجى إدخال سبب رفض طلب الإلغاء:') || 'مرفوض من الإدارة';
    try {
        const res = await fetch(`${API_BASE}/cancellation-requests/${requestId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            alert('تم رفض طلب الإلغاء');
            loadCancellationRequests();
            loadDashboardStats();
        } else {
            alert(data.error || 'فشل رفض طلب الإلغاء');
        }
    } catch (err) {
        alert('حدث خطأ في الاتصال بالخادم');
    }
}

window.loadCancellationRequests = loadCancellationRequests;
window.approveCancellationRequest = approveCancellationRequest;
window.rejectCancellationRequest = rejectCancellationRequest;


// ===== Unified Theme & Customization Management (Clean Modern SaaS) =====
var THEME_PRESETS = {
    default: {
        id: 'default',
        name: 'الافتراضي الرسمي',
        description: 'توصيلة كحلي هادئ ولمسات كهرمانية دافئة',
        primaryColor: '#1B4965',
        primaryHover: '#14364A',
        accentColor: '#D97706',
        bgColor: '#F8FAFC',
        cardBg: '#FFFFFF',
        textColor: '#0F172A',
        borderColor: '#E2E8F0',
        badgeBg: '#ECFDF5',
        badgeText: '#047857',
        isDark: false
    },
    emerald: {
        id: 'emerald',
        name: 'الزمردي الحديث',
        description: 'أخضر زمردي راقٍ ومتوازن يمنح إحساساً بالحيوية والراحة',
        primaryColor: '#065F46',
        primaryHover: '#044E39',
        accentColor: '#10B981',
        bgColor: '#F8FAFC',
        cardBg: '#FFFFFF',
        textColor: '#0F172A',
        borderColor: '#E2E8F0',
        badgeBg: '#ECFDF5',
        badgeText: '#047857',
        isDark: false
    },
    slate: {
        id: 'slate',
        name: 'الرمادي الصخري',
        description: 'مظهر مؤسسي محايد وعصري مستوحى من كبرى المنصات السحابية',
        primaryColor: '#334155',
        primaryHover: '#1E293B',
        accentColor: '#0284C7',
        bgColor: '#F8FAFC',
        cardBg: '#FFFFFF',
        textColor: '#0F172A',
        borderColor: '#E2E8F0',
        badgeBg: '#F0F9FF',
        badgeText: '#0369A1',
        isDark: false
    },
    dark: {
        id: 'dark',
        name: 'الوضع الليلي الهادئ',
        description: 'نمط ليلي مريح للعين وخالٍ من التباين المجهد',
        primaryColor: '#38BDF8',
        primaryHover: '#0EA5E9',
        accentColor: '#F59E0B',
        bgColor: '#0F172A',
        cardBg: '#1E293B',
        textColor: '#F8FAFC',
        borderColor: '#334155',
        badgeBg: '#132743',
        badgeText: '#38BDF8',
        isDark: true
    }
};

var currentThemeSettings = {
    preset: 'default',
    primaryColor: '#1B4965',
    primaryHover: '#14364A',
    accentColor: '#D97706',
    fontFamily: 'IBM Plex Sans Arabic',
    fontSize: '14px',
    bgColor: '#F8FAFC',
    cardBg: '#FFFFFF',
    textColor: '#0F172A'
};

function switchCustomSubTab(tabName) {
    var tabs = ['unified-theme', 'static-texts'];
    tabs.forEach(function(t) {
        var btn = document.getElementById('custom-subtab-' + t);
        var view = document.getElementById('custom-view-' + t);
        if (t === tabName) {
            if (btn) {
                btn.className = 'px-4 py-2 rounded-lg text-xs font-bold transition flex items-center gap-2 bg-[#1B4965] text-white shadow-xs';
            }
            if (view) {
                view.classList.remove('hidden');
                view.style.display = 'grid';
            }
        } else {
            if (btn) {
                btn.className = 'px-4 py-2 rounded-lg text-xs font-medium transition flex items-center gap-2 text-slate-600 hover:text-slate-900 hover:bg-slate-50';
            }
            if (view) {
                view.classList.add('hidden');
                view.style.display = 'none';
            }
        }
    });
}
window.switchCustomSubTab = switchCustomSubTab;

function selectThemePreset(presetKey) {
    var p = THEME_PRESETS[presetKey] || THEME_PRESETS['default'];
    currentThemeSettings.preset = presetKey;
    currentThemeSettings.primaryColor = p.primaryColor;
    currentThemeSettings.primaryHover = p.primaryHover;
    currentThemeSettings.accentColor = p.accentColor;
    currentThemeSettings.bgColor = p.bgColor;
    currentThemeSettings.cardBg = p.cardBg;
    currentThemeSettings.textColor = p.textColor;

    // Update preset cards UI
    Object.keys(THEME_PRESETS).forEach(function(k) {
        var card = document.getElementById('card-preset-' + k);
        var check = document.getElementById('check-preset-' + k);
        if (k === presetKey) {
            if (card) {
                card.classList.remove('border-slate-200', 'bg-white');
                card.classList.add('border-2', 'bg-slate-50/60');
                if (k === 'default') card.style.borderColor = '#1B4965';
                else if (k === 'emerald') card.style.borderColor = '#065F46';
                else if (k === 'slate') card.style.borderColor = '#334155';
                else if (k === 'dark') card.style.borderColor = '#38BDF8';
            }
            if (check) check.classList.remove('hidden');
        } else {
            if (card) {
                card.classList.remove('bg-slate-50/60');
                card.classList.add('border-slate-200', 'bg-white');
                card.style.borderColor = '#e2e8f0';
            }
            if (check) check.classList.add('hidden');
        }
    });

    var activeBadge = document.getElementById('active-preset-badge');
    if (activeBadge) activeBadge.innerText = p.name + ' محدد ✓';

    updateLivePreviewCard();
    applyLiveThemeToDashboard(currentThemeSettings);
}
window.selectThemePreset = selectThemePreset;
window.applyDashboardPreset = selectThemePreset;

function selectFontSize(size) {
    currentThemeSettings.fontSize = size;
    ['14', '15', '16'].forEach(function(s) {
        var btn = document.getElementById('btn-font-size-' + s);
        if (btn) {
            if (s + 'px' === size) {
                btn.className = 'font-size-btn px-3 py-2.5 rounded-xl border-2 border-[#1B4965] bg-slate-50 text-slate-900 text-xs font-bold transition flex items-center justify-center gap-1 shadow-2xs cursor-pointer';
                btn.innerHTML = '<i class="fa-solid fa-check text-[10px]"></i><span>' + (s === '14' ? 'عادي (14px)' : s === '15' ? 'متوسط (15px)' : 'كبير (16px)') + '</span>';
            } else {
                btn.className = 'font-size-btn px-3 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-xs font-semibold transition flex items-center justify-center gap-1 cursor-pointer';
                btn.innerHTML = '<span>' + (s === '14' ? 'عادي (14px)' : s === '15' ? 'متوسط (15px)' : 'كبير (16px)') + '</span>';
            }
        }
    });

    updateLivePreviewCard();
    applyLiveThemeToDashboard(currentThemeSettings);
}
window.selectFontSize = selectFontSize;

function onTypographyChange() {
    var ffEl = document.getElementById('theme-font-family');
    if (ffEl) {
        currentThemeSettings.fontFamily = ffEl.value;
    }
    updateLivePreviewCard();
    applyLiveThemeToDashboard(currentThemeSettings);
}
window.onTypographyChange = onTypographyChange;

function updateLivePreviewCard() {
    var p = THEME_PRESETS[currentThemeSettings.preset] || THEME_PRESETS['default'];
    var mockContainer = document.getElementById('mock-preview-container');
    var mockPrimaryBtn = document.getElementById('mock-preview-primary-btn');
    var mockAccentIcon = document.getElementById('mock-preview-accent-icon');
    var previewPresetName = document.getElementById('preview-preset-name');
    var previewFontName = document.getElementById('preview-font-name');
    var previewSizeName = document.getElementById('preview-size-name');

    if (mockContainer) {
        mockContainer.style.fontFamily = "'" + currentThemeSettings.fontFamily + "', -apple-system, sans-serif";
        mockContainer.style.fontSize = currentThemeSettings.fontSize;
        if (p.isDark) {
            mockContainer.style.backgroundColor = '#0b1120';
            mockContainer.style.color = '#f8fafc';
        } else {
            mockContainer.style.backgroundColor = '#f8fafc';
            mockContainer.style.color = '#0f172a';
        }
    }

    if (mockPrimaryBtn) {
        mockPrimaryBtn.style.backgroundColor = currentThemeSettings.primaryColor;
        mockPrimaryBtn.style.fontFamily = "'" + currentThemeSettings.fontFamily + "', -apple-system, sans-serif";
    }

    if (mockAccentIcon) {
        mockAccentIcon.style.color = currentThemeSettings.accentColor;
    }

    if (previewPresetName) {
        previewPresetName.innerText = p.name;
        previewPresetName.style.color = currentThemeSettings.primaryColor;
    }
    if (previewFontName) previewFontName.innerText = currentThemeSettings.fontFamily;
    if (previewSizeName) {
        var sz = currentThemeSettings.fontSize;
        previewSizeName.innerText = sz === '14px' ? 'عادي (14px)' : sz === '15px' ? 'متوسط (15px)' : 'كبير (16px)';
    }
}
window.updateLivePreviewCard = updateLivePreviewCard;

function applyLiveThemeToDashboard(th) {
    if (!th) return;
    var fontFamily = th.fontFamily || 'IBM Plex Sans Arabic';
    var fontSize = th.fontSize || '14px';
    var primary = th.primaryColor || '#1B4965';
    var active = th.accentColor || '#D97706';
    var p = THEME_PRESETS[th.preset] || THEME_PRESETS['default'];

    var styleEl = document.getElementById('dynamic-dashboard-theme-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'dynamic-dashboard-theme-style';
        document.head.appendChild(styleEl);
    }

    var isDark = Boolean(p.isDark);
    var bg = isDark ? '#0b1120' : '#f8fafc';
    var sidebarBg = isDark ? '#0f172a' : '#ffffff';
    var cardBg = isDark ? '#1e293b' : '#ffffff';
    var textColor = isDark ? '#94a3b8' : '#334155';
    var headingColor = isDark ? '#f8fafc' : '#0f172a';
    var borderColor = isDark ? '#334155' : '#e2e8f0';

    styleEl.textContent = `
        body, html, input, button, select, textarea, p, h1, h2, h3, h4, h5, h6, table, th, td, label, div, span:not([class*="fa"]):not([class*="badge"]) {
            font-family: '${fontFamily}', 'IBM Plex Sans Arabic', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        }
        body, html {
            font-size: ${fontSize} !important;
        }
        p, label, table, th, td, input, select, textarea {
            font-size: ${fontSize} !important;
        }
        body {
            background-color: ${bg} !important;
            color: ${textColor} !important;
        }
        main {
            background-color: ${bg} !important;
            color: ${textColor} !important;
        }
        #sidebar-drawer, aside {
            background-color: ${sidebarBg} !important;
            border-color: ${borderColor} !important;
        }
        header {
            background-color: ${sidebarBg} !important;
            border-color: ${borderColor} !important;
        }
        .tab-btn.active {
            border-right-color: ${primary} !important;
            color: ${primary} !important;
        }
        .tab-btn.active i {
            color: ${primary} !important;
        }
    `;
}
window.applyDashboardTheme = applyLiveThemeToDashboard;

async function saveAndPublishTheme() {
    var btn = document.getElementById('btn-save-publish-theme');
    var origHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-xs"></i><span>جاري الحفظ والنشر...</span>';
    }

    try {
        localStorage.setItem('tawseela_dashboard_theme', JSON.stringify(currentThemeSettings));
        localStorage.setItem('tawseela_web_theme', JSON.stringify(currentThemeSettings));

        var res = await fetch('/api/admin/app-config/theme', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '')
            },
            body: JSON.stringify(currentThemeSettings)
        });

        applyLiveThemeToDashboard(currentThemeSettings);
        showToast('تم حفظ ونشر المظهر على التطبيق ولوحة التحكم بنجاح! 🚀');

        var activeBadge = document.getElementById('active-preset-badge');
        if (activeBadge) {
            var p = THEME_PRESETS[currentThemeSettings.preset] || THEME_PRESETS['default'];
            activeBadge.innerText = p.name + ' منشور ومفعّل ✓';
        }
    } catch (err) {
        showToast('حدث خطأ أثناء حفظ ونشر المظهر', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    }
}
window.saveAndPublishTheme = saveAndPublishTheme;
window.saveDashboardTheme = saveAndPublishTheme;

function resetToDefaultTheme() {
    selectThemePreset('default');
    var ffEl = document.getElementById('theme-font-family');
    if (ffEl) ffEl.value = 'IBM Plex Sans Arabic';
    currentThemeSettings.fontFamily = 'IBM Plex Sans Arabic';
    selectFontSize('14px');
    updateLivePreviewCard();
    applyLiveThemeToDashboard(currentThemeSettings);
    showToast('تمت استعادة المظهر الافتراضي للمعاينة ✨');
}
window.resetToDefaultTheme = resetToDefaultTheme;
window.resetDashboardTheme = resetToDefaultTheme;
async function loadCustomizationSettings() {
    try {
        var res = await fetch('/api/app-config/theme', { headers: authHeaders() });
        var data = await res.json();
        var th = (data && data.theme) ? data.theme : (data || {});
        if (th && th.preset) {
            currentThemeSettings = Object.assign({}, currentThemeSettings, th);
            selectThemePreset(th.preset || 'default');
            if (document.getElementById('theme-font-family')) {
                document.getElementById('theme-font-family').value = th.fontFamily || 'IBM Plex Sans Arabic';
                currentThemeSettings.fontFamily = document.getElementById('theme-font-family').value;
            }
            if (th.fontSize) {
                selectFontSize(th.fontSize);
            }
            updateLivePreviewCard();
            applyLiveThemeToDashboard(currentThemeSettings);
        } else {
            var cached = localStorage.getItem('tawseela_dashboard_theme');
            if (cached) {
                try {
                    var dt = JSON.parse(cached);
                    currentThemeSettings = Object.assign({}, currentThemeSettings, dt);
                    selectThemePreset(dt.preset || 'default');
                    if (dt.fontFamily && document.getElementById('theme-font-family')) {
                        document.getElementById('theme-font-family').value = dt.fontFamily;
                    }
                    if (dt.fontSize) selectFontSize(dt.fontSize);
                    updateLivePreviewCard();
                    applyLiveThemeToDashboard(currentThemeSettings);
                } catch (_) {}
            } else {
                selectThemePreset('default');
                selectFontSize('14px');
            }
        }
    } catch (e) {
        console.warn('Could not load theme config from server, falling back to defaults', e);
        selectThemePreset('default');
        selectFontSize('14px');
    }

    // Load static texts from /api/admin/app-config
    try {
        var resConfig = await fetch('/api/admin/app-config', { headers: authHeaders() });
        var cfg = await resConfig.json();
        if (cfg.staticTexts) {
            if (document.getElementById('text-welcome-title')) document.getElementById('text-welcome-title').value = cfg.staticTexts.welcomeTitle || '';
            if (document.getElementById('text-welcome-subtitle')) document.getElementById('text-welcome-subtitle').value = cfg.staticTexts.welcomeSubtitle || '';
            if (document.getElementById('text-driver-pending')) document.getElementById('text-driver-pending').value = cfg.staticTexts.driverPendingMsg || '';
        }
        if (document.getElementById('theme-telegram-link')) {
            document.getElementById('theme-telegram-link').value = cfg.telegramAdminLink || 'https://t.me/tawseela_najaf_bot';
        }
        if (document.getElementById('theme-whatsapp-link')) {
            document.getElementById('theme-whatsapp-link').value = cfg.whatsappAdminLink || 'https://wa.me/9647706204066';
        }
        if (cfg.onboarding && cfg.onboarding.screens) {
            renderOnboardingScreens(cfg.onboarding.screens);
        }
    } catch (_) {}
}
window.loadCustomizationSettings = loadCustomizationSettings;

function broadcastLiveThemeSync(theme) {
    try {
        var bc = new BroadcastChannel('tawseela_config_sync');
        bc.postMessage({ type: 'config_updated', config: { theme: theme } });
        bc.close();
    } catch(_) {}
}
window.broadcastLiveThemeSync = broadcastLiveThemeSync;

function syncLiveActiveTabColor(color) {
    var c = syncColorInputPair('theme-active-tab-color', 'theme-active-tab-color-hex', color);
    if (!c) return;
    applyActiveTabColorStyle(c);
    broadcastLiveThemeSync({ activeTabColor: c, activeColor: c });
}

function applyActiveTabColorStyle(color) {
    if (!color) return;
    var styleEl = document.getElementById('dynamic-active-tab-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'dynamic-active-tab-style';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
        .tab-btn.active {
            color: ${color} !important;
            border-color: ${color} !important;
            box-shadow: 0 4px 14px -2px ${color}50 !important;
        }
        .tab-btn.active i, .tab-btn.active svg, .tab-btn.active span {
            color: ${color} !important;
        }
    `;
}

function syncLiveFontColor(color) {
    var c = syncColorInputPair('theme-font-color', 'theme-font-color-hex', color);
    if (!c) return;
    broadcastLiveThemeSync({ fontColor: c, textColor: c });
}

function syncLivePrimaryColor(color) {
    var c = syncColorInputPair('theme-primary-color', 'theme-primary-color-hex', color);
    if (!c) return;
    broadcastLiveThemeSync({ primaryColor: c });
}

function syncLiveBgColor(color) {
    var c = syncColorInputPair('theme-bg-color', 'theme-bg-color-hex', color);
    if (!c) return;
    broadcastLiveThemeSync({ bgColor: c });
}

function syncLiveButtonColor(color) {
    var c = syncColorInputPair('theme-button-color', 'theme-button-color-hex', color);
    if (!c) return;
    broadcastLiveThemeSync({ buttonColor: c });
}

function syncLiveButtonHoverColor(color) {
    var c = syncColorInputPair('theme-button-hover-color', 'theme-button-hover-color-hex', color);
    if (!c) return;
    broadcastLiveThemeSync({ buttonHoverColor: c });
}

function syncLiveSearchInputColor(color) {
    var c = syncColorInputPair('theme-search-input-color', 'theme-search-input-color-hex', color);
    if (!c) return;
    broadcastLiveThemeSync({ searchInputColor: c });
}

function syncLiveSearchInputBg(color) {
    var c = syncColorInputPair('theme-search-input-bg', 'theme-search-input-bg-hex', color);
    if (!c) return;
    broadcastLiveThemeSync({ searchInputBg: c });
}

function renderOnboardingScreens(screens) {
    var list = document.getElementById('onboarding-screens-list');
    if (!list) return;
    list.innerHTML = screens.map(function(s, i) {
        return '<div class="bg-slate-900 rounded-xl p-3 border border-slate-700"><div class="flex items-center gap-2 mb-2"><span class="text-xl">' + (s.icon||'📱') + '</span><input type="text" class="onb-title flex-1 bg-transparent border-b border-slate-600 text-white text-sm px-1 py-1" value="' + (s.title||'').replace(/"/g,'&quot;') + '" placeholder="العنوان"></div><input type="text" class="onb-desc w-full bg-transparent border-b border-slate-600 text-slate-300 text-xs px-1 py-1" value="' + (s.description||'').replace(/"/g,'&quot;') + '" placeholder="الوصف"><button onclick="this.parentElement.remove()" class="text-xs text-red-400 mt-1">حذف</button></div>';
    }).join('');
}

function addOnboardingScreen() {
    var list = document.getElementById('onboarding-screens-list');
    if (!list) return;
    var div = document.createElement('div');
    div.className = 'bg-slate-900 rounded-xl p-3 border border-slate-700';
    div.innerHTML = '<div class="flex items-center gap-2 mb-2"><span class="text-xl">📱</span><input type="text" class="onb-title flex-1 bg-transparent border-b border-slate-600 text-white text-sm px-1 py-1" value="" placeholder="العنوان"></div><input type="text" class="onb-desc w-full bg-transparent border-b border-slate-600 text-slate-300 text-xs px-1 py-1" value="" placeholder="الوصف"><button onclick="this.parentElement.remove()" class="text-xs text-red-400 mt-1">حذف</button>';
    list.appendChild(div);
}

async function saveOnboarding() {
    var items = document.querySelectorAll('#onboarding-screens-list > div');
    var screens = [];
    items.forEach(function(el) {
        var title = el.querySelector('.onb-title');
        var desc = el.querySelector('.onb-desc');
        if (title && title.value.trim()) screens.push({ title: title.value.trim(), description: desc ? desc.value.trim() : '', icon: '📱' });
    });
    try {
        await fetch('/api/admin/onboarding', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('admin_token')}, body:JSON.stringify({ enabled: true, screens }) });
        showToast('تم حفظ الشاشات التوجيهية ✅');
    } catch(e) { showToast('خطأ في الحفظ', 'error'); }
}

async function saveThemeSettings() {
    var fc = getColorPairVal('theme-font-color', 'theme-font-color-hex', '#111111');
    var btnColor = getColorPairVal('theme-button-color', 'theme-button-color-hex', '#111111');
    var btnHoverColor = getColorPairVal('theme-button-hover-color', 'theme-button-hover-color-hex', '#374151');
    var searchInputColor = getColorPairVal('theme-search-input-color', 'theme-search-input-color-hex', '#111111');
    var searchInputBg = getColorPairVal('theme-search-input-bg', 'theme-search-input-bg-hex', '#fafafa');
    var atc = getColorPairVal('theme-active-tab-color', 'theme-active-tab-color-hex', '#f59e0b');
    var prim = getColorPairVal('theme-primary-color', 'theme-primary-color-hex', '#111111');
    var bg = getColorPairVal('theme-bg-color', 'theme-bg-color-hex', '#ffffff');

    var body = {
        primaryColor: prim,
        bgColor: bg,
        activeTabColor: atc,
        activeColor: atc,
        fontColor: fc,
        buttonColor: btnColor,
        buttonHoverColor: btnHoverColor,
        searchInputColor: searchInputColor,
        searchInputBg: searchInputBg,
        textColor: fc,
        fontFamily: document.getElementById('theme-font').value,
        fontSize: document.getElementById('theme-font-size') ? document.getElementById('theme-font-size').value : '16px',
        appName: document.getElementById('theme-app-name').value,
        logoEmoji: document.getElementById('theme-logo-emoji').value,
        footerText: document.getElementById('theme-footer').value
    };
    applyActiveTabColorStyle(atc);
    try {
        await fetch('/api/admin/theme', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('admin_token')}, body:JSON.stringify(body) });
        broadcastLiveThemeSync(body);
        showToast('تم حفظ إعدادات ثيم تطبيق الويب ومزامنة الألوان فوراً ✅');
    } catch(e) { showToast('خطأ', 'error'); }
}

async function saveStaticTexts() {
    var body = {
        staticTexts: {
            welcomeTitle: document.getElementById('text-welcome-title').value,
            welcomeSubtitle: document.getElementById('text-welcome-subtitle').value,
            driverPendingMsg: document.getElementById('text-driver-pending').value
        },
        telegramAdminLink: document.getElementById('theme-telegram-link') ? document.getElementById('theme-telegram-link').value.trim() : 'https://t.me/tawseela_najaf_bot',
        whatsappAdminLink: document.getElementById('theme-whatsapp-link') ? document.getElementById('theme-whatsapp-link').value.trim() : 'https://wa.me/9647706204066'
    };
    try {
        await fetch('/api/admin/app-config', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('admin_token')}, body:JSON.stringify(body) });
        showToast('تم حفظ النصوص وحسابات التواصل بنجاح ✅');
    } catch(e) { showToast('خطأ', 'error'); }
}

// ===== Custom Buttons & UI Management =====
window.__cachedButtons = [];
window.__cachedAds = [];

async function loadCustomButtons() {
    try {
        var res = await fetch('/api/admin/custom-buttons', authHeaders());
        var buttons = await res.json();
        window.__cachedButtons = buttons || [];
        var lists = [document.getElementById('custom-buttons-list'), document.getElementById('ui-buttons-list')];
        lists.forEach(function(list) {
            if (!list) return;
            if (!buttons || buttons.length === 0) {
                list.innerHTML = '<div class="col-span-2 text-center text-slate-500 py-6"><p class="text-3xl mb-2">🔗</p><p class="text-xs">لا توجد أزرار مخصصة بعد</p></div>';
                return;
            }
            list.innerHTML = buttons.map(function(b) {
                return '<div class="bg-slate-800/80 rounded-xl p-3.5 border border-slate-700 flex items-center justify-between gap-3">' +
                    '<div class="flex items-center gap-3 min-w-0">' +
                        '<span class="text-2xl flex-shrink-0">' + (b.icon||'🔗') + '</span>' +
                        '<div class="min-w-0">' +
                            '<div class="text-white font-bold text-sm truncate">' + (b.label||'') + '</div>' +
                            '<div class="text-slate-400 text-xs truncate max-w-[200px]" dir="ltr">' + (b.url||'') + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="flex items-center gap-1.5 flex-shrink-0">' +
                        '<button onclick="editCustomButton(\'' + b.id + '\')" class="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 rounded-lg text-xs font-bold transition flex items-center gap-1"><i class="fa-solid fa-pen-to-square"></i> تعديل</button>' +
                        '<button onclick="deleteCustomButton(\'' + b.id + '\')" class="px-2.5 py-1 bg-red-500/20 hover:bg-red-500/40 text-red-400 rounded-lg text-xs font-bold transition flex items-center gap-1"><i class="fa-solid fa-trash"></i> حذف</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        });
    } catch(e) { console.error(e); }
}

function showAddButtonModal() {
    var m = document.getElementById('modal-add-button');
    if (!m) return;
    var titleEl = document.getElementById('modal-button-title');
    if (titleEl) titleEl.textContent = 'إضافة زر مخصص جديد';
    var idEl = document.getElementById('btn-id');
    if (idEl) idEl.value = '';
    document.getElementById('btn-label').value = '';
    document.getElementById('btn-url').value = '';
    document.getElementById('btn-icon').value = '🔗';
    document.getElementById('btn-color').value = '#111111';
    m.classList.remove('hidden');
    m.style.display = 'flex';
}

function editCustomButton(id) {
    var b = (window.__cachedButtons || []).find(function(item) { return item.id === id; });
    if (!b) return;
    var m = document.getElementById('modal-add-button');
    if (!m) return;
    var titleEl = document.getElementById('modal-button-title');
    if (titleEl) titleEl.textContent = 'تعديل الزر المخصص ✏️';
    var idEl = document.getElementById('btn-id');
    if (idEl) idEl.value = b.id;
    document.getElementById('btn-label').value = b.label || '';
    document.getElementById('btn-url').value = b.url || '';
    document.getElementById('btn-icon').value = b.icon || '🔗';
    document.getElementById('btn-color').value = b.color || '#111111';
    m.classList.remove('hidden');
    m.style.display = 'flex';
}

function hideAddButtonModal() {
    var m = document.getElementById('modal-add-button');
    if (m) { m.classList.add('hidden'); m.style.display = 'none'; }
}

async function submitNewButton() {
    var id = (document.getElementById('btn-id') || {}).value || '';
    var label = document.getElementById('btn-label').value.trim();
    var url = document.getElementById('btn-url').value.trim();
    var icon = document.getElementById('btn-icon').value.trim() || '🔗';
    var color = document.getElementById('btn-color').value;
    if (!label || !url) { showToast('أدخل نص الزر والرابط', 'error'); return; }
    try {
        var payload = { label: label, url: url, icon: icon, color: color };
        if (id) payload.id = id;
        var res = await fetch('/api/admin/custom-buttons', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('admin_token') },
            body: JSON.stringify(payload)
        });
        var data = await res.json();
        if (data.success) {
            hideAddButtonModal();
            showToast(id ? 'تم تعديل الزر بنجاح ✅' : 'تم إضافة الزر بنجاح ✅');
            loadCustomButtons();
        } else {
            showToast(data.error || 'فشلت العملية', 'error');
        }
    } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

async function deleteCustomButton(id) {
    if (!confirm('هل أنت متأكد من حذف هذا الزر؟')) return;
    try {
        await fetch('/api/admin/custom-buttons', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('admin_token') },
            body: JSON.stringify({ id: id })
        });
        showToast('تم حذف الزر ✅');
        loadCustomButtons();
    } catch(e) { showToast('خطأ في الحذف', 'error'); }
}

// ===== Advertisements Tab & UI Management =====
async function loadAdvertisements() {
    try {
        var res = await fetch('/api/admin/advertisements', authHeaders());
        var ads = await res.json();
        window.__cachedAds = ads || [];
        var lists = [document.getElementById('ads-list'), document.getElementById('ui-ads-list')];
        lists.forEach(function(list) {
            if (!list) return;
            if (!ads || ads.length === 0) {
                list.innerHTML = '<div class="col-span-2 text-center text-slate-500 py-6"><p class="text-3xl mb-2">📢</p><p class="text-xs">لا توجد إعلانات منشورة</p></div>';
                return;
            }
            list.innerHTML = ads.map(function(a) {
                return '<div class="bg-slate-800/80 rounded-xl p-3.5 border border-slate-700 space-y-2">' +
                    '<div class="flex items-center justify-between gap-2">' +
                        '<h4 class="text-white font-bold text-sm truncate">' + (a.title||'إعلان') + '</h4>' +
                        '<div class="flex items-center gap-1.5 flex-shrink-0">' +
                            '<button onclick="editAd(\'' + a.id + '\')" class="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 rounded-lg text-xs font-bold transition flex items-center gap-1"><i class="fa-solid fa-pen-to-square"></i> تعديل</button>' +
                            '<button onclick="deleteAd(\'' + a.id + '\')" class="px-2.5 py-1 bg-red-500/20 hover:bg-red-500/40 text-red-400 rounded-lg text-xs font-bold transition flex items-center gap-1"><i class="fa-solid fa-trash"></i> حذف</button>' +
                        '</div>' +
                    '</div>' +
                    '<p class="text-slate-300 text-xs line-clamp-2">' + (a.content||'') + '</p>' +
                    (a.linkUrl ? '<a href="' + a.linkUrl + '" target="_blank" class="text-sky-400 text-xs block truncate" dir="ltr">🔗 ' + a.linkUrl + '</a>' : '') +
                '</div>';
            }).join('');
        });
    } catch(e) { console.error(e); }
}

function showAddAdModal() {
    var m = document.getElementById('modal-add-ad');
    if (!m) return;
    var titleEl = document.getElementById('modal-ad-title');
    if (titleEl) titleEl.textContent = 'إضافة إعلان جديد';
    var idEl = document.getElementById('ad-id');
    if (idEl) idEl.value = '';
    document.getElementById('ad-title').value = '';
    document.getElementById('ad-content').value = '';
    document.getElementById('ad-link').value = '';
    m.classList.remove('hidden');
    m.style.display = 'flex';
}

function editAd(id) {
    var a = (window.__cachedAds || []).find(function(item) { return item.id === id; });
    if (!a) return;
    var m = document.getElementById('modal-add-ad');
    if (!m) return;
    var titleEl = document.getElementById('modal-ad-title');
    if (titleEl) titleEl.textContent = 'تعديل الإعلان ✏️';
    var idEl = document.getElementById('ad-id');
    if (idEl) idEl.value = a.id;
    document.getElementById('ad-title').value = a.title || '';
    document.getElementById('ad-content').value = a.content || '';
    document.getElementById('ad-link').value = a.linkUrl || '';
    m.classList.remove('hidden');
    m.style.display = 'flex';
}

function hideAddAdModal() {
    var m = document.getElementById('modal-add-ad');
    if (m) { m.classList.add('hidden'); m.style.display = 'none'; }
}

async function submitNewAd() {
    var id = (document.getElementById('ad-id') || {}).value || '';
    var title = document.getElementById('ad-title').value.trim();
    var content = document.getElementById('ad-content').value.trim();
    var linkUrl = document.getElementById('ad-link').value.trim();
    if (!title) { showToast('أدخل عنوان الإعلان', 'error'); return; }
    try {
        var payload = { title: title, content: content, linkUrl: linkUrl };
        if (id) payload.id = id;
        var res = await fetch('/api/admin/advertisements', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('admin_token') },
            body: JSON.stringify(payload)
        });
        var data = await res.json();
        if (data.success) {
            hideAddAdModal();
            showToast(id ? 'تم تعديل الإعلان بنجاح ✅' : 'تم نشر الإعلان بنجاح ✅');
            loadAdvertisements();
        } else {
            showToast(data.error || 'فشلت العملية', 'error');
        }
    } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

async function deleteAd(id) {
    if (!confirm('هل أنت متأكد من حذف هذا الإعلان؟')) return;
    try {
        await fetch('/api/admin/advertisements', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('admin_token') },
            body: JSON.stringify({ id: id })
        });
        showToast('تم حذف الإعلان ✅');
        loadAdvertisements();
    } catch(e) { showToast('خطأ في الحذف', 'error'); }
}

// ===== Telegram Notification =====
async function sendTelegramNotification() {
    var msg = document.getElementById('tg-notify-msg').value.trim();
    if (!msg) { showToast('اكتب الرسالة أولاً', 'error'); return; }
    try {
        await fetch('/api/admin/telegram/notify', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('admin_token')}, body:JSON.stringify({message:msg}) });
        showToast('تم الإرسال عبر تيليجرام ✅');
        document.getElementById('tg-notify-msg').value = '';
    } catch(e) { showToast('خطأ في الإرسال', 'error'); }
}

// ===== Feature 8: Fleet Operations Log =====
async function loadFleetOperationsLog() {
    const tbody = document.getElementById('fleet-ops-log-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-slate-400 text-xs"><i class="fa-solid fa-circle-notch fa-spin"></i> جاري التحميل...</td></tr>';
    try {
        const res = await fetch('/api/fleet/operations-log', { headers: authHeaders() });
        const data = await res.json();
        const ops = data.operations || [];
        if (ops.length === 0) { tbody.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-slate-400 text-sm">لا توجد عمليات بعد</td></tr>'; return; }
        const typeMap = { booking: { label: 'حجز داخلي', color: 'bg-emerald-100 text-emerald-700' }, external: { label: 'حجز خارجي', color: 'bg-blue-100 text-blue-700' }, join: { label: 'طلب انضمام', color: 'bg-amber-100 text-amber-700' } };
        const statusMap = { Confirmed: 'مؤكد', Pending: 'معلق', Approved: 'موافق عليه', Rejected: 'مرفوض', Completed: 'مكتمل', Cancelled: 'ملغى' };
        tbody.innerHTML = ops.map(op => {
            const tm = typeMap[op.type] || { label: op.type, color: 'bg-slate-100 text-slate-700' };
            const st = statusMap[op.status] || op.status || '--';
            const dt = op.createdAt ? new Date(op.createdAt).toLocaleString('ar-IQ') : '--';
            const passenger = op.passengerName || op.passengerPhone || '--';
            return `<tr class="hover:bg-slate-50">
                <td class="p-3"><span class="px-2 py-0.5 rounded-full text-xs font-bold ${tm.color}">${tm.label}${op.channel ? ' ('+op.channel+')' : ''}</span></td>
                <td class="p-3 font-semibold">${passenger}</td>
                <td class="p-3">${op.driverName || op.driverPhone || '--'}</td>
                <td class="p-3 text-slate-500 max-w-[120px] truncate">${op.from || '--'}</td>
                <td class="p-3 text-slate-500 max-w-[120px] truncate">${op.to || '--'}</td>
                <td class="p-3"><span class="px-2 py-0.5 rounded-full text-xs font-bold ${st==='مؤكد'||st==='موافق عليه'||st==='مكتمل' ? 'bg-emerald-100 text-emerald-700' : st==='معلق' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}">${st}</span></td>
                <td class="p-3 text-slate-400 whitespace-nowrap">${dt}</td>
            </tr>`;
        }).join('');
    } catch(e) { tbody.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-red-500 text-xs">خطأ في التحميل</td></tr>'; }
}

// ===== Feature 8: Join Requests in Dashboard =====
async function loadJoinRequests() {
    const container = document.getElementById('join-requests-container');
    const badge = document.getElementById('join-requests-badge');
    if (!container) return;
    container.innerHTML = '<p class="text-center text-slate-400 text-sm"><i class="fa-solid fa-circle-notch fa-spin"></i> جاري التحميل...</p>';
    try {
        // Collect all pending join requests across all drivers
        const res = await fetch('/api/fleet/operations-log', { headers: authHeaders() });
        const data = await res.json();
        const pending = (data.operations || []).filter(op => op.type === 'join' && op.status === 'Pending');
        if (badge) { badge.textContent = pending.length; badge.classList.toggle('hidden', pending.length === 0); }
        if (pending.length === 0) { container.innerHTML = '<p class="text-center text-slate-400 text-sm">لا توجد طلبات انضمام معلقة</p>'; return; }
        container.innerHTML = '';
        pending.forEach(req => {
            const div = document.createElement('div');
            div.className = 'flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-3';
            div.innerHTML = `
                <div class="space-y-1">
                    <div class="font-bold text-slate-900 text-sm">🙋 ${req.passengerName} → 🚕 ${req.driverName}</div>
                    <div class="text-xs text-slate-500">${req.from || '--'} ← → ${req.to || '--'}</div>
                    <div class="text-xs text-slate-400">${req.createdAt ? new Date(req.createdAt).toLocaleString('ar-IQ') : ''}</div>
                </div>
                <div class="flex gap-2">
                    <button onclick="adminApproveJoin('${req.id}')" class="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-white rounded-lg text-xs font-bold">✅ قبول</button>
                    <button onclick="adminRejectJoin('${req.id}')" class="px-3 py-1.5 bg-red-500 hover:bg-red-400 text-white rounded-lg text-xs font-bold">❌ رفض</button>
                </div>`;
            container.appendChild(div);
        });
    } catch(e) { container.innerHTML = '<p class="text-center text-red-500 text-sm">خطأ في التحميل</p>'; }
}

async function adminApproveJoin(requestId) {
    try {
        const res = await fetch('/api/driver/approve-join', { method:'POST', headers:{'Content-Type':'application/json', ...authHeaders()}, body:JSON.stringify({requestId}) });
        const data = await res.json();
        if (data.success) {
            showToast('تم قبول طلب الانضمام ✅');
            loadJoinRequests();
            loadFleetOperationsLog();
        } else showToast(data.error || 'خطأ', 'error');
    } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

async function adminRejectJoin(requestId) {
    try {
        await fetch('/api/driver/reject-join', { method:'POST', headers:{'Content-Type':'application/json', ...authHeaders()}, body:JSON.stringify({requestId}) });
        showToast('تم رفض الطلب');
        loadJoinRequests();
    } catch(e) { showToast('خطأ', 'error'); }
}

// ===== Feature 7: Real-time config sync polling =====
// Poll app-config every 30s and apply theme changes immediately to portal
(function initConfigSyncPoller() {
    let lastConfigStr = '';
    async function pollConfig() {
        try {
            const res = await fetch('/api/admin/app-config?t=' + Date.now(), { headers: authHeaders() });
            const cfg = await res.json();
            const cfgStr = JSON.stringify(cfg);
            if (cfgStr !== lastConfigStr) {
                lastConfigStr = cfgStr;
                // Broadcast to portal via BroadcastChannel (same origin)
                try {
                    const bc = new BroadcastChannel('tawseela_config_sync');
                    bc.postMessage({ type: 'config_updated', config: cfg });
                    bc.close();
                } catch(_) {}
            }
        } catch(_) {}
    }
    setInterval(pollConfig, 30000);
})();

// ===== Feature 7: Auto-reload theme in portal via BroadcastChannel =====
// This runs in dashboard; portal listens via its own BroadcastChannel listener
// (Portal's applyDynamicAppConfig is called from the portal's own polling)



// -----------------------------------------------------------------------------
// Trip Ratings & Driver Points Management
// -----------------------------------------------------------------------------
let tripRatingsDebounceTimeout = null;
function debounceTripRatingsSearch() {
    clearTimeout(tripRatingsDebounceTimeout);
    tripRatingsDebounceTimeout = setTimeout(() => {
        const input = document.getElementById('trip-ratings-search-input');
        loadTripRatings(input ? input.value : '');
    }, 300);
}

async function loadTripRatings(search = '') {
    const tbody = document.getElementById('trip-ratings-table-body');
    const table = document.getElementById('trip-ratings-table');
    const emptyBox = document.getElementById('trip-ratings-empty');
    const countBadge = document.getElementById('badge-trip-ratings');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">جاري تحميل تقييمات الرحلات...</td></tr>';
    if (emptyBox) emptyBox.classList.add('hidden');
    if (table) table.classList.remove('hidden');

    try {
        const res = await fetch(`${API_BASE}/admin/trip-ratings`, { headers: authHeaders() });
        const data = await res.json();
        let ratings = data.ratings || [];

        if (countBadge) {
            if (ratings.length > 0) {
                countBadge.textContent = ratings.length;
                countBadge.classList.remove('hidden');
            } else {
                countBadge.classList.add('hidden');
            }
        }

        if (search) {
            const q = search.trim().toLowerCase();
            ratings = ratings.filter(r => 
                (r.driverId && r.driverId.toLowerCase().includes(q)) ||
                (r.passengerName && r.passengerName.toLowerCase().includes(q)) ||
                (r.passengerId && String(r.passengerId).toLowerCase().includes(q)) ||
                (r.comment && r.comment.toLowerCase().includes(q)) ||
                (Array.isArray(r.tags) && r.tags.some(t => String(t).toLowerCase().includes(q)))
            );
        }

        tbody.innerHTML = '';

        if (!ratings || ratings.length === 0) {
            if (emptyBox) emptyBox.classList.remove('hidden');
            if (table) table.classList.add('hidden');
            return;
        }

        if (emptyBox) emptyBox.classList.add('hidden');
        if (table) table.classList.remove('hidden');

        ratings.forEach(r => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50/80 transition-colors border-b border-slate-100/80 text-xs md:text-sm';

            // Find driver info if available
            const driver = window.driversMap ? (window.driversMap[r.driverId] || null) : null;
            const driverName = driver ? driver.fullName : (r.driverName || r.driverId || 'الكابتن');
            const driverPhone = driver ? driver.phoneNumber : '';

            // Stars
            const numStars = Math.min(5, Math.max(1, parseInt(r.rating, 10) || 5));
            let starsHtml = '';
            for (let i = 1; i <= 5; i++) {
                if (i <= numStars) {
                    starsHtml += '<i class="fa-solid fa-star text-amber-400 text-xs ml-0.5"></i>';
                } else {
                    starsHtml += '<i class="fa-regular fa-star text-slate-300 text-xs ml-0.5"></i>';
                }
            }

            // Tags
            let tagsHtml = '';
            if (Array.isArray(r.tags) && r.tags.length > 0) {
                tagsHtml = r.tags.map(tag => 
                    `<span class="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200/60 mr-1 mb-1 inline-block">${escapeHtml(tag)}</span>`
                ).join('');
            } else {
                tagsHtml = '<span class="text-xs text-slate-400">لا توجد وسوم</span>';
            }

            // Date
            let dateStr = 'الآن';
            if (r.createdAt) {
                try {
                    const d = new Date(r.createdAt);
                    dateStr = d.toLocaleDateString('ar-IQ', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                } catch(_) {}
            }

            const drvPhoneHtml = driverPhone 
                ? `<a href="tel:${escapeHtml(driverPhone)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs mt-0.5 transition-colors" dir="ltr" title="اتصال بالكابتن"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(driverPhone)}</span></a>`
                : '';

            const passPhone = r.passengerPhone || '';
            const passPhoneHtml = passPhone 
                ? `<a href="tel:${escapeHtml(passPhone)}" class="inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 font-mono text-xs mt-0.5 transition-colors" dir="ltr" title="اتصال بالراكب"><i class="fa-solid fa-phone text-[10px] text-slate-400"></i><span>${escapeHtml(passPhone)}</span></a>`
                : (r.passengerId ? `<span class="text-[11px] text-slate-400 font-mono block mt-0.5">${escapeHtml(r.passengerId)}</span>` : '');

            tr.innerHTML = `
                <td class="py-3.5 px-4 text-xs font-mono text-slate-500">${escapeHtml(dateStr)}</td>
                <td class="py-3.5 px-4">
                    <div class="font-bold text-slate-900">${escapeHtml(driverName)}</div>
                    ${drvPhoneHtml}
                </td>
                <td class="py-3.5 px-4">
                    <div class="font-bold text-slate-800">${escapeHtml(r.passengerName || 'الراكب')}</div>
                    ${passPhoneHtml}
                </td>
                <td class="py-3.5 px-4">
                    <div class="flex items-center gap-1">${starsHtml} <span class="text-xs font-bold text-slate-700 mr-1">(${numStars}/5)</span></div>
                </td>
                <td class="py-3.5 px-4"><div class="flex flex-wrap">${tagsHtml}</div></td>
                <td class="py-3.5 px-4 text-xs text-slate-700 max-w-[200px] truncate" title="${escapeHtml(r.comment || '')}">
                    ${r.comment ? escapeHtml(r.comment) : '<span class="text-slate-400 italic">بدون ملاحظات</span>'}
                </td>
                <td class="py-3.5 px-4 text-center">
                    <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold badge-amber shadow-xs">
                        <span>+${r.pointsEarned || 50}</span>
                        <span>⭐</span>
                    </span>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500 font-bold">تعذر تحميل التقييمات. تأكد من اتصال الخادم.</td></tr>';
    }
}


