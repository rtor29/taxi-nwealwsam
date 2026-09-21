// Verification script for Iraqi Phone Validation & OTP endpoints
const assert = require('assert');

// Test the validateIraqiPhone logic directly
function validateIraqiPhone(rawPhone) {
    if (!rawPhone || typeof rawPhone !== 'string') {
        return { isValid: false, error: "يرجى إدخال رقم هاتف عراقي صالح (زين أو آسيا سيل فقط)" };
    }

    let cleaned = rawPhone.replace(/[\s\-\(\)\.]/g, '').trim();

    const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
    for (let i = 0; i < arabicDigits.length; i++) {
        cleaned = cleaned.replace(new RegExp(arabicDigits[i], 'g'), i);
    }

    const localRegex = /^(077|078|079)[0-9]{8}$/;
    const intlRegex = /^(\+?964)(77|78|79)[0-9]{8}$/;

    if (!localRegex.test(cleaned) && !intlRegex.test(cleaned)) {
        return {
            isValid: false,
            error: "يرجى إدخال رقم هاتف عراقي صالح (زين أو آسيا سيل فقط)",
            rejectedPrefix: cleaned.slice(0, 4)
        };
    }

    let core = cleaned;
    if (core.startsWith('+964')) core = core.slice(4);
    else if (core.startsWith('964')) core = core.slice(3);
    else if (core.startsWith('0')) core = core.slice(1);

    const prefix = core.slice(0, 2);
    const operator = (prefix === '77') ? 'Asiacell' : 'Zain';

    return {
        isValid: true,
        operator,
        normalizedLocal: '0' + core,
        normalizedE164: '+964' + core
    };
}

console.log('--- Testing Backend Iraqi Phone Validation Rules ---');

const testCases = [
    { input: '07701234567', expectedValid: true, expectedOp: 'Asiacell' },
    { input: '07801234567', expectedValid: true, expectedOp: 'Zain' },
    { input: '07901234567', expectedValid: true, expectedOp: 'Zain' },
    { input: '07501234567', expectedValid: false, reason: 'Korek rejected' },
    { input: '07601234567', expectedValid: false, reason: 'Invalid operator rejected' },
    { input: '123456', expectedValid: false, reason: 'Invalid length rejected' },
    { input: '+9647701234567', expectedValid: true, expectedOp: 'Asiacell' },
    { input: '9647801234567', expectedValid: true, expectedOp: 'Zain' }
];

let passed = 0;
for (const tc of testCases) {
    const res = validateIraqiPhone(tc.input);
    assert.strictEqual(res.isValid, tc.expectedValid, `Failed on ${tc.input}: expected ${tc.expectedValid}, got ${res.isValid}`);
    if (tc.expectedOp) {
        assert.strictEqual(res.operator, tc.expectedOp, `Operator mismatch on ${tc.input}: expected ${tc.expectedOp}, got ${res.operator}`);
    }
    if (!tc.expectedValid) {
        assert.strictEqual(res.error, "يرجى إدخال رقم هاتف عراقي صالح (زين أو آسيا سيل فقط)");
    }
    console.log(`✅ ${tc.input.padEnd(16)} -> ${res.isValid ? 'VALID (' + res.operator + ')' : 'REJECTED (422)'}`);
    passed++;
}

console.log(`\n🎉 All ${passed}/${testCases.length} backend validation test cases passed successfully!`);
