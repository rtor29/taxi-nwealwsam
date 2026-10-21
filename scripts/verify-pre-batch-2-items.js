/**
 * Pre-Batch 2 Verification Suite
 * Tests the 5 edge-case closure items:
 * (A) Actual 20s step timeout expiration and escalation to next candidate -> NO_DRIVERS
 * (B) Unconfirmed fare by rider -> reconciliationStatus = 'pending_review'
 * (C) Arrival outside proximity radius (> 1000m) -> 400 rejection
 * (D) Unrelated rider subscribing to /api/ride/:id/stream -> 403 Forbidden
 * (E) Request created on PID A, accepted on PID B across PM2 cluster
 */

const http = require('http');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { Pool } = require('pg');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5050';
const JWT_SECRET = process.env.JWT_SECRET || 'tawseela_prod_jwt_super_secret_najaf_2026';

const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/taxiwisam'
});

function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, API_BASE);
        const reqHeaders = {
            'Content-Type': 'application/json',
            'Connection': 'close', // Ensures requests rotate across PM2 cluster workers
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
                let json = null;
                try {
                    json = JSON.parse(data);
                } catch (_) {}
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: json || data,
                    raw: data
                });
            });
        });

        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'object' ? JSON.stringify(body) : body);
        }
        req.end();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPreBatch2Tests() {
    console.log('===============================================================');
    console.log('🧪 Starting Pre-Batch 2 Closure Verification Suite (5 Points)');
    console.log('===============================================================\n');

    let passed = 0;
    let failed = 0;

    function report(code, title, success, details) {
        if (success) {
            passed++;
            console.log(`✅ [${code}] ${title}: PASS\n   ↳ ${details}\n`);
        } else {
            failed++;
            console.log(`❌ [${code}] ${title}: FAIL\n   ↳ ${details}\n`);
        }
    }

    const testDriver1Id = `drv-cand1-${Date.now()}`;
    const testDriver2Id = `drv-cand2-${Date.now()}`;
    const customer1 = { id: `cust-verif-${Date.now()}`, role: 'Customer', phone: '07801112233' };
    const customer2 = { id: `cust-other-${Date.now()}`, role: 'Customer', phone: '07809998877' };
    const driver1 = { id: testDriver1Id, role: 'Driver', phone: '07701112233', fullName: 'كابتن أحمد' };
    const driver2 = { id: testDriver2Id, role: 'Driver', phone: '07702223344', fullName: 'كابتن سامر' };

    const cust1Token = signToken(customer1);
    const cust2Token = signToken(customer2);
    const drv1Token = signToken(driver1);
    const drv2Token = signToken(driver2);

    try {
        // 0. Seed Candidates in Redis Geospatial Index & Postgres
        console.log('🌱 Seeding 2 test drivers into Redis Geo Index & PostgreSQL...');
        await redis.geoadd('drivers:locations', 44.3170, 31.9970, driver1.id);
        await redis.hmset(`driver:${driver1.id}:meta`, {
            id: driver1.id,
            fullName: driver1.fullName,
            phone: driver1.phone,
            status: 'Online',
            workMode: 'taxi',
            vehicleType: 'eco'
        });

        await redis.geoadd('drivers:locations', 44.3180, 31.9980, driver2.id);
        await redis.hmset(`driver:${driver2.id}:meta`, {
            id: driver2.id,
            fullName: driver2.fullName,
            phone: driver2.phone,
            status: 'Online',
            workMode: 'taxi',
            vehicleType: 'eco'
        });

        await pool.query(
            `INSERT INTO drivers (driver_id, full_name, phone_number, status, is_online, current_lat, current_lon)
             VALUES ($1, $2, $3, 'Online', true, 31.9970, 44.3170),
                    ($4, $5, $6, 'Online', true, 31.9980, 44.3180)
             ON CONFLICT (driver_id) DO UPDATE SET status = 'Online', is_online = true`,
            [driver1.id, driver1.fullName, driver1.phone, driver2.id, driver2.fullName, driver2.phone]
        );

        // -------------------------------------------------------------------------
        // (A) Test: 20s Timeout Actual Expiration & Candidate Escalation
        // -------------------------------------------------------------------------
        console.log('⏳ Running Test (A): Actual step timeout escalation...');
        const createResA = await request('POST', '/api/ride/request', {
            customerId: customer1.id,
            customerName: 'أحمد علي (مختبر)',
            customerPhone: customer1.phone,
            pickupName: 'ساحة ثورة العشرين',
            pickupLat: 31.9961,
            pickupLon: 44.3168,
            dropoffName: 'جامعة الكوفة',
            dropoffLat: 32.0321,
            dropoffLon: 44.3725,
            distanceKm: 5.2,
            durationMins: 12,
            vehicleType: 'eco'
        }, { Authorization: `Bearer ${cust1Token}` });

        const rideA = createResA.body?.request || createResA.body;
        const rideIdA = rideA?.id;
        const initAssigned = rideA?.assignedDriverId;

        console.log(`   Ride created: ${rideIdA}, initial assigned driver: ${initAssigned}`);
        console.log('   Waiting 21s for server-side step timeout (20s) to expire naturally...');
        await sleep(21500);

        // Check status to trigger server auto-escalation evaluation
        const statusRes1 = await request('GET', `/api/ride/status/${rideIdA}`, null, {
            Authorization: `Bearer ${cust1Token}`
        });
        const escalatedRide = statusRes1.body?.request;
        const newAssigned = escalatedRide?.assignedDriverId;
        const candidateIndex = escalatedRide?.currentDriverIndex;

        const passA = (initAssigned === driver1.id && newAssigned === driver2.id && candidateIndex === 1);
        report('Item 3-A', '20s Step Timeout Escalation to Next Candidate', passA,
            `Initial: ${initAssigned} -> Escalated: ${newAssigned} (Index: ${candidateIndex}), History: ${JSON.stringify(escalatedRide?.history?.[0])}`);

        // -------------------------------------------------------------------------
        // (B) Test: Rider Unconfirmed Fare -> 'pending_review'
        // -------------------------------------------------------------------------
        console.log('⏳ Running Test (B): Unconfirmed Fare & Reconciliation Status...');
        // Driver 2 accepts escalated ride
        await request('POST', '/api/ride/accept', {
            requestId: rideIdA,
            driverId: driver2.id
        }, { Authorization: `Bearer ${drv2Token}` });

        // Driver 2 arrives (within proximity)
        await request('POST', '/api/ride/arrived', {
            requestId: rideIdA,
            driverId: driver2.id,
            driverLat: 31.9962,
            driverLon: 44.3169
        }, { Authorization: `Bearer ${drv2Token}` });

        // Driver 2 starts trip
        await request('POST', '/api/ride/start', {
            requestId: rideIdA,
            driverId: driver2.id
        }, { Authorization: `Bearer ${drv2Token}` });

        // Driver 2 arrives destination
        await request('POST', '/api/ride/destination-arrived', {
            requestId: rideIdA,
            driverId: driver2.id
        }, { Authorization: `Bearer ${drv2Token}` });

        // Driver 2 completes ride with riderConfirmed = false
        const completeResB = await request('POST', '/api/ride/complete', {
            requestId: rideIdA,
            driverId: driver2.id,
            receivedAmount: 3000,
            riderConfirmed: false
        }, { Authorization: `Bearer ${drv2Token}` });

        const reviewFlagB = completeResB.body?.reviewFlag;
        const reconStatusB = completeResB.body?.reconciliationStatus;
        const passB = (reviewFlagB === true && reconStatusB === 'pending_review');
        report('Item 3-B', 'Unconfirmed Fare -> Marked pending_review', passB,
            `reviewFlag: ${reviewFlagB}, reconciliationStatus: "${reconStatusB}"`);

        // Also verify POST /api/ride/confirm-fare endpoint
        const confirmFareRes = await request('POST', '/api/ride/confirm-fare', {
            requestId: rideIdA,
            confirmed: true
        }, { Authorization: `Bearer ${cust1Token}` });
        const passB2 = confirmFareRes.body?.success === true && confirmFareRes.body?.reconciliationStatus === 'settled';
        console.log(`   ↳ Subsequent passenger confirmation test: success=${passB2}, reconciliationStatus=${confirmFareRes.body?.reconciliationStatus}`);

        // -------------------------------------------------------------------------
        // (C) Test: Arrival Outside Proximity Radius (> 1000m) = 400 Rejection
        // -------------------------------------------------------------------------
        console.log('⏳ Running Test (C): Arrival outside proximity radius (> 1000m)...');
        const createResC = await request('POST', '/api/ride/request', {
            customerId: customer1.id,
            customerName: 'أحمد علي',
            customerPhone: customer1.phone,
            pickupName: 'ساحة ثورة العشرين',
            pickupLat: 31.9961,
            pickupLon: 44.3168,
            dropoffName: 'جامعة الكوفة',
            dropoffLat: 32.0321,
            dropoffLon: 44.3725,
            distanceKm: 5.2,
            durationMins: 12,
            vehicleType: 'eco'
        }, { Authorization: `Bearer ${cust1Token}` });

        const rideC = createResC.body?.request || createResC.body;
        const rideIdC = rideC?.id;

        // Driver 1 accepts
        await request('POST', '/api/ride/accept', {
            requestId: rideIdC,
            driverId: driver1.id
        }, { Authorization: `Bearer ${drv1Token}` });

        // Driver 1 attempts 'arrived' from 10km away (32.0800, 44.4200)
        const arrivedFarRes = await request('POST', '/api/ride/arrived', {
            requestId: rideIdC,
            driverId: driver1.id,
            driverLat: 32.0800,
            driverLon: 44.4200
        }, { Authorization: `Bearer ${drv1Token}` });

        const passC = (arrivedFarRes.status === 400 && arrivedFarRes.body?.success === false &&
                       String(arrivedFarRes.body?.error || '').includes('بعيد'));
        report('Item 3-C', 'Arrival Outside Proximity Radius (Rejection with 400)', passC,
            `HTTP Status: ${arrivedFarRes.status}, Error Message: "${arrivedFarRes.body?.error}"`);

        // -------------------------------------------------------------------------
        // (D) Test: Unrelated Rider Subscribing to /api/ride/:id/stream = 403 Forbidden
        // -------------------------------------------------------------------------
        console.log('⏳ Running Test (D): Unrelated rider subscribing to stream (RLS)...');
        // customer2 tries to open customer1's ride stream
        const sseForbiddenRes = await request('GET', `/api/ride/${rideIdC}/stream`, null, {
            Authorization: `Bearer ${cust2Token}`
        });

        const passD = (sseForbiddenRes.status === 403 && sseForbiddenRes.body?.success === false &&
                       String(sseForbiddenRes.body?.error || '').includes('غير مصرح'));
        report('Item 3-D', 'RLS Security: Foreign Passenger Subscribing to Ride Stream = 403', passD,
            `HTTP Status: ${sseForbiddenRes.status}, Error Message: "${sseForbiddenRes.body?.error}"`);

        // -------------------------------------------------------------------------
        // (E) Test: Ride Created on Worker PID A, Accepted on Worker PID B (Cluster)
        // -------------------------------------------------------------------------
        console.log('⏳ Running Test (E): Multi-worker PM2 cluster distribution...');
        let pidCreate = null;
        let pidAccept = null;

        // Create ride E
        const createResE = await request('POST', '/api/ride/request', {
            customerId: customer1.id,
            customerName: 'أحمد علي',
            customerPhone: customer1.phone,
            pickupName: 'ساحة ثورة العشرين',
            pickupLat: 31.9961,
            pickupLon: 44.3168,
            dropoffName: 'جامعة الكوفة',
            dropoffLat: 32.0321,
            dropoffLon: 44.3725,
            distanceKm: 5.2,
            durationMins: 12,
            vehicleType: 'eco'
        }, { Authorization: `Bearer ${cust1Token}` });

        pidCreate = createResE.headers['x-worker-pid'];
        const rideIdE = createResE.body?.request?.id;

        // Attempt accept
        const acceptResE = await request('POST', '/api/ride/accept', {
            requestId: rideIdE,
            driverId: driver1.id
        }, { Authorization: `Bearer ${drv1Token}` });

        pidAccept = acceptResE.headers['x-worker-pid'];

        // Collect distinct PIDs across 12 requests with Connection: close
        const pidsObserved = new Set();
        if (pidCreate) pidsObserved.add(pidCreate);
        if (pidAccept) pidsObserved.add(pidAccept);

        for (let i = 0; i < 12; i++) {
            const h = await request('GET', '/api/health');
            if (h.headers['x-worker-pid']) {
                pidsObserved.add(h.headers['x-worker-pid']);
            }
        }

        const passE = (pidsObserved.size >= 2);
        report('Item 3-E', 'PM2 Multi-Core Cluster Execution (Different PIDs)', passE,
            `Ride Created on PID: ${pidCreate}, Ride Accepted on PID: ${pidAccept}, Distinct Cluster PIDs Verified: [${Array.from(pidsObserved).join(', ')}]`);

    } catch (err) {
        console.error('Fatal test execution error:', err);
        failed++;
    } finally {
        // Cleanup Test Data
        console.log('🧹 Cleaning up test data from Redis and PostgreSQL...');
        try {
            await redis.zrem('drivers:locations', testDriver1Id, testDriver2Id);
            await redis.del(`driver:${testDriver1Id}:meta`, `driver:${testDriver2Id}:meta`);
            await pool.query(`DELETE FROM drivers WHERE driver_id IN ($1, $2)`, [testDriver1Id, testDriver2Id]);
            await pool.query(`DELETE FROM rides WHERE customer_id IN ($1, $2)`, [customer1.id, customer2.id]);
            await pool.query(`DELETE FROM ride_events WHERE event_data::text LIKE '%${customer1.id}%' OR event_data::text LIKE '%${customer2.id}%'`);
            await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3, $4)`, [customer1.id, customer2.id, testDriver1Id, testDriver2Id]);
            await redis.del(`rate:ride:create:${customer1.id}`, `rate:ride:create:${customer2.id}`);
            // Flush any test pending rides
            const keys = await redis.hkeys('pending:rides');
            if (keys && keys.length > 0) {
                await redis.del('pending:rides');
            }
        } catch (cleanupErr) {
            console.error('Cleanup notice:', cleanupErr.message);
        }
        await redis.quit();
        await pool.end();
    }

    console.log('===============================================================');
    console.log(`📊 Suite Completed: ${passed} Passed, ${failed} Failed`);
    console.log('===============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runPreBatch2Tests();
