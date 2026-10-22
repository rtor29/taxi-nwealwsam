/**
 * E2E Real Lifecycle Reproduction & Verification Script
 * Tests the entire chain without seeding scripts:
 * Admin creates/approves Captain -> Captain logs in & turns Online -> Passenger registers & requests ride -> SSE & Telegram verification
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';

const BASE = 'https://tawseelaiq.app';
const VPS_SSH = 'ssh -o ConnectTimeout=10 root@173.212.206.86';

function runSsh(cmd) {
  try {
    return execSync(`${VPS_SSH} "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

async function run() {
  console.log('====================================================');
  console.log('🚀 STARTING REAL LIFECYCLE REPRODUCTION / VERIFICATION');
  console.log('====================================================');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  // 1. Admin Context: Login to Dashboard and Add/Approve Captain
  console.log('\n--- [Step 1: Admin Dashboard - Add/Verify Captain] ---');
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const adminPage = await adminContext.newPage();

  // Test credentials for clean reproducible run
  const testPhone = '07819998811';
  const testRiderPhone = '07849992233';

  // Navigate to Dashboard
  await adminPage.goto(`${BASE}/dashboard/`, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('Dashboard title:', await adminPage.title());

  // Check if login is needed
  const loginModal = await adminPage.$('#admin-login-modal, #login-overlay, input[type="password"]');
  if (loginModal) {
    console.log('Logging into Admin Dashboard...');
    const userInput = await adminPage.$('input[placeholder*="المستخدم"], #admin-user, input[type="text"]');
    if (userInput) await userInput.fill('admin');
    const passInput = await adminPage.$('input[type="password"]');
    if (passInput) await passInput.fill('1122');
    const submitBtn = await adminPage.$('button[type="submit"], button:has-text("دخول")');
    if (submitBtn) await submitBtn.click();
    await adminPage.waitForTimeout(2000);
  }

  // Create Captain via Dashboard modal or API
  console.log(`Creating test captain ${testPhone}...`);
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

  console.log('Admin createDriver response:', JSON.stringify(createRes));

  // Check PostgreSQL immediately
  const pgDriverCheck = runSsh(`su - postgres -c "psql -d taxiwisam -t -c \\"SELECT driver_id, full_name, status, is_approved FROM drivers WHERE phone_number = '${testPhone}'\\""`);
  console.log('PostgreSQL driver row:', pgDriverCheck);

  // 2. Captain Context: Login, Turn Online, Send Location
  console.log('\n--- [Step 2: Captain Web App - Login, Turn Online, Send Location] ---');
  const captainContext = await browser.newContext({
    viewport: { width: 360, height: 780 },
    geolocation: { latitude: 32.0298, longitude: 44.3285 },
    permissions: ['geolocation']
  });
  const captainPage = await captainContext.newPage();

  // Monitor network requests on Captain page
  let captainSseConnected = false;
  let captainSseUrl = '';
  let lastSseEvent = null;

  captainPage.on('response', resp => {
    const url = resp.url();
    if (url.includes('/api/events/driver/')) {
      captainSseConnected = resp.status() === 200;
      captainSseUrl = url;
      console.log(`[Captain Network] SSE Response: status=${resp.status()}, url=${url}`);
    }
    if (url.includes('/api/driver/location')) {
      console.log(`[Captain Network] Location update: status=${resp.status()}`);
    }
  });

  captainPage.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('[SSE]') || txt.includes('[Dispatch]') || txt.includes('Incoming')) {
      console.log(`[Captain Console] ${txt}`);
    }
  });

  // Navigate to login
  await captainPage.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('Captain page loaded at /login');

  // Switch to Captain tab
  const captainTab = await captainPage.$('button:has-text("كابتن"), button:has-text("سائق")');
  if (captainTab) {
    await captainTab.click();
    await captainPage.waitForTimeout(500);
  }

  // Fill Phone Number
  const phoneInput = await captainPage.$('input[type="tel"], input[placeholder*="07"]');
  if (phoneInput) {
    await phoneInput.fill(testPhone);
    await captainPage.waitForTimeout(1000);
  }

  // Click direct login
  const directLoginBtn = await captainPage.$('button:has-text("دخول"), button:has-text("مباشر"), button:has-text("أهلاً بك يا كابتن")');
  if (directLoginBtn) {
    console.log('Clicking direct login button for captain...');
    await directLoginBtn.click();
    await captainPage.waitForTimeout(3000);
  }

  console.log('Captain current URL:', captainPage.url());

  // If redirected to /drive
  if (captainPage.url().includes('/drive')) {
    console.log('Captain successfully in /drive page!');
  } else {
    console.log('Forcing navigate to /drive with token from localStorage...');
    await captainPage.goto(`${BASE}/drive`, { waitUntil: 'networkidle', timeout: 15000 });
  }

  // Wait for DriverHomePage to hydrate
  await captainPage.waitForTimeout(3000);

  // Check workStatus toggle
  const onlineButton = await captainPage.$('button:has-text("تكسي"), button:has-text("متصل"), button:has-text("كلاهما")');
  if (onlineButton) {
    console.log('Clicking taxi/online toggle button...');
    await onlineButton.click();
    await captainPage.waitForTimeout(2000);
  }

  // Send an explicit location ping from page context to guarantee Redis registration
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
  console.log('Driver location update ping result:', JSON.stringify(pingRes));

  // Check Redis state for captain
  const redisDrivers = runSsh(`redis-cli --no-auth-warning GEOPOS 'drivers:locations' '${createRes.data?.driver?.driverId}'`);
  console.log('Redis GEOPOS for new driver:', redisDrivers);

  // 3. Passenger Context: Register & Request Ride
  console.log('\n--- [Step 3: Passenger Web App - Request Ride within 300m] ---');
  const riderContext = await browser.newContext({
    viewport: { width: 360, height: 780 },
    geolocation: { latitude: 32.0310, longitude: 44.3300 },
    permissions: ['geolocation']
  });
  const riderPage = await riderContext.newPage();
  await riderPage.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30000 });

  // Create Rider via complete-passenger-registration API
  console.log(`Registering rider ${testRiderPhone}...`);
  const riderAuth = await riderPage.evaluate(async (phone) => {
    const res = await fetch('/api/auth/complete-passenger-registration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'راكب فحص تجريبي',
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

  // Navigate to Taxi Booking Page
  await riderPage.goto(`${BASE}/taxi`, { waitUntil: 'networkidle', timeout: 30000 });
  await riderPage.waitForTimeout(2000);

  // Submit Ride Request
  console.log('Submitting Ride Request from Passenger Context...');
  const rideRes = await riderPage.evaluate(async () => {
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
        customerName: 'راكب فحص تجريبي',
        customerPhone: '07849992233',
        pickupName: 'حي الحنانة - قرب الجسر',
        pickupLat: 32.0310,
        pickupLon: 44.3300,
        dropoffName: 'الكوفة - جامع السهلة',
        dropoffLat: 32.0380,
        dropoffLon: 44.3720,
        distanceKm: 4.5,
        durationMins: 10,
        rangeKm: 25,
        vehicleType: 'eco'
      })
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  });

  console.log('Ride Request response:', JSON.stringify(rideRes));

  // 4. Verify SSE Event on Captain and Telegram Alert
  console.log('\n--- [Step 4: Real-time SSE and Telegram Verification] ---');
  await captainPage.waitForTimeout(3000);

  // Check if Incoming Trip Sheet appeared on Captain page
  const tripSheet = await captainPage.$('[data-testid="incoming-trip-sheet"], .incoming-trip-card, button:has-text("قبول الطلب"), button:has-text("قبول")');
  console.log('Incoming trip sheet visible on Captain UI:', !!tripSheet);

  // Check PM2 Logs for Telegram Dispatch
  const pm2TelegramLog = runSsh(`grep -rn 'TelegramDispatch' /root/.pm2/logs/taxi-wisam-api-out.log | tail -5`);
  console.log('PM2 TelegramDispatch logs:\n', pm2TelegramLog);

  // Take screenshots
  await captainPage.screenshot({ path: '/Users/mu_it/.gemini/antigravity/brain/b0e252c3-bcae-4017-af79-e1199eadddf7/screenshots/step1-captain-view.png' });
  await riderPage.screenshot({ path: '/Users/mu_it/.gemini/antigravity/brain/b0e252c3-bcae-4017-af79-e1199eadddf7/screenshots/step1-rider-view.png' });
  console.log('Screenshots saved for Step 1.');

  await browser.close();
  console.log('====================================================');
  console.log('🏁 STEP 1 REPRODUCTION RUN COMPLETE');
  console.log('====================================================');
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
