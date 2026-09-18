// Taxi-Wisam Admin Dashboard Client
const API_BASE = '/api/admin';

let currentDocId = null;
let currentDriverId = null;
let isRejectionOpen = false;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadDashboardStats();
    loadMatchingSettings();
});

// Tab Switching
function switchTab(tabName) {
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

        document.getElementById('stat-total-drivers').innerText = data.totalDrivers;
        document.getElementById('stat-verified-drivers').innerText = data.verifiedDrivers;
        document.getElementById('stat-pending-verifications').innerText = data.pendingVerifications;
        document.getElementById('stat-active-routes').innerText = data.activeRoutes;
        document.getElementById('stat-total-bookings').innerText = data.totalBookings;
        document.getElementById('stat-total-revenue').innerText = Number(data.totalRevenue).toLocaleString();

        const badgeVerif = document.getElementById('badge-verifications');
        if (data.pendingVerifications > 0) {
            badgeVerif.innerText = data.pendingVerifications;
            badgeVerif.classList.remove('hidden');
        } else {
            badgeVerif.classList.add('hidden');
        }

        const badgeComp = document.getElementById('badge-complaints');
        if (data.pendingComplaints > 0) {
            badgeComp.innerText = data.pendingComplaints;
            badgeComp.classList.remove('hidden');
        } else {
            badgeComp.classList.add('hidden');
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
            d.documents.forEach(doc => {
                const statusBadge = doc.status === 'Pending' 
                    ? '<span class="px-2 py-0.5 text-[11px] bg-amber-100 text-amber-800 rounded font-bold">بانتظار التدقيق</span>'
                    : `<span class="px-2 py-0.5 text-[11px] bg-emerald-100 text-emerald-800 rounded font-bold">${doc.status}</span>`;

                docsHtml += `
                    <div class="flex items-center justify-between p-1.5 bg-slate-100 rounded-lg text-xs mb-1">
                        <span class="font-semibold text-slate-700">${translateDocType(doc.documentType)}</span>
                        <div class="flex items-center space-x-2 space-x-reverse">
                            ${statusBadge}
                            <button onclick="previewDocument('${d.driverId}', '${doc.id}')" class="px-2 py-0.5 bg-slate-900 text-white rounded text-[11px] hover:bg-slate-800 transition">
                                <i class="fa-solid fa-eye ml-1"></i> فحص
                            </button>
                        </div>
                    </div>
                `;
            });

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${d.fullName}</td>
                <td class="p-4 text-slate-600 font-mono text-xs">${d.phoneNumber}</td>
                <td class="p-4 text-slate-600 font-mono text-xs">${d.licenseNumber}</td>
                <td class="p-4 text-slate-700 text-xs">${vehicleInfo}</td>
                <td class="p-4 min-w-[260px]">${docsHtml || '<span class="text-slate-400 text-xs">لا توجد وثائق مرفوعة</span>'}</td>
                <td class="p-4 text-center">
                    <button onclick="viewFullDriver('${d.driverId}')" class="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-xl text-xs font-bold transition">
                        تفاصيل السائق
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

async function previewDocument(driverId, docId) {
    currentDocId = docId;
    currentDriverId = driverId;
    isRejectionOpen = false;
    document.getElementById('rejection-box').classList.add('hidden');
    document.getElementById('rejection-reason-input').value = '';

    try {
        const res = await fetch(`/api/documents/${docId}/signed-url?expirySeconds=3600`);
        if (!res.ok) {
            showToast('تعذر جلب رابط المعاينة المشفر', true);
            return;
        }

        const data = await res.json();
        const img = document.getElementById('modal-doc-img');
        const pdfBox = document.getElementById('modal-no-preview');
        const pdfLink = document.getElementById('modal-pdf-link');

        document.getElementById('modal-doc-title').innerText = `معاينة: ${translateDocType(data.documentType)}`;

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

function closeDocumentModal() {
    document.getElementById('document-modal').classList.add('hidden');
    currentDocId = null;
}

function toggleRejectionBox() {
    isRejectionOpen = !isRejectionOpen;
    const box = document.getElementById('rejection-box');
    if (isRejectionOpen) {
        box.classList.remove('hidden');
    } else {
        box.classList.add('hidden');
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
                : '<span class="px-2.5 py-1 text-xs bg-amber-100 text-amber-800 rounded-full font-bold">غير موثق</span>';

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${d.fullName}</td>
                <td class="p-4 text-slate-600 font-mono text-xs">${d.phoneNumber}</td>
                <td class="p-4 text-slate-600 font-mono text-xs">${d.licenseNumber}</td>
                <td class="p-4"><span class="px-2 py-0.5 text-xs rounded-full font-semibold ${statusClass}">${d.status}</span></td>
                <td class="p-4">${verifBadge}</td>
                <td class="p-4 font-bold text-amber-600"><i class="fa-solid fa-star ml-1 text-xs"></i>${d.ratingAverage.toFixed(1)}</td>
                <td class="p-4 text-slate-700 font-mono text-xs">${d.totalTrips}</td>
                <td class="p-4 text-center">
                    <button onclick="viewFullDriver('${d.driverId}')" class="px-3 py-1 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 transition">
                        فحص
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
                <td class="p-4 text-slate-600 font-mono text-xs">${c.phoneNumber}</td>
                <td class="p-4 text-slate-700 text-xs">${c.preferredPaymentMethod}</td>
                <td class="p-4 text-amber-600 font-bold"><i class="fa-solid fa-star ml-1 text-xs"></i>${c.ratingAverage.toFixed(1)}</td>
                <td class="p-4 font-mono text-xs">${c.totalBookings}</td>
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

// -----------------------------------------------------------------------------
// 5. Routes & Bookings
// -----------------------------------------------------------------------------
async function loadRoutes() {
    const tbody = document.getElementById('routes-table-body');
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
                <td class="p-4 text-emerald-600 font-bold">${Number(b.totalFare).toLocaleString()} د.ع</td>
                <td class="p-4"><span class="px-2 py-0.5 text-xs bg-blue-100 text-blue-800 rounded font-bold">${b.status}</span></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-rose-500">فشل في الاتصال</td></tr>';
    }
}

// -----------------------------------------------------------------------------
// 6. Complaints & Disputes
// -----------------------------------------------------------------------------
async function loadComplaints() {
    const tbody = document.getElementById('complaints-table-body');
    tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">جاري التحميل...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/complaints`);
        const data = await res.json();
        tbody.innerHTML = '';

        if (!data.complaints || data.complaints.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">لا توجد شكاوى مسجلة</td></tr>';
            return;
        }

        data.complaints.forEach(c => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-50 transition';

            tr.innerHTML = `
                <td class="p-4 font-bold text-slate-900">${c.complainantName}</td>
                <td class="p-4 text-slate-700 text-xs">${c.targetUserName || 'غير محدد'}</td>
                <td class="p-4"><span class="px-2 py-0.5 text-xs bg-slate-200 text-slate-800 rounded font-semibold">${c.category}</span></td>
                <td class="p-4 text-xs text-slate-600 max-w-xs truncate">${c.description}</td>
                <td class="p-4"><span class="px-2 py-0.5 text-xs bg-amber-100 text-amber-800 rounded font-bold">${c.status}</span></td>
                <td class="p-4 font-mono text-xs">${new Date(c.createdAt).toLocaleDateString('ar-IQ')}</td>
                <td class="p-4 text-center">
                    <button onclick="resolveComplaint('${c.complaintId}')" class="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition">
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
    const note = prompt('أدخل ملاحظات المشرف لحل الشكوى:');
    if (!note) return;

    try {
        const res = await fetch(`${API_BASE}/complaints/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 2, adminNotes: note }) // 2 = Resolved
        });

        if (res.ok) {
            showToast('تم حل الشكوى بنجاح ✅');
            loadComplaints();
            loadDashboardStats();
        }
    } catch (err) {
        showToast('فشل حل الشكوى', true);
    }
}

// -----------------------------------------------------------------------------
// 7. System Settings (Matching & Pricing)
// -----------------------------------------------------------------------------
async function loadMatchingSettings() {
    try {
        const res = await fetch(`${API_BASE}/settings`);
        if (!res.ok) return;
        const settings = await res.json();

        settings.forEach(s => {
            try {
                const val = JSON.parse(s.valueJson);
                if (s.key === 'matching_settings') {
                    document.getElementById('setting-max-detour').value = val.max_detour_meters || 1500;
                    document.getElementById('setting-min-overlap').value = val.min_overlap_percentage || 60;
                    document.getElementById('setting-search-radius').value = val.search_radius_meters || 5000;
                    document.getElementById('setting-time-window').value = val.time_window_minutes || 30;
                } else if (s.key === 'pricing_settings') {
                    document.getElementById('setting-base-fare').value = val.base_fare_iqd || 3000;
                    document.getElementById('setting-per-km').value = val.per_km_rate_iqd || 500;
                    document.getElementById('setting-per-minute').value = val.per_minute_rate_iqd || 100;
                    document.getElementById('setting-surge-max').value = val.surge_multiplier_max || 2.5;
                }
            } catch (e) {}
        });
    } catch (err) {
        console.warn('Could not load settings', err);
    }
}

async function saveMatchingSettings() {
    const payload = {
        max_detour_meters: Number(document.getElementById('setting-max-detour').value),
        min_overlap_percentage: Number(document.getElementById('setting-min-overlap').value),
        search_radius_meters: Number(document.getElementById('setting-search-radius').value),
        time_window_minutes: Number(document.getElementById('setting-time-window').value)
    };

    await updateSettingOnServer('matching_settings', payload, 'معايير محرك المطابقة الجغرافي');
}

async function savePricingSettings() {
    const payload = {
        base_fare_iqd: Number(document.getElementById('setting-base-fare').value),
        per_km_rate_iqd: Number(document.getElementById('setting-per-km').value),
        per_minute_rate_iqd: Number(document.getElementById('setting-per-minute').value),
        surge_multiplier_max: Number(document.getElementById('setting-surge-max').value)
    };

    await updateSettingOnServer('pricing_settings', payload, 'تسعيرات المشاوير الأساسية');
}

async function updateSettingOnServer(key, payloadObj, description) {
    try {
        const res = await fetch(`${API_BASE}/settings/${key}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                valueJson: JSON.stringify(payloadObj),
                description: description
            })
        });

        if (res.ok) {
            showToast('تم حفظ الإعدادات بنجاح ومزامنتها مع الخادم ✅');
        } else {
            showToast('فشل في حفظ الإعدادات', true);
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
                <td class="p-4 font-mono text-xs">${new Date(l.createdAt).toLocaleString()}</td>
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
    return map[type] || type;
}

function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-msg');
    const toastInner = document.getElementById('toast-inner');
    const icon = document.getElementById('toast-icon');

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
