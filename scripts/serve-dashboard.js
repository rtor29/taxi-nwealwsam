// Lightweight Development Server for Taxi-Wisam Admin Dashboard
// Uses built-in Node.js modules (no npm install required)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5050;
const DASHBOARD_DIR = path.join(__dirname, '..', 'src', 'TaxiWisam.Api', 'wwwroot', 'dashboard');

// Clean state database focused on Najaf Governorate (محافظة النجف الأشرف)
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'state.json');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

let state = {
    stats: {
        totalUsers: 0,
        totalDrivers: 0,
        verifiedDrivers: 0,
        pendingVerifications: 0,
        activeRoutes: 0,
        totalBookings: 0,
        pendingComplaints: 0,
        totalRevenue: 0
    },
    verifications: [],
    drivers: [],
    customers: [],
    routes: [],
    bookings: [],
    complaints: [],
    vacancyAds: [],
    settings: [
        {
            key: "city_coverage",
            valueJson: JSON.stringify({ province: "النجف الأشرف", centerLat: 31.9961, centerLon: 44.3168, allowedAreas: ["المركز", "الكوفة", "المشخاب", "الحيدرية", "المناذرة"] }),
            description: "نطاق تغطية الخدمة المعتمد"
        },
        {
            key: "matching_settings",
            valueJson: JSON.stringify({ max_detour_meters: 2000, min_overlap_percentage: 60, search_radius_meters: 5000, time_window_minutes: 30 }),
            description: "معايير محرك المطابقة الجغرافي بالنجف"
        },
        {
            key: "pricing_settings",
            valueJson: JSON.stringify({ base_fare_iqd: 2500, per_km_rate_iqd: 400, per_minute_rate_iqd: 80, surge_multiplier_max: 2.0 }),
            description: "تسعيرات مشاوير النجف الأشرف"
        }
    ],
    auditLogs: [
        { action: "SystemInitialized", entityName: "System", entityId: "Najaf-Core", newValuesJson: '{"city":"النجف الأشرف","status":"Active"}', ipAddress: "127.0.0.1", createdAt: new Date().toISOString() }
    ]
};

try {
    const dataDir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    if (fs.existsSync(DATA_FILE)) {
        const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        state = { ...state, ...saved };
        console.log(`[State] Loaded persisted state from ${DATA_FILE}`);
    }
} catch (e) {
    console.warn(`[State] Error loading state: ${e.message}`);
}

function saveState() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        console.warn(`[State] Error saving state: ${e.message}`);
    }
}

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // Helper: JSON response
    const json = (data, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    };

    // Helper: Parse body
    const parseBody = (callback) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                callback(body ? JSON.parse(body) : {});
            } catch (e) {
                callback({});
            }
        });
    };

    // -------------------------------------------------------------------------
    // API Routes (/api/admin/...)
    // -------------------------------------------------------------------------
    if (pathname === '/api/admin/stats') {
        return json(state.stats);
    }

    if (pathname === '/api/admin/drivers/pending-verifications') {
        const unverified = state.drivers.filter(d => !d.isVerified).map(d => {
            const driverDocs = state.verifications.filter(v => v.driverId === d.driverId);
            return {
                driverId: d.driverId,
                fullName: d.fullName,
                phoneNumber: d.phoneNumber,
                licenseNumber: d.licenseNumber,
                vehicles: [
                    { make: 'تويوتا', model: 'كورولا', plateNumber: 'النجف - ' + (d.licenseNumber.match(/\d+/) ? d.licenseNumber.match(/\d+/)[0] : '1029') }
                ],
                documents: driverDocs.length > 0 ? driverDocs.map(doc => ({
                    id: doc.documentId,
                    documentType: doc.documentType || 'DrivingLicense',
                    status: doc.status || 'Pending'
                })) : [
                    {
                        id: 'doc-' + d.driverId,
                        documentType: 'DrivingLicense',
                        status: 'Pending'
                    }
                ]
            };
        });
        return json(unverified);
    }

    if (pathname.startsWith('/api/documents/') && pathname.endsWith('/signed-url')) {
        const parts = pathname.split('/');
        const docId = parts[3];
        const doc = state.verifications.find(v => v.documentId === docId || v.documentId === 'doc-' + docId);
        
        let signedUrl = "https://images.unsplash.com/photo-1633265486064-086b219458ec?w=800&auto=format&fit=crop&q=80";
        if (doc && doc.fileUrl) {
            signedUrl = doc.fileUrl;
        } else if (fs.existsSync(path.join(UPLOADS_DIR, `${docId}.jpg`))) {
            signedUrl = `/uploads/${docId}.jpg`;
        }

        return json({
            documentId: docId || "doc-preview",
            documentType: doc ? (doc.documentType || 'DrivingLicense') : "DrivingLicense",
            signedUrl: signedUrl,
            driverId: doc ? doc.driverId : null,
            expiresInSeconds: 3600
        });
    }

    if (pathname === '/api/documents/upload') {
        return parseBody(body => {
            const docId = 'doc-' + Math.random().toString(36).substr(2, 8);
            const driverId = body.driverId || 'usr-sample';
            const docType = body.documentType || 'DrivingLicense';
            let fileUrl = '';

            if (body.fileBase64) {
                try {
                    const buffer = Buffer.from(body.fileBase64, 'base64');
                    const fileName = `${docId}.jpg`;
                    fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buffer);
                    fileUrl = `/uploads/${fileName}`;
                } catch (e) {
                    console.error('Error saving uploaded file:', e.message);
                }
            }

            state.verifications.push({
                documentId: docId,
                driverId: driverId,
                documentType: docType,
                filePath: fileUrl || ('licenses/' + docId + '.jpg'),
                fileUrl: fileUrl,
                status: 'Pending',
                submittedAt: new Date().toISOString()
            });
            state.stats.pendingVerifications++;
            saveState();
            return json({ success: true, documentId: docId, fileUrl, status: 'Pending' });
        });
    }

    // OSRM Routing Simulation Endpoint (Focused on Najaf routes)
    if (pathname === '/api/routing/route') {
        const startLat = parseFloat(url.searchParams.get('startLat') || '31.9961');
        const startLon = parseFloat(url.searchParams.get('startLon') || '44.3168');
        const endLat = parseFloat(url.searchParams.get('endLat') || '32.0289');
        const endLon = parseFloat(url.searchParams.get('endLon') || '44.4011');

        const distanceMeters = 8200; // 8.2 km
        const durationSeconds = 900; // 15 minutes
        return json({
            distanceMeters,
            distanceKm: 8.2,
            durationSeconds,
            durationMinutes: 15.0,
            points: [
                { latitude: startLat, longitude: startLon },
                { latitude: (startLat + endLat) / 2, longitude: (startLon + endLon) / 2 },
                { latitude: endLat, longitude: endLon }
            ]
        });
    }

    // Nominatim Address Search Simulation Endpoint (Najaf Governorate)
    if (pathname === '/api/routing/search-address') {
        return json([
            { displayName: "مرقد الإمام علي (ع)، المدينة القديمة، النجف الأشرف", latitude: 31.9961, longitude: 44.3168, city: "النجف", suburb: "المدينة القديمة" },
            { displayName: "مسجد الكوفة المعظم، الكوفة، النجف الأشرف", latitude: 32.0289, longitude: 44.4011, city: "النجف", suburb: "الكوفة" },
            { displayName: "مطار النجف الدولي، طريق المطار، النجف الأشرف", latitude: 31.9902, longitude: 44.4042, city: "النجف", suburb: "المطار" },
            { displayName: "ساحة ثورة العشرين، مركز المحافظة، النجف الأشرف", latitude: 32.0085, longitude: 44.3312, city: "النجف", suburb: "المركز" },
            { displayName: "جامعة الكوفة، شارع الكوفة، النجف الأشرف", latitude: 32.0152, longitude: 44.3725, city: "النجف", suburb: "الكوفة" }
        ]);
    }

    // Dynamic Fare Estimation Endpoint
    if (pathname === '/api/pricing/estimate') {
        return parseBody(body => {
            const distMeters = body.distanceMeters || 5400;
            const durSeconds = body.durationSeconds || 720;
            const distKm = distMeters / 1000.0;
            const durMin = durSeconds / 60.0;
            const baseFare = 3000;
            const perKm = 500;
            const perMin = 100;
            const surge = body.surgeMultiplier || 1.0;
            const total = Math.round(((baseFare + (distKm * perKm) + (durMin * perMin)) * surge) / 250) * 250;

            return json({
                totalFare: total,
                baseFare,
                distanceFare: distKm * perKm,
                timeFare: durMin * perMin,
                distanceKm: Math.round(distKm * 10) / 10,
                durationMinutes: Math.round(durMin * 10) / 10,
                surgeMultiplier: surge,
                currency: "IQD"
            });
        });
    }

    if (pathname.startsWith('/api/admin/documents/') && pathname.endsWith('/verify')) {
        const parts = pathname.split('/');
        const docId = parts[parts.length - 2]; // /api/admin/documents/{docId}/verify
        return parseBody(body => {
            const isApproved = body.approved !== false;
            
            // Update document in state
            const doc = state.verifications.find(v => v.documentId === docId || v.documentId === 'doc-' + docId);
            if (doc) {
                doc.status = isApproved ? 'Approved' : 'Rejected';
            }
            
            // Find driver
            const driver = state.drivers.find(d => 
                (doc && d.driverId === doc.driverId) ||
                ('doc-' + d.driverId === docId) ||
                (d.driverId === docId)
            );
            if (driver && isApproved) {
                driver.isVerified = true;
                driver.status = 'Online';
                state.stats.pendingVerifications = Math.max(0, state.stats.pendingVerifications - 1);
                state.stats.verifiedDrivers++;
            }

            state.auditLogs.unshift({
                action: isApproved ? "ApproveDriverDocument" : "RejectDriverDocument",
                entityName: "DriverDocument",
                entityId: docId,
                newValuesJson: JSON.stringify({ approved: isApproved, driverId: driver ? driver.driverId : null }),
                ipAddress: "127.0.0.1",
                createdAt: new Date().toISOString()
            });

            saveState();
            return json({ success: true, approved: isApproved });
        });
    }

    // Nearby Drivers Endpoint (Najaf Governorate)
    if (pathname === '/api/drivers/nearby') {
        const lat = parseFloat(url.searchParams.get('latitude') || '31.9961');
        const lon = parseFloat(url.searchParams.get('longitude') || '44.3168');

        // Najaf Captains list:
        const nearby = [
            {
                driverId: "drv-njf-1",
                fullName: "كابتن حيدر النجفي",
                phoneNumber: "07801122334",
                latitude: lat + 0.0035,
                longitude: lon + 0.0020,
                rating: 4.9,
                carModel: "كيا أوبتيما (أجرة)",
                plateNumber: "النجف 45212",
                distanceKm: 0.4,
                etaMinutes: 2
            },
            {
                driverId: "drv-njf-2",
                fullName: "كابتن علي الغري",
                phoneNumber: "07805566778",
                latitude: lat - 0.0040,
                longitude: lon - 0.0025,
                rating: 4.8,
                carModel: "تويوتا كورولا",
                plateNumber: "النجف 19830",
                distanceKm: 0.7,
                etaMinutes: 3
            },
            {
                driverId: "drv-njf-3",
                fullName: "كابتن سجاد الكوفي",
                phoneNumber: "07812233445",
                latitude: lat + 0.0060,
                longitude: lon + 0.0050,
                rating: 5.0,
                carModel: "هيونداي إلنترا",
                plateNumber: "النجف 88102",
                distanceKm: 1.1,
                etaMinutes: 5
            }
        ];

        // Include any online registered driver
        state.drivers.filter(d => d.isVerified).forEach((d, idx) => {
            nearby.push({
                driverId: d.driverId,
                fullName: d.fullName,
                phoneNumber: d.phoneNumber,
                latitude: lat + 0.0015 * (idx + 1),
                longitude: lon + 0.0015 * (idx + 1),
                rating: d.ratingAverage || 5.0,
                carModel: "تاكسي وسام المعتمد",
                plateNumber: d.licenseNumber || "النجف 1000",
                distanceKm: 0.5 * (idx + 1),
                etaMinutes: 2 * (idx + 1)
            });
        });

        return json(nearby);
    }

    // Real-time Fleet Tracking API
    if (pathname === '/api/admin/fleet/live') {
        const baseLat = 31.9961;
        const baseLon = 44.3168;
        const fleet = [
            {
                driverId: "drv-njf-1",
                driverName: "كابتن حيدر النجفي",
                phone: "07801122334",
                latitude: baseLat + 0.0035,
                longitude: baseLon + 0.0020,
                heading: 45.0,
                speedKmh: 38.5,
                status: "on_trip",
                carModel: "كيا أوبتيما (أجرة)",
                plateNumber: "النجف 45212",
                lastPing: new Date().toISOString()
            },
            {
                driverId: "drv-njf-2",
                driverName: "كابتن علي الغري",
                phone: "07805566778",
                latitude: baseLat - 0.0040,
                longitude: baseLon - 0.0025,
                heading: 180.0,
                speedKmh: 42.0,
                status: "available",
                carModel: "تويوتا كورولا",
                plateNumber: "النجف 19830",
                lastPing: new Date().toISOString()
            },
            {
                driverId: "drv-njf-3",
                driverName: "كابتن سجاد الكوفي",
                phone: "07812233445",
                latitude: baseLat + 0.0060,
                longitude: baseLon + 0.0050,
                heading: 90.0,
                speedKmh: 0.0,
                status: "waiting",
                carModel: "هيونداي إلنترا",
                plateNumber: "النجف 88102",
                lastPing: new Date().toISOString()
            }
        ];

        // Also append all registered drivers
        state.drivers.forEach((d, idx) => {
            fleet.push({
                driverId: d.driverId,
                driverName: d.fullName,
                phone: d.phoneNumber,
                latitude: baseLat + 0.0018 * (idx + 1),
                longitude: baseLon + 0.0018 * (idx + 1),
                heading: (idx * 60) % 360,
                speedKmh: 30.0 + (idx * 5),
                status: d.isVerified ? "available" : "offline",
                carModel: "تاكسي وسام المعتمد",
                plateNumber: d.licenseNumber || `النجف ${1000 + idx}`,
                lastPing: new Date().toISOString()
            });
        });

        return json(fleet);
    }

    // Broadcast Route to Active Driver & Passengers
    if (pathname === '/api/admin/routes/broadcast' && req.method === 'POST') {
        return parseBody(body => {
            const { routeId, driverId, routeName, coordinates, waypoints, totalDistanceMeters, estimatedDurationSeconds } = body;
            
            if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
                return json({ error: "Coordinates array with at least 2 points is required." }, 400);
            }

            const broadcastId = `bcast-${Date.now()}`;
            const broadcastPayload = {
                broadcastId,
                routeId: routeId || `route-${Date.now()}`,
                driverId: driverId || "all",
                routeName: routeName || "مسار معتمد من إدارة العمليات",
                coordinates,
                waypoints: waypoints || [],
                totalDistanceMeters: totalDistanceMeters || 0,
                estimatedDurationSeconds: estimatedDurationSeconds || 0,
                broadcastedAt: new Date().toISOString(),
                status: "active"
            };

            if (!state.broadcastedRoutes) {
                state.broadcastedRoutes = [];
            }
            state.broadcastedRoutes.unshift(broadcastPayload);
            if (state.broadcastedRoutes.length > 50) state.broadcastedRoutes.pop();

            state.auditLogs.unshift({
                action: "RouteBroadcasted",
                entityName: "Route",
                entityId: broadcastPayload.routeId,
                newValuesJson: JSON.stringify({ driverId: broadcastPayload.driverId, pointsCount: coordinates.length, distance: totalDistanceMeters }),
                ipAddress: req.socket.remoteAddress || "127.0.0.1",
                createdAt: new Date().toISOString()
            });
            saveState();

            return json({
                success: true,
                message: "تم تعميم المسار بنجاح إلى أجهزة السائقين والركاب",
                data: broadcastPayload
            }, 201);
        });
    }

    if (pathname === '/api/admin/routes/broadcast' && req.method === 'GET') {
        return json(state.broadcastedRoutes || []);
    }

    // Matching Regular Routes Endpoint (Najaf Governorate)
    if (pathname === '/api/matching/find-routes') {
        return parseBody(body => {
            const matches = [
                {
                    driverRouteId: "route-njf-1",
                    routeName: "خط مركز النجف - جامعة الكوفة",
                    driverName: "كابتن حيدر النجفي",
                    startName: "ساحة ثورة العشرين - مركز النجف",
                    endName: "جامعة الكوفة - مجمع كليات الكوفة",
                    departureTime: "07:30 ص",
                    availableSeats: 3,
                    pricePerSeat: 3000,
                    distanceKm: 8.5,
                    driverRating: 4.9,
                    vehicleInfo: "كيا أوبتيما حديثة"
                },
                {
                    driverRouteId: "route-njf-2",
                    routeName: "خط المدينة القديمة - مطار النجف الدولي",
                    driverName: "كابتن علي الغري",
                    startName: "مرقد الإمام علي (ع) - المدينة القديمة",
                    endName: "مطار النجف الدولي - صالة المغادرة",
                    departureTime: "08:15 ص",
                    availableSeats: 4,
                    pricePerSeat: 5000,
                    distanceKm: 9.8,
                    driverRating: 4.8,
                    vehicleInfo: "تويوتا كورولا"
                },
                {
                    driverRouteId: "route-njf-3",
                    routeName: "خط الكوفة - حي العدالة والمشخاب",
                    driverName: "كابتن سجاد الكوفي",
                    startName: "مسجد الكوفة المعظم",
                    endName: "حي العدالة - المشخاب",
                    departureTime: "08:00 ص",
                    availableSeats: 2,
                    pricePerSeat: 4000,
                    distanceKm: 12.0,
                    driverRating: 5.0,
                    vehicleInfo: "هيونداي إلنترا"
                }
            ];

            // If drivers created custom routes, add them
            state.routes.forEach(r => {
                matches.push({
                    driverRouteId: r.routeId,
                    routeName: r.routeName,
                    driverName: r.driverName || "كابتن وسام",
                    startName: r.startName,
                    endName: r.endName,
                    departureTime: r.departureTime || "08:00 ص",
                    availableSeats: r.availableSeats || 4,
                    pricePerSeat: r.pricePerSeat || 3500,
                    distanceKm: 7.5,
                    driverRating: 5.0,
                    vehicleInfo: "تاكسي وسام"
                });
            });

            return json(matches);
        });
    }

    // Booking Creation & History Endpoints
    if (pathname === '/api/bookings' && req.method === 'POST') {
        return parseBody(body => {
            const bookingId = 'bk-' + Math.random().toString(36).substr(2, 8);
            const newBooking = {
                id: bookingId,
                bookingId,
                customerId: body.customerId || 'usr-cust',
                driverId: body.driverId || 'drv-njf-1',
                driverName: body.driverName || 'كابتن حيدر النجفي',
                pickupName: body.pickupName || 'ساحة ثورة العشرين - مركز النجف',
                dropoffName: body.dropoffName || 'جامعة الكوفة',
                pickupLat: body.pickupLat || 31.9961,
                pickupLon: body.pickupLon || 44.3168,
                dropoffLat: body.dropoffLat || 32.0300,
                dropoffLon: body.dropoffLon || 44.3700,
                totalFare: body.seatsBooked ? (body.seatsBooked * 3000) : 3000,
                seatsBooked: body.seatsBooked || 1,
                status: 'Confirmed',
                bookingDate: body.bookingDate || new Date().toISOString().split('T')[0]
            };

            state.bookings.unshift(newBooking);
            state.stats.totalBookings++;

            state.auditLogs.unshift({
                action: "CreateBooking",
                entityName: "Booking",
                entityId: bookingId,
                newValuesJson: JSON.stringify(newBooking),
                ipAddress: "127.0.0.1",
                createdAt: new Date().toISOString()
            });

            saveState();
            return json(newBooking);
        });
    }

    if (pathname.startsWith('/api/bookings/customer/')) {
        const custId = pathname.split('/').pop();
        const custBookings = state.bookings.filter(b => b.customerId === custId);
        return json(custBookings);
    }

    // Driver Route Management
    if (pathname.startsWith('/api/drivers/') && pathname.endsWith('/routes')) {
        const driverId = pathname.split('/')[3];
        return parseBody(body => {
            const routeId = 'rt-' + Math.random().toString(36).substr(2, 8);
            const newRoute = {
                routeId,
                driverId,
                routeName: body.routeName || 'خط سير جديد',
                startName: body.startName || 'مركز النجف',
                endName: body.endName || 'الكوفة',
                departureTime: body.departureTime || '07:30 ص',
                availableSeats: body.availableSeats || 4,
                pricePerSeat: body.pricePerSeat || 3000,
                status: 'Active'
            };
            state.routes.unshift(newRoute);
            state.stats.activeRoutes++;
            saveState();
            return json(newRoute);
        });
    }

    // Driver Status Update
    if (pathname.startsWith('/api/drivers/') && pathname.endsWith('/status')) {
        const driverId = pathname.split('/')[3];
        return parseBody(body => {
            const driver = state.drivers.find(d => d.driverId === driverId);
            if (driver) {
                driver.status = body.status || 'Online';
                saveState();
            }
            return json({ success: true, status: body.status });
        });
    }

    if (pathname.startsWith('/api/admin/drivers/') && req.method === 'GET') {
        const driverId = pathname.replace('/api/admin/drivers/', '').trim();
        const driver = state.drivers.find(d => d.driverId === driverId);
        if (driver) {
            const docs = state.verifications.filter(v => v.driverId === driverId);
            const vehicles = [
                { make: 'تويوتا', model: 'كورولا', plateNumber: 'النجف - ' + (driver.licenseNumber ? (driver.licenseNumber.match(/\d+/) || ['1029'])[0] : '1029') }
            ];
            return json({ ...driver, vehicles, documents: docs.length > 0 ? docs : [{
                documentId: 'doc-' + driver.driverId,
                documentType: 'DrivingLicense',
                status: driver.isVerified ? 'Approved' : 'Pending',
                fileUrl: fs.existsSync(path.join(UPLOADS_DIR, `doc-${driver.driverId}.jpg`)) ? `/uploads/doc-${driver.driverId}.jpg` : "https://images.unsplash.com/photo-1633265486064-086b219458ec?w=800&auto=format&fit=crop&q=80"
            }] });
        }
    }

    if (pathname === '/api/admin/drivers') {
        return json({ total: state.drivers.length, drivers: state.drivers });
    }

    if (pathname === '/api/admin/customers') {
        return json({ total: state.customers.length, customers: state.customers });
    }

    if (pathname === '/api/admin/routes') {
        return json({ total: state.routes.length, routes: state.routes });
    }

    if (pathname === '/api/admin/bookings') {
        return json({ total: state.bookings.length, bookings: state.bookings });
    }

    if (pathname === '/api/admin/complaints') {
        return json({ total: state.complaints.length, complaints: state.complaints });
    }

    if (pathname.startsWith('/api/admin/complaints/')) {
        return parseBody(body => {
            state.stats.pendingComplaints = Math.max(0, state.stats.pendingComplaints - 1);
            saveState();
            return json({ success: true });
        });
    }

    if (pathname === '/api/admin/settings') {
        if (req.method === 'GET') {
            return json(state.settings);
        }
    }

    if (pathname.startsWith('/api/admin/settings/')) {
        const key = pathname.split('/').pop();
        return parseBody(body => {
            const existing = state.settings.find(s => s.key === key);
            if (existing) {
                existing.valueJson = body.valueJson;
            } else {
                state.settings.push({ key, valueJson: body.valueJson, description: body.description });
            }
            saveState();
            return json({ success: true, key });
        });
    }

    if (pathname === '/api/admin/audit-logs') {
        return json({ total: state.auditLogs.length, logs: state.auditLogs });
    }

    // -------------------------------------------------------------------------
    // Mobile App Authentication Routes (/api/auth/...)
    // -------------------------------------------------------------------------
    if (pathname === '/api/auth/register') {
        return parseBody(body => {
            const userId = 'usr-' + Math.random().toString(36).substr(2, 9);
            const role = body.role || 'Customer';
            const fullName = body.fullName || 'مستخدم جديد';
            const email = body.email || '';
            const phone = body.phoneNumber || '';

            if (role === 'Driver') {
                const licenseNo = body.licenseNumber || 'IRQ-NJF-' + Math.floor(1000 + Math.random() * 9000);
                state.drivers.push({
                    driverId: userId,
                    fullName,
                    phoneNumber: phone,
                    email,
                    licenseNumber: licenseNo,
                    status: 'Offline',
                    isVerified: false,
                    ratingAverage: 5.0,
                    totalTrips: 0
                });
                state.verifications.push({
                    documentId: 'doc-' + userId,
                    driverId: userId,
                    driverName: fullName,
                    phoneNumber: phone,
                    documentType: 'DrivingLicense',
                    filePath: 'licenses/' + userId + '.jpg',
                    submittedAt: new Date().toISOString(),
                    status: 'Pending'
                });
                state.stats.totalDrivers++;
                state.stats.pendingVerifications++;
            } else {
                state.customers.push({
                    customerId: userId,
                    fullName,
                    phoneNumber: phone,
                    email,
                    preferredPaymentMethod: 'Cash',
                    ratingAverage: 5.0,
                    totalBookings: 0,
                    isActive: true
                });
                state.stats.totalUsers++;
            }

            state.auditLogs.unshift({
                action: 'UserRegistered',
                entityName: 'User',
                entityId: userId,
                newValuesJson: JSON.stringify({ fullName, phone, email, role }),
                ipAddress: '127.0.0.1',
                createdAt: new Date().toISOString()
            });

            saveState();

            return json({
                userId,
                fullName,
                email,
                phoneNumber: phone,
                role,
                token: 'jwt_token_' + userId
            });
        });
    }

    if (pathname === '/api/auth/login') {
        return parseBody(body => {
            const identifier = (body.identifier || body.email || body.phoneNumber || '').trim().toLowerCase();
            
            // Search in drivers
            const driver = state.drivers.find(d => 
                (d.phoneNumber && d.phoneNumber.toLowerCase() === identifier) ||
                (d.email && d.email.toLowerCase() === identifier)
            );
            if (driver) {
                return json({
                    userId: driver.driverId,
                    fullName: driver.fullName,
                    phoneNumber: driver.phoneNumber,
                    email: driver.email || '',
                    role: 'Driver',
                    isDriverVerified: driver.isVerified,
                    token: 'jwt_token_' + driver.driverId
                });
            }

            // Search in customers
            const customer = state.customers.find(c => 
                (c.phoneNumber && c.phoneNumber.toLowerCase() === identifier) ||
                (c.email && c.email.toLowerCase() === identifier)
            );
            if (customer) {
                return json({
                    userId: customer.customerId,
                    fullName: customer.fullName,
                    phoneNumber: customer.phoneNumber,
                    email: customer.email || '',
                    role: 'Customer',
                    token: 'jwt_token_' + customer.customerId
                });
            }

            // If not found, dynamically log them in as verified customer with entered credentials
            const newId = 'usr-' + Math.random().toString(36).substr(2, 9);
            const isEmail = identifier.includes('@');
            return json({
                userId: newId,
                fullName: isEmail ? identifier.split('@')[0] : 'مستخدم تاكسي وسام',
                email: isEmail ? identifier : '',
                phoneNumber: isEmail ? '07700000000' : identifier,
                role: 'Customer',
                token: 'jwt_token_' + newId
            });
        });
    }

    if (pathname === '/api/auth/me') {
        const queryPhone = url.searchParams.get('phone');
        const queryEmail = url.searchParams.get('email');
        const queryId = url.searchParams.get('userId');

        const driver = state.drivers.find(d => d.driverId === queryId || d.phoneNumber === queryPhone || d.email === queryEmail);
        if (driver) {
            return json({ id: driver.driverId, fullName: driver.fullName, role: 'Driver', isDriverVerified: driver.isVerified });
        }

        const customer = state.customers.find(c => c.customerId === queryId || c.phoneNumber === queryPhone || c.email === queryEmail);
        if (customer) {
            return json({ id: customer.customerId, fullName: customer.fullName, role: 'Customer' });
        }

        return json({ id: queryId || 'usr-default', fullName: 'مستخدم توصيله', role: 'Customer' });
    }

    // Trip Approval Flow (Accept / Decline Booking)
    if (pathname.startsWith('/api/bookings/') && (pathname.endsWith('/accept') || pathname.endsWith('/decline'))) {
        const parts = pathname.split('/');
        const bookingId = parts[3];
        const isAccept = pathname.endsWith('/accept');
        const booking = state.bookings.find(b => b.bookingId === bookingId || b.id === bookingId);
        if (booking) {
            booking.status = isAccept ? 'Confirmed' : 'Declined';
            saveState();
        }
        return json({ success: true, bookingId, status: isAccept ? 'Confirmed' : 'Declined' });
    }

    // Vacancy Ads System (إعلانات الرحلات الشاغرة)
    if (pathname === '/api/ads/vacancies') {
        if (req.method === 'GET') {
            const defaultAds = [
                {
                    id: 'ad-njf-101',
                    driverId: 'drv-ali-najaf',
                    driverName: 'علي الكعبي',
                    driverPhone: '07812345678',
                    vehicleModel: 'تويوتا كورولا 2023',
                    plateNumber: 'النجف 14502',
                    rating: 4.95,
                    fromLocation: 'ساحة ثورة العشرين - المركز',
                    toLocation: 'جامعة الكوفة - مجمع الكليات',
                    departureDate: 'اليوم',
                    departureTime: '08:15 ص',
                    availableSeats: 3,
                    totalSeats: 4,
                    pricePerSeatIqd: 3000,
                    notes: 'تكييف بارد ومقاعد مريحة والانطلاق فوري عند اكتمال الركاب.',
                    status: 'Open'
                },
                {
                    id: 'ad-njf-102',
                    driverId: 'drv-hassan-najaf',
                    driverName: 'حسين الخفاجي',
                    driverPhone: '07809876543',
                    vehicleModel: 'هيونداي إلنترا 2021',
                    plateNumber: 'النجف 8921',
                    rating: 4.88,
                    fromLocation: 'مرقد الإمام علي (ع) - المدينة القديمة',
                    toLocation: 'مطار النجف الدولي',
                    departureDate: 'اليوم',
                    departureTime: '10:00 ص',
                    availableSeats: 2,
                    totalSeats: 4,
                    pricePerSeatIqd: 5000,
                    notes: 'خاص للمسافرين ولدينا مساحة واسعة للحقائب.',
                    status: 'Open'
                }
            ];
            return json(state.vacancyAds && state.vacancyAds.length > 0 ? state.vacancyAds : defaultAds);
        }

        if (req.method === 'POST') {
            return parseBody(body => {
                const newAd = {
                    id: 'ad-' + Math.random().toString(36).substr(2, 8),
                    driverId: body.driverId || 'drv-sample',
                    driverName: body.driverName || 'كابتن توصيله',
                    driverPhone: body.driverPhone || '07801234567',
                    vehicleModel: body.vehicleModel || 'تويوتا كورولا',
                    plateNumber: body.plateNumber || 'النجف 1029',
                    rating: 4.9,
                    fromLocation: body.fromLocation || 'مركز النجف',
                    toLocation: body.toLocation || 'الكوفة',
                    departureDate: body.departureDate || 'اليوم',
                    departureTime: body.departureTime || '08:00 ص',
                    availableSeats: body.availableSeats || 3,
                    totalSeats: body.totalSeats || 4,
                    pricePerSeatIqd: body.pricePerSeatIqd || 3000,
                    notes: body.notes || '',
                    status: 'Open',
                    createdAt: new Date().toISOString()
                };
                if (!state.vacancyAds) state.vacancyAds = [];
                state.vacancyAds.unshift(newAd);
                saveState();
                return json(newAd);
            });
        }
    }

    // Serve Uploaded Driver Documents
    if (pathname.startsWith('/uploads/')) {
        const uploadFile = path.join(UPLOADS_DIR, pathname.replace(/^\/uploads\//, ''));
        if (fs.existsSync(uploadFile)) {
            const ext = path.extname(uploadFile).toLowerCase();
            const contentType = mimeTypes[ext] || 'image/jpeg';
            return fs.readFile(uploadFile, (err, content) => {
                if (err) {
                    res.writeHead(404);
                    return res.end('File not found');
                }
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
            });
        }
    }

    // Android APK Direct Download Route
    if (pathname === '/downloads/tawseela.apk' || pathname === '/tawseela.apk') {
        const apkPath = path.join(__dirname, '..', 'apps', 'taxi_wisam_flutter', 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
        const altApkPath = path.join(__dirname, '..', 'data', 'tawseela.apk');
        const target = fs.existsSync(apkPath) ? apkPath : (fs.existsSync(altApkPath) ? altApkPath : null);
        if (target) {
            res.writeHead(200, {
                'Content-Type': 'application/vnd.android.package-archive',
                'Content-Disposition': 'attachment; filename="tawseela.apk"'
            });
            return fs.createReadStream(target).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('جاري تجهيز حزمة APK، يرجى إعادة المحاولة بعد اكتمال البناء.');
        }
    }

    // -------------------------------------------------------------------------
    // Static Files (Dashboard UI)
    // -------------------------------------------------------------------------
    let filePath = path.join(DASHBOARD_DIR, pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/' ? 'index.html' : pathname.replace(/^\/dashboard\//, ''));

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // Fallback to index.html
            filePath = path.join(DASHBOARD_DIR, 'index.html');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        fs.readFile(filePath, (readErr, content) => {
            if (readErr) {
                res.writeHead(500);
                res.end('Error loading dashboard file');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        });
    });
});

server.listen(PORT, () => {
    console.log(`\n========================================================`);
    console.log(`🚖 Taxi-Wisam Admin Dashboard Live Server Running!`);
    console.log(`🔗 Dashboard URL: http://localhost:${PORT}/dashboard/index.html`);
    console.log(`🔗 Direct URL:    http://localhost:${PORT}`);
    console.log(`========================================================\n`);
});
