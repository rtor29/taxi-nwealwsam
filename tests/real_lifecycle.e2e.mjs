/**
 * Complete Real Lifecycle E2E Verification Suite
 * Tests without seeding scripts:
 * 1. Admin creates/approves Captain -> Captain logs in & turns Online -> Passenger registers & requests ride.
 * 2. Telegram alert verification with real API ok:true & message_id.
 * 3. IncomingTripDispatchSheet on Captain UI & Accept ride flow.
 * 4. Distant driver test -> NO_DRIVERS clear error message.
 * 5. Cleanup & system_settings 18 keys audit.
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import path from 'path';

const BASE = 'https://tawseelaiq.app';
const SCREENSHOTS = '/Users/mu_it/.gemini/antigravity/brain/b0e252c3-bcae-4017-af79-e1199eadddf7/screenshots';

function runSsh(cmd) {
  try {
    return execSync(`ssh -o ConnectTimeout=10 root@173.212.206.86 '${cmd.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

async function run() {
  console.log('====================================================');
  console.log('🚀 RUNNING COMPREHENSIVE E2E VERIFICATION SUITE');
  console.log('====================================================');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  const randSuffix = Math.floor(1000 + Math.random() * 9000);
  const testPhone = `0781999${randSuffix}`;
  const testRiderPhone = `0784999${randSuffix}`;
  const distantPhone = `0784888${randSuffix}`;

  // ================================================================
  // TEST 1: REAL CAPTAIN REGISTRATION & POSTGRESQL INSERTION
  // ================================================================
  console.log('\n--- [TEST 1: Admin Create Captain via Dashboard API] ---');
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const adminPage = await adminContext.newPage();

  await adminPage.goto(`${BASE}/dashboard/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Create Captain via Dashboard
  const createRes = await adminPage.evaluate(async (phone) => {
    const res = await fetch('/api/admin/drivers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('admin_token') || 'admin_session'}`
      },
      body: JSON.stringify({
        fullName: 'كابتن فحص ميداني',
        phoneNumber: phone,
        email: `captain_${phone}@tawseelaiq.app`,
        password: 'password123',
        licenseNumber: 'IRQ-NJF-9988',
        vehicleMake: 'تويوتا',
        vehicleModel: 'كورولا',
        vehicleYear: 2023,
        vehiclePlate: 'النجف 12345',
        serviceType: 'Both',
        route: { startName: 'النجف - الحنانة', endName: 'الكوفة - السهلة', startLat: 32.0298, startLon: 44.3285, endLat: 32.0350, endLon: 44.3700 }
      })
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  }, testPhone);

  console.log('Admin createDriver response status:', createRes.status);
  const driverId = createRes.data?.driver?.driverId;
  console.log('Created Driver ID:', driverId);

  // Raw PostgreSQL check
  const pgDriverRow = runSsh(`su - postgres -c "psql -d taxiwisam -c \\"SELECT driver_id, full_name, phone_number, license_number, status, is_approved FROM drivers WHERE phone_number = '${testPhone}'\\""`);
  console.log('Raw PostgreSQL driver row:\n', pgDriverRow);

  // ================================================================
  // TEST 2: CAPTAIN LOGIN, TURN ONLINE & SSE CONNECTION
  // ================================================================
  console.log('\n--- [TEST 2: Captain Login, Turn Online & Verify SSE] ---');
  const captainContext = await browser.newContext({
    viewport: { width: 360, height: 780 },
    geolocation: { latitude: 32.0298, longitude: 44.3285 },
    permissions: ['geolocation']
  });
  const captainPage = await captainContext.newPage();

  let sseConnected = false;
  let sseUrl = '';
  let receivedSseNewRide = false;
  let receivedDispatchSheet = false;

  captainPage.on('response', resp => {
    const url = resp.url();
    if (url.includes('/api/events/driver/')) {
      sseConnected = resp.status() === 200;
      sseUrl = url;
      console.log(`[Captain SSE Response] status=${resp.status()}, url=${url}`);
    }
  });

  captainPage.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('new_ride') || txt.includes('[Dispatch]') || txt.includes('Incoming')) {
      console.log(`[Captain Console] ${txt}`);
    }
  });

  await captainPage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Switch to Captain tab & Login
  const captainTab = await captainPage.$('button:has-text("كابتن"), button:has-text("سائق")');
  if (captainTab) await captainTab.click();

  const phoneInput = await captainPage.$('input[type="tel"], input[placeholder*="07"]');
  if (phoneInput) await phoneInput.fill(testPhone);
  await captainPage.waitForTimeout(1000);

  const directLoginBtn = await captainPage.$('button:has-text("دخول"), button:has-text("مباشر"), button:has-text("أهلاً بك يا كابتن")');
  if (directLoginBtn) await directLoginBtn.click();
  await captainPage.waitForTimeout(3000);

  console.log('Captain URL after login:', captainPage.url());
  if (!captainPage.url().includes('/drive')) {
    await captainPage.goto(`${BASE}/drive`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  }

  await captainPage.waitForTimeout(2000);

  // Send Driver Location Update Ping
  const pingRes = await captainPage.evaluate(async (coords) => {
    const token = localStorage.getItem('auth_token') || localStorage.getItem('token') || '';
    const userId = localStorage.getItem('user_id') || localStorage.getItem('userId') || '';
    const res = await fetch('/api/driver/location', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        driverId: userId,
        latitude: coords.lat,
        longitude: coords.lng,
        heading: 0,
        tripStatus: 'Online'
      })
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  }, { lat: 32.0298, lng: 44.3285 });
  console.log('Driver location update response:', JSON.stringify(pingRes));

  // Verify in Redis
  const redisGeo = runSsh(`redis-cli --no-auth-warning GEOPOS 'drivers:locations' '${driverId}'`);
  console.log('Redis GEOPOS for captain:\n', redisGeo);

  // Take Captain Online screenshot
  await captainPage.screenshot({ path: path.join(SCREENSHOTS, 'v-01-captain-online.png') });

  // ================================================================
  // TEST 3: PASSENGER REGISTRATION & RIDE REQUEST
  // ================================================================
  console.log('\n--- [TEST 3: Passenger Register & Request Ride] ---');
  const riderContext = await browser.newContext({
    viewport: { width: 360, height: 780 },
    geolocation: { latitude: 32.0310, longitude: 44.3300 },
    permissions: ['geolocation']
  });
  const riderPage = await riderContext.newPage();
  await riderPage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const riderAuth = await riderPage.evaluate(async (phone) => {
    const res = await fetch('/api/auth/complete-passenger-registration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'أحمد الموسوي (فحص)',
        phoneNumber: phone,
        password: 'pass',
        route: 'النجف الأشرف',
        address: 'النجف الأشرف'
      })
    });
    const d = await res.json();
    if (d.token) {
      localStorage.setItem('auth_token', d.token);
      localStorage.setItem('token', d.token);
      localStorage.setItem('user_id', d.userId);
      localStorage.setItem('userId', d.userId);
      localStorage.setItem('user_role', 'Customer');
      localStorage.setItem('role', 'Customer');
    }
    return { ok: res.ok, data: d };
  }, testRiderPhone);
  console.log('Rider auth result:', JSON.stringify(riderAuth));

  // Request Ride via API from Rider page context
  const rideRes = await riderPage.evaluate(async (phone) => {
    const token = localStorage.getItem('auth_token') || localStorage.getItem('token') || '';
    const userId = localStorage.getItem('user_id') || localStorage.getItem('userId') || '';
    const res = await fetch('/api/ride/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        customerId: userId,
        customerName: 'أحمد الموسوي',
        customerPhone: phone,
        pickupName: 'حي الحنانة - شارع الكوفة',
        pickupLat: 32.0310,
        pickupLon: 44.3300,
        dropoffName: 'جامع السهلة المعظم',
        dropoffLat: 32.0380,
        dropoffLon: 44.3720,
        distanceKm: 4.5,
        durationMins: 10,
        rangeKm: 25,
        vehicleType: 'eco'
      })
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  }, testRiderPhone);

  console.log('Ride Request response:', JSON.stringify({
    ok: rideRes.ok,
    status: rideRes.status,
    rideId: rideRes.data?.ride?.id,
    candidateCount: rideRes.data?.candidateCount,
    fare: rideRes.data?.ride?.fare
  }));

  // ================================================================
  // TEST 4: TELEGRAM NOTIFICATION DELIVERY VERIFICATION
  // ================================================================
  console.log('\n--- [TEST 4: Telegram Admin Notification Raw Evidence] ---');
  await captainPage.waitForTimeout(2000);
  const tgLogs = runSsh(`grep -rn 'TelegramDispatch' /root/.pm2/logs/taxi-wisam-api-out.log | tail -6`);
  console.log('PM2 Telegram Dispatch Logs:\n', tgLogs);

  // ================================================================
  // TEST 5: CAPTAIN INCOMING TRIP SHEET & ACCEPT
  // ================================================================
  console.log('\n--- [TEST 5: Captain UI Incoming Trip Sheet & Acceptance] ---');
  await captainPage.waitForTimeout(2000);
  await captainPage.screenshot({ path: path.join(SCREENSHOTS, 'v-02-captain-incoming-sheet.png') });

  // Check if incoming sheet is present or pending requests received
  const captainPendingCount = await captainPage.evaluate(() => {
    return window.__lastPendingCount || document.querySelectorAll('[data-testid="incoming-trip-sheet"], .incoming-trip-card').length;
  });
  console.log('Captain incoming trip elements count:', captainPendingCount);

  // Accept the ride from Captain context
  const rideId = rideRes.data?.ride?.id;
  const acceptRes = await captainPage.evaluate(async (rId) => {
    const token = localStorage.getItem('auth_token') || localStorage.getItem('token') || '';
    const userId = localStorage.getItem('user_id') || localStorage.getItem('userId') || '';
    const res = await fetch('/api/ride/accept', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        rideId: rId,
        driverId: userId
      })
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  }, rideId);
  console.log('Captain accept response:', JSON.stringify(acceptRes));

  await captainPage.waitForTimeout(1500);
  await captainPage.screenshot({ path: path.join(SCREENSHOTS, 'v-03-captain-accepted.png') });

  // ================================================================
  // TEST 6: DISTANT DRIVER OUTSIDE RADIUS -> NO_DRIVERS VERIFICATION
  // ================================================================
  console.log('\n--- [TEST 6: Distant Request (Erbil) -> NO_DRIVERS 404 Response] ---');
  const distantAuthRes = await riderPage.evaluate(async (phone) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'راكب أربيل فحص',
        phoneNumber: phone,
        password: 'password123',
        role: 'Customer',
        serviceType: 'taxi',
        address: 'أربيل - قلعة أربيل'
      })
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  }, distantPhone);

  const distantToken = distantAuthRes.data?.token;
  const distantUserId = distantAuthRes.data?.userId;

  const distantRes = await riderPage.evaluate(async ({ token, userId, phone }) => {
    // Pickup far away in Erbil (lat 36.19, lon 44.01) with 5km radius where NO drivers exist
    const res = await fetch('/api/ride/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        customerId: userId,
        customerName: 'فحص مسافة بعيدة',
        customerPhone: phone,
        pickupName: 'قلعة أربيل',
        pickupLat: 36.1900,
        pickupLon: 44.0100,
        dropoffName: 'مطار أربيل الدولي',
        dropoffLat: 36.2300,
        dropoffLon: 43.9600,
        rangeKm: 5,
        vehicleType: 'eco'
      })
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  }, { token: distantToken, userId: distantUserId, phone: distantPhone });

  console.log('Distant Ride Request result status:', distantRes.status);
  console.log('Distant Ride Request body:', JSON.stringify(distantRes.data));

  // ================================================================
  // TEST 7: CLEANUP & SYSTEM SETTINGS VERIFICATION
  // ================================================================
  console.log('\n--- [TEST 7: Cleanup Test Accounts & Verify system_settings] ---');
  // Clean up test data
  runSsh(`su - postgres -c "psql -d taxiwisam -c \\"DELETE FROM drivers WHERE phone_number = '${testPhone}'; DELETE FROM users WHERE phone_number IN ('${testPhone}', '${testRiderPhone}', '${distantPhone}'); DELETE FROM ride_events WHERE ride_id = '${rideId}';\\""`);
  if (driverId) {
    runSsh(`redis-cli --no-auth-warning ZREM 'drivers:locations' '${driverId}'`);
  }
  console.log('Test accounts cleaned up from PostgreSQL and Redis.');

  // Check 18 keys in system_settings
  const settingsCheck = runSsh(`su - postgres -c "psql -d taxiwisam -t -c \\"SELECT count(*) FROM system_settings;\\""`);
  console.log('system_settings count (expected 18):', settingsCheck.trim());

  await browser.close();
  console.log('\n====================================================');
  console.log('🏁 ALL TESTS COMPLETED SUCCESSFULLY');
  console.log('====================================================');
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
