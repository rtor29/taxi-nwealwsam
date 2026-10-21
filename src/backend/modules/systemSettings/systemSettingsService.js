/**
 * System Settings & Operational Constants Service
 * Decouples hardcoded constants from codebase into postgres system_settings table
 * with in-memory caching and resilient defaults.
 */

const db = require('../../db');

const DEFAULTS = {
    // Dispatch & Safety
    proximity_radius_meters: 1000,
    speed_jump_limit_kmh: 140,
    step_timeout_seconds: 20,
    // Reconciliation & Cancellation
    fare_discrepancy_threshold_iqd: 500,
    fare_rounding_multiple_iqd: 250,
    cancellation_fee_iqd: 1500,
    // Round Trip & External Nav (Batch 2)
    minute_wait_rate_iqd: 100,
    free_wait_minutes: 5,
    max_wait_minutes: 60,
    round_trip_discount_percent: 0,
    external_nav_timeout_minutes: 15
};

class SystemSettingsService {
    constructor() {
        this._cache = { ...DEFAULTS };
        this._lastLoaded = 0;
        this._ttlMs = 60000; // 60 seconds cache TTL
        this._loadPromise = null;
    }

    async refreshCache() {
        if (!db.pool || !db.isPostgresConnected) {
            return this._cache;
        }

        try {
            const client = await db.pool.connect();
            try {
                const res = await client.query(
                    `SELECT key, value_json FROM system_settings WHERE key IN (
                        'dispatch_constants',
                        'reconciliation_constants',
                        'proximity_radius_meters',
                        'fare_discrepancy_threshold_iqd',
                        'fare_rounding_multiple_iqd',
                        'cancellation_fee_iqd',
                        'speed_jump_limit_kmh',
                        'step_timeout_seconds',
                        'minute_wait_rate_iqd',
                        'free_wait_minutes',
                        'max_wait_minutes',
                        'round_trip_discount_percent',
                        'external_nav_timeout_minutes'
                    )`
                );

                // Priority Rule:
                // 1. First parse legacy composite rows as fallback
                const compositeKeys = ['dispatch_constants', 'reconciliation_constants'];
                for (const row of res.rows.filter(r => compositeKeys.includes(r.key))) {
                    try {
                        const parsed = typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json;
                        if (!parsed) continue;

                        if (row.key === 'dispatch_constants') {
                            if (parsed.proximity_radius_meters !== undefined) this._cache.proximity_radius_meters = Number(parsed.proximity_radius_meters);
                            if (parsed.step_timeout_seconds !== undefined) this._cache.step_timeout_seconds = Number(parsed.step_timeout_seconds);
                            if (parsed.speed_jump_limit_kmh !== undefined) this._cache.speed_jump_limit_kmh = Number(parsed.speed_jump_limit_kmh);
                        } else if (row.key === 'reconciliation_constants') {
                            if (parsed.fare_discrepancy_threshold_iqd !== undefined) this._cache.fare_discrepancy_threshold_iqd = Number(parsed.fare_discrepancy_threshold_iqd);
                            if (parsed.fare_rounding_multiple_iqd !== undefined) this._cache.fare_rounding_multiple_iqd = Number(parsed.fare_rounding_multiple_iqd);
                            if (parsed.cancellation_fee_iqd !== undefined) this._cache.cancellation_fee_iqd = Number(parsed.cancellation_fee_iqd);
                        }
                    } catch (_) {}
                }

                // 2. Then apply individual keys (SINGLE SOURCE OF TRUTH - overrides composite values)
                for (const row of res.rows.filter(r => !compositeKeys.includes(r.key))) {
                    try {
                        const parsed = typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json;
                        if (parsed === null || parsed === undefined) continue;
                        const val = parsed.value !== undefined ? parsed.value : parsed;
                        if (typeof val === 'number' || (typeof val === 'string' && !isNaN(Number(val)))) {
                            this._cache[row.key] = Number(val);
                        }
                    } catch (_) {}
                }

                this._lastLoaded = Date.now();
            } finally {
                client.release();
            }
        } catch (err) {
            // Keep existing cache on transient database error
        }

        return this._cache;
    }

    getConstant(key, fallback = null) {
        // Trigger background refresh if TTL expired
        if (Date.now() - this._lastLoaded > this._ttlMs) {
            this.refreshCache().catch(() => {});
        }
        if (this._cache[key] !== undefined) {
            return this._cache[key];
        }
        return fallback !== null ? fallback : DEFAULTS[key];
    }

    getProximityRadiusMeters() {
        return this.getConstant('proximity_radius_meters', DEFAULTS.proximity_radius_meters);
    }

    getFareDiscrepancyThresholdIqd() {
        return this.getConstant('fare_discrepancy_threshold_iqd', DEFAULTS.fare_discrepancy_threshold_iqd);
    }

    getFareRoundingMultipleIqd() {
        return this.getConstant('fare_rounding_multiple_iqd', DEFAULTS.fare_rounding_multiple_iqd);
    }

    getCancellationFeeIqd() {
        return this.getConstant('cancellation_fee_iqd', DEFAULTS.cancellation_fee_iqd);
    }

    getSpeedJumpLimitKmh() {
        return this.getConstant('speed_jump_limit_kmh', DEFAULTS.speed_jump_limit_kmh);
    }

    getStepTimeoutSeconds() {
        return this.getConstant('step_timeout_seconds', DEFAULTS.step_timeout_seconds);
    }

    getMinuteWaitRateIqd() {
        return this.getConstant('minute_wait_rate_iqd', DEFAULTS.minute_wait_rate_iqd);
    }

    getFreeWaitMinutes() {
        return this.getConstant('free_wait_minutes', DEFAULTS.free_wait_minutes);
    }

    getMaxWaitMinutes() {
        return this.getConstant('max_wait_minutes', DEFAULTS.max_wait_minutes);
    }

    getRoundTripDiscountPercent() {
        return this.getConstant('round_trip_discount_percent', DEFAULTS.round_trip_discount_percent);
    }

    getExternalNavTimeoutMinutes() {
        return this.getConstant('external_nav_timeout_minutes', DEFAULTS.external_nav_timeout_minutes);
    }

    getAllConstants() {
        return {
            proximity_radius_meters: this.getProximityRadiusMeters(),
            fare_discrepancy_threshold_iqd: this.getFareDiscrepancyThresholdIqd(),
            fare_rounding_multiple_iqd: this.getFareRoundingMultipleIqd(),
            cancellation_fee_iqd: this.getCancellationFeeIqd(),
            speed_jump_limit_kmh: this.getSpeedJumpLimitKmh(),
            step_timeout_seconds: this.getStepTimeoutSeconds(),
            minute_wait_rate_iqd: this.getMinuteWaitRateIqd(),
            free_wait_minutes: this.getFreeWaitMinutes(),
            max_wait_minutes: this.getMaxWaitMinutes(),
            round_trip_discount_percent: this.getRoundTripDiscountPercent(),
            external_nav_timeout_minutes: this.getExternalNavTimeoutMinutes()
        };
    }
}

const systemSettingsService = new SystemSettingsService();
module.exports = systemSettingsService;
