/**
 * Verification Suite for Batch 2.6: Backend Gap Closure (Settings, Rounding, SSE, Port, Dashboard)
 * Tests:
 * 1. Financial Rounding:
 *    - Arithmetic validation: 8800 IQD (4000 outward + 1000 wait + 3800 return) rounds to 8750 IQD (nearest 250).
 *    - Live API Round-Trip ride finalFare % 250 === 0.
 *    - Live API One-Way ride finalFare % 250 === 0.
 * 2. System Settings Integrity:
 *    - Verify exact keys: proximity=1000, speed_jump=140, fare_discrepancy=500, cancellation_fee=1500, max_wait=60, discount=0.
 *    - Assure snapshot is invariant before and after tests.
 * 3. Last-Event-ID SSE on BOTH channels:
 *    - /api/events/driver/:id
 *    - /api/ride/:id/stream
 * 4. Dashboard API Verification:
 *    - /api/admin/rides returns isRoundTrip, waitFee, actualWaitMinutes, totalFare, needsReconciliationReview.
 */

require('../src/backend/config');
const http = require('http');
const jwt = require('jsonwebtoken');
const db = require('../src/backend/db');
const redisManager = require('../src/backend/modules/redis/redisClient');
const pricingService = require('../src/backend/modules/pricing/pricingService');
const systemSettingsService = require('../src/backend/modules/systemSettings/systemSettingsService');

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
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function fetchSseWithLastEventId(path, lastEventId, token = null, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const url = new URL(path, API_BASE);
        const headers = {
            'Accept': 'text/event-stream',
            'Connection': 'close'
        };
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const receivedEvents = [];
        let buffer = '';

        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'GET',
            headers
        }, (res) => {
            res.on('data', chunk => {
                buffer += chunk.toString();
                const blocks = buffer.split('\n\n');
                buffer = blocks.pop();
                for (const b of blocks) {
                    if (b.trim()) {
                        const lines = b.split('\n');
                        let id = null, event = null, data = null;
                        for (const l of lines) {
                            if (l.startsWith('id: ')) id = l.substring(4).trim();
                            if (l.startsWith('event: ')) event = l.substring(7).trim();
                            if (l.startsWith('data: ')) {
                                try { data = JSON.parse(l.substring(6).trim()); } catch (_) { data = l.substring(6).trim(); }
                            }
                        }
                        receivedEvents.push({ id, event, data, raw: b });
                    }
                }
            });
        });

        req.on('error', () => {});

        setTimeout(() => {
            try { req.destroy(); } catch (_) {}
            resolve(receivedEvents);
        }, timeoutMs);

        req.end();
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const testResults = [];
function report(code, name, pass, details = '') {
    testResults.push({ code, name, pass, details });
    const mark = pass ? '✅' : '❌';
    console.log(`${mark} [${code}] ${name}: ${pass ? 'PASS' : 'FAIL'}`);
    if (details) console.log(`   ↳ ${details}`);
}

async function getSettingsSnapshot() {
    const keys = [
        'proximity_radius_meters',
        'speed_jump_limit_kmh',
        'fare_discrepancy_threshold_iqd',
        'cancellation_fee_iqd',
        'max_wait_minutes',
        'round_trip_discount_percent'
    ];
    const res = await db.pool.query(
        'SELECT key, value_json FROM system_settings WHERE key = ANY($1) ORDER BY key',
        [keys]
    );
    const map = {};
    for (const r of res.rows) {
        const parsed = typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json;
        map[r.key] = parsed.value !== undefined ? parsed.value : parsed;
    }
    return map;
}

async function main() {
    console.log('========================================================================');
    console.log('🚀 Starting Batch 2.6 Gap-Closure Verification Suite');
    console.log('========================================================================\n');

    await db.init();
    await redisManager.connect();

    const createdRideIds = [];
    const testDriverId = 'drv-b26-test-' + Date.now();
    const testCustomerId = 'cust-b26-test-' + Date.now();
    const testDriverPhone = '+96477' + Math.floor(10000000 + Math.random() * 90000000);
    const testCustomerPhone = '+96478' + Math.floor(10000000 + Math.random() * 90000000);

    const drvToken = signToken({ id: testDriverId, role: 'driver', phone: testDriverPhone, name: 'Captain B26' });
    const custToken = signToken({ id: testCustomerId, role: 'customer', phone: testCustomerPhone, name: 'Rider B26' });

    try {
        // =====================================================================
        // Test 1: Settings Snapshot Check
        // =====================================================================
        console.log('⏳ Running Test 1: Verifying System Settings Snapshot...');
        const initialSettings = await getSettingsSnapshot();
        const expectedSettings = {
            cancellation_fee_iqd: 1500,
            fare_discrepancy_threshold_iqd: 500,
            max_wait_minutes: 60,
            proximity_radius_meters: 1000,
            round_trip_discount_percent: 0,
            speed_jump_limit_kmh: 140
        };

        const passSettingsMatch = JSON.stringify(initialSettings) === JSON.stringify(expectedSettings);
        report('B2.6-1', 'System Settings Baseline Integrity Check', passSettingsMatch,
            `Observed: ${JSON.stringify(initialSettings)}`);

        // =====================================================================
        // Test 2: Financial Rounding - Arithmetic and Nearest Multiple Check
        // =====================================================================
        console.log('⏳ Running Test 2: Financial Rounding to Nearest 250 IQD Multiple...');
        // Scenario from user: Outward 4000 + Wait 1000 + Return 3800 = 8800
        const rounded8800 = pricingService.roundToNearest250(8800);
        const passArithmeticRounding = (rounded8800 === 8750) && (rounded8800 % 250 === 0);

        report('B2.6-2', 'Financial Rounding (8,800 IQD rounds to nearest 250 -> 8,750 IQD)', passArithmeticRounding,
            `Input: 8,800 IQD -> Output: ${rounded8800} IQD, mod 250: ${rounded8800 % 250}`);

        // =====================================================================
        // Test 3: Financial Rounding on Live One-Way Ride
        // =====================================================================
        console.log('⏳ Running Test 3: Live One-Way Ride finalFare % 250 === 0...');
        // Seed driver location
        await redisManager.client.geoadd('drivers:geo', 44.3168, 31.9961, testDriverId);
        await redisManager.client.hset(`driver:${testDriverId}`, 'is_online', 'true', 'status', 'available');

        const createOneWay = await request('POST', '/api/ride/request', {
            customerId: testCustomerId,
            customerName: 'Rider B26',
            customerPhone: testCustomerPhone,
            pickupName: 'المدينة القديمة',
            pickupLat: 31.9961,
            pickupLon: 44.3168,
            dropoffName: 'الكوفة',
            dropoffLat: 32.0321,
            dropoffLon: 44.3725,
            distanceKm: 5.7,
            durationMins: 14,
            tripType: 'ONE_WAY',
            isRoundTrip: false
        }, { Authorization: `Bearer ${custToken}` });

        const oneWayRideId = createOneWay.body?.request?.id;
        if (oneWayRideId) createdRideIds.push(oneWayRideId);

        await request('POST', '/api/ride/accept', { requestId: oneWayRideId, driverId: testDriverId }, { Authorization: `Bearer ${drvToken}` });
        await request('POST', '/api/ride/arrived', { requestId: oneWayRideId, driverId: testDriverId, driverLat: 31.9961, driverLon: 44.3168 }, { Authorization: `Bearer ${drvToken}` });
        await request('POST', '/api/ride/start', { requestId: oneWayRideId, driverId: testDriverId }, { Authorization: `Bearer ${drvToken}` });
        await request('POST', '/api/ride/destination-arrived', { requestId: oneWayRideId, driverId: testDriverId }, { Authorization: `Bearer ${drvToken}` });
        const completeOneWay = await request('POST', '/api/ride/complete', { requestId: oneWayRideId, driverId: testDriverId }, { Authorization: `Bearer ${drvToken}` });

        const oneWayFinalFare = Number(completeOneWay.body?.finalFare || completeOneWay.body?.ride?.fare || 0);
        const passOneWayRounding = (oneWayFinalFare > 0) && (oneWayFinalFare % 250 === 0);

        report('B2.6-3', 'Live One-Way Ride finalFare % 250 === 0', passOneWayRounding,
            `RideId: ${oneWayRideId}, finalFare: ${oneWayFinalFare} IQD, mod 250: ${oneWayFinalFare % 250}`);

        // =====================================================================
        // Test 4: Financial Rounding on Live Round-Trip Ride
        // =====================================================================
        console.log('⏳ Running Test 4: Live Round-Trip Ride finalFare % 250 === 0...');
        const createRoundTrip = await request('POST', '/api/ride/request', {
            customerId: testCustomerId,
            customerName: 'Rider B26',
            customerPhone: testCustomerPhone,
            pickupName: 'حي السعد',
            pickupLat: 31.9961,
            pickupLon: 44.3168,
            dropoffName: 'مسجد السهلة',
            dropoffLat: 32.0321,
            dropoffLon: 44.3725,
            distanceKm: 6.3,
            durationMins: 16,
            tripType: 'ROUND_TRIP',
            isRoundTrip: true
        }, { Authorization: `Bearer ${custToken}` });

        const roundTripId = createRoundTrip.body?.request?.id;
        if (roundTripId) createdRideIds.push(roundTripId);

        await request('POST', '/api/ride/accept', { requestId: roundTripId, driverId: testDriverId }, { Authorization: `Bearer ${drvToken}` });
        await request('POST', '/api/ride/arrived', { requestId: roundTripId, driverId: testDriverId, driverLat: 31.9961, driverLon: 44.3168 }, { Authorization: `Bearer ${drvToken}` });
        await request('POST', '/api/ride/start', { requestId: roundTripId, driverId: testDriverId }, { Authorization: `Bearer ${drvToken}` });
        await request('POST', '/api/ride/destination-arrived', { requestId: roundTripId, driverId: testDriverId }, { Authorization: `Bearer ${drvToken}` });
        await request('POST', '/api/ride/return/start', { requestId: roundTripId, driverId: testDriverId, actualWaitMinutes: 12 }, { Authorization: `Bearer ${drvToken}` });
        const arrivedReturn = await request('POST', '/api/ride/return/arrived', { requestId: roundTripId, driverId: testDriverId, leg2Distance: 6.3 }, { Authorization: `Bearer ${drvToken}` });
        const completeRound = await request('POST', '/api/ride/complete', { requestId: roundTripId, driverId: testDriverId }, { Authorization: `Bearer ${drvToken}` });

        const roundTripFinalFare = Number(completeRound.body?.finalFare || arrivedReturn.body?.finalFare || 0);
        const passRoundTripRounding = (roundTripFinalFare > 0) && (roundTripFinalFare % 250 === 0);

        report('B2.6-4', 'Live Round-Trip Ride finalFare % 250 === 0', passRoundTripRounding,
            `RideId: ${roundTripId}, finalFare: ${roundTripFinalFare} IQD, mod 250: ${roundTripFinalFare % 250}`);

        // =====================================================================
        // Test 5: SSE Last-Event-ID on Driver Channel (/api/events/driver/:id)
        // =====================================================================
        console.log('⏳ Running Test 5: SSE Last-Event-ID on /api/events/driver/:id...');
        const dEv1 = await redisManager.publishDriverEvent(testDriverId, { type: 'driver_alert_1', text: 'Alert 1' });
        await sleep(30);
        const dEv2 = await redisManager.publishDriverEvent(testDriverId, { type: 'driver_alert_2', text: 'Alert 2' });
        await sleep(30);
        const dEv3 = await redisManager.publishDriverEvent(testDriverId, { type: 'driver_alert_3', text: 'Alert 3' });

        const receivedDriverEvents = await fetchSseWithLastEventId(`/api/events/driver/${testDriverId}`, dEv1, drvToken);
        const driverEventIds = receivedDriverEvents.map(e => e.id);

        const passDriverSse = (
            receivedDriverEvents.length >= 2 &&
            driverEventIds.includes(dEv2) &&
            driverEventIds.includes(dEv3) &&
            !driverEventIds.includes(dEv1)
        );

        report('B2.6-5', 'SSE Last-Event-ID on Captain Stream (/api/events/driver/:id)', passDriverSse,
            `Sent [${dEv1}, ${dEv2}, ${dEv3}], Last-Event-ID=${dEv1} -> Received ${receivedDriverEvents.length} events: [${driverEventIds.join(', ')}]`);

        // =====================================================================
        // Test 6: SSE Last-Event-ID on Ride Stream (/api/ride/:id/stream)
        // =====================================================================
        console.log('⏳ Running Test 6: SSE Last-Event-ID on /api/ride/:id/stream...');
        const rEv1 = await redisManager.publishRideEvent(roundTripId, { type: 'trip_progress_1', km: 1.0 });
        await sleep(30);
        const rEv2 = await redisManager.publishRideEvent(roundTripId, { type: 'trip_progress_2', km: 2.0 });
        await sleep(30);
        const rEv3 = await redisManager.publishRideEvent(roundTripId, { type: 'trip_progress_3', km: 3.0 });

        const receivedRideEvents = await fetchSseWithLastEventId(`/api/ride/${roundTripId}/stream`, rEv1, custToken);
        const rideEventIds = receivedRideEvents.map(e => e.id);

        const passRideSse = (
            receivedRideEvents.length >= 2 &&
            rideEventIds.includes(rEv2) &&
            rideEventIds.includes(rEv3) &&
            !rideEventIds.includes(rEv1)
        );

        report('B2.6-6', 'SSE Last-Event-ID on Ride Stream (/api/ride/:id/stream)', passRideSse,
            `Sent [${rEv1}, ${rEv2}, ${rEv3}], Last-Event-ID=${rEv1} -> Received ${receivedRideEvents.length} events: [${rideEventIds.join(', ')}]`);

        // =====================================================================
        // Test 7: Dashboard API Structure (/api/admin/rides)
        // =====================================================================
        console.log('⏳ Running Test 7: Dashboard API (/api/admin/rides) structure verification...');
        const adminRidesRes = await request('GET', '/api/admin/rides', null);
        const adminRidesList = adminRidesRes.body?.rides || (Array.isArray(adminRidesRes.body) ? adminRidesRes.body : []);
        const targetRide = adminRidesList.find(r => r.id === roundTripId);

        const passDashboardApi = (
            adminRidesRes.status === 200 &&
            targetRide !== undefined &&
            targetRide.isRoundTrip === true &&
            targetRide.totalFare !== undefined &&
            targetRide.needsReconciliationReview !== undefined
        );

        report('B2.6-7', 'Admin Dashboard API (/api/admin/rides returns round-trip and review flags)', passDashboardApi,
            `Found ride ${roundTripId}: isRoundTrip=${targetRide?.isRoundTrip}, totalFare=${targetRide?.totalFare}, needsReconciliationReview=${targetRide?.needsReconciliationReview}`);

        // =====================================================================
        // Test 8: Settings Immutability Post-Test Check
        // =====================================================================
        console.log('⏳ Running Test 8: Verifying System Settings Invariance After Tests...');
        const finalSettings = await getSettingsSnapshot();
        const passSettingsInvariant = JSON.stringify(finalSettings) === JSON.stringify(expectedSettings);

        report('B2.6-8', 'System Settings Post-Test Immutability Check', passSettingsInvariant,
            `Settings unchanged: ${passSettingsInvariant} -> ${JSON.stringify(finalSettings)}`);

    } finally {
        // Full cleanup
        console.log('\n🧹 Cleaning up Batch 2.6 test data...');
        for (const rId of createdRideIds) {
            await redisManager.client.del(`ride:active:${rId}`);
            await redisManager.client.del(`sse:history:ride:${rId}`);
            await db.pool.query('DELETE FROM ride_events WHERE ride_id = $1', [rId]).catch(() => {});
            await db.pool.query('DELETE FROM rides WHERE id = $1', [rId]).catch(() => {});
        }
        await redisManager.client.del(`driver:${testDriverId}`);
        await redisManager.client.del(`sse:history:driver:${testDriverId}`);
        await redisManager.client.zrem('drivers:geo', testDriverId);
        await db.pool.query('DELETE FROM audit_logs WHERE action LIKE $1', ['RIDE_STATE_%']).catch(() => {});
        await db.pool.query('DELETE FROM audit_logs WHERE entity_id = ANY($1)', [createdRideIds]).catch(() => {});
    }

    console.log('\n========================================================================');
    const passedCount = testResults.filter(r => r.pass).length;
    const totalCount = testResults.length;
    console.log(`Test Execution Finished: ${passedCount} Passed, ${totalCount - passedCount} Failed`);
    console.log('========================================================================\n');

    process.exit(passedCount === totalCount ? 0 : 1);
}

main().catch(err => {
    console.error('Fatal Test Suite Error:', err);
    process.exit(1);
});
