/**
 * WhatsApp Cloud API Service for Tawsela (توصيلة)
 * Phone Number ID: 1404147582779377
 * WABA ID: 25795264216635389
 * Phone: +964 780 580 964
 * Verify Token: Musaonline33
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Auto-load .env if not loaded
(function loadEnv() {
    const envPaths = [
        path.join(process.cwd(), '.env'),
        '/var/www/taxi-wisam/.env',
        path.join(__dirname, '..', '..', '..', '.env')
    ];
    for (const p of envPaths) {
        try {
            if (fs.existsSync(p)) {
                const lines = fs.readFileSync(p, 'utf8').split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const idx = trimmed.indexOf('=');
                    if (idx > 0) {
                        const k = trimmed.slice(0, idx).trim();
                        const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
                        if (!process.env[k]) process.env[k] = v;
                    }
                }
                break;
            }
        } catch (_) {}
    }
})();

class WhatsAppService {
    constructor() {
        this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
        this.wabaId = process.env.WHATSAPP_WABA_ID || '';
        this.verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
        // TOKEN: loaded from env only — never hardcoded
        this.accessToken = process.env.WHATSAPP_TOKEN || process.env.META_ACCESS_TOKEN || '';
        this.apiVersion = 'v21.0';
        this.pin = process.env.WHATSAPP_PIN || '';
        this.templateId = process.env.WHATSAPP_TEMPLATE_ID || '';
        this.templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'auth_otp';
        // VerifyWay OTP API key — loaded from env only
        this.verifyWayKey = process.env.VERIFYWAY_API_KEY || '';

        if (!this.accessToken) console.warn('[WhatsApp] WHATSAPP_TOKEN missing — Meta API calls disabled.');
        if (!this.verifyWayKey) console.warn('[WhatsApp] VERIFYWAY_API_KEY missing — OTP may fail.');

        // In-memory store for OTPs (phone -> { code, expiresAt, attempts })
        this.otpStore = new Map();

        // In-memory store for incoming webhook message logs
        this.messageLogs = [];
    }

    /**
     * Parse and normalize any Iraqi phone number format:
     * - 0780580964 (10 digits)
     * - 07701234567 (11 digits)
     * - 780580964 (9 digits)
     * - 7801234567 (10 digits)
     * - +964780580964 / 00964780580964
     */
    parseIraqiPhone(phone) {
        if (!phone) return null;
        const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
        let clean = String(phone || '').replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');

        if (clean.startsWith('00964')) clean = clean.substring(5);
        else if (clean.startsWith('964')) clean = clean.substring(3);
        if (clean.startsWith('0')) clean = clean.substring(1);

        if (!clean.startsWith('7') || clean.length < 9 || clean.length > 10) {
            return null;
        }

        return {
            clean,
            localPhone: '0' + clean,
            normalized: '964' + clean,
            recipient: '+964' + clean
        };
    }

    /**
     * Normalize Iraqi phone numbers to E.164 without '+'
     * e.g., '0780580964' -> '964780580964'
     */
    normalizePhone(phone) {
        const parsed = this.parseIraqiPhone(phone);
        return parsed ? parsed.normalized : String(phone || '').replace(/[^0-9]/g, '');
    }

    /**
     * Send HTTP POST request to WhatsApp Graph API
     */
    async _callGraphApi(endpoint, payload) {
        if (!this.accessToken) {
            console.warn('[WhatsApp] No access token configured (WHATSAPP_TOKEN). Message logged but not sent to Meta API.');
            return { success: false, warning: 'NO_ACCESS_TOKEN', simulated: true };
        }

        const dataString = JSON.stringify(payload);
        const options = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/${this.apiVersion}/${this.phoneNumberId}/${endpoint}`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(dataString)
            }
        };

        return new Promise((resolve) => {
            const req = https.request(options, (res) => {
                let responseBody = '';
                res.on('data', chunk => { responseBody += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseBody);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            console.log('[WhatsApp API Success]:', JSON.stringify(parsed));
                            resolve({ success: true, data: parsed });
                        } else {
                            console.error('[WhatsApp API Meta Error]: HTTP', res.statusCode, JSON.stringify(parsed));
                            resolve({ success: false, error: parsed, statusCode: res.statusCode });
                        }
                    } catch (e) {
                        console.error('[WhatsApp API Raw Response]: HTTP', res.statusCode, responseBody);
                        resolve({ success: false, error: responseBody, statusCode: res.statusCode });
                    }
                });
            });

            req.on('error', (err) => {
                console.error('[WhatsApp] Network Error:', err.message);
                resolve({ success: false, error: err.message });
            });

            req.setTimeout(10000, () => {
                req.destroy();
                resolve({ success: false, error: 'TIMEOUT' });
            });

            req.write(dataString);
            req.end();
        });
    }

    /**
     * Generate 6-digit OTP code and store with 5 min expiration
     */
    generateOtp(phone) {
        const parsed = this.parseIraqiPhone(phone) || {
            clean: String(phone),
            localPhone: String(phone),
            normalized: String(phone),
            recipient: String(phone)
        };
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

        const record = {
            code,
            expiresAt,
            attempts: 0,
            createdAt: Date.now(),
            phoneInfo: parsed
        };

        // Store under all formats to guarantee instant lookup
        this.otpStore.set(parsed.normalized, record);
        this.otpStore.set(parsed.localPhone, record);
        this.otpStore.set(parsed.recipient, record);
        this.otpStore.set(parsed.clean, record);

        return { code, expiresAt, parsed };
    }

    /**
     * Send OTP via Meta Cloud API template
     */
    async sendOtpViaMeta(parsed, code) {
        if (!this.accessToken) return { success: false, error: 'NO_META_TOKEN' };

        const templatePayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: parsed.normalized,
            type: 'template',
            template: {
                name: this.templateName || 'auth_otp',
                language: { code: 'ar' },
                components: [
                    {
                        type: 'body',
                        parameters: [
                            { type: 'text', text: String(code) }
                        ]
                    },
                    {
                        type: 'button',
                        sub_type: 'url',
                        index: '0',
                        parameters: [
                            { type: 'text', text: String(code) }
                        ]
                    }
                ]
            }
        };

        console.log(`[WhatsApp] Attempting Meta Template "${this.templateName}" to ${parsed.normalized}...`);
        const res = await this._callGraphApi('messages', templatePayload);
        if (res.success) {
            return { success: true, provider: 'meta_template', data: res.data };
        }

        // If button template failed, try simple body parameter
        if (res.error && (res.statusCode === 400 || res.statusCode === 404)) {
            const simpleTemplate = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: parsed.normalized,
                type: 'template',
                template: {
                    name: this.templateName || 'auth_otp',
                    language: { code: 'ar' },
                    components: [
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: String(code) }
                            ]
                        }
                    ]
                }
            };
            const resSimple = await this._callGraphApi('messages', simpleTemplate);
            if (resSimple.success) {
                return { success: true, provider: 'meta_template_simple', data: resSimple.data };
            }
        }

        return { success: false, error: res.error, statusCode: res.statusCode };
    }

    /**
     * Send OTP via VerifyWay WhatsApp gateway
     */
    async sendOtpViaVerifyWay(parsed, code) {
        const apiKey = this.verifyWayKey || process.env.VERIFYWAY_API_KEY || '';
        if (!apiKey) return { success: false, error: 'NO_VERIFYWAY_KEY' };

        const payload = JSON.stringify({
            recipient: parsed.recipient,
            type: "otp",
            channel: "whatsapp",
            fallback: "no",
            code: String(code),
            lang: "ar"
        });

        console.log(`[WhatsApp] Calling VerifyWay for ${parsed.recipient}...`);
        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'api.verifyway.com',
                port: 443,
                path: '/api/v1/',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsedRes = JSON.parse(data);
                        if (parsedRes.status === 'success' || (res.statusCode >= 200 && res.statusCode < 300)) {
                            console.log('[WhatsApp VerifyWay Success]:', JSON.stringify(parsedRes));
                            resolve({ success: true, provider: 'verifyway', data: parsedRes });
                        } else {
                            console.error('[WhatsApp VerifyWay Error]:', data);
                            resolve({ success: false, error: parsedRes });
                        }
                    } catch (e) {
                        resolve({ success: false, error: data });
                    }
                });
            });

            req.on('error', err => resolve({ success: false, error: err.message }));
            req.setTimeout(10000, () => {
                req.destroy();
                resolve({ success: false, error: 'TIMEOUT' });
            });
            req.write(payload);
            req.end();
        });
    }

    /**
     * Send OTP via WhatsApp (Tries VerifyWay first, falls back to Meta Cloud API)
     */
    async sendOtp(phone, customCode = null) {
        const parsed = this.parseIraqiPhone(phone);
        if (!parsed) {
            return {
                success: false,
                error: 'يرجى إدخال رقم هاتف عراقي صالح (مثال: 07801234567 أو 07701234567)'
            };
        }

        const otpData = customCode 
            ? { code: customCode, expiresAt: Date.now() + 5 * 60 * 1000, parsed } 
            : this.generateOtp(phone);
            
        const code = otpData.code;

        // Register in store under all phone representations
        const record = {
            code,
            expiresAt: Date.now() + 5 * 60 * 1000,
            attempts: 0,
            createdAt: Date.now(),
            phoneInfo: parsed
        };
        this.otpStore.set(parsed.normalized, record);
        this.otpStore.set(parsed.localPhone, record);
        this.otpStore.set(parsed.recipient, record);
        this.otpStore.set(parsed.clean, record);

        console.log(`[WhatsApp] Sending OTP [${code}] to ${parsed.localPhone} (${parsed.recipient})`);

        // 1. Try VerifyWay Gateway first
        const vwRes = await this.sendOtpViaVerifyWay(parsed, code);
        if (vwRes.success) {
            return {
                success: true,
                phone: parsed.localPhone,
                normalized: parsed.normalized,
                code: code,
                provider: 'verifyway',
                apiResult: vwRes
            };
        }

        console.warn('[WhatsApp] VerifyWay gateway returned error, trying Meta API...', vwRes.error);

        // 2. Fallback to Meta Cloud API template
        const metaRes = await this.sendOtpViaMeta(parsed, code);
        if (metaRes.success) {
            return {
                success: true,
                phone: parsed.localPhone,
                normalized: parsed.normalized,
                code: code,
                provider: 'meta',
                apiResult: metaRes
            };
        }

        console.error('[WhatsApp] All WhatsApp dispatch providers failed:', {
            verifyWayError: vwRes.error,
            metaError: metaRes.error
        });

        return {
            success: false,
            error: 'تعذر إرسال رمز التحقق عبر واتساب حالياً، يرجى التحقق من الرقم والمحاولة ثانية',
            phone: parsed.localPhone
        };
    }

    /**
     * Verify OTP entered by user
     */
    verifyOtp(phone, inputCode) {
        if (!phone || !inputCode) {
            return { valid: false, error: 'رقم الهاتف ورمز التحقق مطلوبان' };
        }

        const parsed = this.parseIraqiPhone(phone);
        const searchKeys = parsed 
            ? [parsed.normalized, parsed.localPhone, parsed.recipient, parsed.clean]
            : [this.normalizePhone(phone), String(phone).trim()];

        let record = null;
        let matchedKey = null;
        for (const k of searchKeys) {
            if (this.otpStore.has(k)) {
                record = this.otpStore.get(k);
                matchedKey = k;
                break;
            }
        }

        if (!record) {
            return { valid: false, error: 'لم يتم طلب رمز تحقق لهذا الرقم أو انتهت صلاحيته' };
        }

        if (Date.now() > record.expiresAt) {
            searchKeys.forEach(k => this.otpStore.delete(k));
            return { valid: false, error: 'انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد' };
        }

        record.attempts = (record.attempts || 0) + 1;
        if (record.attempts > 5) {
            searchKeys.forEach(k => this.otpStore.delete(k));
            return { valid: false, error: 'تم تجاوز الحد الأقصى للمحاولات، اطلب رمزاً جديداً' };
        }

        const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
        const persDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
        const cleanInputCode = String(inputCode)
            .replace(/[٠-٩]/g, d => arabicDigits.indexOf(d))
            .replace(/[۰-۹]/g, d => persDigits.indexOf(d))
            .trim();

        if (String(record.code).trim() === cleanInputCode) {
            record.verified = true;
            record.verifiedUntil = Date.now() + 15 * 60 * 1000;
            return { valid: true };
        }

        return { valid: false, error: 'رمز التحقق غير صحيح، يرجى التأكد وإعادة المحاولة' };
    }

    /**
     * Check if phone has been successfully verified via WhatsApp
     */
    isPhoneVerified(phone) {
        const normalized = this.normalizePhone(phone);
        const record = this.otpStore.get(normalized);
        if (!record || !record.verified) return false;
        return Date.now() < (record.verifiedUntil || 0);
    }

    /**
     * Clear OTP after successful registration
     */
    consumeVerification(phone) {
        const normalized = this.normalizePhone(phone);
        this.otpStore.delete(normalized);
    }

    /**
     * Send general text message via WhatsApp
     */
    async sendTextMessage(phone, messageText) {
        const normalized = this.normalizePhone(phone);
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: normalized,
            type: 'text',
            text: {
                preview_url: false,
                body: messageText
            }
        };
        return await this._callGraphApi('messages', payload);
    }

    /**
     * Send booking confirmation notification
     */
    async sendBookingConfirmation(phone, { bookingId, driverName, route, seats, totalFare }) {
        const text = `🚖 *منصة توصيلة - تأكيد الحجز*\n\nمرحباً بك! تم تأكيد حجزك بنجاح:\n- *رقم الحجز:* ${bookingId}\n- *الكابتن:* ${driverName || 'كابتن توصيلة'}\n- *المسار:* ${route || 'النجف الأشرف'}\n- *عدد المقاعد:* ${seats || 1}\n- *الأجرة:* ${totalFare ? totalFare.toLocaleString('ar-IQ') + ' د.ع' : 'حسب التسعيرة'}\n\nنتمنى لك رحلة مريحة وآمنة!`;
        return await this.sendTextMessage(phone, text);
    }

    /**
     * Send driver verification status update
     */
    async sendDriverStatusNotification(phone, { driverName, status, reason }) {
        let text = '';
        if (status === 'Approved') {
            text = `🎉 *تهانينا كابتن ${driverName || ''}!*\nتم اعتماد وتوثيق حسابك في منصة توصيلة بنجاح. يمكنك الآن استقبال الركاب والبدء في تنفيذ الرحلات.\nرابط الدخول: https://tawseelaiq.app/captain-login`;
        } else if (status === 'Rejected') {
            text = `⚠️ *ملاحظة توثيق - منصة توصيلة*\nأهلاً كابتن ${driverName || ''}، يرجى إعادة رفع الوثائق المطلوبة.\nالسبب: ${reason || 'يرجى التأكد من وضوح صور الهوية وإجازة السوق'}.\nللمساعدة تواصل مع الإدارة.`;
        } else {
            text = `📢 *إشعار منصة توصيلة*\nأهلاً كابتن ${driverName || ''}، تم تحديث حالة حسابك إلى: ${status}`;
        }
        return await this.sendTextMessage(phone, text);
    }

    /**
     * Send driver credentials via WhatsApp
     */
    async sendDriverCredentials(phone, { fullName, password }) {
        const text = `🚖 *بيانات حساب الكابتن - منصة توصيلة*\n\nأهلاً كابتن ${fullName || ''}، تم إنشاء حسابك بنجاح:\n- *رقم الهاتف (اسم المستخدم):* ${phone}\n- *كلمة المرور:* ${password}\n\nيمكنك تسجيل الدخول عبر الرابط المباشر:\nhttps://tawseelaiq.app/captain-login`;
        return await this.sendTextMessage(phone, text);
    }

    /**
     * Handle incoming Meta WhatsApp Webhook events
     */
    handleIncomingWebhook(payload) {
        try {
            if (!payload || !payload.entry) return { status: 'ignored' };

            for (const entry of payload.entry) {
                const changes = entry.changes || [];
                for (const change of changes) {
                    const value = change.value || {};
                    
                    // Incoming Messages from Users
                    if (value.messages && value.messages.length > 0) {
                        for (const msg of value.messages) {
                            const sender = msg.from;
                            const msgType = msg.type;
                            const timestamp = msg.timestamp;
                            let textContent = '';

                            if (msgType === 'text' && msg.text) {
                                textContent = msg.text.body;
                            } else if (msgType === 'interactive') {
                                textContent = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
                            } else if (msgType === 'button') {
                                textContent = msg.button?.text || '';
                            }

                            console.log(`[WhatsApp Webhook] Incoming message from +${sender}: "${textContent}"`);

                            const logEntry = {
                                sender,
                                text: textContent,
                                type: msgType,
                                timestamp: new Date(timestamp * 1000).toISOString(),
                                raw: msg
                            };
                            this.messageLogs.unshift(logEntry);
                            if (this.messageLogs.length > 100) this.messageLogs.pop();

                            // User response handling (e.g. confirmation, help)
                            this._handleUserReply(sender, textContent);
                        }
                    }

                    // Message Delivery / Read Status Updates
                    if (value.statuses && value.statuses.length > 0) {
                        for (const status of value.statuses) {
                            console.log(`[WhatsApp Webhook] Message ${status.id} status: ${status.status} for +${status.recipient_id}`);
                        }
                    }
                }
            }

            return { status: 'processed' };
        } catch (err) {
            console.error('[WhatsApp Webhook] Error handling webhook event:', err);
            return { status: 'error', error: err.message };
        }
    }

    /**
     * Automated smart reply handling based on user response
     */
    async _handleUserReply(sender, text) {
        const clean = (text || '').trim().toLowerCase();
        if (clean === 'نعم' || clean === 'تأكيد' || clean === 'موافق') {
            await this.sendTextMessage(sender, 'شكراً لتأكيدك! تم تسجيل طلبك بنجاح في تطبيق توصيلة.');
        } else if (clean === 'مساعدة' || clean === 'help') {
            await this.sendTextMessage(sender, 'أهلاً بك في خدمة عملاء توصيلة (Tawsela) 🚖\nلطلب رحلة أو الاستفسار يرجى فتح التطبيق عبر: https://tawseelaiq.app');
        }
    }
}

module.exports = new WhatsAppService();
