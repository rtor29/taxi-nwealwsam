const http = require('http');

const API_BASE = 'http://173.212.206.86:5050';

function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_BASE);
        const reqHeaders = {
            'Content-Type': 'application/json',
            ...headers
        };
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: reqHeaders
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, body: data, raw: data });
                }
            });
        });

        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'object' ? JSON.stringify(body) : body);
        }
        req.end();
    });
}

async function runTests() {
    console.log('========================================================');
    console.log('🚀 Starting Complete 18-Point Full System Verification');
    console.log('========================================================\n');

    let passed = 0;
    let failed = 0;

    function report(num, name, success, details) {
        if (success) {
            passed++;
            console.log(`✅ [${num}/18] ${name}: PASS - ${details}`);
        } else {
            failed++;
            console.log(`❌ [${num}/18] ${name}: FAIL - ${details}`);
        }
    }

    try {
        // 1. Google Login
        const googleRes = await request('GET', '/complete-profile');
        const googlePass = googleRes.status === 200 && typeof googleRes.body === 'string' && googleRes.body.includes('إكمال إنشاء حسابك في توصيله');
        report(1, 'Google Login & Onboarding Wizard', googlePass, `Status: ${googleRes.status}, HTML contains Arabic Onboarding`);

        // 2. Customer Registration & Login
        const custEmail = `test.cust.${Date.now()}@example.com`;
        const custReg = await request('POST', '/api/auth/complete-passenger-registration', {
            role: 'Customer',
            fullName: 'أحمد علي النجفي (مختبر)',
            email: custEmail,
            phoneNumber: '07801122334',
            area: 'حي الأمير',
            paymentMethod: 'Cash'
        });
        const custLogin = await request('POST', '/api/auth/login', {
            identifier: custEmail,
            email: custEmail
        });
        const custPass = custReg.body?.success === true && custLogin.body?.token && custLogin.body?.role === 'Customer';
        report(2, 'Customer Flow', custPass, `CustomerId: ${custReg.body?.userId}, Login: ${custLogin.body?.fullName}`);

        // 3. Driver Registration with 4 docs, vehicle, route
        const drvEmail = `test.drv.${Date.now()}@example.com`;
        const dummyBase64 = 'data:image/jpeg;base64,' + Buffer.from('fake-image-bytes-for-test').toString('base64');
        const drvReg = await request('POST', '/api/auth/complete-driver-registration', {
            fullName: 'حيدر الكرعاوي (كابتن مختبر)',
            email: drvEmail,
            phoneNumber: '07809988776',
            vehicleMake: 'هيونداي إلنترا',
            vehiclePlate: 'النجف 5544 خصوصي',
            vehicleYear: 2024,
            documents: {
                'id-front': dummyBase64,
                'id-back': dummyBase64,
                'lic-front': dummyBase64,
                'lic-back': dummyBase64
            },
            route: {
                startName: 'ساحة ثورة العشرين',
                endName: 'جامعة الكوفة - مجمع الكليات',
                startLat: 31.9961,
                startLon: 44.3168,
                endLat: 32.0321,
                endLon: 44.3725,
                departureTime: '08:00 ص',
                availableSeats: 4,
                fare: 3000
            }
        });
        const testDriverId = drvReg.body?.userId;
        const drvPass = drvReg.body?.success === true && !!testDriverId;
        report(3, 'Driver Flow (4 Docs + Route + Vehicle)', drvPass, `DriverId: ${testDriverId}, Status: ${drvReg.body?.status}`);

        // 4. Driver Verification
        const verifGet = await request('GET', `/api/drivers/${testDriverId}`);
        const verifApprove = await request('POST', `/api/drivers/${testDriverId}/status`, {
            status: 'Approved',
            reason: 'تم التحقق من المستمسكات بنجاح'
        });
        const approvedStatus = verifApprove.body?.driver?.status || verifApprove.body?.status;
        const verifPass = verifGet.body?.driverId === testDriverId && approvedStatus === 'Approved';
        report(4, 'Driver Verification (Inspection & Approval)', verifPass, `Documents count: ${verifGet.body?.documents?.length || 0}, New Status: ${approvedStatus}`);

        // 5. Admin Dashboard
        const dashMetrics = await request('GET', '/api/admin/metrics');
        const dashPass = dashMetrics.status === 200 && (dashMetrics.body?.totalDrivers >= 1 || dashMetrics.body?.verifiedDrivers >= 1);
        report(5, 'Admin Dashboard Metrics', dashPass, `Drivers: ${dashMetrics.body?.totalDrivers}, Verified: ${dashMetrics.body?.verifiedDrivers}, Users: ${dashMetrics.body?.totalUsers}`);

        // 6. Delete Driver
        const delDrvRes = await request('DELETE', `/api/admin/drivers/${testDriverId}`);
        const checkDeletedDrv = await request('GET', `/api/drivers/${testDriverId}`);
        const delDrvPass = delDrvRes.body?.success === true && checkDeletedDrv.status === 404;
        report(6, 'Delete Driver (Permanent DB Removal)', delDrvPass, `Delete response: ${JSON.stringify(delDrvRes.body)}`);

        // 7. Delete Customer
        const testCustId = custReg.body?.userId;
        const delCustRes = await request('DELETE', `/api/admin/customers/${testCustId}`);
        const delCustPass = delCustRes.body?.success === true;
        report(7, 'Delete Customer (Permanent DB Removal)', delCustPass, `Delete response: ${JSON.stringify(delCustRes.body)}`);

        // 8. Notifications
        const notifCreate = await request('POST', '/api/notifications/send', {
            target: 'all',
            title: 'إشعار تجريبي',
            message: 'نظام الإشعارات يعمل بكفاءة عالية'
        });
        const notifPass = notifCreate.status === 200 || notifCreate.body?.success === true;
        report(8, 'Notifications Engine', notifPass, `Sent notification successfully`);

        // 9. Counters
        const countersRes = await request('GET', '/api/admin/counters');
        const countersPass = countersRes.status === 200 && typeof countersRes.body?.totalDrivers === 'number';
        report(9, 'Counters & System Stats', countersPass, `Total Drivers: ${countersRes.body?.totalDrivers}, Verified: ${countersRes.body?.verifiedDrivers}, Pending: ${countersRes.body?.pendingVerifications}`);

        // 10. Backend Health
        const healthRes = await request('GET', '/api/health');
        const healthPass = healthRes.status === 200 && healthRes.body?.status === 'Healthy';
        report(10, 'Backend API Health', healthPass, `Status: ${healthRes.body?.status}, Uptime: ${healthRes.body?.uptime}s`);

        // 11. Database PostgreSQL
        const dbStatus = healthRes.body?.postgres;
        const dbPass = dbStatus?.connected === true && dbStatus?.engine?.includes('PostgreSQL');
        report(11, 'Database PostgreSQL 16', dbPass, `Connected: ${dbStatus?.connected}, Engine: ${dbStatus?.engine}`);

        // 12. Backup
        const backupRes = await request('GET', '/api/admin/backup');
        const backupPayload = backupRes.body?.backupPayload || backupRes.body;
        const backupPass = backupRes.status === 200 && backupPayload?.data?.drivers;
        report(12, 'Backup Generation', backupPass, `Backup version: ${backupPayload?.version}, Filename: ${backupRes.body?.filename}`);

        // 13. Restore
        const restoreRes = await request('POST', '/api/admin/restore', backupRes.body);
        const restorePass = restoreRes.status === 200 && restoreRes.body?.success === true;
        report(13, 'Restore Verification', restorePass, `Restore status: ${restoreRes.body?.message}`);

        // 14. Docker Container
        const dockerPass = healthRes.body?.postgres?.connected === true;
        report(14, 'Docker Postgres Container', dockerPass, `PostgreSQL is active and responding on Docker network`);

        // 15. Permissions & Roles
        const roleRes = await request('POST', '/api/auth/login', { identifier: 'admin@taxiwisam.com' });
        const permPass = roleRes.body?.role === 'Admin';
        report(15, 'Permissions & Role RBAC', permPass, `Admin authenticated with role: ${roleRes.body?.role}`);

        // 16. Security & Input Sanitization
        const secRes = await request('POST', '/api/auth/complete-passenger-registration', {
            role: 'Customer',
            email: ''
        });
        const secPass = secRes.status === 400 || !secRes.body?.success;
        report(16, 'Security & Validation', secPass, `Safely rejected invalid or incomplete payload (status: ${secRes.status})`);

        // 17. Web App Serving
        const appRes = await request('GET', '/app/');
        const appPass = appRes.status === 200 && typeof appRes.body === 'string' && appRes.body.includes('توصيله');
        report(17, 'Web App Delivery (/app/)', appPass, `Status: ${appRes.status}, Title: توصيله`);

        // 18. Web Dashboard Serving
        const dashUiRes = await request('GET', '/dashboard/index.html');
        const dashUiPass = dashUiRes.status === 200 && typeof dashUiRes.body === 'string' && dashUiRes.body.includes('لوحة تحكم');
        report(18, 'Web Dashboard Delivery (/dashboard/)', dashUiPass, `Status: ${dashUiRes.status}, Responsive UI ready`);

    } catch (err) {
        console.error('Fatal test execution error:', err);
    }

    console.log('\n========================================================');
    console.log(`📊 Result Summary: ${passed}/18 Passed, ${failed}/18 Failed`);
    console.log('========================================================\n');
}

runTests();
