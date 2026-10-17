const db = require('../../db');

/**
 * Enterprise Audit Logging Service for Tawseela Platform
 * Ensures all sensitive administrative and security actions are persisted in PostgreSQL
 */
class AuditService {
    /**
     * Records an audit event both in PostgreSQL (persistent) and in-memory cache
     */
    async logAuditEvent({
        action,
        entityType = 'System',
        entityId = 'N/A',
        actor = 'المشرف العام (Admin)',
        details = {},
        ip = '127.0.0.1',
        userAgent = ''
    }) {
        if (!action) {
            console.warn('[AuditService] logAuditEvent called without action');
            return null;
        }

        const timestamp = new Date().toISOString();
        const payload = {
            actor: actor || 'المشرف العام (Admin)',
            userAgent: userAgent || '',
            timestamp,
            ...(typeof details === 'object' && details !== null ? details : { raw: details })
        };
        const newValuesJson = JSON.stringify(payload);
        const entityName = entityType || 'System';
        const entId = String(entityId || 'N/A');
        const clientIp = (ip || '127.0.0.1').toString().split(',')[0].trim();

        const logEntry = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            action,
            entityName,
            entityId: entId,
            newValuesJson,
            ipAddress: clientIp,
            createdAt: timestamp
        };

        // 1. In-memory cache update
        if (db.memoryState && Array.isArray(db.memoryState.auditLogs)) {
            db.memoryState.auditLogs.unshift(logEntry);
            if (db.memoryState.auditLogs.length > 1000) {
                db.memoryState.auditLogs = db.memoryState.auditLogs.slice(0, 1000);
            }
        }

        // 2. Persistent PostgreSQL insert
        if (db.isPostgresConnected && db.pool) {
            try {
                const res = await db.pool.query(`
                    INSERT INTO audit_logs (action, entity_name, entity_id, new_values_json, ip_address, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, action, entity_name, entity_id, new_values_json, ip_address, created_at
                `, [action, entityName, entId, newValuesJson, clientIp, timestamp]);

                if (res.rows && res.rows[0]) {
                    logEntry.id = res.rows[0].id;
                }
            } catch (err) {
                console.warn('[AuditService] PostgreSQL insertion warning:', err.message);
            }
        }

        return logEntry;
    }

    /**
     * Retrieves audit logs with pagination, type filtering, and search
     */
    async getAuditLogs({ limit = 200, offset = 0, action = '', search = '' } = {}) {
        const lim = Math.max(1, Math.min(parseInt(limit, 10) || 200, 1000));
        const off = Math.max(0, parseInt(offset, 10) || 0);

        if (db.isPostgresConnected && db.pool) {
            try {
                const whereClauses = [];
                const params = [];
                let pIndex = 1;

                if (action && action !== 'all') {
                    // Match action category
                    if (action === 'pricing') {
                        whereClauses.push(`(action ILIKE '%pricing%' OR action ILIKE '%setting%' OR entity_name ILIKE '%setting%')`);
                    } else if (action === 'driver_verification') {
                        whereClauses.push(`(action ILIKE '%driver%' OR action ILIKE '%verif%' OR entity_name ILIKE '%driver%')`);
                    } else if (action === 'cancellation') {
                        whereClauses.push(`(action ILIKE '%cancell%' OR entity_name ILIKE '%cancell%')`);
                    } else if (action === 'database') {
                        whereClauses.push(`(action ILIKE '%backup%' OR action ILIKE '%restore%' OR entity_name ILIKE '%database%')`);
                    } else if (action === 'auth') {
                        whereClauses.push(`(action ILIKE '%login%' OR action ILIKE '%logout%' OR action ILIKE '%auth%')`);
                    } else {
                        whereClauses.push(`action ILIKE $${pIndex++}`);
                        params.push(`%${action}%`);
                    }
                }

                if (search && search.trim()) {
                    const s = `%${search.trim()}%`;
                    whereClauses.push(`(
                        entity_id ILIKE $${pIndex} OR 
                        ip_address ILIKE $${pIndex} OR 
                        action ILIKE $${pIndex} OR 
                        entity_name ILIKE $${pIndex} OR 
                        new_values_json ILIKE $${pIndex}
                    )`);
                    params.push(s);
                    pIndex++;
                }

                const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

                // Count total
                const countRes = await db.pool.query(
                    `SELECT COUNT(*)::int AS total FROM audit_logs ${whereSql}`,
                    params
                );
                const total = countRes.rows[0]?.total || 0;

                // Query paginated rows
                const dataRes = await db.pool.query(`
                    SELECT 
                        id,
                        action,
                        entity_name AS "entityName",
                        entity_id AS "entityId",
                        new_values_json AS "newValuesJson",
                        ip_address AS "ipAddress",
                        created_at AS "createdAt"
                    FROM audit_logs
                    ${whereSql}
                    ORDER BY created_at DESC
                    LIMIT $${pIndex++} OFFSET $${pIndex++}
                `, [...params, lim, off]);

                return {
                    success: true,
                    total,
                    limit: lim,
                    offset: off,
                    logs: dataRes.rows
                };
            } catch (err) {
                console.warn('[AuditService] getAuditLogs DB query warning:', err.message);
            }
        }

        // In-memory fallback
        let logs = (db.memoryState && Array.isArray(db.memoryState.auditLogs)) ? [...db.memoryState.auditLogs] : [];

        if (action && action !== 'all') {
            const act = action.toLowerCase();
            logs = logs.filter(l => {
                const a = (l.action || '').toLowerCase();
                const e = (l.entityName || '').toLowerCase();
                if (action === 'pricing') return a.includes('pricing') || a.includes('setting') || e.includes('setting');
                if (action === 'driver_verification') return a.includes('driver') || a.includes('verif') || e.includes('driver');
                if (action === 'cancellation') return a.includes('cancell') || e.includes('cancell');
                if (action === 'database') return a.includes('backup') || a.includes('restore') || e.includes('database');
                if (action === 'auth') return a.includes('login') || a.includes('logout') || a.includes('auth');
                return a.includes(act);
            });
        }

        if (search && search.trim()) {
            const s = search.trim().toLowerCase();
            logs = logs.filter(l =>
                (l.entityId || '').toLowerCase().includes(s) ||
                (l.ipAddress || '').toLowerCase().includes(s) ||
                (l.action || '').toLowerCase().includes(s) ||
                (l.entityName || '').toLowerCase().includes(s) ||
                (l.newValuesJson || '').toLowerCase().includes(s)
            );
        }

        const total = logs.length;
        const paginated = logs.slice(off, off + lim);

        return {
            success: true,
            total,
            limit: lim,
            offset: off,
            logs: paginated
        };
    }
}

module.exports = new AuditService();
