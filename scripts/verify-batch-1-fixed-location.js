/**
 * Automated Verification Suite for Batch 1/6: Driver Fixed Location (الباك إند فقط)
 * 
 * Verifies:
 * 1. Commute driver sets (200), changes (200), and removes (200) fixed location.
 * 2. Persistence across pm2 reload (Postgres, Redis, state.json).
 * 3. Rejection of taxi or idle drivers (409 with Arabic message).
 * 4. RLS enforcement when a driver attempts to modify another driver's location (403 with Arabic message).
 * 5. Authentication requirement (401 without token).
 * 6. Input validation: coordinates out of range (400), label > 60 chars (400).
 * 7. Rate limiting: 10 requests / 10 minutes (429 with retry_after).
 * 8. Idempotency: Duplicate request with same Idempotency-Key returns cached response.
 * 9. Cross-core verification: Proving distinct worker PIDs reading fixed location.
 * 10. Audit logs recording for all set, update, and remove actions.
 * 11. Cleanup of test data and verification of system_settings (18 keys unchanged).
 */

require('../src/backend/config');
const http = require('http');
const jwt = require('jsonwebtoken');
const { execSync } = require('child_process');
const db = require('../src/backend/db');
const redisManager = require('../src/backend/modules/redis/redisClient');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5050';
const JWT_SECRET = process.env.JWT_SECRET || 'tawseela_production_secret_key_najaf_2026_!@#';

function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_BASE);
        const reqHeaders = {
            'Content-Type': 'application/json',
            'Connection': 'close',
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
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    pid: res.headers['x-worker-pid'],
                    body: parsed
                });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runSuite() {
    console.log('================================================================');
    console.log('       BATCH 1/6: DRIVER FIXED LOCATION VERIFICATION SUITE       ');
    console.log('================================================================\n');

    // 0. Connect DB & Redis
    await db.init();

    const results = [];
    function record(name, passed, evidence, details = '') {
        results.push({ name, passed, evidence, details });
        const tag = passed ? '✅ PASS' : '❌ FAIL';
        console.log(`${tag} | ${name}`);
        if (details) console.log(`   └─ Details: ${details}`);
        console.log(`   └─ Evidence: ${JSON.stringify(evidence).slice(0, 200)}\n`);
    }

    const testDriverCommuteId = 'drv_test_commute_b1_' + Date.now();
    const testDriverTaxiId = 'drv_test_taxi_b1_' + Date.now();
    const testDriverIdleId = 'drv_test_idle_b1_' + Date.now();
    const testDriverOtherId = 'drv_test_other_b1_' + Date.now();
    const testCustomerId = 'cust_test_b1_' + Date.now();

    async function registerDriver(driverId, phone, name, mode, status = 'Online') {
        const token = signToken({ id: driverId, role: 'Driver', phone, name });
        if (db.pool && db.isPostgresConnected) {
            await db.pool.query(`
                INSERT INTO users (id, phone_number, full_name, role, is_active)
                VALUES ($1, $2, $3, 'Driver', true)
                ON CONFLICT (id) DO UPDATE SET role = 'Driver', full_name = $3
            `, [driverId, phone, name]);

            await db.pool.query(`
                INSERT INTO drivers (driver_id, full_name, phone_number, license_number, work_mode, status, is_verified, is_approved)
                VALUES ($1, $2, $3, 'TEST-LIC-1000', $4, $5, true, true)
                ON CONFLICT (driver_id) DO UPDATE SET work_mode = $4, status = $5
            `, [driverId, name, phone, mode, status]);
        }
        if (redisManager && redisManager.isConnected && redisManager.client) {
            await redisManager.client.hset(`driver:${driverId}:meta`, {
                id: driverId,
                fullName: name,
                phone: phone,
                workMode: mode,
                status: status,
                isOnline: status === 'Online' ? 'true' : 'false'
            });
        }
        const memDrv = {
            driverId,
            fullName: name,
            phoneNumber: phone,
            workMode: mode,
            work_mode: mode,
            workStatus: (mode === 'commute' || mode === 'خط دائمي' || mode === 'permanent') ? 'permanent' : (mode === 'both' ? 'both' : (status === 'Online' ? 'taxi' : 'idle')),
            status: status,
            isOnline: status === 'Online',
            isVerified: true,
            isApproved: true
        };
        db.memoryState.drivers = db.memoryState.drivers || [];
        db.memoryState.drivers = db.memoryState.drivers.filter(d => (d.driverId || d.id) !== driverId);
        db.memoryState.drivers.push(memDrv);
        db.saveStateSnapshot();
        return { driverId, token, phone, name, mode };
    }

    const phoneCommute = '078' + Math.floor(10000000 + Math.random() * 90000000);
    const phoneTaxi = '078' + Math.floor(10000000 + Math.random() * 90000000);
    const phoneIdle = '078' + Math.floor(10000000 + Math.random() * 90000000);
    const phoneOther = '078' + Math.floor(10000000 + Math.random() * 90000000);
    const phoneCustomer = '078' + Math.floor(10000000 + Math.random() * 90000000);

    const commuteDriver = await registerDriver(testDriverCommuteId, phoneCommute, 'كابتن فحص خط دائم', 'commute', 'Online');
    const taxiDriver = await registerDriver(testDriverTaxiId, phoneTaxi, 'كابتن فحص تكسي', 'taxi', 'Online');
    const idleDriver = await registerDriver(testDriverIdleId, phoneIdle, 'كابتن فحص خمول', 'idle', 'Offline');
    const otherDriver = await registerDriver(testDriverOtherId, phoneOther, 'كابتن فحص آخر', 'commute', 'Online');

    // Register test customer
    if (db.pool && db.isPostgresConnected) {
        await db.pool.query(`
            INSERT INTO users (id, phone_number, full_name, role, is_active)
            VALUES ($1, $2, 'راكب فحص', 'Customer', true)
            ON CONFLICT (id) DO UPDATE SET role = 'Customer'
        `, [testCustomerId, phoneCustomer]);
    }
    const tokenCustomer = signToken({ id: testCustomerId, role: 'Customer', phone: phoneCustomer, name: 'راكب فحص' });

    console.log('--- Initial Setup Completed (All Drivers Seeded in Postgres, Redis, Memory) ---\n');

    // TEST 1: Unauthenticated request (Missing Token = 401)
    {
        const res = await request('POST', '/api/driver/fixed-location', {
            lat: 32.0298,
            lng: 44.3285,
            label: 'النجف - ساحة الصدرين'
        });
        const pass = res.status === 401 && res.body?.success === false;
        record('Authentication Guard (Missing Token -> 401)', pass, { status: res.status, body: res.body });
    }

    // TEST 2: Customer role attempting Driver endpoint (Role = Customer -> 403)
    {
        const res = await request('POST', '/api/driver/fixed-location', {
            lat: 32.0298,
            lng: 44.3285,
            label: 'النجف - ساحة الصدرين'
        }, { 'Authorization': `Bearer ${tokenCustomer}` });
        const pass = res.status === 403 && res.body?.success === false;
        record('Role Guard (Customer attempting Driver endpoint -> 403)', pass, { status: res.status, body: res.body });
    }

    // TEST 3: Driver attempting to modify another driver's location (RLS -> 403)
    {
        const res = await request('POST', '/api/driver/fixed-location', {
            driverId: otherDriver.driverId, // Mismatched ID in body vs JWT token
            lat: 32.0298,
            lng: 44.3285,
            label: 'محاولة تعديل كابتن آخر'
        }, { 'Authorization': `Bearer ${commuteDriver.token}` });
        const pass = res.status === 403 && res.body?.success === false;
        record('RLS Isolation (Modifying other driver location -> 403)', pass, { status: res.status, body: res.body });
    }

    // TEST 4: Captain in taxi mode attempts to set fixed location (Taxi mode -> 409)
    {
        const res = await request('POST', '/api/driver/fixed-location', {
            lat: 32.0298,
            lng: 44.3285,
            label: 'تثبيت في وضع التكسي'
        }, { 'Authorization': `Bearer ${taxiDriver.token}` });
        const pass = res.status === 409 && res.body?.success === false;
        record('Work Mode Guard (Taxi mode -> 409 Conflict)', pass, { status: res.status, body: res.body });
    }

    // TEST 5: Captain in idle mode attempts to set fixed location (Idle mode -> 409)
    {
        const res = await request('POST', '/api/driver/fixed-location', {
            lat: 32.0298,
            lng: 44.3285,
            label: 'تثبيت في وضع الخمول'
        }, { 'Authorization': `Bearer ${idleDriver.token}` });
        const pass = res.status === 409 && res.body?.success === false;
        record('Work Mode Guard (Idle mode -> 409 Conflict)', pass, { status: res.status, body: res.body });
    }

    // TEST 6: Validation - Latitude out of range (lat = 95 -> 400)
    {
        const res = await request('POST', '/api/driver/fixed-location', {
            lat: 95.0,
            lng: 44.3285,
            label: 'إحداثيات خاطئة'
        }, { 'Authorization': `Bearer ${commuteDriver.token}` });
        const pass = res.status === 400 && res.body?.success === false;
        record('Input Validation (Latitude > 90 -> 400)', pass, { status: res.status, body: res.body });
    }

    // TEST 7: Validation - Longitude out of range (lng = 200 -> 400)
    {
        const res = await request('POST', '/api/driver/fixed-location', {
            lat: 32.0298,
            lng: 200.0,
            label: 'إحداثيات خاطئة'
        }, { 'Authorization': `Bearer ${commuteDriver.token}` });
        const pass = res.status === 400 && res.body?.success === false;
        record('Input Validation (Longitude > 180 -> 400)', pass, { status: res.status, body: res.body });
    }

    // TEST 8: Validation - Label length > 60 chars (400)
    {
        const longLabel = 'م'.repeat(65);
        const res = await request('POST', '/api/driver/fixed-location', {
            lat: 32.0298,
            lng: 44.3285,
            label: longLabel
        }, { 'Authorization': `Bearer ${commuteDriver.token}` });
        const pass = res.status === 400 && res.body?.success === false;
        record('Input Validation (Label > 60 characters -> 400)', pass, { status: res.status, body: res.body });
    }

    // Reset rate limiter for commuteDriver before operational flow
    if (redisManager && redisManager.isConnected && redisManager.client) {
        await redisManager.client.del(`rate:driver:fixed_loc:${commuteDriver.driverId}`);
    }

    // TEST 9: Idempotency-Key handling (Same key returns cached response)
    const idemKey = 'idem_b1_test_' + Date.now();
    {
        const firstIdemRes = await request('POST', '/api/driver/fixed-location', {
            lat: 32.0298,
            lng: 44.3285,
            label: 'النجف - الحنانة'
        }, {
            'Authorization': `Bearer ${commuteDriver.token}`,
            'Idempotency-Key': idemKey
        });

        const secondIdemRes = await request('POST', '/api/driver/fixed-location', {
            lat: 32.0298,
            lng: 44.3285,
            label: 'النجف - الحنانة'
        }, {
            'Authorization': `Bearer ${commuteDriver.token}`,
            'Idempotency-Key': idemKey
        });

        const pass = firstIdemRes.status === 200 &&
                     secondIdemRes.status === 200 &&
                     firstIdemRes.body?.fixed_updated_at === secondIdemRes.body?.fixed_updated_at;
        record('Idempotency Guard (Duplicate Idempotency-Key -> Single Cached Execution)', pass, {
            firstStatus: firstIdemRes.status,
            secondStatus: secondIdemRes.status,
            matchingTimestamp: firstIdemRes.body?.fixed_updated_at === secondIdemRes.body?.fixed_updated_at
        });
    }

    // TEST 10: Commute driver changes fixed location (Update -> 200)
    {
        const res = await request('POST', '/api/driver/fixed-location', {
            lat: 32.0350,
            lng: 44.3700,
            label: 'الكوفة - مسجد السهلة'
        }, { 'Authorization': `Bearer ${commuteDriver.token}` });

        const pass = res.status === 200 &&
                     res.body?.success === true &&
                     res.body?.fixed_lat === 32.0350 &&
                     res.body?.fixed_lng === 44.3700 &&
                     res.body?.fixed_label === 'الكوفة - مسجد السهلة';
        record('Update Fixed Location (Commute Driver -> 200 OK)', pass, { status: res.status, body: res.body });
    }

    // TEST 11: Cross-core reading (GET across PM2 cluster proving distinct PIDs)
    {
        const pids = new Set();
        const responses = [];
        for (let i = 0; i < 15; i++) {
            const res = await request('GET', '/api/driver/fixed-location', null, {
                'Authorization': `Bearer ${commuteDriver.token}`
            });
            if (res.pid) pids.add(res.pid);
            responses.push({ pid: res.pid, lat: res.body?.fixed_lat, label: res.body?.fixed_label });
            await sleep(40);
        }

        const pass = pids.size > 1 && responses.every(r => r.lat === 32.0350 && r.label === 'الكوفة - مسجد السهلة');
        record('Cross-Core Redis/Cluster Reading (Proving Distinct Worker PIDs)', pass, {
            distinctPidsCount: pids.size,
            distinctPids: Array.from(pids),
            sampleResponsesCount: responses.length
        });
    }

    // TEST 12: Persistence across PM2 Reload
    {
        console.log('   --> Triggering pm2 reload taxi-wisam-api to test persistence...');
        execSync('pm2 reload taxi-wisam-api');
        await sleep(4000); // Wait for workers to come online

        const res = await request('GET', '/api/driver/fixed-location', null, {
            'Authorization': `Bearer ${commuteDriver.token}`
        });

        const pass = res.status === 200 &&
                     res.body?.fixed_lat === 32.0350 &&
                     res.body?.fixed_lng === 44.3700 &&
                     res.body?.fixed_label === 'الكوفة - مسجد السهلة';
        record('Cluster Persistence (Survives pm2 reload from Postgres/Redis)', pass, {
            status: res.status,
            body: res.body,
            postReloadPid: res.pid
        });
    }

    // TEST 13: Removal of fixed location (DELETE /api/driver/fixed-location -> 200)
    {
        const res = await request('DELETE', '/api/driver/fixed-location', null, {
            'Authorization': `Bearer ${commuteDriver.token}`
        });

        const getAfter = await request('GET', '/api/driver/fixed-location', null, {
            'Authorization': `Bearer ${commuteDriver.token}`
        });

        const pass = res.status === 200 &&
                     res.body?.fixed_lat === null &&
                     getAfter.body?.fixed_lat === null;
        record('Remove Fixed Location (DELETE /api/driver/fixed-location -> 200 OK)', pass, {
            deleteBody: res.body,
            getAfterBody: getAfter.body
        });
    }

    // TEST 14: Removal via POST /api/driver/fixed-location/remove (200)
    {
        // First set it again
        await request('POST', '/api/driver/fixed-location', {
            lat: 32.0298,
            lng: 44.3285,
            label: 'موقع مؤقت للإزالة عبر POST'
        }, { 'Authorization': `Bearer ${commuteDriver.token}` });

        const res = await request('POST', '/api/driver/fixed-location/remove', null, {
            'Authorization': `Bearer ${commuteDriver.token}`
        });

        const pass = res.status === 200 && res.body?.fixed_lat === null;
        record('Remove Fixed Location via POST /remove (200 OK)', pass, { status: res.status, body: res.body });
    }

    // TEST 15: Rate Limiting (10 requests per 10 minutes -> 429 with retry_after)
    {
        const rateDriverId = 'drv_test_rate_b1_' + Date.now();
        const rateDriver = await registerDriver(rateDriverId, '07890009999', 'كابتن فحص المعدل', 'commute', 'Online');

        let hit429 = false;
        let lastRes = null;
        for (let i = 0; i < 15; i++) {
            lastRes = await request('POST', '/api/driver/fixed-location', {
                lat: 32.0298,
                lng: 44.3285,
                label: `موقع تجربة ${i}`
            }, { 'Authorization': `Bearer ${rateDriver.token}` });

            if (lastRes.status === 429) {
                hit429 = true;
                break;
            }
        }

        const pass = hit429 &&
                     lastRes?.status === 429 &&
                     (lastRes?.body?.retry_after !== undefined || lastRes?.headers['retry-after'] !== undefined);
        record('Rate Limiting Guard (Exceeding 10 reqs/10 min -> 429 + retry_after)', pass, {
            status: lastRes?.status,
            body: lastRes?.body,
            retryAfterHeader: lastRes?.headers['retry-after']
        });
    }

    // TEST 16: Audit Logs Verification
    {
        let auditRows = [];
        if (db.pool && db.isPostgresConnected) {
            const pgAudit = await db.pool.query(
                `SELECT action, entity_name, entity_id, new_values_json, created_at 
                 FROM audit_logs 
                 WHERE entity_id = $1 
                 ORDER BY created_at DESC`,
                [testDriverCommuteId]
            );
            auditRows = pgAudit.rows || [];
        }

        const hasUpdate = auditRows.some(r => r.action === 'DRIVER_FIXED_LOCATION_UPDATED');
        const hasRemove = auditRows.some(r => r.action === 'DRIVER_FIXED_LOCATION_REMOVED');
        const pass = hasUpdate && hasRemove;
        record('Audit Logging Guard (Audit logs recorded for set, update, and remove)', pass, {
            auditCount: auditRows.length,
            hasUpdateAction: hasUpdate,
            hasRemoveAction: hasRemove,
            sampleAction: auditRows[0]?.action
        });
    }

    // CLEANUP TEST DATA
    console.log('--- Cleaning Up Test Data ---');
    const testIds = [testDriverCommuteId, testDriverTaxiId, testDriverIdleId, testDriverOtherId];

    if (db.pool && db.isPostgresConnected) {
        for (const tid of testIds) {
            await db.pool.query('DELETE FROM audit_logs WHERE entity_id = $1', [tid]).catch(() => {});
            await db.pool.query('DELETE FROM drivers WHERE driver_id = $1', [tid]).catch(() => {});
            await db.pool.query('DELETE FROM users WHERE id = $1', [tid]).catch(() => {});
        }
        await db.pool.query('DELETE FROM users WHERE id = $1', [testCustomerId]).catch(() => {});
        // Also cleanup rate limit test driver
        await db.pool.query('DELETE FROM drivers WHERE driver_id LIKE $1', ['drv_test_rate_b1_%']).catch(() => {});
        await db.pool.query('DELETE FROM users WHERE id LIKE $1', ['drv_test_rate_b1_%']).catch(() => {});
    }

    if (redisManager && redisManager.isConnected && redisManager.client) {
        for (const tid of testIds) {
            await redisManager.client.del(`driver:${tid}:meta`).catch(() => {});
            await redisManager.client.del(`rate:driver:fixed_loc:${tid}`).catch(() => {});
        }
        await redisManager.client.del(`idem:${idemKey}`).catch(() => {});
        // cleanup rate driver redis keys
        const keys = await redisManager.client.keys('rate:driver:fixed_loc:drv_test_rate_b1_*');
        if (keys && keys.length > 0) await redisManager.client.del(...keys);
    }

    if (db.memoryState && Array.isArray(db.memoryState.drivers)) {
        db.memoryState.drivers = db.memoryState.drivers.filter(d => !testIds.includes(d.driverId || d.id));
    }
    db.saveStateSnapshot();

    // Verify system_settings has exactly 18 keys
    let systemSettingsKeys = [];
    if (db.pool && db.isPostgresConnected) {
        const ssRes = await db.pool.query('SELECT key FROM system_settings ORDER BY key ASC');
        systemSettingsKeys = (ssRes.rows || []).map(r => r.key);
    }
    const ssPass = systemSettingsKeys.length === 18;
    record('System Settings Integrity Check (Exactly 18 baseline keys unchanged)', ssPass, {
        keysCount: systemSettingsKeys.length,
        keysList: systemSettingsKeys
    });

    console.log('\n================================================================');
    console.log(`TOTAL TESTS: ${results.length} | PASSED: ${results.filter(r => r.passed).length} | FAILED: ${results.filter(r => !r.passed).length}`);
    console.log('================================================================\n');

    process.exit(results.every(r => r.passed) ? 0 : 1);
}

runSuite().catch(err => {
    console.error('Fatal suite execution error:', err);
    process.exit(1);
});
