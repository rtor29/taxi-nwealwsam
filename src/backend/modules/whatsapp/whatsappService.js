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
     * Normalize Iraqi phone numbers to E.164 without '+'
     * e.g., '0780580964' -> '964780580964'
     */
    normalizePhone(phone) {
        if (!phone) return '';
        const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
        let clean = String(phone).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
        
        if (clean.startsWith('00964')) {
            clean = clean.substring(2);
        } else if (clean.startsWith('0')) {
            clean = '964' + clean.substring(1);
        } else if (clean.startsWith('7') && clean.length === 10) {
            clean = '964' + clean;
        } else if (!clean.startsWith('964') && clean.length >= 9) {
            clean = '964' + clean;
        }
        return clean;
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
        const normalized = this.normalizePhone(phone);
        // Generate secure 6-digit random code
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

        this.otpStore.set(normalized, {
            code,
            expiresAt,
            attempts: 0,
            createdAt: Date.now()
        });

        return { code, expiresAt, normalized };
    }

    /**
     * Send OTP via VerifyWay WhatsApp API
     */
    async sendOtp(phone, customCode = null) {
        const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
        let clean = String(phone || '').replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');

        if (clean.startsWith('00964')) clean = clean.substring(5);
        else if (clean.startsWith('964')) clean = clean.substring(3);
        if (clean.length === 10 && clean.startsWith('7')) clean = '0' + clean;

        if (!clean.startsWith('07') || clean.length !== 11) {
            return {
                success: false,
                error: 'يقبل فقط الرقم العراقي (07xxxxxxxx)'
            };
        }

        const recipient = '+964' + clean.substring(1);
        const normalized = '964' + clean.substring(1);

        const otpData = customCode 
            ? { code: customCode, expiresAt: Date.now() + 5 * 60 * 1000, normalized } 
            : this.generateOtp(clean);
            
        const code = otpData.code;
        // Also register in otpStore under alternative formats
        this.otpStore.set(normalized, otpData);
        this.otpStore.set(clean, otpData);

        const apiKey = this.verifyWayKey || process.env.VERIFYWAY_API_KEY || '';
        const payload = JSON.stringify({
            recipient: recipient,
            type: "otp",
            channel: "whatsapp",
            fallback: "no",
            code: String(code),
            lang: "ar"
        });

        const result = await new Promise((resolve) => {
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
                        const parsed = JSON.parse(data);
                        if (parsed.status === 'success' || (res.statusCode >= 200 && res.statusCode < 300)) {
                            resolve({ success: true, data: parsed });
                        } else {
                            resolve({ success: false, error: parsed });
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

        if (!result.success) {
            return {
                success: false,
                error: result.error?.message || result.error || 'فشل إرسال رمز التحقق',
                phone: clean
            };
        }

        return {
            success: true,
            phone: clean,
            code: code,
            apiResult: result
        };
    }

    /**
     * Verify OTP entered by user
     */
    verifyOtp(phone, inputCode) {
        const normalized = this.normalizePhone(phone);
        const record = this.otpStore.get(normalized);

        if (!record) {
            return { valid: false, error: 'لم يتم طلب رمز تحقق لهذا الرقم أو انتهت صلاحيته' };
        }

        if (Date.now() > record.expiresAt) {
            this.otpStore.delete(normalized);
            return { valid: false, error: 'انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد' };
        }

        record.attempts = (record.attempts || 0) + 1;
        if (record.attempts > 5) {
            this.otpStore.delete(normalized);
            return { valid: false, error: 'تم تجاوز الحد الأقصى للمحاولات، اطلب رمزاً جديداً' };
        }

        if (record.verified && Date.now() < (record.verifiedUntil || 0)) {
            return { valid: true };
        }

        if (String(record.code).trim() === String(inputCode).trim()) {
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
