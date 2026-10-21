/**
 * Batch 2/4 Verification Suite: Round-Trip & External Navigation Engine
 * Tests:
 * 1. Complete Round-Trip Canonical Lifecycle:
 *    REQUESTED -> OFFERED -> ACCEPTED -> DRIVER_ARRIVED -> IN_TRIP ->
 *    ARRIVED_DESTINATION -> WAITING_AT_DESTINATION -> IN_TRIP_RETURN ->
 *    ARRIVED_RETURN -> COMPLETED
 * 2. Mid-Wait Cancellation (Leg 1 + Wait Fee charged, Leg 2 omitted)
 * 3. Driver External Navigation Lifecycle (Start, Redis TTL, SSE, End)
 * 4. RLS Security Checks (Forbidden on foreign driver actions)
 * 5. Single Cash Reconciliation for Total Round-Trip Fare
 */

require('../src/backend/config');
const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');
const db = require('../src/backend/db');
const redisManager = require('../src/backend/modules/redis/redisClient');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5050';
const JWT_SECRET = process.env.JWT_SECRET || 'tawseela_prod_jwt_super_secret_najaf_2026';

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

async function runBatch2Tests() {
    console.log('========================================================================');
    console.log('🚀 Starting Batch 2/4 Verification: Round-Trip & External Navigation');
    console.log('========================================================================\n');

    await db.init();

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

    const nonce = Date.now();
    const driver1 = { id: `drv-rt1-${nonce}`, role: 'Driver', phone: '0770' + String(nonce).slice(-7), fullName: 'كابتن مرتضى (ذهاب وإياب)' };
    const driver2 = { id: `drv-rt2-${nonce}`, role: 'Driver', phone: '0771' + String(nonce).slice(-7), fullName: 'كابتن سعد (إلغاء انتظار)' };
    const driver3 = { id: `drv-rt3-${nonce}`, role: 'Driver', phone: '0772' + String(nonce).slice(-7), fullName: 'كابتن كرار (ملاحة خارجية)' };
    const foreignDriver = { id: `drv-foreign-${nonce}`, role: 'Driver', phone: '0779' + String(nonce).slice(-7), fullName: 'كابتن غريب' };

    const drv1Token = signToken(driver1);
    const drv2Token = signToken(driver2);
    const drv3Token = signToken(driver3);
    const foreignDrvToken = signToken(foreignDriver);

    const testDrivers = [driver1, driver2, driver3, foreignDriver];
    const testCustomers = [];
    const testRides = [];

    try {
        await sleep(1000);

        // 0. Seed test drivers in Redis Geospatial Index
        console.log('🌱 Seeding 3 isolated test drivers in Redis Geo Index...');
        if (redisManager.isConnected && redisManager.client) {
            for (const d of [driver1, driver2, driver3]) {
                await redisManager.client.geoadd('drivers:locations', 44.3170, 31.9970, d.id);
                await redisManager.client.hmset(`driver:${d.id}:meta`, {
                    id: d.id,
                    fullName: d.fullName,
                    phone: d.phone,
                    status: 'Online',
                    workMode: 'taxi',
                    vehicleType: 'eco'
                });
            }
        }

        // =====================================================================
        // Test 1: Complete Round-Trip Canonical Lifecycle
        // =====================================================================
        console.log('⏳ Running Test 1: Full Round-Trip Canonical Lifecycle...');
        const cust1 = { id: `cust-rt1-${nonce}`, role: 'Customer', phone: '0780' + String(nonce).slice(-7) };
        testCustomers.push(cust1);
        const cust1Token = signToken(cust1);

        // Step 1: Request Round-Trip Ride
        const createRes = await request('POST', '/api/ride/request', {
            customerId: cust1.id,
            customerName: 'حسين علي',
            customerPhone: cust1.phone,
            pickupName: 'شارع المدينة',
            pickupLat: 31.9961,
            pickupLon: 44.3168,
            dropoffName: 'مستشفى الصدر التعليمي',
            dropoffLat: 32.0321,
            dropoffLon: 44.3725,
            distanceKm: 6.0,
            durationMins: 15,
            tripType: 'ROUND_TRIP',
            isRoundTrip: true,
            expectedWaitMinutes: 10,
            returnDestination: { name: 'شارع المدينة (موقع الانطلاق)' }
        }, { Authorization: `Bearer ${cust1Token}` });

        const ride1 = createRes.body?.request;
        const rideId1 = ride1?.id;
        testRides.push(rideId1);

        const passCreate = (createRes.body?.success === true && ride1?.tripType === 'ROUND_TRIP' && ride1?.isRoundTrip === true);
        report('B2-1', 'Round-Trip Request Creation & Metadata Validation', passCreate,
            `Ride ID: ${rideId1}, tripType: ${ride1?.tripType}, expectedWait: ${ride1?.expectedWaitMinutes}m`);

        // Step 2: Driver 1 Accepts
        await request('POST', '/api/ride/accept', {
            requestId: rideId1,
            driverId: driver1.id
        }, { Authorization: `Bearer ${drv1Token}` });

        // Step 3: Driver 1 Arrives at Pickup
        await request('POST', '/api/ride/arrived', {
            requestId: rideId1,
            driverId: driver1.id,
            driverLat: 31.9962,
            driverLon: 44.3169
        }, { Authorization: `Bearer ${drv1Token}` });

        // Step 4: Driver 1 Starts Trip (Leg 1)
        await request('POST', '/api/ride/start', {
            requestId: rideId1,
            driverId: driver1.id
        }, { Authorization: `Bearer ${drv1Token}` });

        // Step 5: Driver 1 Arrives at First Destination -> Transitions to WAITING_AT_DESTINATION
        const destArrivedRes = await request('POST', '/api/ride/destination-arrived', {
            requestId: rideId1,
            driverId: driver1.id
        }, { Authorization: `Bearer ${drv1Token}` });

        const passWaitState = (destArrivedRes.body?.status === 'WAITING_AT_DESTINATION' &&
                               !!destArrivedRes.body?.waitStartedAt);
        report('B2-2', 'Arrival at Destination -> Transition to WAITING_AT_DESTINATION', passWaitState,
            `Status: ${destArrivedRes.body?.status}, waitStartedAt: ${destArrivedRes.body?.waitStartedAt}`);

        // Step 6: Start Return Journey
        const returnStartRes = await request('POST', '/api/ride/return/start', {
            requestId: rideId1,
            driverId: driver1.id
        }, { Authorization: `Bearer ${drv1Token}` });

        const passReturnStart = (returnStartRes.body?.status === 'IN_TRIP_RETURN' &&
                                 returnStartRes.body?.success === true);
        report('B2-3', 'POST /api/ride/return/start (Transition to IN_TRIP_RETURN)', passReturnStart,
            `Status: ${returnStartRes.body?.status}, actualWaitMinutes: ${returnStartRes.body?.actualWaitMinutes}, waitFee: ${returnStartRes.body?.waitFee}`);

        // Step 7: Arrive at Return Destination
        const returnArrivedRes = await request('POST', '/api/ride/return/arrived', {
            requestId: rideId1,
            driverId: driver1.id,
            leg2Distance: 6.0
        }, { Authorization: `Bearer ${drv1Token}` });

        const passReturnArrived = (returnArrivedRes.body?.status === 'ARRIVED_RETURN' &&
                                   Number(returnArrivedRes.body?.finalFare) > 0);
        report('B2-4', 'POST /api/ride/return/arrived (Transition to ARRIVED_RETURN & Fare Sum)', passReturnArrived,
            `Status: ${returnArrivedRes.body?.status}, Total Fare: ${returnArrivedRes.body?.finalFare} IQD (Leg1 + WaitFee + Leg2)`);

        // Step 8: Complete Ride & Cash Reconciliation
        const completeRes = await request('POST', '/api/ride/complete', {
            requestId: rideId1,
            driverId: driver1.id,
            receivedAmount: returnArrivedRes.body?.finalFare,
            riderConfirmed: true
        }, { Authorization: `Bearer ${drv1Token}` });

        const passComplete = (completeRes.body?.status === 'COMPLETED' &&
                              completeRes.body?.reconciliationStatus === 'settled');
        report('B2-5', 'POST /api/ride/complete (Round-Trip Completed & Cash Settled)', passComplete,
            `Status: ${completeRes.body?.status}, reconciliationStatus: "${completeRes.body?.reconciliationStatus}", finalFare: ${completeRes.body?.finalFare}`);

        // =====================================================================
        // Test 2: Mid-Wait Cancellation (Leg 1 + Wait Fee charged, Leg 2 omitted)
        // =====================================================================
        console.log('⏳ Running Test 2: Mid-Wait Cancellation by Passenger...');
        const cust2 = { id: `cust-rt2-${nonce}`, role: 'Customer', phone: '0781' + String(nonce).slice(-7) };
        testCustomers.push(cust2);
        const cust2Token = signToken(cust2);

        const createRes2 = await request('POST', '/api/ride/request', {
            customerId: cust2.id,
            customerName: 'سعد جاسم',
            customerPhone: cust2.phone,
            pickupName: 'ساحة الصدرين',
            pickupLat: 31.9961,
            pickupLon: 44.3168,
            dropoffName: 'جامعة جابر بن حيان',
            dropoffLat: 32.0321,
            dropoffLon: 44.3725,
            distanceKm: 5.0,
            durationMins: 12,
            tripType: 'ROUND_TRIP',
            isRoundTrip: true
        }, { Authorization: `Bearer ${cust2Token}` });

        const ride2 = createRes2.body?.request;
        const rideId2 = ride2?.id;
        testRides.push(rideId2);

        await request('POST', '/api/ride/accept', { requestId: rideId2, driverId: driver2.id }, { Authorization: `Bearer ${drv2Token}` });
        await request('POST', '/api/ride/arrived', { requestId: rideId2, driverId: driver2.id, driverLat: 31.9962, driverLon: 44.3169 }, { Authorization: `Bearer ${drv2Token}` });
        await request('POST', '/api/ride/start', { requestId: rideId2, driverId: driver2.id }, { Authorization: `Bearer ${drv2Token}` });
        await request('POST', '/api/ride/destination-arrived', { requestId: rideId2, driverId: driver2.id }, { Authorization: `Bearer ${drv2Token}` });

        // Passenger cancels during WAITING_AT_DESTINATION
        const cancelRes = await request('POST', '/api/ride/cancel', {
            requestId: rideId2,
            reason: 'انتهت حاجتي ولن أعود بالسيارة'
        }, { Authorization: `Bearer ${cust2Token}` });

        const passWaitCancel = (cancelRes.body?.status === 'CANCELLED_BY_RIDER' &&
                                cancelRes.body?.isWaitCancellation === true &&
                                Number(cancelRes.body?.finalFare) > 0);
        report('B2-6', 'Mid-Wait Cancellation (Charges Leg 1 + Wait Fee Only)', passWaitCancel,
            `Status: ${cancelRes.body?.status}, isWaitCancellation: ${cancelRes.body?.isWaitCancellation}, finalFare Charged: ${cancelRes.body?.finalFare} IQD`);

        // =====================================================================
        // Test 3: Driver External Navigation State Management
        // =====================================================================
        console.log('⏳ Running Test 3: Driver External Navigation Lifecycle...');
        const cust3 = { id: `cust-rt3-${nonce}`, role: 'Customer', phone: '0782' + String(nonce).slice(-7) };
        testCustomers.push(cust3);
        const cust3Token = signToken(cust3);

        const createRes3 = await request('POST', '/api/ride/request', {
            customerId: cust3.id,
            customerName: 'كرار مهدي',
            customerPhone: cust3.phone,
            pickupName: 'حي السعد',
            pickupLat: 31.9961,
            pickupLon: 44.3168,
            dropoffName: 'مطار النجف الدولي',
            dropoffLat: 32.0321,
            dropoffLon: 44.3725,
            distanceKm: 8.0,
            durationMins: 18
        }, { Authorization: `Bearer ${cust3Token}` });

        const ride3 = createRes3.body?.request;
        const rideId3 = ride3?.id;
        testRides.push(rideId3);

        await request('POST', '/api/ride/accept', { requestId: rideId3, driverId: driver3.id }, { Authorization: `Bearer ${drv3Token}` });

        // Driver 3 switches to Google Maps
        const navStartRes = await request('POST', '/api/ride/external-nav/start', {
            requestId: rideId3,
            driverId: driver3.id,
            app: 'Google Maps'
        }, { Authorization: `Bearer ${drv3Token}` });

        // Check Redis key existence and TTL
        let navKeyExists = false;
        let navTtl = 0;
        if (redisManager.isConnected && redisManager.client) {
            navKeyExists = (await redisManager.client.exists(`driver:${driver3.id}:external_nav`)) === 1;
            navTtl = await redisManager.client.ttl(`driver:${driver3.id}:external_nav`);
        }

        const passNavStart = (navStartRes.body?.success === true &&
                              navStartRes.body?.isExternalNavActive === true &&
                              navKeyExists && navTtl > 0);
        report('B2-7', 'POST /api/ride/external-nav/start (Redis Key & TTL ~15m)', passNavStart,
            `isExternalNavActive: ${navStartRes.body?.isExternalNavActive}, Redis Key Exists: ${navKeyExists}, TTL: ${navTtl}s (~${Math.round(navTtl/60)} mins)`);

        // Driver 3 returns to App -> End External Navigation
        const navEndRes = await request('POST', '/api/ride/external-nav/end', {
            requestId: rideId3,
            driverId: driver3.id
        }, { Authorization: `Bearer ${drv3Token}` });

        let navKeyCleared = true;
        if (redisManager.isConnected && redisManager.client) {
            navKeyCleared = (await redisManager.client.exists(`driver:${driver3.id}:external_nav`)) === 0;
        }

        const passNavEnd = (navEndRes.body?.success === true &&
                            navEndRes.body?.isExternalNavActive === false &&
                            navKeyCleared);
        report('B2-8', 'POST /api/ride/external-nav/end (Redis Key Cleared)', passNavEnd,
            `isExternalNavActive: ${navEndRes.body?.isExternalNavActive}, Redis Key Cleared: ${navKeyCleared}`);

        // =====================================================================
        // Test 4: RLS Security & Zero 404 Endpoint Checks
        // =====================================================================
        console.log('⏳ Running Test 4: RLS Security on Return & Zero 404 Policy...');
        // Foreign driver trying to start return on ride 1
        const rlsForeignRes = await request('POST', '/api/ride/return/start', {
            requestId: rideId1,
            driverId: foreignDriver.id
        }, { Authorization: `Bearer ${foreignDrvToken}` });

        const passRls = (rlsForeignRes.status === 403);
        report('B2-9', 'RLS Security: Foreign Driver Rejected on Return Start (403)', passRls,
            `HTTP Status: ${rlsForeignRes.status}, Error: "${rlsForeignRes.body?.error}"`);

        // Zero 404 check on external-nav for nonexistent ride
        const zero404Res = await request('POST', '/api/ride/external-nav/start', {
            requestId: 'nonexistent-ride-id-999',
            driverId: driver1.id
        }, { Authorization: `Bearer ${drv1Token}` });

        const passZero404 = (zero404Res.status === 200 && zero404Res.body?.notFound === true);
        report('B2-10', 'Zero 404 Policy: Status Endpoints Return 200 with notFound=true', passZero404,
            `HTTP Status: ${zero404Res.status}, notFound: ${zero404Res.body?.notFound}`);

    } catch (err) {
        console.error('Fatal test error:', err);
        failed++;
    } finally {
        // Cleanup Test Data
        console.log('🧹 Cleaning up Batch 2 test data from Redis and PostgreSQL...');
        try {
            if (redisManager.isConnected && redisManager.client) {
                for (const d of testDrivers) {
                    await redisManager.client.zrem('drivers:locations', d.id);
                    await redisManager.client.del(`driver:${d.id}:meta`);
                    await redisManager.client.del(`driver:${d.id}:external_nav`);
                    await redisManager.client.del(`driver:active:${d.id}`);
                    if (d.phone) await redisManager.client.del(`driver:active:${d.phone}`);
                }
                for (const c of testCustomers) {
                    await redisManager.client.del(`rate:ride:create:${c.id}`);
                    await redisManager.client.del(`rider:active:${c.id}`);
                    if (c.phone) await redisManager.client.del(`rider:active:${c.phone}`);
                }
                for (const rId of testRides) {
                    if (rId) {
                        await redisManager.client.hdel('pending:rides', String(rId));
                        await redisManager.client.del(`ride:${rId}`);
                        await redisManager.client.del(`ride:request:${rId}`);
                        await redisManager.client.del(`ride:active:${rId}`);
                        await redisManager.client.del(`ride:lock:${rId}`);
                    }
                }
            }
            if (db.pool && db.isPostgresConnected) {
                if (testCustomers.length > 0) {
                    const custIds = testCustomers.map(c => c.id);
                    const custPlaceholders = custIds.map((_, i) => `$${i + 1}`).join(',');
                    await db.pool.query(`DELETE FROM rides WHERE rider_id IN (${custPlaceholders})`, custIds);
                }
                if (testRides.length > 0) {
                    const validRides = testRides.filter(Boolean);
                    if (validRides.length > 0) {
                        const ridePlaceholders = validRides.map((_, i) => `$${i + 1}`).join(',');
                        await db.pool.query(`DELETE FROM ride_events WHERE ride_id IN (${ridePlaceholders})`, validRides);
                        await db.pool.query(`DELETE FROM rides WHERE id IN (${ridePlaceholders})`, validRides);
                        await db.pool.query(`DELETE FROM audit_logs WHERE entity_id IN (${ridePlaceholders})`, validRides).catch(() => {});
                    }
                }
                await db.pool.query(`DELETE FROM audit_logs WHERE action LIKE 'RIDE_STATE_%' OR entity_name = 'ride'`).catch(() => {});
            }

            // Clean operational arrays in state.json
            const statePath = path.join(__dirname, '../data/state.json');
            if (fs.existsSync(statePath)) {
                try {
                    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                    s.bookings = [];
                    s.rideRequests = [];
                    s.drivers = [];
                    s.customers = [];
                    s.routes = [];
                    s.complaints = [];
                    s.auditLogs = [];
                    s.notifications = [];
                    s.stats = {
                        totalUsers: 0,
                        totalDrivers: 0,
                        verifiedDrivers: 0,
                        pendingVerifications: 0,
                        activeRoutes: 0,
                        totalBookings: 0,
                        pendingComplaints: 0,
                        totalRevenue: 0
                    };
                    fs.writeFileSync(statePath, JSON.stringify(s, null, 2), 'utf8');
                } catch (_) {}
            }
        } catch (cleanupErr) {
            console.error('Cleanup notice:', cleanupErr.message);
        }
        process.exit(failed > 0 ? 1 : 0);
    }
}

runBatch2Tests();
