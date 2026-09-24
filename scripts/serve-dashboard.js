// Backward-compatible entry point delegating to the unified PostgreSQL backend server
const { startServer } = require('../src/backend/server');

startServer().catch(err => {
    console.error('Fatal server boot error:', err);
    process.exit(1);
});
