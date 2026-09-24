const path = require('path');
const fs = require('fs');

let googleSecretConfig = {};
try {
    const secPath = path.join(__dirname, '..', '..', '..', 'google_client_secret.json');
    if (fs.existsSync(secPath)) {
        const parsed = JSON.parse(fs.readFileSync(secPath, 'utf8'));
        googleSecretConfig = parsed.web || parsed.installed || {};
    }
} catch (_) {}

const config = {
    port: parseInt(process.env.PORT || '5050', 10),
    env: process.env.NODE_ENV || 'production',
    
    // Database Configuration (PostgreSQL self-hosted)
    databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/taxiwisam',
    pg: {
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5432', 10),
        database: process.env.PGDATABASE || 'taxiwisam',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'postgres',
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 4000,
    },

    // Google OAuth 2.0
    googleClientId: process.env.GOOGLE_CLIENT_ID || googleSecretConfig.client_id || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || googleSecretConfig.client_secret || '',

    // Static Paths
    dashboardDir: process.env.DASHBOARD_DIR || path.join(__dirname, '..', '..', 'TaxiWisam.Api', 'wwwroot', 'dashboard'),
    flutterWebDir: process.env.FLUTTER_WEB_DIR || path.join(__dirname, '..', '..', '..', 'apps', 'taxi_wisam_flutter', 'build', 'web'),
    dataFile: process.env.DATA_FILE || path.join(__dirname, '..', '..', '..', 'data', 'state.json'),
    uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', '..', 'data', 'uploads'),

    // Admin Credentials
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '1122',

    // Najaf Default Coordinates
    najafDefaults: {
        latitude: 31.9961,
        longitude: 44.3168,
        city: 'النجف الأشرف'
    }
};

if (!fs.existsSync(config.uploadsDir)) {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
}

module.exports = config;
