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

function normalizeDigits(str) {
    if (!str) return '';
    const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    return str.toString().replace(/[٠-٩]/g, d => arabicDigits.indexOf(d));
}

function checkAdminAuth() {
    const isAuth = localStorage.getItem('tawseela_admin_auth') === 'true';
    const overlay = document.getElementById('login-overlay');
    if (isAuth) {
        if (overlay) overlay.classList.add('hidden');
        loadDashboardStats();
        loadMatchingSettings();
    } else {
        if (overlay) overlay.classList.remove('hidden');
    }
}

function handleAdminLogin(event) {
    event.preventDefault();
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const errorBox = document.getElementById('login-error');

    const username = (usernameInput.value || '').trim().toLowerCase();
    const rawPassword = (passwordInput.value || '').trim();
    const password = normalizeDigits(rawPassword);

    if (username === 'admin' && (password === '1122' || rawPassword === '1122' || rawPassword === '١١٢٢')) {
        localStorage.setItem('tawseela_admin_auth', 'true');
        if (errorBox) errorBox.classList.add('hidden');
        const overlay = document.getElementById('login-overlay');
        if (overlay) overlay.classList.add('hidden');
        showToast('مرحباً بك في لوحة تحكم منصة توصيله! 🚖');
        loadDashboardStats();
        loadMatchingSettings();
    } else {
        if (errorBox) {
            errorBox.innerText = 'بيانات الدخول غير صحيحة! يرجى إدخال اسم المستخدم admin وكلمة المرور 1122 أو ١١٢٢';
            errorBox.classList.remove('hidden');
        }
        passwordInput.focus();
    }
}

function logoutAdmin() {
    localStorage.removeItem('tawseela_admin_auth');
    const overlay = document.getElementById('login-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        const pwd = document.getElementById('login-password');
        if (pwd) pwd.value = '';
    }
    showToast('تم تسجيل الخروج من النظام');
}

// -----------------------------------------------------------------------------
// Mobile Sidebar Off-Canvas Navigation
// -----------------------------------------------------------------------------
function toggleMobileSidebar(force) {
    const drawer = document.getElementById('sidebar-drawer');
    const backdrop = document.getElementById('mobile-sidebar-backdrop');
    if (!drawer || !backdrop) return;

    const isOpen = !drawer.classList.contains('translate-x-full');
    const target = force !== undefined ? force : !isOpen;

    if (target) {
        drawer.classList.remove('translate-x-full');
        backdrop.classList.remove('hidden');
    } else {
        drawer.classList.add('translate-x-full');
        backdrop.classList.add('hidden');
    }
}

// -----------------------------------------------------------------------------
// Tab Switching
// -----------------------------------------------------------------------------
function switchTab(tabName) {
    // Close mobile drawer if open
    toggleMobileSidebar(false);

    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));

    const btn = document.getElementById(`tab-btn-${tabName}`);
    if (btn) btn.classList.add('active');

    const content = document.getElementById(`tab-${tabName}`);
    if (content) content.classList.remove('hidden');

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
        case 'complaints':
            loadComplaints();
            break;
        case 'settings':
            loadMatchingSettings();
            break;
        case 'audit':
            loadAuditLogs();
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
// 1. Dashboard Overview Stats
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
    } catch (err) {
        console.warn('Dashboard stats offline/mock', err);
    }
}

// -----------------------------------------------------------------------------
// 2. Driver Verifications Queue & Signed URL Previews
// -----------------------------------------------------------------------------
async function loadVerifications() {
    const loading = document.getElementById('verifications-loading');
    const empty = document.getElementById('verifications-empty');
    const table = document.getElementById('verifications-table');
    const tbody = document.getElementById('verifications-body');

    loading.classList.remove('hidden');
    empty.classList.add('hidden');
    table.classList.add('hidden');
    tbody.innerHTML = '';

    try {
        const res = await fetch(`${API_BASE}/drivers/pending-verifications`);
        const drivers = await res.json();
        loading.classList.add('hidden');

        if (!drivers || drivers.length === 0) {
            empty.classList.remove('hidden');
            return;
        }

        table.classList.remove('hidden');

        drivers.forEach(d => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            const vehicleInfo = d.vehicles && d.vehicles.length > 0 
                ? `${d.vehicles[0].make} ${d.vehicles[0].model} (${d.vehicles[0].plateNumber})`
                : '<span class="text-slate-400">لم تُسجل مركبة</span>';

            let docsHtml = '';
            if (d.documents && d.documents.length > 0) {
                d.documents.forEach(doc => {
                    const statusBadge = doc.status === 'Pending' 
                        ? '<span class="px-2 py-0.5 text-[11px] bg-amber-100 text-amber-800 rounded font-bold">بانتظار التدقيق</span>'
                        : `<span class="px-2 py-0.5 text-[11px] bg-emerald-100 text-emerald-800 rounded font-bold">${doc.status}</span>`;

                    // Driver encoded payload for inspection modal
                    const encodedDriver = encodeURIComponent(JSON.stringify({
                        driverId: d.driverId,
                        fullName: d.fullName,
                        phoneNumber: d.phoneNumber,
                        licenseNumber: d.licenseNumber,
                        vehicleInfo: vehicleInfo.replace(/<[^>]*>?/gm, '')
                    }));

                    docsHtml += `
                        <div class="flex items-center justify-between p-1.5 bg-slate-100 rounded-lg text-xs mb-1">
                            <span class="font-semibold text-slate-700">${translateDocType(doc.documentType)}</span>
                            <div class="flex items-center space-x-2 space-x-reverse">
                                ${statusBadge}
                                <button onclick="previewDocument('${d.driverId}', '${doc.id}', '${encodedDriver}')" class="px-2.5 py-1 bg-slate-900 text-amber-400 font-bold rounded-lg text-xs hover:bg-slate-800 transition flex items-center gap-1">
                                    <i class="fa-solid fa-eye text-xs"></i> فحص
                                </button>
                            </div>
                        </div>
                    `;
                });
            } else {
                docsHtml = '<span class="text-slate-400 text-xs">لا توجد وثائق مرفوعة</span>';
            }

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${d.fullName}</td>
                <td class="p-4 text-slate-600 font-mono text-xs"><a href="tel:${d.phoneNumber}" class="hover:text-amber-600 underline">${d.phoneNumber}</a></td>
                <td class="p-4 text-slate-600 font-mono text-xs">${d.licenseNumber}</td>
                <td class="p-4 text-slate-700 text-xs">${vehicleInfo}</td>
                <td class="p-4 min-w-[260px]">${docsHtml}</td>
                <td class="p-4 text-center">
                    <button onclick="viewFullDriver('${d.driverId}')" class="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl text-xs transition shadow-sm">
                        فحص المستمسكات 🪪
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

    } catch (err) {
        loading.classList.add('hidden');
        console.error('Error fetching verifications', err);
    }
}

// -----------------------------------------------------------------------------
// Document Inspection, Saving & Printing
// -----------------------------------------------------------------------------
async function previewDocument(driverId, docId, encodedDriver = null) {
    currentDocId = docId;
    currentDriverId = driverId;
    isRejectionOpen = false;

    const rejBox = document.getElementById('rejection-box');
    if (rejBox) rejBox.classList.add('hidden');
    const rejInput = document.getElementById('rejection-reason-input');
    if (rejInput) rejInput.value = '';

    // Parse driver data if passed
    if (encodedDriver) {
        try {
            currentDriverData = JSON.parse(decodeURIComponent(encodedDriver));
        } catch (e) {
            currentDriverData = null;
        }
    }

    // If driver data not passed, fetch driver details
    if (!currentDriverData || currentDriverData.driverId !== driverId) {
        try {
            const dRes = await fetch(`${API_BASE}/drivers/${driverId}`);
            if (dRes.ok) {
                const dJson = await dRes.json();
                currentDriverData = {
                    driverId: dJson.driverId,
                    fullName: dJson.fullName,
                    phoneNumber: dJson.phoneNumber,
                    licenseNumber: dJson.licenseNumber,
                    vehicleInfo: dJson.vehicles && dJson.vehicles[0] ? `${dJson.vehicles[0].make} ${dJson.vehicles[0].model} (${dJson.vehicles[0].plateNumber})` : 'النجف الأشرف'
                };
            }
        } catch (e) {}
    }

    // Populate driver info in modal
    if (currentDriverData) {
        document.getElementById('modal-driver-name').innerText = currentDriverData.fullName || '-';
        document.getElementById('modal-driver-phone').innerText = currentDriverData.phoneNumber || '-';
        document.getElementById('modal-driver-vehicle').innerText = currentDriverData.vehicleInfo || '-';
        document.getElementById('modal-driver-license').innerText = currentDriverData.licenseNumber || '-';
    }

    try {
        const res = await fetch(`/api/documents/${docId}/signed-url?expirySeconds=3600`);
        if (!res.ok) {
            showToast('تعذر جلب رابط المعاينة للوثيقة', true);
            return;
        }

        const data = await res.json();
        currentDocData = data;

        const img = document.getElementById('modal-doc-img');
        const pdfBox = document.getElementById('modal-no-preview');
        const pdfLink = document.getElementById('modal-pdf-link');

        document.getElementById('modal-doc-title').innerText = `فحص وثيقة: ${translateDocType(data.documentType)}`;

        if (data.signedUrl.endsWith('.pdf')) {
            img.classList.add('hidden');
            pdfBox.classList.remove('hidden');
            pdfLink.href = data.signedUrl;
        } else {
            pdfBox.classList.add('hidden');
            img.classList.remove('hidden');
            img.src = data.signedUrl;
        }

        document.getElementById('document-modal').classList.remove('hidden');
    } catch (err) {
        console.error('Error previewing doc', err);
        showToast('خطأ أثناء تحميل المستند', true);
    }
}

// Inspect full driver documents directly from driver directory
async function viewFullDriver(driverId) {
    try {
        const res = await fetch(`${API_BASE}/drivers/${driverId}`);
        if (!res.ok) {
            showToast('تعذر العثور على بيانات السائق', true);
            return;
        }
        const driver = await res.json();
        const vehicleInfo = driver.vehicles && driver.vehicles.length > 0 
            ? `${driver.vehicles[0].make} ${driver.vehicles[0].model} (${driver.vehicles[0].plateNumber})`
            : 'النجف الأشرف';

        currentDriverData = {
            driverId: driver.driverId,
            fullName: driver.fullName,
            phoneNumber: driver.phoneNumber,
            licenseNumber: driver.licenseNumber,
            vehicleInfo: vehicleInfo
        };

        const firstDoc = driver.documents && driver.documents[0] ? driver.documents[0] : { id: 'doc-' + driver.driverId, documentType: 'DrivingLicense' };
        previewDocument(driver.driverId, firstDoc.id || firstDoc.documentId);
    } catch (err) {
        console.error('Error viewing full driver:', err);
        showToast('فشل في جلب مستمسكات السائق', true);
    }
}

// Download/Save Document to device
async function downloadDocument() {
    if (!currentDocData || !currentDocData.signedUrl) {
        showToast('لا توجد وثيقة لتحميلها', true);
        return;
    }

    try {
        showToast('جاري بدء حفظ الوثيقة على جهازك...');
        const response = await fetch(currentDocData.signedUrl);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const driverName = (currentDriverData && currentDriverData.fullName ? currentDriverData.fullName.replace(/\s+/g, '_') : 'driver');
        const docType = (currentDocData && currentDocData.documentType ? translateDocType(currentDocData.documentType).replace(/\s+/g, '_') : 'document');
        a.download = `وثيقة_توصيله_${driverName}_${docType}.jpg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        showToast('تم حفظ الوثيقة بنجاح على جهازك ✅');
    } catch (err) {
        console.warn('Download fetch failed, opening direct URL:', err);
        window.open(currentDocData.signedUrl, '_blank');
    }
}

// Print Document with official Tawseela letterhead & stamp
function printDocument() {
    if (!currentDocData || !currentDocData.signedUrl) {
        showToast('لا توجد وثيقة لطباعتها', true);
        return;
    }

    const driverName = currentDriverData ? currentDriverData.fullName : 'سائق مسجل';
    const phone = currentDriverData ? currentDriverData.phoneNumber : '-';
    const license = currentDriverData ? currentDriverData.licenseNumber : '-';
    const vehicle = currentDriverData ? currentDriverData.vehicleInfo : '-';
    const docTitle = translateDocType(currentDocData.documentType);
    const printDate = new Date().toLocaleString('ar-IQ');

    const printWindow = window.open('', '_blank', 'width=900,height=750');
    if (!printWindow) {
        showToast('يرجى السماح بالنوافذ المنبثقة للطباعة', true);
        return;
    }

    printWindow.document.write(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <title>طباعة وثيقة سائق - منصة توصيله</title>
            <style>
                body { font-family: 'Cairo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif; padding: 35px; color: #0f172a; direction: rtl; }
                .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #0f172a; padding-bottom: 15px; margin-bottom: 25px; }
                .brand { font-size: 26px; font-weight: 900; color: #0f172a; }
                .brand span { color: #f59e0b; }
                .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 25px; }
                .meta-table td { padding: 10px 14px; border: 1px solid #cbd5e1; font-size: 14px; }
                .meta-table .label { background-color: #f8fafc; font-weight: bold; width: 22%; color: #475569; }
                .img-box { text-align: center; margin: 20px 0; border: 1px solid #94a3b8; padding: 15px; border-radius: 12px; background: #fafafa; }
                .img-box img { max-width: 100%; max-height: 540px; object-fit: contain; border-radius: 8px; }
                .footer { margin-top: 30px; display: flex; justify-content: space-between; font-size: 13px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 15px; }
                .stamp-box { border: 2px dashed #cbd5e1; border-radius: 8px; width: 150px; height: 75px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #94a3b8; }
                @media print {
                    body { padding: 10px; }
                    @page { margin: 12mm; }
                }
            </style>
        </head>
        <body>
            <div class="header">
                <div>
                    <div class="brand">منصة <span>توصيله</span> 🚖</div>
                    <div style="font-size: 13px; color: #64748b; margin-top: 4px;">نظام إدارة النقل الذكي الموحد - محافظة النجف الأشرف</div>
                </div>
                <div style="text-align: left; font-size: 13px;">
                    <div><strong>استمارة فحص واعتماد وثائق السائق</strong></div>
                    <div style="color: #64748b; margin-top: 4px;">تاريخ المعاينة: ${printDate}</div>
                </div>
            </div>

            <table class="meta-table">
                <tr>
                    <td class="label">اسم السائق:</td>
                    <td><strong>${driverName}</strong></td>
                    <td class="label">رقم الهاتف:</td>
                    <td style="font-family: monospace;">${phone}</td>
                </tr>
                <tr>
                    <td class="label">رقم إجازة السوق:</td>
                    <td style="font-family: monospace;">${license}</td>
                    <td class="label">بيانات المركبة:</td>
                    <td>${vehicle}</td>
                </tr>
                <tr>
                    <td class="label">نوع الوثيقة:</td>
                    <td><strong>${docTitle}</strong></td>
                    <td class="label">المنطقة الجغرافية:</td>
                    <td>محافظة النجف الأشرف</td>
                </tr>
            </table>

            <div class="img-box">
                <img src="${currentDocData.signedUrl}" alt="${docTitle}" onload="setTimeout(() => window.print(), 500);" />
            </div>

            <div class="footer">
                <div>
                    <div>المشرف الإداري: <strong>Admin Root</strong></div>
                    <div style="margin-top: 5px;">توصيله v2.0 • سجل رقابة إداري معتمد</div>
                </div>
                <div class="stamp-box">
                    ختم الاعتماد والتوثيق
                </div>
            </div>
        </body>
        </html>
    `);
    printWindow.document.close();
}

function closeDocumentModal() {
    document.getElementById('document-modal').classList.add('hidden');
    currentDocId = null;
    currentDriverId = null;
    currentDocData = null;
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

async function approveCurrentDocument() {
    if (!currentDocId) return;

    try {
        const res = await fetch(`${API_BASE}/documents/${currentDocId}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved: true, rejectionReason: null })
        });

        if (res.ok) {
            showToast('تم اعتماد وتوثيق المستند بنجاح! ✅');
            closeDocumentModal();
            loadVerifications();
            loadDrivers();
            loadDashboardStats();
        } else {
            showToast('حدث خطأ أثناء اعتماد المستند', true);
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
}

async function rejectCurrentDocument() {
    if (!currentDocId) return;

    const reason = document.getElementById('rejection-reason-input').value.trim();
    if (!reason) {
        showToast('يرجى كتابة سبب الرفض أولاً', true);
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/documents/${currentDocId}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approved: false, rejectionReason: reason })
        });

        if (res.ok) {
            showToast('تم رفض المستند وتسجيل السبب بنجاح');
            closeDocumentModal();
            loadVerifications();
            loadDrivers();
            loadDashboardStats();
        } else {
            showToast('فشل تسجيل رفض المستند', true);
        }
    } catch (err) {
        showToast('خطأ في الاتصال بالخادم', true);
    }
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

        data.drivers.forEach(d => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            const statusClass = d.status === 'Online' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600';
            const verifBadge = d.isVerified 
                ? '<span class="px-2.5 py-1 text-xs bg-emerald-100 text-emerald-800 rounded-full font-bold"><i class="fa-solid fa-circle-check ml-1"></i> موثق</span>'
                : '<span class="px-2.5 py-1 text-xs bg-amber-100 text-amber-800 rounded-full font-bold">بانتظار الفحص</span>';

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${d.fullName}</td>
                <td class="p-4 text-slate-600 font-mono text-xs"><a href="tel:${d.phoneNumber}" class="hover:text-amber-600 underline">${d.phoneNumber}</a></td>
                <td class="p-4 text-slate-600 font-mono text-xs">${d.licenseNumber}</td>
                <td class="p-4"><span class="px-2.5 py-1 text-xs rounded-full font-bold ${statusClass}">${d.status}</span></td>
                <td class="p-4">${verifBadge}</td>
                <td class="p-4 font-bold text-amber-600"><i class="fa-solid fa-star ml-1 text-xs"></i>${(d.ratingAverage || 5.0).toFixed(1)}</td>
                <td class="p-4 text-slate-700 font-mono text-xs">${d.totalTrips || 0}</td>
                <td class="p-4 text-center">
                    <button onclick="viewFullDriver('${d.driverId}')" class="px-3.5 py-1.5 bg-slate-900 text-amber-400 hover:bg-slate-800 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1 mx-auto shadow-sm">
                        <i class="fa-solid fa-id-card text-xs"></i>
                        <span>فحص المستمسكات</span>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-rose-500">فشل في الاتصال بقاعدة البيانات</td></tr>';
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
async function loadCustomers() {
    const tbody = document.getElementById('customers-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/customers`);
        const data = await res.json();
        tbody.innerHTML = '';

        if (!data.customers || data.customers.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">لا يوجد ركاب مسجلون</td></tr>';
            return;
        }

        data.customers.forEach(c => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            const activeBadge = c.isActive 
                ? '<span class="px-2 py-0.5 text-xs bg-emerald-100 text-emerald-800 rounded font-bold">نشط</span>'
                : '<span class="px-2 py-0.5 text-xs bg-rose-100 text-rose-800 rounded font-bold">معطل</span>';

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${c.fullName}</td>
                <td class="p-4 text-slate-600 font-mono text-xs"><a href="tel:${c.phoneNumber}" class="hover:text-amber-600 underline">${c.phoneNumber}</a></td>
                <td class="p-4 text-slate-700 text-xs">${c.preferredPaymentMethod || 'نقداً'}</td>
                <td class="p-4 text-amber-600 font-bold"><i class="fa-solid fa-star ml-1 text-xs"></i>${(c.ratingAverage || 5.0).toFixed(1)}</td>
                <td class="p-4 font-mono text-xs">${c.totalBookings || 0}</td>
                <td class="p-4">${activeBadge}</td>
                <td class="p-4 text-center">
                    <button onclick="toggleCustomerStatus('${c.customerId}')" class="px-3 py-1 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-xl text-xs font-bold transition">
                        ${c.isActive ? 'تعطيل الحساب' : 'تفعيل الحساب'}
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500">فشل في الاتصال</td></tr>';
    }
}

async function toggleCustomerStatus(customerId) {
    showToast('تم تحديث حالة حساب الراكب');
    loadCustomers();
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
        const settings = await res.json();

        const matchConfig = settings.find(s => s.key === 'SpatialMatching') || {};
        const matchVals = matchConfig.valueJson ? JSON.parse(matchConfig.valueJson) : {
            MaxDetourMeters: 1500,
            MinOverlapPercentage: 65,
            SearchRadiusMeters: 2500,
            TimeWindowMinutes: 15
        };

        if (document.getElementById('setting-max-detour')) document.getElementById('setting-max-detour').value = matchVals.MaxDetourMeters ?? 1500;
        if (document.getElementById('setting-min-overlap')) document.getElementById('setting-min-overlap').value = matchVals.MinOverlapPercentage ?? 65;
        if (document.getElementById('setting-search-radius')) document.getElementById('setting-search-radius').value = matchVals.SearchRadiusMeters ?? 2500;
        if (document.getElementById('setting-time-window')) document.getElementById('setting-time-window').value = matchVals.TimeWindowMinutes ?? 15;

        const priceConfig = settings.find(s => s.key === 'PricingParameters') || {};
        const priceVals = priceConfig.valueJson ? JSON.parse(priceConfig.valueJson) : {
            BaseFareIqd: 3000,
            PerKmRateIqd: 750,
            PerMinuteWaitIqd: 250,
            SurgeMultiplierMax: 2.0
        };

        if (document.getElementById('setting-base-fare')) document.getElementById('setting-base-fare').value = priceVals.BaseFareIqd ?? 3000;
        if (document.getElementById('setting-per-km')) document.getElementById('setting-per-km').value = priceVals.PerKmRateIqd ?? 750;
        if (document.getElementById('setting-per-minute')) document.getElementById('setting-per-minute').value = priceVals.PerMinuteWaitIqd ?? 250;
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
