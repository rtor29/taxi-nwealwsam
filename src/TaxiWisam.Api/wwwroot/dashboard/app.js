// =============================================================================
// Tawseela (توصيله) Admin Dashboard Client
// Enterprise Platform for Najaf Governorate
// =============================================================================
const API_BASE = '/api/admin';

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
        try { loadDashboardStats(); } catch(e) { console.warn(e); }
        try { loadMatchingSettings(); } catch(e) { console.warn(e); }
        try { loadCustomizationSettings(); } catch(e) { console.warn(e); }
    } else {
        if (errorBox) {
            errorBox.innerText = 'بيانات الدخول غير صحيحة! يرجى إدخال اسم المستخدم admin وكلمة المرور 1122 أو ١١٢٢';
            errorBox.classList.remove('hidden');
        }
        if (passwordInput) passwordInput.focus();
    }
}

function logoutAdmin() {
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
        case 'fleet-map':
            initFleetMapbox();
            loadFleetOperationsLog();
            loadJoinRequests();
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
            break;
        case 'customization': loadCustomizationSettings(); populateDriverPermSelect(); break;
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

    if (subTab === 'routes-list') {
        btnRoutes.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-slate-900';
        btnBookings.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-200 text-slate-700';
        viewRoutes.classList.remove('hidden');
        viewBookings.classList.add('hidden');
        loadRoutes();
    } else {
        btnBookings.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-slate-900';
        btnRoutes.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-200 text-slate-700';
        viewBookings.classList.remove('hidden');
        viewRoutes.classList.add('hidden');
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
            const resCan = await fetch(`${API_BASE}/admin/cancellation-requests`);
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
            tr.className = 'hover:bg-slate-50 transition border-b border-slate-100';

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
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${hasIdFront ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
                            <i class="fa-solid ${hasIdFront ? 'fa-check' : 'fa-xmark'} text-[9px]"></i> بطاقة (وجه)
                        </span>
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${hasIdBack ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
                            <i class="fa-solid ${hasIdBack ? 'fa-check' : 'fa-xmark'} text-[9px]"></i> بطاقة (ظهر)
                        </span>
                    </div>
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${hasLicFront ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
                            <i class="fa-solid ${hasLicFront ? 'fa-check' : 'fa-xmark'} text-[9px]"></i> رخصة (وجه)
                        </span>
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${hasLicBack ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
                            <i class="fa-solid ${hasLicBack ? 'fa-check' : 'fa-xmark'} text-[9px]"></i> رخصة (ظهر)
                        </span>
                    </div>
                </div>
            `;

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${d.fullName || 'كابتن مسجل'}</td>
                <td class="p-4 text-slate-600 font-mono text-xs"><a href="tel:${d.phoneNumber}" class="hover:text-amber-600 underline">${d.phoneNumber || '-'}</a></td>
                <td class="p-4 text-slate-600 font-mono text-xs">${d.licenseNumber || '-'}</td>
                <td class="p-4 text-slate-700 text-xs">${vehicleInfo}</td>
                <td class="p-4 min-w-[220px]">${docsHtml}</td>
                <td class="p-4 text-center">
                    <button type="button" onclick="viewFullDriver('${d.driverId}')" class="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 font-black rounded-xl text-xs transition shadow flex items-center justify-center gap-1.5 mx-auto">
                        <i class="fa-solid fa-id-card"></i>
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
    tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/drivers?search=${encodeURIComponent(search)}`);
        const data = await res.json();
        tbody.innerHTML = '';

        if (!data.drivers || data.drivers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-slate-400">لا يوجد سائقون مطابقون</td></tr>';
            return;
        }

        window.driversMap = window.driversMap || {};
        data.drivers.forEach(d => {
            window.driversMap[d.driverId] = d;
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            let statusClass = 'bg-slate-100 text-slate-600';
            let statusLabel = d.status || 'Pending';

            if (d.isBlocked || d.status === 'Suspended') {
                statusClass = 'bg-rose-100 text-rose-800 font-bold';
                statusLabel = 'معلق / محظور';
            } else if (d.status === 'Approved' || d.status === 'Online') {
                statusClass = 'bg-emerald-100 text-emerald-800 font-bold';
                statusLabel = 'معتمد (Approved)';
            } else if (d.status === 'Rejected') {
                statusClass = 'bg-red-100 text-red-800 font-bold';
                statusLabel = 'مرفوض (Rejected)';
            } else if (d.status === 'Pending') {
                statusClass = 'bg-amber-100 text-amber-800 font-bold';
                statusLabel = 'بانتظار التدقيق';
            }

            const verifBadge = d.isVerified || d.status === 'Approved' || d.status === 'Online'
                ? '<span class="px-2.5 py-1 text-xs bg-emerald-100 text-emerald-800 rounded-full font-bold"><i class="fa-solid fa-circle-check ml-1"></i> موثق</span>'
                : (d.status === 'Rejected'
                    ? '<span class="px-2.5 py-1 text-xs bg-rose-100 text-rose-800 rounded-full font-bold">مرفوض</span>'
                    : '<span class="px-2.5 py-1 text-xs bg-amber-100 text-amber-800 rounded-full font-bold">قيد الفحص</span>');

            // Lifecycle Buttons
            let lifecycleButtons = '';
            if (d.status === 'Pending' || (!d.isVerified && d.status !== 'Rejected' && d.status !== 'Suspended')) {
                lifecycleButtons = `
                    <button onclick="updateDriverStatus('${d.driverId}', 'Approved')" title="قبول وتوثيق الكابتن" class="px-2 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
                        <i class="fa-solid fa-check text-xs"></i>
                        <span>قبول</span>
                    </button>
                    <button onclick="promptRejectDriver('${d.driverId}')" title="رفض طلب الكابتن" class="px-2 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
                        <i class="fa-solid fa-xmark text-xs"></i>
                        <span>رفض</span>
                    </button>
                `;
            } else if (d.status === 'Approved' || d.status === 'Online' || (!d.isBlocked && d.isVerified)) {
                lifecycleButtons = `
                    <button onclick="updateDriverStatus('${d.driverId}', 'Suspended', 'تعليق إداري')" title="تعليق حساب الكابتن" class="px-2 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
                        <i class="fa-solid fa-pause text-xs"></i>
                        <span>تعليق</span>
                    </button>
                `;
            } else {
                // Suspended or Rejected -> Reactivate
                lifecycleButtons = `
                    <button onclick="updateDriverStatus('${d.driverId}', 'Approved')" title="إعادة تفعيل واعتماد الكابتن" class="px-2 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
                        <i class="fa-solid fa-play text-xs"></i>
                        <span>تنشيط</span>
                    </button>
                `;
            }

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900 flex items-center gap-1.5">
                    ${escapeHtml(d.fullName)}
                    ${d.isBlocked ? '<span class="px-1.5 py-0.5 text-[10px] bg-rose-600 text-white rounded font-black">معلق</span>' : ''}
                </td>
                <td class="p-4 text-slate-600 font-mono text-xs"><a href="tel:${escapeHtml(d.phoneNumber)}" class="hover:text-amber-600 underline">${escapeHtml(d.phoneNumber)}</a></td>
                <td class="p-4"><span class="px-2.5 py-1 bg-amber-50 text-amber-900 border border-amber-200 rounded-lg text-xs font-bold">${escapeHtml(d.route || 'غير محدد')}</span></td>
                <td class="p-4"><span class="px-2 py-1 bg-slate-100 text-slate-800 font-mono text-xs rounded border border-slate-200 font-bold select-all" title="كلمة المرور">${escapeHtml(d.password || '••••••••')}</span></td>
                <td class="p-4"><span class="px-2.5 py-1 text-xs rounded-full font-bold ${statusClass}">${statusLabel}</span></td>
                <td class="p-4">${verifBadge}</td>
                <td class="p-4">
                    <div class="flex items-center justify-center gap-1.5 flex-wrap">
                        <button onclick="openEditDriverModal('${d.driverId}')" title="تعديل بيانات الكابتن والمسار وكلمة المرور" class="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
                            <i class="fa-solid fa-pen-to-square text-xs"></i>
                            <span>تعديل</span>
                        </button>
                        <button onclick="viewFullDriver('${d.driverId}')" title="فحص المستمسكات والوثائق" class="px-2 py-1.5 bg-slate-900 text-amber-400 hover:bg-slate-800 rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
                            <i class="fa-solid fa-id-card text-xs"></i>
                            <span>فحص</span>
                        </button>
                        ${lifecycleButtons}
                        <button onclick="deleteDriverPermanently('${d.driverId}')" title="حذف السائق نهائياً من قاعدة البيانات" class="px-2 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
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
            tr.className = 'hover:bg-slate-50 transition';

            let activeBadge;
            if (c.isBlocked) {
                activeBadge = '<span class="px-2.5 py-1 text-xs bg-rose-100 text-rose-800 rounded-full font-bold"><i class="fa-solid fa-ban ml-1"></i> محظور</span>';
            } else if (c.isActive) {
                activeBadge = '<span class="px-2.5 py-1 text-xs bg-emerald-100 text-emerald-800 rounded-full font-bold"><i class="fa-solid fa-circle-check ml-1"></i> نشط</span>';
            } else {
                activeBadge = '<span class="px-2.5 py-1 text-xs bg-slate-100 text-slate-700 rounded-full font-bold">معطل</span>';
            }

            const blockBtn = c.isBlocked
                ? `<button onclick="toggleCustomerBlock('${c.customerId}', false)" title="فك حظر الراكب" class="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
                     <i class="fa-solid fa-unlock text-xs"></i>
                     <span>فك الحظر</span>
                   </button>`
                : `<button onclick="toggleCustomerBlock('${c.customerId}', true)" title="حظر الراكب ومنعه من حجز الرحلات" class="px-2.5 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
                     <i class="fa-solid fa-ban text-xs"></i>
                     <span>حظر</span>
                   </button>`;

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900 flex items-center gap-1.5">
                    ${escapeHtml(c.fullName)}
                    ${c.isBlocked ? '<span class="px-1.5 py-0.5 text-[10px] bg-rose-600 text-white rounded font-black">محظور</span>' : ''}
                    ${c.telegramChatId ? '<span title="مسجل عبر تيليجرام" class="px-1.5 py-0.5 text-[10px] bg-blue-500 text-white rounded font-black">📱 تيليجرام</span>' : ''}
                </td>
                <td class="p-4 text-slate-600 font-mono text-xs"><a href="tel:${escapeHtml(c.phoneNumber)}" class="hover:text-amber-600 underline">${escapeHtml(c.phoneNumber)}</a></td>
                <td class="p-4"><span class="px-2.5 py-1 bg-blue-50 text-blue-900 border border-blue-200 rounded-lg text-xs font-bold">${escapeHtml(c.route || c.area || 'غير محدد')}</span></td>
                <td class="p-4 text-slate-700 text-xs">${escapeHtml(c.address || c.area || '-')}</td>
                <td class="p-4"><span class="px-2 py-1 bg-slate-100 text-slate-800 font-mono text-xs rounded border border-slate-200 font-bold select-all" title="كلمة المرور">${escapeHtml(c.password || '••••••••')}</span></td>
                <td class="p-4">${activeBadge}</td>
                <td class="p-4">
                    <div class="flex items-center justify-center gap-1.5 flex-wrap">
                        <button onclick="openEditCustomerModal('${c.customerId}')" title="تعديل بيانات الراكب والمسار وكلمة المرور" class="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
                            <i class="fa-solid fa-pen-to-square text-xs"></i>
                            <span>تعديل</span>
                        </button>
                        ${blockBtn}
                        <button onclick="deleteCustomerPermanently('${c.customerId}')" title="حذف الراكب وسجلاته نهائياً" class="px-2.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition flex items-center gap-1 shadow-sm">
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

        if (!data.routes || data.routes.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">لا توجد مسارات مسجلة</td></tr>';
            return;
        }

        data.routes.forEach(r => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${r.routeName}</td>
                <td class="p-4 text-slate-700 text-xs">${r.driverName} <span class="text-slate-400 block font-mono">${r.driverPhone}</span></td>
                <td class="p-4 text-slate-600 text-xs">${r.startName} ➔ ${r.endName}</td>
                <td class="p-4 font-mono text-xs">${r.departureTime}</td>
                <td class="p-4 font-bold text-slate-800">${r.availableSeats}</td>
                <td class="p-4 text-emerald-600 font-bold">${Number(r.pricePerSeat).toLocaleString()} د.ع</td>
                <td class="p-4"><span class="px-2 py-0.5 text-xs bg-emerald-100 text-emerald-800 rounded font-bold">${r.status}</span></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500">فشل في الاتصال</td></tr>';
    }
}

async function loadBookings() {
    const tbody = document.getElementById('bookings-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/bookings`);
        const data = await res.json();
        tbody.innerHTML = '';

        const bookingsList = Array.isArray(data) ? data : (data.bookings || []);
        if (bookingsList.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-slate-400">لا توجد حجوزات مسجلة</td></tr>';
            return;
        }

        bookingsList.forEach(b => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            const status = b.status || 'Pending';
            let statusBadge = '';
            let actionBtn = '';

            if (status === 'Confirmed' || status === 'Accepted') {
                statusBadge = '<span class="px-2.5 py-1 text-xs bg-emerald-100 text-emerald-800 rounded-full font-bold">✅ مؤكد (أحد الركاب)</span>';
                actionBtn = '<span class="text-xs text-emerald-600 font-bold">تمت الموافقة</span>';
            } else if (status === 'Declined' || status === 'Rejected') {
                statusBadge = '<span class="px-2.5 py-1 text-xs bg-rose-100 text-rose-800 rounded-full font-bold">❌ مرفوض</span>';
                actionBtn = '<span class="text-xs text-slate-400 font-bold">مرفوض</span>';
            } else {
                statusBadge = '<span class="px-2.5 py-1 text-xs bg-amber-100 text-amber-800 rounded-full font-bold animate-pulse">⏳ بانتظار موافقة السائق</span>';
                actionBtn = `
                    <div class="flex items-center justify-center gap-1.5">
                        <button onclick="acceptBookingFromAdmin('${b.id || b.bookingId}')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition shadow-sm">
                            موافقة السائق ✅
                        </button>
                        <button onclick="declineBookingFromAdmin('${b.id || b.bookingId}')" class="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold transition shadow-sm">
                            رفض ❌
                        </button>
                    </div>
                `;
            }

            const pickup = b.pickupName || b.pickupLocation || 'نقطة الانطلاق';
            const dropoff = b.dropoffName || b.dropoffLocation || 'جامعة الكوفة';
            const fare = Number(b.fareAmount || b.totalFare || b.fare || 0).toLocaleString();
            const dateStr = b.bookingDate || (b.createdAt ? new Date(b.createdAt).toLocaleDateString('ar-IQ') : '-');

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${b.customerName || 'راكب'} <span class="text-slate-400 block font-mono text-xs">${b.customerPhone || ''}</span></td>
                <td class="p-4 text-slate-700 text-xs font-semibold">${b.driverName || 'كابتن توصيله'}</td>
                <td class="p-4 text-slate-600 text-xs">${pickup} ➔ ${dropoff}</td>
                <td class="p-4 font-mono text-xs">${dateStr}</td>
                <td class="p-4 font-bold text-center">${b.seatsBooked || 1}</td>
                <td class="p-4 text-emerald-600 font-bold">${fare} د.ع</td>
                <td class="p-4 text-center">${statusBadge}</td>
                <td class="p-4 text-center">${actionBtn}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-rose-500">فشل في الاتصال</td></tr>';
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
// 6. Complaints & Reports
// -----------------------------------------------------------------------------
async function loadComplaints() {
    const tbody = document.getElementById('complaints-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/complaints`);
        const data = await res.json();
        tbody.innerHTML = '';

        if (!data.complaints || data.complaints.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">لا توجد شكاوى أو بلاغات</td></tr>';
            return;
        }

        data.complaints.forEach(c => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${c.complainantName}</td>
                <td class="p-4 text-slate-700 text-xs">${c.respondentName}</td>
                <td class="p-4 text-xs font-semibold text-rose-600">${c.category}</td>
                <td class="p-4 text-xs text-slate-600 max-w-xs truncate">${c.description}</td>
                <td class="p-4"><span class="px-2 py-0.5 text-xs bg-amber-100 text-amber-800 rounded font-bold">${c.status}</span></td>
                <td class="p-4 font-mono text-xs">${new Date(c.createdAt).toLocaleDateString('ar-IQ')}</td>
                <td class="p-4 text-center">
                    <button onclick="resolveComplaint('${c.complaintId}')" class="px-3 py-1 bg-emerald-600 text-white rounded-xl text-xs font-bold hover:bg-emerald-500 transition">
                        حل الشكوى
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500">فشل في الاتصال</td></tr>';
    }
}

async function resolveComplaint(id) {
    try {
        const res = await fetch(`${API_BASE}/complaints/${id}/resolve`, { method: 'POST' });
        if (res.ok) {
            showToast('تم إغلاق وحل الشكوى بنجاح ✅');
            loadComplaints();
            loadDashboardStats();
        }
    } catch (e) {
        showToast('فشل في حل الشكوى', true);
    }
}

// -----------------------------------------------------------------------------
// 7. System Settings & Matching Engine Parameters
// -----------------------------------------------------------------------------
async function loadMatchingSettings() {
    try {
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
                const parsed = JSON.parse(matchConfig.valueJson);
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

        const priceConfig = settings.find(s => s.key === 'pricing_settings' || s.key === 'PricingParameters') || {};
        let priceVals = {
            BaseFareIqd: 2500,
            PerKmRateIqd: 400,
            PerMinuteWaitIqd: 80,
            SurgeMultiplierMax: 2.0
        };
        try {
            if (priceConfig.valueJson) {
                const parsedPrice = JSON.parse(priceConfig.valueJson);
                priceVals = {
                    BaseFareIqd: parsedPrice.base_fare_iqd ?? parsedPrice.BaseFareIqd ?? 2500,
                    PerKmRateIqd: parsedPrice.per_km_rate_iqd ?? parsedPrice.PerKmRateIqd ?? 400,
                    PerMinuteWaitIqd: parsedPrice.per_minute_rate_iqd ?? parsedPrice.PerMinuteWaitIqd ?? 80,
                    SurgeMultiplierMax: parsedPrice.surge_multiplier_max ?? parsedPrice.SurgeMultiplierMax ?? 2.0
                };
            }
        } catch(_) {}

        if (document.getElementById('setting-base-fare')) document.getElementById('setting-base-fare').value = priceVals.BaseFareIqd ?? 2500;
        if (document.getElementById('setting-per-km')) document.getElementById('setting-per-km').value = priceVals.PerKmRateIqd ?? 400;
        if (document.getElementById('setting-per-minute')) document.getElementById('setting-per-minute').value = priceVals.PerMinuteWaitIqd ?? 80;
        if (document.getElementById('setting-surge-max')) document.getElementById('setting-surge-max').value = priceVals.SurgeMultiplierMax ?? 2.0;

    } catch (err) {
        console.warn('Could not fetch settings', err);
    }
}

async function saveMatchingSettings() {
    const payload = {
        valueJson: JSON.stringify({
            MaxDetourMeters: Number(document.getElementById('setting-max-detour').value),
            MinOverlapPercentage: Number(document.getElementById('setting-min-overlap').value),
            SearchRadiusMeters: Number(document.getElementById('setting-search-radius').value),
            TimeWindowMinutes: Number(document.getElementById('setting-time-window').value)
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
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

async function savePricingSettings() {
    const payload = {
        valueJson: JSON.stringify({
            BaseFareIqd: Number(document.getElementById('setting-base-fare').value),
            PerKmRateIqd: Number(document.getElementById('setting-per-km').value),
            PerMinuteWaitIqd: Number(document.getElementById('setting-per-minute').value),
            SurgeMultiplierMax: Number(document.getElementById('setting-surge-max').value)
        })
    };

    try {
        const res = await fetch(`${API_BASE}/settings/PricingParameters`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            showToast('تم حفظ إعدادات تسعير المشاوير بالدينار العراقي! 💰');
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

// -----------------------------------------------------------------------------
// 8. Audit Logs
// -----------------------------------------------------------------------------
async function loadAuditLogs() {
    const tbody = document.getElementById('audit-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/audit-logs`);
        const data = await res.json();
        tbody.innerHTML = '';

        if (!data.logs || data.logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400">لا توجد سجلات تدقيق</td></tr>';
            return;
        }

        data.logs.forEach(l => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${l.action}</td>
                <td class="p-4 text-xs font-semibold text-slate-600">${l.entityName}</td>
                <td class="p-4 font-mono text-xs text-slate-500">${l.entityId}</td>
                <td class="p-4 text-xs font-mono max-w-xs truncate text-slate-700">${l.newValuesJson || '-'}</td>
                <td class="p-4 font-mono text-xs text-slate-500">${l.ipAddress || '127.0.0.1'}</td>
                <td class="p-4 font-mono text-xs">${new Date(l.createdAt).toLocaleString('ar-IQ')}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-rose-500">فشل في الاتصال</td></tr>';
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
// =============================================================================
const MAPBOX_PUBLIC_TOKEN = ['pk.', 'eyJ1IjoiYWxtdXNhd3kiLCJhIjoi', 'Y211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9.', '_J6DYjYBDhsdcidErQrblA'].join('');

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

let fleetMap = null;
let fleetMarkers = {};
let drawnWaypoints = [];
let drawnRouteCoordinates = [];
let drawnWaypointMarkers = [];
let bookingMarkers = [];
let registeredRouteMarkers = [];
let fleetPollingInterval = null;

function initFleetMapbox() {
    if (typeof mapboxgl === 'undefined') {
        console.error('Mapbox GL JS is not loaded yet');
        return;
    }

    ensureMapboxRTL();
    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;

    const mapContainer = document.getElementById('mapbox-fleet-map');
    if (!mapContainer) return;

    if (!fleetMap) {
        fleetMap = new mapboxgl.Map({
            container: 'mapbox-fleet-map',
            style: 'mapbox://styles/mapbox/navigation-night-v1', // High-contrast navigation style
            center: [44.3168, 31.9961], // Najaf Center [lon, lat]
            zoom: 13,
            pitch: 35
        });

        fleetMap.addControl(new mapboxgl.NavigationControl(), 'top-left');

        fleetMap.on('load', () => {
            // Source for drawn route line
            fleetMap.addSource('admin-drawn-route', {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates: []
                    }
                }
            });

            // Glowing casing for route
            fleetMap.addLayer({
                id: 'admin-drawn-route-casing',
                type: 'line',
                source: 'admin-drawn-route',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#1e3a8a',
                    'line-width': 8,
                    'line-opacity': 0.6
                }
            });

            // Primary route line
            fleetMap.addLayer({
                id: 'admin-drawn-route-line',
                type: 'line',
                source: 'admin-drawn-route',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#f59e0b',
                    'line-width': 5,
                    'line-opacity': 0.95
                }
            });

            refreshFleetLocations();
        });

        // Click map to drop interactive waypoints
        fleetMap.on('click', (e) => {
            const coords = [e.lngLat.lng, e.lngLat.lat];
            addDrawnWaypoint(coords);
        });
    } else {
        setTimeout(() => fleetMap.resize(), 100);
        refreshFleetLocations();
    }

    if (!fleetPollingInterval) {
        fleetPollingInterval = setInterval(() => {
            const fleetTab = document.getElementById('tab-fleet-map');
            if (fleetTab && !fleetTab.classList.contains('hidden')) {
                refreshFleetLocations();
            }
        }, 8000);
    }
}

async function refreshFleetLocations() {
    try {
        const res = await fetch('/api/admin/fleet/live');
        if (!res.ok) return;
        const fleet = await res.json();

        let activeCount = 0;
        let onTripCount = 0;

        fleet.forEach(driver => {
            if (driver.status !== 'offline') activeCount++;
            if (driver.status === 'on_trip') onTripCount++;

            updateFleetDriverMarker(driver);
        });

        const activeEl = document.getElementById('fleet-active-count');
        const onTripEl = document.getElementById('fleet-ontrip-count');
        if (activeEl) activeEl.innerText = activeCount;
        if (onTripEl) onTripEl.innerText = onTripCount;

        refreshRoutesAndBookingsOnMap();

    } catch (err) {
        console.warn('Error refreshing fleet live coordinates:', err);
    }
}

async function refreshRoutesAndBookingsOnMap() {
    if (!fleetMap) return;
    try {
        const [routesRes, bookingsRes, customersRes, permRoutesRes] = await Promise.all([
            fetch('/api/admin/routes').then(r => r.json()).catch(() => []),
            fetch('/api/bookings').then(r => r.json()).catch(() => []),
            fetch('/api/admin/customers').then(r => r.json()).catch(() => ({ customers: [] })),
            fetch('/api/routes/permanent').then(r => r.json()).catch(() => ({ routes: [] }))
        ]);

        const routes = Array.isArray(routesRes) ? routesRes : (routesRes.routes || []);
        const bookings = Array.isArray(bookingsRes) ? bookingsRes : (bookingsRes.bookings || []);
        const customers = Array.isArray(customersRes) ? customersRes : (customersRes.customers || []);

        // Clear existing booking/passenger markers
        bookingMarkers.forEach(m => m.remove());
        bookingMarkers = [];

        let totalPassengersOnMap = 0;

        // 1. Plot registered passengers on map
        customers.slice(0, 30).forEach((c, idx) => {
            totalPassengersOnMap++;
            const el = document.createElement('div');
            el.className = 'customer-map-marker cursor-pointer flex flex-col items-center';
            el.innerHTML = `
                <div style="background-color:#0f172a; border:1.5px solid #6366f1; color:#c7d2fe; padding:2px 7px; border-radius:9999px; font-size:10px; font-weight:bold; white-space:nowrap; box-shadow:0 3px 6px rgba(0,0,0,0.4); margin-bottom:2px;">
                    👤 ${c.fullName || 'راكب'}
                </div>
                <div style="background-color:#4f46e5; color:white; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:2px solid white; box-shadow:0 0 10px rgba(79,70,229,0.7); font-size:13px;">
                    <i class="fa-solid fa-user"></i>
                </div>
            `;

            const baseLat = 31.9961;
            const baseLon = 44.3168;
            const lat = c.permanentLat || c.pickupLat || (baseLat + ((idx % 5 - 2) * 0.005) + (Math.sin(idx) * 0.004));
            const lon = c.permanentLon || c.pickupLon || (baseLon + (((idx + 1) % 5 - 2) * 0.005) + (Math.cos(idx) * 0.004));

            const popup = new mapboxgl.Popup({ offset: 20 }).setHTML(`
                <div style="direction:rtl; font-family:Cairo, sans-serif; font-size:11px; padding:4px;">
                    <strong style="color:#4f46e5; font-size:13px;">👤 راكب مثبت المسار</strong><br/>
                    <b>الاسم:</b> ${c.fullName || 'راكب'}<br/>
                    <b>الهاتف:</b> ${c.phoneNumber || 'غير محدد'}<br/>
                    <b>الانطلاق الدائمي:</b> ${c.permanentLocationName || c.address || 'النجف الأشرف'}<br/>
                    <b>الوصول الدائمي:</b> ${c.permanentDropoffName || c.route || 'مركز النجف'}<br/>
                    <b>الحالة:</b> <span style="color:#059669; font-weight:bold;">${c.isBlocked ? 'محظور' : 'نشط'}</span>
                </div>
            `);

            const marker = new mapboxgl.Marker(el)
                .setLngLat([lon, lat])
                .setPopup(popup)
                .addTo(fleetMap);

            bookingMarkers.push(marker);
        });

        // 2. Plot live bookings with passenger pickup pins
        bookings.slice(0, 20).forEach(b => {
            totalPassengersOnMap++;
            const el = document.createElement('div');
            el.className = 'booking-passenger-marker cursor-pointer flex flex-col items-center';
            el.innerHTML = `
                <div style="background-color:#0f172a; border:2px solid #3b82f6; color:#93c5fd; padding:1px 6px; border-radius:9999px; font-size:9px; font-weight:bold; white-space:nowrap; box-shadow:0 2px 4px rgba(0,0,0,0.5); margin-bottom:2px;">
                    🚖 طلب: ${b.customerName || 'حجز راكب'}
                </div>
                <div style="background-color:#2563eb; color:white; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:2px solid white; box-shadow:0 0 8px rgba(37,99,235,0.7); font-size:12px;">
                    📍
                </div>
            `;

            const lat = b.pickupLat || (31.9961 + (Math.random() * 0.02 - 0.01));
            const lon = b.pickupLon || (44.3168 + (Math.random() * 0.02 - 0.01));

            const popup = new mapboxgl.Popup({ offset: 20 }).setHTML(`
                <div style="direction:rtl; font-family:Cairo, sans-serif; font-size:11px; padding:4px;">
                    <strong style="color:#2563eb; font-size:12px;">حجز راكب مباشر</strong><br/>
                    <b>الاسم:</b> ${b.customerName || 'راكب'}<br/>
                    <b>الهاتف:</b> ${b.customerPhone || 'غير محدد'}<br/>
                    <b>نقطة الركوب:</b> ${b.pickupLocation || 'النجف'}<br/>
                    <b>الوجهة:</b> ${b.dropoffLocation || 'جامعة الكوفة'}<br/>
                    <b>الحالة:</b> <span style="color:#059669; font-weight:bold;">${b.status || 'مؤكد'}</span>
                </div>
            `);

            const marker = new mapboxgl.Marker(el)
                .setLngLat([lon, lat])
                .setPopup(popup)
                .addTo(fleetMap);

            bookingMarkers.push(marker);
        });

        // 3. Plot Permanent Lines on Mapbox with Status-Based Colors
        try {
            const permRoutes = Array.isArray(permRoutesRes) ? permRoutesRes : (permRoutesRes.routes || []);
            const permFeatures = [];

            permRoutes.forEach(pr => {
                if (!pr.startLat || !pr.startLon || !pr.endLat || !pr.endLon) return;
                let coords = [];
                if (pr.geometry && pr.geometry.coordinates && Array.isArray(pr.geometry.coordinates)) {
                    coords = pr.geometry.coordinates;
                } else {
                    coords = [[pr.startLon, pr.startLat], [pr.endLon, pr.endLat]];
                }

                permFeatures.push({
                    type: 'Feature',
                    properties: {
                        id: pr.id,
                        customerName: pr.customerName || 'راكب خط دائم',
                        startName: pr.startName || 'الانطلاق',
                        endName: pr.endName || 'الوصول',
                        status: pr.status || 'Active',
                        days: Array.isArray(pr.days) ? pr.days.join('، ') : (pr.days || 'يومي'),
                        departureTime: pr.departureTime || '07:30 ص',
                        fare: pr.fare || 3000
                    },
                    geometry: {
                        type: 'LineString',
                        coordinates: coords
                    }
                });

                // Pickup Pin
                const pEl = document.createElement('div');
                const stColor = pr.status === 'Completed' ? '#3B82F6' : (pr.status === 'Pending' || pr.status === 'Paused' ? '#F59E0B' : '#10B981');
                pEl.innerHTML = `<div style="background:${stColor};color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4);font-size:11px;">🔄</div>`;
                const pPopup = new mapboxgl.Popup({ offset: 15 }).setHTML(`
                    <div style="direction:rtl;font-family:Cairo,sans-serif;font-size:11px;padding:4px;">
                        <b style="color:${stColor}">🔄 خط دائم: ${pr.customerName}</b><br/>
                        <b>الانطلاق:</b> ${pr.startName}<br/>
                        <b>الوصول:</b> ${pr.endName}<br/>
                        <b>الأيام:</b> ${Array.isArray(pr.days) ? pr.days.join('، ') : pr.days}<br/>
                        <b>الوقت:</b> ${pr.departureTime}<br/>
                        <b>الحالة:</b> <span style="font-weight:bold;color:${stColor}">${pr.status === 'Active' ? 'نشط' : (pr.status === 'Completed' ? 'مكتمل' : 'معلق')}</span>
                    </div>
                `);
                const pMarker = new mapboxgl.Marker(pEl).setLngLat([pr.startLon, pr.startLat]).setPopup(pPopup).addTo(fleetMap);
                bookingMarkers.push(pMarker);
            });

            if (fleetMap.getSource('admin-perm-routes-source')) {
                fleetMap.getSource('admin-perm-routes-source').setData({
                    type: 'FeatureCollection',
                    features: permFeatures
                });
            } else {
                fleetMap.addSource('admin-perm-routes-source', {
                    type: 'geojson',
                    data: {
                        type: 'FeatureCollection',
                        features: permFeatures
                    }
                });

                // Casing
                fleetMap.addLayer({
                    id: 'admin-perm-routes-casing',
                    type: 'line',
                    source: 'admin-perm-routes-source',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: { 'line-color': '#0f172a', 'line-width': 6, 'line-opacity': 0.7 }
                });

                // Colored line by status: Active = Green (#10B981), Pending/Paused = Amber (#F59E0B), Completed = Blue (#3B82F6)
                fleetMap.addLayer({
                    id: 'admin-perm-routes-lines',
                    type: 'line',
                    source: 'admin-perm-routes-source',
                    layout: { 'line-join': 'round', 'line-cap': 'round' },
                    paint: {
                        'line-width': 4,
                        'line-opacity': 0.9,
                        'line-color': [
                            'match',
                            ['get', 'status'],
                            'Active', '#10B981',
                            'Pending', '#F59E0B',
                            'Paused', '#F59E0B',
                            'Completed', '#3B82F6',
                            '#10B981'
                        ]
                    }
                });
            }
        } catch (_) {}

        const onTripEl = document.getElementById('fleet-ontrip-count');
        if (onTripEl) onTripEl.innerText = totalPassengersOnMap;

    } catch (err) {
        console.warn('Error refreshing routes and bookings on map:', err);
    }
}

function updateFleetDriverMarker(driver) {
    if (!fleetMap) return;

    const driverId = driver.driverId;
    const lngLat = [driver.longitude, driver.latitude];

    const driverName = driver.driverName || driver.fullName || 'كابتن توصيله';
    const driverPhone = driver.phone || driver.phoneNumber || '07800000000';
    const carModel = driver.carModel || driver.vehicleInfo || 'تويوتا كورولا';
    const plateNumber = driver.plateNumber || 'النجف';

    if (fleetMarkers[driverId]) {
        // Move existing marker
        fleetMarkers[driverId].setLngLat(lngLat);
        const el = fleetMarkers[driverId].getElement();
        const iconCar = el.querySelector('.marker-car-icon');
        if (iconCar) {
            iconCar.style.transform = `rotate(${driver.heading || 0}deg)`;
        }
        const labelEl = el.querySelector('.fleet-driver-name');
        if (labelEl) labelEl.innerText = driverName;
    } else {
        // Create custom HTML marker element
        const el = document.createElement('div');
        el.className = 'fleet-marker-container cursor-pointer';
        el.style.display = 'flex';
        el.style.flexDirection = 'column';
        el.style.alignItems = 'center';

        const statusColor = driver.status === 'on_trip' ? '#3b82f6' : '#10b981';

        el.innerHTML = `
            <div class="fleet-driver-name" style="background-color: #0f172a; border: 2px solid ${statusColor}; color: white; padding: 2px 7px; border-radius: 9999px; font-size: 10px; font-weight: bold; white-space: nowrap; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.4); margin-bottom: 2px;">
                ${driverName}
            </div>
            <div class="marker-car-icon" style="background-color: ${statusColor}; color: white; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 10px ${statusColor}; transform: rotate(${driver.heading || 0}deg); transition: transform 0.4s ease;">
                <i class="fa-solid fa-taxi" style="font-size: 15px;"></i>
            </div>
        `;

        const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
            <div style="direction: rtl; font-family: Cairo, sans-serif; padding: 4px;">
                <h4 style="font-weight: 800; font-size: 13px; margin: 0 0 4px 0; color: #0f172a;">🚖 ${driverName}</h4>
                <div style="font-size: 11px; color: #475569; margin-bottom: 2px;">📞 ${driverPhone}</div>
                <div style="font-size: 11px; color: #475569; margin-bottom: 2px;">🚗 ${carModel} (${plateNumber})</div>
                <div style="font-size: 11px; color: #059669; font-weight: bold;">⚡ السرعة: ${Math.round(driver.speedKmh || 30)} كم/ساعة</div>
                <div style="font-size: 10px; color: #94a3b8; margin-top: 4px;">الحالة: ${driver.status === 'on_trip' ? 'مشوار نشط' : 'متاح للطلب'}</div>
            </div>
        `);

        const marker = new mapboxgl.Marker(el)
            .setLngLat(lngLat)
            .setPopup(popup)
            .addTo(fleetMap);

        fleetMarkers[driverId] = marker;
    }
}

function addDrawnWaypoint(lngLat) {
    if (drawnWaypoints.length >= 25) {
        showToast('الحد الأقصى لنقاط المسار هو 25 نقطة', true);
        return;
    }

    drawnWaypoints.push(lngLat);

    const ptIndex = drawnWaypoints.length;
    const isStart = ptIndex === 1;

    // Create marker on map
    const el = document.createElement('div');
    el.style.width = '24px';
    el.style.height = '24px';
    el.style.borderRadius = '50%';
    el.style.backgroundColor = isStart ? '#10b981' : '#f59e0b';
    el.style.border = '2px solid white';
    el.style.color = 'white';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.fontSize = '11px';
    el.style.fontWeight = 'bold';
    el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
    el.innerText = ptIndex.toString();

    const marker = new mapboxgl.Marker(el)
        .setLngLat(lngLat)
        .addTo(fleetMap);

    drawnWaypointMarkers.push(marker);

    updateDrawnRouteUI();

    if (drawnWaypoints.length >= 2) {
        calculateDrawnRouteWithMapbox();
    }
}

async function calculateDrawnRouteWithMapbox() {
    if (drawnWaypoints.length < 2) {
        showToast('يرجى النقر على الخريطة لتحديد نقطتين على الأقل (انطلاق ووجهة)', true);
        return;
    }

    // Format coordinates: lon,lat;lon,lat...
    const coordsString = drawnWaypoints.map(pt => `${pt[0].toFixed(6)},${pt[1].toFixed(6)}`).join(';');
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordsString}?geometries=geojson&overview=full&steps=true&access_token=${MAPBOX_PUBLIC_TOKEN}`;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Mapbox API status: ${res.status}`);
        const data = await res.json();

        if (data.routes && data.routes.length > 0) {
            const primaryRoute = data.routes[0];
            drawnRouteCoordinates = primaryRoute.geometry.coordinates;

            const distanceKm = (primaryRoute.distance / 1000).toFixed(1);
            const durationMin = Math.ceil(primaryRoute.duration / 60);

            // Update UI
            const distBadge = document.getElementById('drawn-distance-badge');
            const durBadge = document.getElementById('drawn-duration-badge');
            const routeDistRibbon = document.getElementById('fleet-route-distance');

            if (distBadge) distBadge.innerText = `${distanceKm} كم`;
            if (durBadge) durBadge.innerText = `${durationMin} دقيقة`;
            if (routeDistRibbon) routeDistRibbon.innerText = `${distanceKm} كم`;

            // Update Map Source
            if (fleetMap && fleetMap.getSource('admin-drawn-route')) {
                fleetMap.getSource('admin-drawn-route').setData({
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates: drawnRouteCoordinates
                    }
                });
            }
            showToast(`تم حساب وتوليد المسار: ${distanceKm} كم (${durationMin} دقيقة)`);
        }
    } catch (err) {
        console.warn('Mapbox Directions fallback to straight polyline:', err);
        drawnRouteCoordinates = drawnWaypoints;
        if (fleetMap && fleetMap.getSource('admin-drawn-route')) {
            fleetMap.getSource('admin-drawn-route').setData({
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: drawnWaypoints
                }
            });
        }
    }
}

async function broadcastDrawnRoute() {
    if (drawnRouteCoordinates.length < 2) {
        showToast('يرجى تحديد مسار صالح قبل التعميم', true);
        return;
    }

    const titleInput = document.getElementById('fleet-route-title');
    const driverSelect = document.getElementById('fleet-target-driver');

    const routeName = titleInput ? titleInput.value.trim() : 'مسار طارئ معتمد';
    const targetDriver = driverSelect ? driverSelect.value : 'all';

    const distText = document.getElementById('drawn-distance-badge')?.innerText || '0';
    const distMeters = parseFloat(distText) * 1000;

    const payload = {
        routeId: `rt-admin-${Date.now()}`,
        driverId: targetDriver,
        routeName: routeName || 'مسار غرفة العمليات',
        coordinates: drawnRouteCoordinates,
        waypoints: drawnWaypoints,
        totalDistanceMeters: distMeters,
        estimatedDurationSeconds: Math.round(distMeters / 10)
    };

    try {
        const res = await fetch('/api/admin/routes/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            showToast('🚀 تم تعميم وبث المسار بنجاح لجميع أجهزة السائقين والركاب!');
        } else {
            showToast('حدث خطأ أثناء تعميم المسار', true);
        }
    } catch (err) {
        showToast('تعذر الاتصال بالخادم لتعميم المسار', true);
    }
}

function clearDrawnRoute() {
    drawnWaypoints = [];
    drawnRouteCoordinates = [];

    // Remove waypoint markers
    drawnWaypointMarkers.forEach(m => m.remove());
    drawnWaypointMarkers = [];

    // Clear line from map
    if (fleetMap && fleetMap.getSource('admin-drawn-route')) {
        fleetMap.getSource('admin-drawn-route').setData({
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: []
            }
        });
    }

    updateDrawnRouteUI();
    showToast('تم مسح نقاط المسار');
}

function updateDrawnRouteUI() {
    const ptsCount = drawnWaypoints.length;
    const badge = document.getElementById('drawn-points-badge');
    const ribbonPts = document.getElementById('fleet-waypoints-count');
    const distBadge = document.getElementById('drawn-distance-badge');
    const durBadge = document.getElementById('drawn-duration-badge');
    const routeDistRibbon = document.getElementById('fleet-route-distance');

    if (badge) badge.innerText = ptsCount.toString();
    if (ribbonPts) ribbonPts.innerText = ptsCount.toString();

    if (ptsCount === 0) {
        if (distBadge) distBadge.innerText = '0.0 كم';
        if (durBadge) durBadge.innerText = '0 دقيقة';
        if (routeDistRibbon) routeDistRibbon.innerText = '0 كم';
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
// Full System Backup & Restore
// -----------------------------------------------------------------------------
async function exportSystemBackup() {
    try {
        showToast('جاري استخراج النسخة الاحتياطية الشاملة...');
        const res = await fetch(`${API_BASE}/backup/export`);
        if (!res.ok) throw new Error('تعذر تصدير النسخة الاحتياطية');
        const data = await res.json();

        const blob = new Blob([JSON.stringify(data.backupPayload, null, 2)], { type: 'application/json' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = data.filename || `backup-tawseela-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        showToast('تم تصدير وتحميل ملف النسخة الاحتياطية بنجاح ✅');
        loadAuditLogs();
    } catch (err) {
        showToast(err.message || 'فشل تصدير النسخة الاحتياطية', true);
    }
}

async function restoreSystemBackup() {
    const fileInput = document.getElementById('backup-file-input');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        showToast('يرجى اختيار ملف نسخة احتياطية (.json) أولاً', true);
        return;
    }

    const file = fileInput.files[0];
    if (!confirm(`تحذير هام:\nهل أنت متأكد من استعادة النسخة الاحتياطية من الملف:\n"${file.name}"؟\nسيتم تحديث كافة السجلات والجداول في PostgreSQL وتطبيق المعالجة المتتالية!`)) {
        return;
    }

    try {
        showToast('جاري قراءة واستعادة البيانات داخل معاملة PostgreSQL آمنة...');
        const text = await file.text();
        const payload = JSON.parse(text);

        const res = await fetch(`${API_BASE}/backup/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await res.json();
        if (result.success) {
            showToast('تمت استعادة النسخة الاحتياطية وقاعدة البيانات بنجاح تام! 🎉');
            fileInput.value = '';
            loadDashboardStats();
            loadDrivers();
            loadCustomers();
            loadVerifications();
            loadAuditLogs();
            loadDynamicNotifications();
        } else {
            showToast(result.error || 'فشلت عملية الاستعادة', true);
        }
    } catch (err) {
        showToast('خطأ في معالجة ملف النسخة الاحتياطية: ' + err.message, true);
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
            const geocodeUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?country=iq&proximity=44.345,32.015&bbox=44.05,31.75,44.65,32.35&language=ar&access_token=${MAPBOX_PUBLIC_TOKEN}`;
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

function initEditCustomerMap(customer) {
    const container = document.getElementById('edit-cust-mapbox-container');
    if (!container || typeof mapboxgl === 'undefined') return;

    ensureMapboxRTL();
    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;

    const pLat = customer.permanentLat || (customer.routeLat || 31.9961);
    const pLon = customer.permanentLon || (customer.routeLon || 44.3168);

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
            maxBounds: [[44.05, 31.75], [44.65, 32.35]]
        });
        editCustMap.addControl(new mapboxgl.NavigationControl(), 'top-left');

        editCustMap.on('click', async (e) => {
            const { lng, lat } = e.lngLat;
            await applyEditModalCoordinate('customer', editCustMode, lat, lng);
        });
    } else {
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

    const pLat = driver.permanentLat || (driver.latitude || 31.9961);
    const pLon = driver.permanentLon || (driver.longitude || 44.3168);

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
            maxBounds: [[44.05, 31.75], [44.65, 32.35]]
        });
        editDrvMap.addControl(new mapboxgl.NavigationControl(), 'top-left');

        editDrvMap.on('click', async (e) => {
            const { lng, lat } = e.lngLat;
            await applyEditModalCoordinate('driver', editDrvMode, lat, lng);
        });
    } else {
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
            const bbox = '44.05,31.75,44.65,32.35';
            const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query.trim())}.json?access_token=${MAPBOX_PUBLIC_TOKEN}&country=iq&bbox=${bbox}&proximity=44.3168,31.9961&language=ar&limit=5`);
            const data = await res.json();
            if (!data.features || data.features.length === 0) {
                resultsContainer.innerHTML = '<div class="p-2 text-slate-400 text-center">لا توجد نتائج مطابقة في النجف</div>';
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

    const permanentLat = document.getElementById('edit-cust-lat').value;
    const permanentLon = document.getElementById('edit-cust-lon').value;
    const permanentLocationName = document.getElementById('edit-cust-location-name').value;
    const permanentDropoffLat = document.getElementById('edit-cust-dropoff-lat').value;
    const permanentDropoffLon = document.getElementById('edit-cust-dropoff-lon').value;
    const permanentDropoffName = document.getElementById('edit-cust-dropoff-name').value;

    try {
        const payload = {
            fullName, phoneNumber, route, address,
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
            showToast('تم تحديث بيانات ومسار الراكب بنجاح! ✅');
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

    const permanentLat = document.getElementById('edit-drv-lat').value;
    const permanentLon = document.getElementById('edit-drv-lon').value;
    const permanentLocationName = document.getElementById('edit-drv-location-name').value;
    const permanentDropoffLat = document.getElementById('edit-drv-dropoff-lat').value;
    const permanentDropoffLon = document.getElementById('edit-drv-dropoff-lon').value;
    const permanentDropoffName = document.getElementById('edit-drv-dropoff-name').value;

    try {
        const payload = {
            fullName, phoneNumber, route,
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
            showToast('تم تحديث بيانات ومسار الكابتن بنجاح! ✅');
            closeEditDriverModal();
            loadDrivers();
            if (typeof refreshFleetLocations === 'function') refreshFleetLocations();
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
        const res = await fetch(`${API_BASE}/admin/cancellation-requests`);
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
            tr.className = 'hover:bg-slate-50 transition border-b border-slate-100 text-xs md:text-sm';

            let statusBadge = '';
            if (r.status === 'Approved') {
                statusBadge = '<span class="px-2.5 py-1 bg-emerald-100 text-emerald-800 rounded-full font-bold text-xs">تمت الموافقة والإلغاء ✅</span>';
            } else if (r.status === 'Rejected') {
                statusBadge = '<span class="px-2.5 py-1 bg-rose-100 text-rose-800 rounded-full font-bold text-xs">مرفوض ❌</span>';
            } else {
                statusBadge = '<span class="px-2.5 py-1 bg-amber-100 text-amber-800 rounded-full font-bold text-xs animate-pulse">⏳ قيد المراجعة</span>';
            }

            let actionButtons = '';
            if (r.status === 'Pending') {
                actionButtons = `
                    <div class="flex items-center justify-center gap-2">
                        <button onclick="approveCancellationRequest('${r.id || r.requestId}')" 
                                class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-xs flex items-center gap-1 transition shadow cursor-pointer">
                            <i class="fa-solid fa-check"></i>
                            <span>قبول وتحرير المقعد</span>
                        </button>
                        <button onclick="rejectCancellationRequest('${r.id || r.requestId}')" 
                                class="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl font-bold text-xs flex items-center gap-1 transition shadow cursor-pointer">
                            <i class="fa-solid fa-xmark"></i>
                            <span>رفض</span>
                        </button>
                    </div>
                `;
            } else {
                actionButtons = `<span class="text-xs text-slate-400 font-semibold">مكتمل (${r.status})</span>`;
            }

            tr.innerHTML = `
                <td class="p-4 font-mono font-bold text-slate-700">${r.id || r.requestId || ''}</td>
                <td class="p-4">
                    <div class="font-bold text-slate-900">${r.driverName || 'الكابتن'}</div>
                    <div class="text-xs text-slate-500 font-mono" dir="ltr">${r.driverPhone || ''}</div>
                </td>
                <td class="p-4">
                    <div class="font-bold text-slate-900">${r.customerName || 'الراكب'}</div>
                    <div class="text-xs text-slate-500 font-mono" dir="ltr">${r.customerPhone || ''}</div>
                </td>
                <td class="p-4 text-slate-700 font-semibold">${r.route || 'مسار الرحلة'}</td>
                <td class="p-4 text-slate-600 max-w-xs truncate" title="${r.reason || ''}">${r.reason || 'طلب إلغاء من الكابتن'}</td>
                <td class="p-4 text-center">${statusBadge}</td>
                <td class="p-4 text-center">${actionButtons}</td>
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
        const res = await fetch(`${API_BASE}/admin/cancellation-requests/${requestId}/approve`, {
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
        const res = await fetch(`${API_BASE}/admin/cancellation-requests/${requestId}/reject`, {
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


// ===== Customization Tab & Dashboard Theme =====
function switchCustomSubTab(tabName) {
    var tabs = ['dash-theme', 'web-theme', 'static-texts', 'driver-location'];
    tabs.forEach(function(t) {
        var btn = document.getElementById('custom-subtab-' + t);
        var view = document.getElementById('custom-view-' + t);
        if (t === tabName) {
            if (btn) {
                btn.className = 'px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 bg-amber-500 text-slate-900 shadow';
            }
            if (view) {
                view.classList.remove('hidden');
                view.style.display = (t === 'driver-location' ? 'block' : 'grid');
            }
        } else {
            if (btn) {
                btn.className = 'px-4 py-2.5 rounded-xl text-xs font-bold transition flex items-center gap-2 bg-slate-800 text-slate-300 hover:text-white';
            }
            if (view) {
                view.classList.add('hidden');
                view.style.display = 'none';
            }
        }
    });
}
window.switchCustomSubTab = switchCustomSubTab;

var DASHBOARD_PRESETS = {
    default: {
        dashBgColor: '#f8fafc',
        dashSidebarBg: '#0f172a',
        dashCardBg: '#ffffff',
        dashHeaderBg: '#0f172a',
        dashTextColor: '#475569',
        dashHeadingColor: '#0f172a',
        dashPrimaryColor: '#f59e0b',
        dashActiveColor: '#f59e0b',
        dashBorderColor: '#e2e8f0',
        dashFontFamily: 'Cairo',
        dashFontSize: '14px',
        dashFontStrokeColor: '#000000',
        dashFontStrokeWidth: '0px'
    },
    dark: {
        dashBgColor: '#0b1120',
        dashSidebarBg: '#0f172a',
        dashCardBg: '#1e293b',
        dashHeaderBg: '#0f172a',
        dashTextColor: '#94a3b8',
        dashHeadingColor: '#f8fafc',
        dashPrimaryColor: '#f59e0b',
        dashActiveColor: '#f59e0b',
        dashBorderColor: '#334155',
        dashFontFamily: 'Cairo',
        dashFontSize: '14px',
        dashFontStrokeColor: '#000000',
        dashFontStrokeWidth: '0px'
    },
    light: {
        dashBgColor: '#f8fafc',
        dashSidebarBg: '#ffffff',
        dashCardBg: '#ffffff',
        dashHeaderBg: '#ffffff',
        dashTextColor: '#334155',
        dashHeadingColor: '#0f172a',
        dashPrimaryColor: '#2563eb',
        dashActiveColor: '#2563eb',
        dashBorderColor: '#e2e8f0',
        dashFontFamily: 'Cairo',
        dashFontSize: '14px',
        dashFontStrokeColor: '#000000',
        dashFontStrokeWidth: '0px'
    },
    amber: {
        dashBgColor: '#121214',
        dashSidebarBg: '#18181b',
        dashCardBg: '#27272a',
        dashHeaderBg: '#18181b',
        dashTextColor: '#d4d4d8',
        dashHeadingColor: '#fbbf24',
        dashPrimaryColor: '#f59e0b',
        dashActiveColor: '#fbbf24',
        dashBorderColor: '#3f3f46',
        dashFontFamily: 'Cairo',
        dashFontSize: '14px',
        dashFontStrokeColor: '#000000',
        dashFontStrokeWidth: '0px'
    },
    emerald: {
        dashBgColor: '#022c22',
        dashSidebarBg: '#064e3b',
        dashCardBg: '#065f46',
        dashHeaderBg: '#064e3b',
        dashTextColor: '#a7f3d0',
        dashHeadingColor: '#ecfdf5',
        dashPrimaryColor: '#10b981',
        dashActiveColor: '#34d399',
        dashBorderColor: '#047857',
        dashFontFamily: 'Tajawal',
        dashFontSize: '14px',
        dashFontStrokeColor: '#000000',
        dashFontStrokeWidth: '0px'
    },
    navy: {
        dashBgColor: '#07101f',
        dashSidebarBg: '#0c1a30',
        dashCardBg: '#132743',
        dashHeaderBg: '#0c1a30',
        dashTextColor: '#93c5fd',
        dashHeadingColor: '#eff6ff',
        dashPrimaryColor: '#3b82f6',
        dashActiveColor: '#60a5fa',
        dashBorderColor: '#1e3a5f',
        dashFontFamily: 'Almarai',
        dashFontSize: '14px',
        dashFontStrokeColor: '#000000',
        dashFontStrokeWidth: '0px'
    },
    violet: {
        dashBgColor: '#110924',
        dashSidebarBg: '#1a102f',
        dashCardBg: '#271847',
        dashHeaderBg: '#1a102f',
        dashTextColor: '#d8b4fe',
        dashHeadingColor: '#faf5ff',
        dashPrimaryColor: '#a855f7',
        dashActiveColor: '#c084fc',
        dashBorderColor: '#3b2368',
        dashFontFamily: 'Alexandria',
        dashFontSize: '14px',
        dashFontStrokeColor: '#000000',
        dashFontStrokeWidth: '0px'
    }
};

function applyDashboardPreset(presetKey) {
    var p = DASHBOARD_PRESETS[presetKey];
    if (!p) return;
    setColorPair('dash-bg-color', 'dash-bg-color-hex', p.dashBgColor);
    setColorPair('dash-sidebar-bg', 'dash-sidebar-bg-hex', p.dashSidebarBg);
    setColorPair('dash-card-bg', 'dash-card-bg-hex', p.dashCardBg);
    setColorPair('dash-header-bg', 'dash-header-bg-hex', p.dashHeaderBg);
    setColorPair('dash-text-color', 'dash-text-color-hex', p.dashTextColor);
    setColorPair('dash-heading-color', 'dash-heading-color-hex', p.dashHeadingColor);
    setColorPair('dash-primary-color', 'dash-primary-color-hex', p.dashPrimaryColor);
    setColorPair('dash-active-color', 'dash-active-color-hex', p.dashActiveColor);
    setColorPair('dash-border-color', 'dash-border-color-hex', p.dashBorderColor);
    setColorPair('dash-font-stroke-color', 'dash-font-stroke-color-hex', p.dashFontStrokeColor || '#000000');
    
    var ffEl = document.getElementById('dash-font-family');
    if (ffEl) ffEl.value = p.dashFontFamily || 'Cairo';
    
    var fsEl = document.getElementById('dash-font-size');
    if (fsEl) fsEl.value = p.dashFontSize || '14px';

    var swEl = document.getElementById('dash-font-stroke-width');
    if (swEl) swEl.value = p.dashFontStrokeWidth || '0px';

    document.querySelectorAll('.dash-preset-btn').forEach(function(b) {
        b.classList.remove('ring-2', 'ring-amber-400', 'border-amber-400');
    });
    var selDashBtn = document.getElementById('dash-preset-' + presetKey);
    if (selDashBtn) {
        selDashBtn.classList.add('ring-2', 'ring-amber-400', 'border-amber-400');
    }

    if (presetKey === 'default') {
        var styleEl = document.getElementById('dynamic-dashboard-theme-style');
        if (styleEl) styleEl.remove();
        localStorage.removeItem('tawseela_dashboard_theme');
    } else {
        applyDashboardTheme(p);
        localStorage.setItem('tawseela_dashboard_theme', JSON.stringify(p));
    }
    
    if (typeof showToast === 'function') {
        showToast('تم تطبيق نمط (' + (presetKey === 'default' ? 'الافتراضي الأصلي' : presetKey) + ') بنجاح ✨');
    }
}
window.applyDashboardPreset = applyDashboardPreset;

function syncLiveDashboardColor(pickerId, hexId, val) {
    syncColorInputPair(pickerId, hexId, val);
    syncLiveDashboardTheme();
}
window.syncLiveDashboardColor = syncLiveDashboardColor;

function syncLiveDashboardTheme() {
    var dt = {
        dashBgColor: getColorPairVal('dash-bg-color', 'dash-bg-color-hex', '#f8fafc'),
        dashSidebarBg: getColorPairVal('dash-sidebar-bg', 'dash-sidebar-bg-hex', '#0f172a'),
        dashCardBg: getColorPairVal('dash-card-bg', 'dash-card-bg-hex', '#ffffff'),
        dashHeaderBg: getColorPairVal('dash-header-bg', 'dash-header-bg-hex', '#0f172a'),
        dashTextColor: getColorPairVal('dash-text-color', 'dash-text-color-hex', '#475569'),
        dashHeadingColor: getColorPairVal('dash-heading-color', 'dash-heading-color-hex', '#0f172a'),
        dashPrimaryColor: getColorPairVal('dash-primary-color', 'dash-primary-color-hex', '#f59e0b'),
        dashActiveColor: getColorPairVal('dash-active-color', 'dash-active-color-hex', '#f59e0b'),
        dashBorderColor: getColorPairVal('dash-border-color', 'dash-border-color-hex', '#e2e8f0'),
        dashFontStrokeColor: getColorPairVal('dash-font-stroke-color', 'dash-font-stroke-color-hex', '#000000'),
        dashFontStrokeWidth: document.getElementById('dash-font-stroke-width') ? document.getElementById('dash-font-stroke-width').value : '0px',
        dashFontFamily: document.getElementById('dash-font-family') ? document.getElementById('dash-font-family').value : 'Cairo',
        dashFontSize: document.getElementById('dash-font-size') ? document.getElementById('dash-font-size').value : '14px'
    };
    applyDashboardTheme(dt);
}
window.syncLiveDashboardTheme = syncLiveDashboardTheme;

function applyDashboardTheme(th) {
    if (!th) return;
    var bg = th.dashBgColor || '#f8fafc';
    var sidebarBg = th.dashSidebarBg || '#0f172a';
    var cardBg = th.dashCardBg || '#ffffff';
    var headerBg = th.dashHeaderBg || '#0f172a';
    var textColor = th.dashTextColor || '#475569';
    var headingColor = th.dashHeadingColor || '#0f172a';
    var primaryColor = th.dashPrimaryColor || '#f59e0b';
    var activeColor = th.dashActiveColor || '#f59e0b';
    var borderColor = th.dashBorderColor || '#e2e8f0';
    var fontFamily = th.dashFontFamily || 'Cairo';
    var fontSize = th.dashFontSize || '14px';
    var strokeColor = th.dashFontStrokeColor || '#000000';
    var strokeWidth = th.dashFontStrokeWidth || '0px';

    var styleEl = document.getElementById('dynamic-dashboard-theme-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'dynamic-dashboard-theme-style';
        document.head.appendChild(styleEl);
    }

    var strokeCss = (strokeWidth && strokeWidth !== '0px' && strokeWidth !== '0')
        ? `-webkit-text-stroke: ${strokeWidth} ${strokeColor} !important; text-stroke: ${strokeWidth} ${strokeColor} !important;`
        : `-webkit-text-stroke: 0 !important; text-stroke: 0 !important;`;

    styleEl.textContent = `
        body, html, input, button, select, textarea, p, h1, h2, h3, h4, h5, h6, table, th, td, label, div, span:not([class*="fa"]):not([class*="badge"]) {
            font-family: '${fontFamily}', 'Cairo', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            ${strokeCss}
        }
        body, html {
            font-size: ${fontSize} !important;
        }
        p, label, table, th, td, input, select, textarea {
            font-size: ${fontSize} !important;
        }
        i, i[class*="fa"], i[class*="fa-"], .fa, .fas, .far, .fab, .fa-solid, .fa-regular, .fa-brands, [class^="fa-"], [class*=" fa-"] {
            font-family: "Font Awesome 6 Free", "Font Awesome 6 Brands", "FontAwesome" !important;
            font-style: normal !important;
            font-variant: normal !important;
            text-rendering: auto !important;
            -webkit-font-smoothing: antialiased !important;
            -webkit-text-stroke: 0 !important;
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
        header, header.bg-slate-900 {
            background-color: ${headerBg} !important;
            border-color: ${borderColor} !important;
        }
        .bg-white, .bg-slate-50, .bg-slate-100, .bg-slate-800, .bg-slate-850, .bg-slate-800\\/60, .bg-slate-900, .bg-slate-900\\/80, .bg-slate-950 {
            background-color: ${cardBg} !important;
            border-color: ${borderColor} !important;
        }
        .text-slate-900, .text-slate-800, .text-white, h1, h2, h3, h4, h5, h6, .font-black {
            color: ${headingColor} !important;
        }
        .text-slate-700, .text-slate-600, .text-slate-500, .text-slate-400, .text-slate-300, p, label {
            color: ${textColor} !important;
        }
        .border-slate-100, .border-slate-200, .border-slate-300, .border-slate-600, .border-slate-700, .border-slate-800, .border-slate-900 {
            border-color: ${borderColor} !important;
        }
        .tab-btn.active {
            background-color: ${activeColor} !important;
            color: #ffffff !important;
            border-color: ${activeColor} !important;
            box-shadow: 0 4px 14px -2px ${activeColor}80 !important;
        }
        .tab-btn.active i, .tab-btn.active span {
            color: #ffffff !important;
        }
        .btn-theme-primary {
            background-color: ${primaryColor} !important;
            border-color: ${primaryColor} !important;
            color: #ffffff !important;
        }
    `;
}
window.applyDashboardTheme = applyDashboardTheme;

async function saveDashboardTheme() {
    var dt = {
        dashBgColor: getColorPairVal('dash-bg-color', 'dash-bg-color-hex', '#f8fafc'),
        dashSidebarBg: getColorPairVal('dash-sidebar-bg', 'dash-sidebar-bg-hex', '#0f172a'),
        dashCardBg: getColorPairVal('dash-card-bg', 'dash-card-bg-hex', '#ffffff'),
        dashHeaderBg: getColorPairVal('dash-header-bg', 'dash-header-bg-hex', '#0f172a'),
        dashTextColor: getColorPairVal('dash-text-color', 'dash-text-color-hex', '#475569'),
        dashHeadingColor: getColorPairVal('dash-heading-color', 'dash-heading-color-hex', '#0f172a'),
        dashPrimaryColor: getColorPairVal('dash-primary-color', 'dash-primary-color-hex', '#f59e0b'),
        dashActiveColor: getColorPairVal('dash-active-color', 'dash-active-color-hex', '#f59e0b'),
        dashBorderColor: getColorPairVal('dash-border-color', 'dash-border-color-hex', '#e2e8f0'),
        dashFontStrokeColor: getColorPairVal('dash-font-stroke-color', 'dash-font-stroke-color-hex', '#000000'),
        dashFontStrokeWidth: document.getElementById('dash-font-stroke-width') ? document.getElementById('dash-font-stroke-width').value : '0px',
        dashFontFamily: document.getElementById('dash-font-family') ? document.getElementById('dash-font-family').value : 'Cairo',
        dashFontSize: document.getElementById('dash-font-size') ? document.getElementById('dash-font-size').value : '14px'
    };
    try {
        localStorage.setItem('tawseela_dashboard_theme', JSON.stringify(dt));
        await fetch('/api/admin/theme', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '')
            },
            body: JSON.stringify({ dashboardTheme: dt })
        });
        applyDashboardTheme(dt);
        showToast('تم حفظ ثيم ومظهر لوحة التحكم بنجاح ✅');
    } catch(e) {
        showToast('خطأ في حفظ ثيم لوحة التحكم', 'error');
    }
}
window.saveDashboardTheme = saveDashboardTheme;

function resetDashboardTheme() {
    try {
        localStorage.removeItem('tawseela_dashboard_theme');
        var styleEl = document.getElementById('dynamic-dashboard-theme-style');
        if (styleEl) styleEl.remove();

        var p = DASHBOARD_PRESETS['default'];
        setColorPair('dash-bg-color', 'dash-bg-color-hex', p.dashBgColor);
        setColorPair('dash-sidebar-bg', 'dash-sidebar-bg-hex', p.dashSidebarBg);
        setColorPair('dash-card-bg', 'dash-card-bg-hex', p.dashCardBg);
        setColorPair('dash-header-bg', 'dash-header-bg-hex', p.dashHeaderBg);
        setColorPair('dash-text-color', 'dash-text-color-hex', p.dashTextColor);
        setColorPair('dash-heading-color', 'dash-heading-color-hex', p.dashHeadingColor);
        setColorPair('dash-primary-color', 'dash-primary-color-hex', p.dashPrimaryColor);
        setColorPair('dash-active-color', 'dash-active-color-hex', p.dashActiveColor);
        setColorPair('dash-border-color', 'dash-border-color-hex', p.dashBorderColor);
        setColorPair('dash-font-stroke-color', 'dash-font-stroke-color-hex', p.dashFontStrokeColor || '#000000');
        
        var ffEl = document.getElementById('dash-font-family');
        if (ffEl) ffEl.value = p.dashFontFamily || 'Cairo';
        
        var fsEl = document.getElementById('dash-font-size');
        if (fsEl) fsEl.value = p.dashFontSize || '14px';

        var swEl = document.getElementById('dash-font-stroke-width');
        if (swEl) swEl.value = p.dashFontStrokeWidth || '0px';

        document.querySelectorAll('.dash-preset-btn').forEach(function(b) {
            b.classList.remove('ring-2', 'ring-amber-400', 'border-amber-400');
        });
        var defBtn = document.getElementById('dash-preset-default');
        if (defBtn) defBtn.classList.add('ring-2', 'ring-amber-400', 'border-amber-400');

        fetch('/api/admin/theme', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (localStorage.getItem('admin_token') || '')
            },
            body: JSON.stringify({ dashboardTheme: null })
        }).catch(function() {});

        showToast('تمت استعادة الثيم الافتراضي للوحة التحكم بنجاح 🔄');
    } catch(err) {
        showToast('حدث خطأ أثناء استعادة الثيم الافتراضي', true);
    }
}
window.resetDashboardTheme = resetDashboardTheme;

// Web App Presets
var WEB_APP_PRESETS = {
    amber: {
        fontColor: '#111111',
        bgColor: '#ffffff',
        primaryColor: '#f59e0b',
        buttonColor: '#111111',
        buttonHoverColor: '#1f2937',
        activeTabColor: '#f59e0b',
        searchInputColor: '#111111',
        searchInputBg: '#f9fafb',
        fontFamily: 'Cairo',
        fontSize: '16px'
    },
    dark: {
        fontColor: '#f8fafc',
        bgColor: '#0f172a',
        primaryColor: '#f59e0b',
        buttonColor: '#1e293b',
        buttonHoverColor: '#334155',
        activeTabColor: '#f59e0b',
        searchInputColor: '#ffffff',
        searchInputBg: '#1e293b',
        fontFamily: 'Cairo',
        fontSize: '16px'
    },
    emerald: {
        fontColor: '#064e3b',
        bgColor: '#f0fdf4',
        primaryColor: '#10b981',
        buttonColor: '#065f46',
        buttonHoverColor: '#047857',
        activeTabColor: '#10b981',
        searchInputColor: '#064e3b',
        searchInputBg: '#ffffff',
        fontFamily: 'Tajawal',
        fontSize: '16px'
    },
    navy: {
        fontColor: '#0f172a',
        bgColor: '#f8fafc',
        primaryColor: '#2563eb',
        buttonColor: '#1e40af',
        buttonHoverColor: '#1d4ed8',
        activeTabColor: '#2563eb',
        searchInputColor: '#0f172a',
        searchInputBg: '#ffffff',
        fontFamily: 'Almarai',
        fontSize: '16px'
    },
    crimson: {
        fontColor: '#18181b',
        bgColor: '#ffffff',
        primaryColor: '#e11d48',
        buttonColor: '#9f1239',
        buttonHoverColor: '#be123c',
        activeTabColor: '#e11d48',
        searchInputColor: '#18181b',
        searchInputBg: '#fff1f2',
        fontFamily: 'Alexandria',
        fontSize: '16px'
    },
    violet: {
        fontColor: '#3b0764',
        bgColor: '#faf5ff',
        primaryColor: '#9333ea',
        buttonColor: '#7e22ce',
        buttonHoverColor: '#6b21a8',
        activeTabColor: '#9333ea',
        searchInputColor: '#3b0764',
        searchInputBg: '#ffffff',
        fontFamily: 'Readex Pro',
        fontSize: '16px'
    }
};

function applyWebAppPreset(presetKey) {
    var p = WEB_APP_PRESETS[presetKey];
    if (!p) return;

    setColorPair('theme-font-color', 'theme-font-color-hex', p.fontColor);
    setColorPair('theme-bg-color', 'theme-bg-color-hex', p.bgColor);
    setColorPair('theme-primary-color', 'theme-primary-color-hex', p.primaryColor);
    setColorPair('theme-button-color', 'theme-button-color-hex', p.buttonColor);
    setColorPair('theme-button-hover-color', 'theme-button-hover-color-hex', p.buttonHoverColor);
    setColorPair('theme-active-tab-color', 'theme-active-tab-color-hex', p.activeTabColor);
    setColorPair('theme-search-input-color', 'theme-search-input-color-hex', p.searchInputColor);
    setColorPair('theme-search-input-bg', 'theme-search-input-bg-hex', p.searchInputBg);

    if (document.getElementById('theme-font')) document.getElementById('theme-font').value = p.fontFamily || 'Cairo';
    if (document.getElementById('theme-font-size')) document.getElementById('theme-font-size').value = p.fontSize || '16px';

    applyActiveTabColorStyle(p.activeTabColor);
    broadcastLiveThemeSync(p);

    document.querySelectorAll('.webapp-preset-btn').forEach(function(b) {
        b.classList.remove('ring-2', 'ring-amber-400', 'border-amber-400');
    });
    var selBtn = document.getElementById('webapp-preset-' + presetKey);
    if (selBtn) {
        selBtn.classList.add('ring-2', 'ring-amber-400', 'border-amber-400');
    }

    if (typeof showToast === 'function') {
        showToast('تم تطبيق النمط الجاهز على تطبيق الويب (' + presetKey + ') ✨');
    }
}
window.applyWebAppPreset = applyWebAppPreset;

function syncColorInputPair(pickerId, hexId, value) {
    if (!value) return '';
    var picker = document.getElementById(pickerId);
    var hex = document.getElementById(hexId);
    var cleanVal = String(value).trim();
    if (!cleanVal.startsWith('#') && /^[0-9a-fA-F]{3,8}$/.test(cleanVal)) {
        cleanVal = '#' + cleanVal;
    }
    if (hex && hex !== document.activeElement) {
        hex.value = cleanVal;
    }
    if (picker && /^#[0-9a-fA-F]{6}$/i.test(cleanVal)) {
        picker.value = cleanVal;
    }
    return cleanVal;
}

function setColorPair(pickerId, hexId, value) {
    var val = value || '#111111';
    var p = document.getElementById(pickerId);
    var h = document.getElementById(hexId);
    if (p) p.value = val;
    if (h) h.value = val;
}

function getColorPairVal(pickerId, hexId, fallback) {
    var hexEl = document.getElementById(hexId);
    var pickerEl = document.getElementById(pickerId);
    if (hexEl && hexEl.value && hexEl.value.trim()) {
        var v = hexEl.value.trim();
        if (!v.startsWith('#') && /^[0-9a-fA-F]{3,8}$/.test(v)) v = '#' + v;
        return v;
    }
    if (pickerEl && pickerEl.value) return pickerEl.value;
    return fallback;
}

async function loadCustomizationSettings() {
    try {
        const res = await fetch('/api/admin/app-config', authHeaders());
        const cfg = await res.json();
        if (cfg.theme) {
            setColorPair('theme-primary-color', 'theme-primary-color-hex', cfg.theme.primaryColor || '#111111');
            setColorPair('theme-bg-color', 'theme-bg-color-hex', cfg.theme.bgColor || '#ffffff');
            var fc = cfg.theme.fontColor || cfg.theme.textColor || '#111111';
            setColorPair('theme-font-color', 'theme-font-color-hex', fc);
            var atc = cfg.theme.activeTabColor || cfg.theme.activeColor || '#f59e0b';
            setColorPair('theme-active-tab-color', 'theme-active-tab-color-hex', atc);
            setColorPair('theme-button-color', 'theme-button-color-hex', cfg.theme.buttonColor || '#111111');
            setColorPair('theme-button-hover-color', 'theme-button-hover-color-hex', cfg.theme.buttonHoverColor || '#374151');
            setColorPair('theme-search-input-color', 'theme-search-input-color-hex', cfg.theme.searchInputColor || '#111111');
            setColorPair('theme-search-input-bg', 'theme-search-input-bg-hex', cfg.theme.searchInputBg || '#fafafa');

            if (document.getElementById('theme-font')) document.getElementById('theme-font').value = cfg.theme.fontFamily || 'Cairo';
            if (document.getElementById('theme-font-size')) document.getElementById('theme-font-size').value = cfg.theme.fontSize || '16px';
            if (document.getElementById('theme-app-name')) document.getElementById('theme-app-name').value = cfg.theme.appName || 'توصيله';
            if (document.getElementById('theme-logo-emoji')) document.getElementById('theme-logo-emoji').value = cfg.theme.logoEmoji || '🚕';
            if (document.getElementById('theme-footer')) document.getElementById('theme-footer').value = cfg.theme.footerText || '';
            applyActiveTabColorStyle(atc);

            // Load Dashboard Theme if present
            if (cfg.theme.dashboardTheme) {
                var dt = cfg.theme.dashboardTheme;
                setColorPair('dash-bg-color', 'dash-bg-color-hex', dt.dashBgColor || '#f8fafc');
                setColorPair('dash-sidebar-bg', 'dash-sidebar-bg-hex', dt.dashSidebarBg || '#0f172a');
                setColorPair('dash-card-bg', 'dash-card-bg-hex', dt.dashCardBg || '#ffffff');
                setColorPair('dash-header-bg', 'dash-header-bg-hex', dt.dashHeaderBg || '#0f172a');
                setColorPair('dash-text-color', 'dash-text-color-hex', dt.dashTextColor || '#475569');
                setColorPair('dash-heading-color', 'dash-heading-color-hex', dt.dashHeadingColor || '#0f172a');
                setColorPair('dash-primary-color', 'dash-primary-color-hex', dt.dashPrimaryColor || '#f59e0b');
                setColorPair('dash-active-color', 'dash-active-color-hex', dt.dashActiveColor || '#f59e0b');
                setColorPair('dash-border-color', 'dash-border-color-hex', dt.dashBorderColor || '#e2e8f0');
                setColorPair('dash-font-stroke-color', 'dash-font-stroke-color-hex', dt.dashFontStrokeColor || '#000000');
                if (document.getElementById('dash-font-stroke-width')) document.getElementById('dash-font-stroke-width').value = dt.dashFontStrokeWidth || '0px';
                if (document.getElementById('dash-font-family')) document.getElementById('dash-font-family').value = dt.dashFontFamily || 'Cairo';
                if (document.getElementById('dash-font-size')) document.getElementById('dash-font-size').value = dt.dashFontSize || '14px';
                applyDashboardTheme(dt);
                localStorage.setItem('tawseela_dashboard_theme', JSON.stringify(dt));
            } else {
                var cached = localStorage.getItem('tawseela_dashboard_theme');
                if (cached) {
                    try {
                        var dt = JSON.parse(cached);
                        setColorPair('dash-bg-color', 'dash-bg-color-hex', dt.dashBgColor || '#f8fafc');
                        setColorPair('dash-sidebar-bg', 'dash-sidebar-bg-hex', dt.dashSidebarBg || '#0f172a');
                        setColorPair('dash-card-bg', 'dash-card-bg-hex', dt.dashCardBg || '#ffffff');
                        setColorPair('dash-header-bg', 'dash-header-bg-hex', dt.dashHeaderBg || '#0f172a');
                        setColorPair('dash-text-color', 'dash-text-color-hex', dt.dashTextColor || '#475569');
                        setColorPair('dash-heading-color', 'dash-heading-color-hex', dt.dashHeadingColor || '#0f172a');
                        setColorPair('dash-primary-color', 'dash-primary-color-hex', dt.dashPrimaryColor || '#f59e0b');
                        setColorPair('dash-active-color', 'dash-active-color-hex', dt.dashActiveColor || '#f59e0b');
                        setColorPair('dash-border-color', 'dash-border-color-hex', dt.dashBorderColor || '#e2e8f0');
                        setColorPair('dash-font-stroke-color', 'dash-font-stroke-color-hex', dt.dashFontStrokeColor || '#000000');
                        if (document.getElementById('dash-font-stroke-width')) document.getElementById('dash-font-stroke-width').value = dt.dashFontStrokeWidth || '0px';
                        if (document.getElementById('dash-font-family')) document.getElementById('dash-font-family').value = dt.dashFontFamily || 'Cairo';
                        if (document.getElementById('dash-font-size')) document.getElementById('dash-font-size').value = dt.dashFontSize || '14px';
                        applyDashboardTheme(dt);
                    } catch(_) {}
                }
            }
        }
        if (cfg.staticTexts) {
            document.getElementById('text-welcome-title').value = cfg.staticTexts.welcomeTitle || '';
            document.getElementById('text-welcome-subtitle').value = cfg.staticTexts.welcomeSubtitle || '';
            document.getElementById('text-driver-pending').value = cfg.staticTexts.driverPendingMsg || '';
        }
        if (document.getElementById('theme-telegram-link')) {
            document.getElementById('theme-telegram-link').value = cfg.telegramAdminLink || 'https://t.me/tawseela_iq_bot';
        }
        if (document.getElementById('theme-whatsapp-link')) {
            document.getElementById('theme-whatsapp-link').value = cfg.whatsappAdminLink || 'https://wa.me/9647706204066';
        }
        if (cfg.onboarding && cfg.onboarding.screens) {
            renderOnboardingScreens(cfg.onboarding.screens);
        }
    } catch(e) { console.error(e); }
}

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
        telegramAdminLink: document.getElementById('theme-telegram-link') ? document.getElementById('theme-telegram-link').value.trim() : 'https://t.me/tawseela_iq_bot',
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

// ===== Driver Permanent Location =====
async function populateDriverPermSelect() {
    var sel = document.getElementById('driver-perm-select');
    if (!sel) return;
    try {
        var res = await fetch(API_BASE + '/drivers', { headers: authHeaders() });
        var data = await res.json();
        sel.innerHTML = '<option value="">-- اختر سائق --</option>';
        (data.drivers || []).forEach(function(d) {
            var opt = document.createElement('option');
            opt.value = d.driverId;
            opt.textContent = d.fullName + ' (' + (d.phoneNumber || '') + ')';
            sel.appendChild(opt);
        });
    } catch(e) {}
}
async function loadDriverPermLocation() {
    var sel = document.getElementById('driver-perm-select');
    if (!sel || !sel.value) return;
    try {
        var res = await fetch(API_BASE + '/drivers', { headers: authHeaders() });
        var data = await res.json();
        var drv = (data.drivers || []).find(function(d) { return d.driverId === sel.value; });
        if (drv) {
            document.getElementById('driver-perm-lat').value = drv.permanentLat || '';
            document.getElementById('driver-perm-lon').value = drv.permanentLon || '';
            document.getElementById('driver-perm-name').value = drv.permanentLocationName || '';
        }
    } catch(e) {}
}
async function saveDriverPermanentLocation() {
    var driverId = (document.getElementById('driver-perm-select') || {}).value;
    var lat = (document.getElementById('driver-perm-lat') || {}).value;
    var lon = (document.getElementById('driver-perm-lon') || {}).value;
    var name = (document.getElementById('driver-perm-name') || {}).value;
    if (!driverId || !lat || !lon) { showToast('اختر السائق وأدخل الإحداثيات', 'error'); return; }
    try {
        var res = await fetch('/api/admin/driver/set-permanent-location', {
            method:'POST', headers:{'Content-Type':'application/json', ...authHeaders()},
            body:JSON.stringify({ driverId: driverId, lat: parseFloat(lat), lon: parseFloat(lon), locationName: name })
        });
        var data = await res.json();
        if (data.success) {
            showToast('تم تثبيت موقع السائق الدائمي ✅');
            var st = document.getElementById('driver-perm-status');
            if (st) { st.classList.remove('hidden'); st.textContent = '✅ ' + data.message; }
        } else showToast(data.error || 'خطأ', 'error');
    } catch(e) { showToast('خطأ في الاتصال', 'error'); }
}

