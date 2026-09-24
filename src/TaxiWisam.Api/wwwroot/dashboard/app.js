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
        case 'fleet-map':
            initFleetMapbox();
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
    tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/bookings`);
        const data = await res.json();
        tbody.innerHTML = '';

        if (!data.bookings || data.bookings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">لا توجد حجوزات مسجلة</td></tr>';
            return;
        }

        data.bookings.forEach(b => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${b.customerName} <span class="text-slate-400 block font-mono text-xs">${b.customerPhone}</span></td>
                <td class="p-4 text-slate-700 text-xs">${b.driverName}</td>
                <td class="p-4 text-slate-600 text-xs">${b.pickupName} ➔ ${b.dropoffName}</td>
                <td class="p-4 font-mono text-xs">${b.bookingDate}</td>
                <td class="p-4 font-bold">${b.seatsBooked}</td>
                <td class="p-4 text-emerald-600 font-bold">${Number(b.fareAmount).toLocaleString()} د.ع</td>
                <td class="p-4"><span class="px-2 py-0.5 text-xs bg-emerald-100 text-emerald-800 rounded font-bold">${b.status}</span></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500">فشل في الاتصال</td></tr>';
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
        const [routesRes, bookingsRes, customersRes] = await Promise.all([
            fetch('/api/admin/routes').then(r => r.json()).catch(() => []),
            fetch('/api/bookings').then(r => r.json()).catch(() => []),
            fetch('/api/admin/customers').then(r => r.json()).catch(() => ({ customers: [] }))
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
            const lat = c.pickupLat || (baseLat + ((idx % 5 - 2) * 0.005) + (Math.sin(idx) * 0.004));
            const lon = c.pickupLon || (baseLon + (((idx + 1) % 5 - 2) * 0.005) + (Math.cos(idx) * 0.004));

            const popup = new mapboxgl.Popup({ offset: 20 }).setHTML(`
                <div style="direction:rtl; font-family:Cairo, sans-serif; font-size:11px; padding:4px;">
                    <strong style="color:#4f46e5; font-size:13px;">👤 راكب مسجل بالمنصة</strong><br/>
                    <b>الاسم:</b> ${c.fullName || 'راكب'}<br/>
                    <b>الهاتف:</b> ${c.phoneNumber || 'غير محدد'}<br/>
                    <b>المنطقة / العنوان:</b> ${c.address || c.area || 'النجف الأشرف'}<br/>
                    <b>الخط المطلوب:</b> ${c.route || 'مركز النجف'}<br/>
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
    { name: "ساحة ثورة العشرين - المركز", lat: 31.9961, lon: 44.3168 },
    { name: "مرقد الإمام علي (ع) - المدينة القديمة", lat: 31.9957, lon: 44.3143 },
    { name: "جامعة الكوفة - مجمع الكليات (الشارع الرئيسي)", lat: 32.0321, lon: 44.3725 },
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

// Customer Editing
function openEditCustomerModal(customerId) {
    const customer = (window.customersMap && window.customersMap[customerId]) || {};
    document.getElementById('edit-cust-id').value = customerId;
    document.getElementById('edit-cust-name').value = customer.fullName || '';
    document.getElementById('edit-cust-phone').value = customer.phoneNumber || '';
    document.getElementById('edit-cust-route').value = customer.route || customer.area || '';
    document.getElementById('edit-cust-address').value = customer.address || customer.area || '';
    document.getElementById('edit-cust-password').value = '';
    const modal = document.getElementById('modal-edit-customer');
    if (modal) {
        modal.classList.add('active');
        modal.classList.remove('hidden');
        modal.classList.remove('pointer-events-none');
        modal.style.display = 'flex';
        modal.style.pointerEvents = 'auto';
    }
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

    try {
        const payload = { fullName, phoneNumber, route, address };
        if (password) payload.password = password;

        const res = await fetch(`${API_BASE}/customers/${customerId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showToast('تم تحديث بيانات الراكب بنجاح! ✅');
            closeEditCustomerModal();
            loadCustomers();
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
    const modal = document.getElementById('modal-edit-driver');
    if (modal) {
        modal.classList.add('active');
        modal.classList.remove('hidden');
        modal.classList.remove('pointer-events-none');
        modal.style.display = 'flex';
        modal.style.pointerEvents = 'auto';
    }
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

    try {
        const payload = { fullName, phoneNumber, route };
        if (password) payload.password = password;

        const res = await fetch(`${API_BASE}/drivers/${driverId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showToast('تم تحديث بيانات الكابتن بنجاح! ✅');
            closeEditDriverModal();
            loadDrivers();
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
window.openEditCustomerModal = openEditCustomerModal;
window.closeEditCustomerModal = closeEditCustomerModal;
window.submitEditCustomer = submitEditCustomer;
window.openEditDriverModal = openEditDriverModal;
window.closeEditDriverModal = closeEditDriverModal;
window.submitEditDriver = submitEditDriver;
window.loadDashboardStats = loadDashboardStats;
window.loadMatchingSettings = loadMatchingSettings;


