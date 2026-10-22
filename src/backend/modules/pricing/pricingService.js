/**
 * Dynamic Surge Pricing Engine for Instant Taxi Rides (توصيلة - التكسي الفوري فقط)
 * 
 * Rules:
 * 1. Scope: Instant taxi rides only (Never modifies fixed route subscriptions).
 * 2. Formula: Total Fare = (Base Fare + (Distance_KM * KM_Rate) + (Duration_Minutes * Minute_Rate)) * Multipliers - Discount
 * 3. Factors:
 *    - Demand/Supply ratio in area (5km radius).
 *    - Night Surge (00:00 - 05:30 Baghdad time, +25%).
 *    - Traffic Congestion (estimated from Mapbox duration/km speed).
 *    - Manual Emergency Override (e.g. +25% Ziyarah in Najaf, +50% Extreme Surge, -10% Low Demand, 1.0x Normal).
 *    - Surge Cap (maxSurgeMultiplier, e.g. 2.0x).
 *    - Minimum Fare floor (e.g. 2,500 IQD).
 *    - Iraqi Dinar Rounding: ALWAYS round to nearest 250 IQD.
 */

const db = require('../../db');
const auditService = require('../audit/auditService');
const systemSettingsService = require('../systemSettings/systemSettingsService');

const DEFAULT_PRICING = {
    baseFare: 1000,                // فتح العداد د.ع (معيار تسعيرة بلي القياسية)
    kmRate: 500,                   // سعر الكيلومتر الواحد د.ع (معيار بلي)
    minuteRate: 100,               // سعر دقيقة الوقت/الانتظار د.ع (معيار بلي)
    minFare: 3000,                 // الحد الأدنى للأجرة د.ع (معيار بلي)
    cancellationFee: 1500,         // رسوم إلغاء الرحلة د.ع (معيار بلي بعد دقيقتين أو وصول الكابتن)
    enableDynamicSurge: true,      // تفعيل التسعير الديناميكي الذكي
    maxSurgeMultiplier: 2.0,       // سقف أقصى للذروة
    nightSurgePercent: 25,         // نسبة الزيادة الليلية % (00:00 - 05:30)
    demandSensitivity: 1.0,        // حساسية العرض والطلب (1.0 = عادي)
    manualOverrideMultiplier: 1.0, // مضاعف العرض والطلب الافتراضي (1.0x الوضع الطبيعي)
    manualOverrideLabel: 'وضع طبيعي (1.0x)',
    discountPercent: 0,            // خصم ركود بالنسبة مئوية %
    discountFixed: 0,              // خصم ركود ثابت د.ع
    tierSurchargeEconomy: 0,       // مبلغ إضافي لفئة توفير د.ع (0)
    tierSurchargeSuper: 250,       // مبلغ إضافي لفئة سوبر د.ع (250)
    tierSurchargePlus: 500         // مبلغ إضافي لفئة بلس د.ع (500)
};

class PricingService {
    /**
     * Get current pricing settings merged with defaults
     */
    getPricingSettings() {
        try {
            const list = db.memoryState.settings || [];
            const found = list.find(s => s.key === 'PricingParameters' || s.key === 'pricing_settings');
            if (found && found.valueJson) {
                const parsed = typeof found.valueJson === 'string' ? JSON.parse(found.valueJson) : found.valueJson;
                return {
                    baseFare: Number(parsed.baseFare ?? parsed.base_fare_iqd ?? parsed.BaseFareIqd ?? DEFAULT_PRICING.baseFare),
                    kmRate: Number(parsed.kmRate ?? parsed.per_km_rate_iqd ?? parsed.PerKmRateIqd ?? DEFAULT_PRICING.kmRate),
                    minuteRate: Number(parsed.minuteRate ?? parsed.per_minute_rate_iqd ?? parsed.PerMinuteWaitIqd ?? DEFAULT_PRICING.minuteRate),
                    minFare: Number(parsed.minFare ?? parsed.min_fare_iqd ?? DEFAULT_PRICING.minFare),
                    cancellationFee: Number(parsed.cancellationFee ?? parsed.cancellation_fee_iqd ?? (systemSettingsService ? systemSettingsService.getCancellationFeeIqd() : DEFAULT_PRICING.cancellationFee)),
                    enableDynamicSurge: parsed.enableDynamicSurge !== undefined ? Boolean(parsed.enableDynamicSurge) : DEFAULT_PRICING.enableDynamicSurge,
                    maxSurgeMultiplier: Number(parsed.maxSurgeMultiplier ?? parsed.surge_multiplier_max ?? parsed.SurgeMultiplierMax ?? DEFAULT_PRICING.maxSurgeMultiplier),
                    nightSurgePercent: Number(parsed.nightSurgePercent ?? DEFAULT_PRICING.nightSurgePercent),
                    demandSensitivity: Number(parsed.demandSensitivity ?? DEFAULT_PRICING.demandSensitivity),
                    manualOverrideMultiplier: Number(parsed.manualOverrideMultiplier ?? 1.0),
                    manualOverrideLabel: parsed.manualOverrideLabel || 'وضع طبيعي (1.0x)',
                    discountPercent: Number(parsed.discountPercent ?? 0),
                    discountFixed: Number(parsed.discountFixed ?? 0),
                    tierSurchargeEconomy: systemSettingsService ? systemSettingsService.getVehicleTierSurchargeEconomyIqd() : Number(parsed.tierSurchargeEconomy ?? DEFAULT_PRICING.tierSurchargeEconomy),
                    tierSurchargeSuper: systemSettingsService ? systemSettingsService.getVehicleTierSurchargeSuperIqd() : Number(parsed.tierSurchargeSuper ?? DEFAULT_PRICING.tierSurchargeSuper),
                    tierSurchargePlus: systemSettingsService ? systemSettingsService.getVehicleTierSurchargePlusIqd() : Number(parsed.tierSurchargePlus ?? DEFAULT_PRICING.tierSurchargePlus)
                };
            }
        } catch (e) {
            console.warn('[PricingService] Error loading pricing settings:', e.message);
        }
        return {
            ...DEFAULT_PRICING,
            tierSurchargeEconomy: systemSettingsService ? systemSettingsService.getVehicleTierSurchargeEconomyIqd() : DEFAULT_PRICING.tierSurchargeEconomy,
            tierSurchargeSuper: systemSettingsService ? systemSettingsService.getVehicleTierSurchargeSuperIqd() : DEFAULT_PRICING.tierSurchargeSuper,
            tierSurchargePlus: systemSettingsService ? systemSettingsService.getVehicleTierSurchargePlusIqd() : DEFAULT_PRICING.tierSurchargePlus
        };
    }

    /**
     * Save pricing settings with audit logging & DB persistence
     */
    async savePricingSettings(newSettings, actor = 'المشرف العام (Admin)', ip = '127.0.0.1') {
        const current = this.getPricingSettings();
        const merged = {
            baseFare: Math.max(500, Number(newSettings.baseFare ?? current.baseFare)),
            kmRate: Math.max(100, Number(newSettings.kmRate ?? current.kmRate)),
            minuteRate: Math.max(0, Number(newSettings.minuteRate ?? current.minuteRate)),
            minFare: Math.max(1000, Number(newSettings.minFare ?? current.minFare)),
            cancellationFee: Math.min(10000, Math.max(0, Number(newSettings.cancellationFee ?? current.cancellationFee ?? 1500))),
            enableDynamicSurge: newSettings.enableDynamicSurge !== undefined ? Boolean(newSettings.enableDynamicSurge) : current.enableDynamicSurge,
            maxSurgeMultiplier: Math.min(5.0, Math.max(1.0, Number(newSettings.maxSurgeMultiplier ?? current.maxSurgeMultiplier))),
            nightSurgePercent: Math.min(100, Math.max(0, Number(newSettings.nightSurgePercent ?? current.nightSurgePercent))),
            demandSensitivity: Math.min(3.0, Math.max(0.2, Number(newSettings.demandSensitivity ?? current.demandSensitivity))),
            manualOverrideMultiplier: Math.min(4.0, Math.max(0.5, Number(newSettings.manualOverrideMultiplier ?? current.manualOverrideMultiplier))),
            manualOverrideLabel: String(newSettings.manualOverrideLabel ?? current.manualOverrideLabel),
            discountPercent: Math.min(50, Math.max(0, Number(newSettings.discountPercent ?? current.discountPercent))),
            discountFixed: Math.max(0, Number(newSettings.discountFixed ?? current.discountFixed)),
            tierSurchargeEconomy: Math.max(0, Number(newSettings.tierSurchargeEconomy ?? newSettings.vehicle_tier_surcharge_economy_iqd ?? current.tierSurchargeEconomy ?? 0)),
            tierSurchargeSuper: Math.max(0, Number(newSettings.tierSurchargeSuper ?? newSettings.vehicle_tier_surcharge_super_iqd ?? current.tierSurchargeSuper ?? 250)),
            tierSurchargePlus: Math.max(0, Number(newSettings.tierSurchargePlus ?? newSettings.vehicle_tier_surcharge_plus_iqd ?? current.tierSurchargePlus ?? 500))
        };

        const jsonStr = JSON.stringify(merged);

        // Update memoryState
        if (!db.memoryState.settings) db.memoryState.settings = [];
        let settingEntry = db.memoryState.settings.find(s => s.key === 'PricingParameters');
        if (settingEntry) {
            settingEntry.valueJson = jsonStr;
        } else {
            settingEntry = {
                key: 'PricingParameters',
                valueJson: jsonStr,
                description: 'معايير التسعير والذروة الديناميكية لمشاوير التكسي الفوري'
            };
            db.memoryState.settings.push(settingEntry);
        }

        const updateIndividualSetting = (k, v, desc) => {
            const entry = db.memoryState.settings.find(s => s.key === k);
            if (entry) {
                entry.valueJson = String(v);
            } else {
                db.memoryState.settings.push({ key: k, valueJson: String(v), description: desc });
            }
        };
        updateIndividualSetting('vehicle_tier_surcharge_economy_iqd', merged.tierSurchargeEconomy, 'مبلغ إضافي لفئة توفير (د.ع)');
        updateIndividualSetting('vehicle_tier_surcharge_super_iqd', merged.tierSurchargeSuper, 'مبلغ إضافي لفئة سوبر (د.ع)');
        updateIndividualSetting('vehicle_tier_surcharge_plus_iqd', merged.tierSurchargePlus, 'مبلغ إضافي لفئة بلس (د.ع)');

        // Also update legacy pricing_settings key for compatibility
        let legacyEntry = db.memoryState.settings.find(s => s.key === 'pricing_settings');
        if (legacyEntry) {
            legacyEntry.valueJson = JSON.stringify({
                base_fare_iqd: merged.baseFare,
                per_km_rate_iqd: merged.kmRate,
                per_minute_rate_iqd: merged.minuteRate,
                min_fare_iqd: merged.minFare,
                cancellation_fee_iqd: merged.cancellationFee,
                surge_multiplier_max: merged.maxSurgeMultiplier
            });
        }

        // Persist to PostgreSQL if connected
        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    INSERT INTO system_settings (key, value_json, description, updated_at)
                    VALUES ($1, $2, $3, NOW())
                    ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
                `, ['PricingParameters', jsonStr, 'معايير التسعير والذروة الديناميكية لمشاوير التكسي الفوري']);

                await db.pool.query(`
                    INSERT INTO system_settings (key, value_json, description, updated_at)
                    VALUES 
                        ('vehicle_tier_surcharge_economy_iqd', $1, 'مبلغ إضافي لفئة توفير (د.ع)', NOW()),
                        ('vehicle_tier_surcharge_super_iqd', $2, 'مبلغ إضافي لفئة سوبر (د.ع)', NOW()),
                        ('vehicle_tier_surcharge_plus_iqd', $3, 'مبلغ إضافي لفئة بلس (د.ع)', NOW())
                    ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
                `, [String(merged.tierSurchargeEconomy), String(merged.tierSurchargeSuper), String(merged.tierSurchargePlus)]);
            } catch (e) {
                console.warn('[PricingService] PostgreSQL update error:', e.message);
            }
        }

        // Refresh system settings service cache
        if (systemSettingsService && typeof systemSettingsService.refreshCache === 'function') {
            try {
                await systemSettingsService.refreshCache();
            } catch (_) {}
        }

        // Snapshot to state.json
        db.saveStateSnapshot();

        // Audit Log
        try {
            await auditService.logAuditEvent({
                action: 'PricingParametersUpdated',
                entityType: 'SystemSetting',
                entityId: 'PricingParameters',
                actor: actor || 'المشرف العام (Admin)',
                details: {
                    previous: current,
                    updated: merged,
                    summary: `تحديث إعدادات التسعير: فتح العداد ${merged.baseFare} د.ع، الكيلومتر ${merged.kmRate} د.ع، الحد الأدنى ${merged.minFare} د.ع، رسوم الإلغاء ${merged.cancellationFee} د.ع، الذروة القصوى ${merged.maxSurgeMultiplier}x`
                },
                ip: ip || '127.0.0.1'
            });
        } catch (logErr) {
            console.warn('[PricingService] Audit log error:', logErr.message);
        }

        return { success: true, settings: merged };
    }

    /**
     * Check if current time in Baghdad (Asia/Baghdad) is late night (00:00 to 05:30)
     */
    isNightTimeBaghdad(customDate = null) {
        try {
            const date = customDate || new Date();
            // Format to Asia/Baghdad hour and minute
            const formatter = new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Asia/Baghdad',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            const parts = formatter.formatToParts(date);
            const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
            const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

            // Night surge window: 00:00 to 05:30
            if (hour >= 0 && hour < 5) return true;
            if (hour === 5 && minute <= 30) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Round amount to the configured multiple of Iraqi Dinars (Nearest multiple: Math.round)
     */
    roundToNearest250(amount) {
        const mult = systemSettingsService ? systemSettingsService.getFareRoundingMultipleIqd() : 250;
        return Math.round(Number(amount) / mult) * mult;
    }

    /**
     * Calculate instant taxi ride fare dynamically
     * @param {Object} options
     * @param {number} options.pickupLat
     * @param {number} options.pickupLon
     * @param {number} options.dropoffLat
     * @param {number} options.dropoffLon
     * @param {number} options.distanceKm
     * @param {number} options.durationMins
     * @param {string} options.vehicleType - 'eco' | 'super' | 'vip' | 'plus'
     * @param {boolean} options.isRoundTrip
     * @param {boolean} options.hasSecondStop
     * @param {string} options.promoCode
     * @param {boolean} options.simulatedNight
     * @param {number} options.simulatedDemandMultiplier
     */
    calculateInstantRideFare(options = {}) {
        const settings = this.getPricingSettings();

        const distanceKm = Math.max(0.5, Number(options.distanceKm) || 3.0);
        const durationMins = Math.max(3, Number(options.durationMins) || Math.round(distanceKm * 2.5));
        const vehicleType = (options.vehicleType || options.tier || 'super').toLowerCase();
        const isRoundTrip = Boolean(options.isRoundTrip);
        const hasSecondStop = Boolean(options.hasSecondStop);

        // Vehicle tier surcharges (Fixed addition before rounding to nearest 250 IQD)
        const ecoSurcharge = Number(settings.tierSurchargeEconomy ?? 0);
        const supSurcharge = Number(settings.tierSurchargeSuper ?? 250);
        const pluSurcharge = Number(settings.tierSurchargePlus ?? 500);

        let tierSurcharge = supSurcharge;
        let tierKey = 'super';
        let tierNameAr = 'سوبر (الخيار الأفضل)';

        if (vehicleType === 'eco' || vehicleType === 'saving' || vehicleType === 'توفير') {
            tierKey = 'saving';
            tierNameAr = 'توفير (التكسي الأوفر)';
            tierSurcharge = ecoSurcharge;
        } else if (vehicleType === 'plus' || vehicleType === 'vip' || vehicleType === 'بلس' || vehicleType === 'بلَس') {
            tierKey = 'plus';
            tierNameAr = 'بلَس (خدمة أكثر راحة)';
            tierSurcharge = pluSurcharge;
        }

        // 1. Base components (Standard fare without tier percentage)
        const baseFare = settings.baseFare;
        const distanceFare = distanceKm * settings.kmRate;
        const timeFare = durationMins * settings.minuteRate;

        const rawStandardFare = baseFare + distanceFare + timeFare;

        // 2. Dynamic Factors
        let demandMultiplier = 1.0;
        let demandReason = '';
        let nearbyDriversCount = 0;
        let activeRequestsCount = 0;

        // Check if dynamic surge is enabled
        if (settings.enableDynamicSurge) {
            if (options.simulatedDemandMultiplier !== undefined) {
                // Testing / Simulation mode
                demandMultiplier = Number(options.simulatedDemandMultiplier);
                if (demandMultiplier > 1.0) {
                    demandReason = 'نقص ملحوظ في عدد السائقين بالنسبة للطلبات';
                }
            } else {
                // Real-time calculation from active drivers & pending rides
                const pLat = Number(options.pickupLat) || 31.9961;
                const pLon = Number(options.pickupLon) || 44.3168;

                const toRad = deg => deg * Math.PI / 180;
                const haversineKm = (lat1, lon1, lat2, lon2) => {
                    const R = 6371;
                    const dLat = toRad(lat2 - lat1);
                    const dLon = toRad(lon2 - lon1);
                    const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
                    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                };

                // Online instant taxi drivers within 5km
                const drivers = (db.memoryState.drivers || []).filter(d => {
                    const isOnline = d.isOnline === true || d.status === 'Active' || d.workStatus === 'Active';
                    const isInstant = d.work_mode !== 'خط دائمي' && d.workStatus !== 'permanent';
                    if (!isOnline || !isInstant) return false;
                    const dLat = d.currentLat ? parseFloat(d.currentLat) : (d.permanentLat ? parseFloat(d.permanentLat) : pLat);
                    const dLon = d.currentLon ? parseFloat(d.currentLon) : (d.permanentLon ? parseFloat(d.permanentLon) : pLon);
                    const dist = haversineKm(pLat, pLon, dLat, dLon);
                    return dist <= 6.0;
                });
                nearbyDriversCount = drivers.length;

                // Pending or InProgress instant rides in the last 15 minutes
                const now = Date.now();
                const recentRides = (db.memoryState.rideRequests || []).filter(r => {
                    if (r.status === 'Completed' || r.status === 'Cancelled') return false;
                    const createdAt = new Date(r.createdAt || now).getTime();
                    return (now - createdAt) < 15 * 60 * 1000;
                });
                activeRequestsCount = recentRides.length;

                // Determine supply/demand surge
                const sensitivity = settings.demandSensitivity || 1.0;
                if (nearbyDriversCount === 0 && activeRequestsCount >= 1) {
                    demandMultiplier = 1.35 * sensitivity;
                    demandReason = 'قلة السائقين المتاحين في محيطك حالياً';
                } else if (nearbyDriversCount <= 2 && activeRequestsCount >= 2) {
                    demandMultiplier = 1.25 * sensitivity;
                    demandReason = 'طلب مرتفع جداً مقارنة بعدد السائقين المتواجدين';
                } else if (nearbyDriversCount <= 1) {
                    demandMultiplier = 1.15 * sensitivity;
                    demandReason = 'عدد محدود من السائقين في منطقتك';
                }
            }
        }

        // 3. Night Surge Factor
        let isNight = false;
        let nightMultiplier = 1.0;
        if (options.simulatedNight !== undefined) {
            isNight = Boolean(options.simulatedNight);
        } else {
            isNight = this.isNightTimeBaghdad();
        }

        if (settings.enableDynamicSurge && isNight && settings.nightSurgePercent > 0) {
            nightMultiplier = 1.0 + (settings.nightSurgePercent / 100);
        }

        // 4. Traffic Congestion Factor
        // If speed is very slow (< 18 km/h in urban streets), traffic surge applies
        let trafficMultiplier = 1.0;
        let trafficReason = '';
        const avgSpeedKmh = (distanceKm / (durationMins / 60));
        if (settings.enableDynamicSurge && avgSpeedKmh < 18 && durationMins > 10) {
            if (avgSpeedKmh < 10) {
                trafficMultiplier = 1.20; // Severe congestion
                trafficReason = 'ازدحام مروري خانق على طول المسار';
            } else {
                trafficMultiplier = 1.10; // Moderate congestion
                trafficReason = 'حركة سير بطيئة وازدحام';
            }
        }

        // 5. Manual Emergency Override Factor
        const manualMultiplier = Number(settings.manualOverrideMultiplier) || 1.0;

        // Combine multipliers
        // In real ride-hailing systems, surge factors compound or take the max primary with modifiers
        let combinedMultiplier = 1.0;
        if (settings.enableDynamicSurge) {
            // Base compound multiplier
            combinedMultiplier = manualMultiplier * (1.0 + (demandMultiplier - 1.0) + (nightMultiplier - 1.0) + (trafficMultiplier - 1.0));
        } else {
            combinedMultiplier = manualMultiplier;
        }

        // Enforce Surge Cap
        const maxCap = Math.max(1.0, settings.maxSurgeMultiplier || 2.0);
        const cappedMultiplier = Math.min(maxCap, Math.max(0.7, combinedMultiplier));
        const wasCapped = combinedMultiplier > maxCap;

        // Apply Multiplier to standard fare
        let calculatedFare = rawStandardFare * cappedMultiplier;

        // Additional trip features
        if (isRoundTrip) {
            calculatedFare *= 1.85; // ذهاب وإياب (خصم تشجيعي 15% على العودة)
        }
        if (hasSecondStop) {
            calculatedFare += 1000; // إضافة محطة توقف إضافية
        }
        if (options.stopDuration) {
            calculatedFare += 500; // توقف في الطريق
        }

        // 6. Discounts & Promotions
        let totalDiscount = 0;
        let discountReason = '';

        if (settings.discountPercent > 0) {
            const pDisc = calculatedFare * (settings.discountPercent / 100);
            totalDiscount += pDisc;
            discountReason = `خصم ركود إداري ${settings.discountPercent}%`;
        }
        if (settings.discountFixed > 0) {
            totalDiscount += settings.discountFixed;
            discountReason = discountReason ? `${discountReason} + ${settings.discountFixed} د.ع` : `خصم خاص ${settings.discountFixed} د.ع`;
        }

        // Promo code discount (e.g. from customer app)
        const promo = String(options.promoCode || '').trim().toUpperCase();
        if (promo && (promo === 'TAWSEELA' || promo === 'BALY' || promo === 'WELCOME' || promo === 'PROMO20')) {
            const promoAmount = calculatedFare * 0.20; // 20% discount
            totalDiscount += promoAmount;
            discountReason = discountReason ? `${discountReason} | قسيمة خصم 20%` : 'قسيمة خصم ترويجية 20%';
        }

        let fareAfterDiscount = Math.max(0, calculatedFare - totalDiscount);

        // 7. Enforce Minimum Fare Floor (Baly Standard: 3,000 IQD)
        const minFare = settings.minFare || 3000;
        const reachedMinimum = fareAfterDiscount < minFare;
        if (reachedMinimum) {
            fareAfterDiscount = minFare;
        }

        // 8. Vehicle Tier Surcharge & Iraqi Dinar Rounding (Nearest 250 IQD Ceil)
        const fareWithTier = fareAfterDiscount + tierSurcharge;
        const finalFare = this.roundToNearest250(fareWithTier);

        // Precompute authoritative fares for all three tiers so API returns tierFares
        const tierFares = {
            saving: this.roundToNearest250(fareAfterDiscount + ecoSurcharge),
            super: this.roundToNearest250(fareAfterDiscount + supSurcharge),
            plus: this.roundToNearest250(fareAfterDiscount + pluSurcharge),
            economy: this.roundToNearest250(fareAfterDiscount + ecoSurcharge)
        };

        // 9. Badges & Explanations
        let surgeBadge = null;
        let discountBadge = null;

        if (cappedMultiplier > 1.05) {
            const surgePercent = Math.round((cappedMultiplier - 1.0) * 100);
            if (manualMultiplier > 1.05 && manualMultiplier >= demandMultiplier) {
                surgeBadge = {
                    text: `⚡ ${settings.manualOverrideLabel} (+${surgePercent}%)`,
                    type: 'manual_surge',
                    percent: surgePercent,
                    multiplier: Number(cappedMultiplier.toFixed(2))
                };
            } else if (demandMultiplier > 1.05) {
                surgeBadge = {
                    text: `⚡ زيادة مؤقتة لقلة السائقين (+${surgePercent}%)`,
                    type: 'demand_surge',
                    percent: surgePercent,
                    multiplier: Number(cappedMultiplier.toFixed(2)),
                    reason: demandReason
                };
            } else if (isNight && nightMultiplier > 1.05) {
                surgeBadge = {
                    text: `🌙 تعرفة ليلية متأخرة (+${surgePercent}%)`,
                    type: 'night_surge',
                    percent: surgePercent,
                    multiplier: Number(cappedMultiplier.toFixed(2))
                };
            } else if (trafficMultiplier > 1.05) {
                surgeBadge = {
                    text: `🚗 ذروة وازدحام مروري (+${surgePercent}%)`,
                    type: 'traffic_surge',
                    percent: surgePercent,
                    multiplier: Number(cappedMultiplier.toFixed(2)),
                    reason: trafficReason
                };
            } else {
                surgeBadge = {
                    text: `⚡ تعرفة ذروة (+${surgePercent}%)`,
                    type: 'surge',
                    percent: surgePercent,
                    multiplier: Number(cappedMultiplier.toFixed(2))
                };
            }
        }

        if (totalDiscount > 0 || manualMultiplier < 0.95) {
            discountBadge = {
                text: discountReason || '🏷️ تم تطبيق خصم خاص',
                type: 'discount',
                amountIqd: this.roundToNearest250(totalDiscount)
            };
        }

        return {
            success: true,
            fare: finalFare,                     // المبلغ النهائي المقرب لأقرب 250 د.ع تصاعدياً
            currency: 'IQD',
            tierFares: tierFares,                // الأسعار المحسوبة حتمياً للفئات الثلاث من الخادم
            breakdown: {
                baseFare: Math.round(baseFare),
                distanceKm: Number(distanceKm.toFixed(1)),
                kmRate: settings.kmRate,
                distanceFare: Math.round(distanceFare),
                durationMins: Math.round(durationMins),
                minuteRate: settings.minuteRate,
                timeFare: Math.round(timeFare),
                rawStandardFare: Math.round(rawStandardFare),
                avgSpeedKmh: Number(avgSpeedKmh.toFixed(1)),
                minFare: minFare,
                tierSurcharge: tierSurcharge,
                tierKey: tierKey,
                tierNameAr: tierNameAr,
                cancellationFee: settings.cancellationFee || 1500
            },
            multipliers: {
                tierSurcharge,
                tierKey,
                tierNameAr,
                demandMultiplier: Number(demandMultiplier.toFixed(2)),
                isNight,
                nightMultiplier: Number(nightMultiplier.toFixed(2)),
                trafficMultiplier: Number(trafficMultiplier.toFixed(2)),
                manualMultiplier: Number(manualMultiplier.toFixed(2)),
                combinedMultiplier: Number(combinedMultiplier.toFixed(2)),
                cappedMultiplier: Number(cappedMultiplier.toFixed(2)),
                wasCapped,
                maxSurgeMultiplier: maxCap
            },
            context: {
                nearbyDriversCount,
                activeRequestsCount,
                reachedMinimum
            },
            surgeBadge,
            discountBadge
        };
    }

    /**
     * Calculate waiting fee based on actual waiting minutes and system settings
     * Formula: Math.max(0, actualWaitMinutes - freeWaitMinutes) * minuteWaitRate
     * @param {number} actualWaitMinutes
     * @returns {{ waitFee: number, actualWaitMinutes: number, billableWaitMinutes: number, freeWaitMinutes: number, minuteWaitRate: number }}
     */
    calculateWaitFee(actualWaitMinutes = 0) {
        const actualMins = Math.max(0, parseInt(actualWaitMinutes || 0, 10));
        const freeWaitMins = systemSettingsService ? systemSettingsService.getFreeWaitMinutes() : 5;
        const minuteWaitRate = systemSettingsService ? systemSettingsService.getMinuteWaitRateIqd() : 100;
        const billableMinutes = Math.max(0, actualMins - freeWaitMins);
        const rawFee = billableMinutes * minuteWaitRate;
        const waitFee = this.roundToNearest250(rawFee);

        return {
            waitFee,
            rawFee,
            actualWaitMinutes: actualMins,
            billableWaitMinutes: billableMinutes,
            freeWaitMinutes: freeWaitMins,
            minuteWaitRate
        };
    }

    /**
     * Calculate comprehensive Round-Trip fare:
     * Total = Leg 1 (outbound) + Waiting Fee + Leg 2 (return with optional discount)
     * All rounded to nearest 250 IQD multiple.
     * @param {Object} options
     * @param {number} options.leg1DistanceKm
     * @param {number} options.leg1DurationMins
     * @param {number} options.leg2DistanceKm
     * @param {number} options.leg2DurationMins
     * @param {number} options.actualWaitMinutes
     * @param {string} options.vehicleType
     */
    calculateRoundTripFare(options = {}) {
        const leg1Dist = Math.max(0.5, Number(options.leg1DistanceKm || options.distanceKm || 3.0));
        const leg1Dur = Math.max(3, Number(options.leg1DurationMins || options.durationMins || Math.round(leg1Dist * 2.5)));
        const leg2Dist = Math.max(0.5, Number(options.leg2DistanceKm || leg1Dist));
        const leg2Dur = Math.max(3, Number(options.leg2DurationMins || leg1Dur));
        const actualWaitMins = Math.max(0, parseInt(options.actualWaitMinutes || 0, 10));

        // 1. Leg 1 Standard Instant Fare
        const leg1Calc = this.calculateInstantRideFare({
            ...options,
            distanceKm: leg1Dist,
            durationMins: leg1Dur,
            isRoundTrip: false
        });
        const leg1Fare = leg1Calc.fare;

        // 2. Waiting Fee Calculation
        const waitDetails = this.calculateWaitFee(actualWaitMins);
        const waitFee = waitDetails.waitFee;

        // 3. Leg 2 (Return) Fare with round_trip_discount_percent
        const discountPercent = systemSettingsService ? systemSettingsService.getRoundTripDiscountPercent() : 0;
        const leg2Calc = this.calculateInstantRideFare({
            ...options,
            distanceKm: leg2Dist,
            durationMins: leg2Dur,
            isRoundTrip: false
        });
        const discountFactor = Math.max(0, (100 - discountPercent) / 100.0);
        const leg2Fare = this.roundToNearest250(leg2Calc.fare * discountFactor);

        // 4. Combined Round-Trip Fare
        const totalFare = this.roundToNearest250(leg1Fare + waitFee + leg2Fare);

        return {
            totalFare,
            fare: totalFare,
            leg1Fare,
            leg2Fare,
            waitFee,
            actualWaitMinutes: actualWaitMins,
            billableWaitMinutes: waitDetails.billableWaitMinutes,
            freeWaitMinutes: waitDetails.freeWaitMinutes,
            minuteWaitRate: waitDetails.minuteWaitRate,
            roundTripDiscountPercent: discountPercent,
            leg1: { distanceKm: leg1Dist, durationMins: leg1Dur, fare: leg1Fare },
            leg2: { distanceKm: leg2Dist, durationMins: leg2Dur, fare: leg2Fare }
        };
    }
}

module.exports = new PricingService();
