# 🚖 الدليل الشامل والمرجع التقني لمنصة «توصيلة» (Taxi-Wisam)
### دليل المطور والذكاء الاصطناعي (Master Developer & AI Agent Context File)

---

## 📌 1. بطاقة الهوية التقنية للمنظومة
* **اسم المشروع:** منصة توصيلة (Taxi-Wisam)
* **الوصف:** منصة نقل ذكية وحجز ومطابقة خطوط النقل التشاركية اليومية (جامعات، موظفين، مطار).
* **النطاق الجغرافي الحصري:** محافظة النجف الأشرف، العراق (إحداثيات المركز: `31.9961, 44.3168`).
* **المستودع الرسمي:** `https://github.com/rtor29/taxi-nwealwsam`
* **تقنيات التطوير:**
  - **تطبيق الهاتف والويب:** Flutter 3.24+ (Dart)
  - **الخلفية البرمجية الأساسية:** Node.js (High-Performance Engine)
  - **الخلفية المتقدمة:** ASP.NET Core 9.0 (.NET 9 C# Clean Architecture)
  - **قاعدة البيانات:** PostgreSQL 16 + PostGIS Spatial Engine
  - **لوحة التحكم:** Single Page Application (Tailwind CSS + Mapbox GL JS)

---

## 🌐 2. الروابط الرسمية وبيانات الاعتماد (Access & Credentials)

| الخدمة / الواجهة | الرابط (URL) | بيانات الدخول / الملاحظات |
| :--- | :--- | :--- |
| **الموقع الرئيسي وتطبيق الويب** | `https://tawseelaiq.app/` | بوابة الركاب وحجز الخطوط |
| **لوحة التحكم الإدارية** | `https://tawseelaiq.app/dashboard/` | **المستخدم:** `admin` \| **الرمز:** `1122` |
| **بوابة تسجيل دخول الكباتن** | `https://tawseelaiq.app/captain-login` | بوابة السائقين المعتمدين |
| **تطبيق Flutter Web المدمج** | `https://tawseelaiq.app/app-view/` | واجهة فلاتر ويب |
| **سيرفر الـ VPS (Contabo)** | `173.212.206.86` | يرجى مراجعة ملف `.env` الداخلي |
| **قاعدة بيانات PostgreSQL** | `173.212.206.86:5432` | يرجى مراجعة ملف `.env` الداخلي |

---

## 🔑 3. مفاتيح وتوكنات الربط (راجع ملف .env الخاص بالسيرفر)

* **بوت التليجرام:** معرف في `src/backend/modules/telegram/telegramBot.js` والمتغير `TELEGRAM_BOT_TOKEN`.
* **واتساب كلاود (Meta WhatsApp Cloud API):** مضبوط في `WHATSAPP_TOKEN` و `WHATSAPP_PHONE_NUMBER_ID` و `WHATSAPP_WABA_ID`.
* **جوجل كلاود (Google OAuth 2.0):** مضبوط في `GOOGLE_CLIENT_ID` و `GOOGLE_CLIENT_SECRET`.
* **خرائط ماب بوكس (Mapbox GL):** مضبوط في `MAPBOX_TOKEN` في تطبيق فلاتر وخادم Node.js.

---

## 🔌 4. الدليل الكامل لواجهات برمجة التطبيقات (API Reference)

### أولاً: واجهات المصادقة والحسابات (Auth APIs)
* `POST /api/auth/login` : تسجيل الدخول بالهاتف أو البريد أو اسم المستخدم.
* `POST /api/auth/register` : تسجيل مستخدم أو كابتن جديد.
* `POST /api/auth/send-whatsapp-otp` : إرسال كود تحقق OTP عبر واتساب.
* `POST /api/auth/verify-whatsapp-otp` : التحقق من كود الـ OTP المدخل.
* `GET /api/auth/check-phone?phone=07801234567` : فحص ما إذا كان الرقم مسجلاً كسائق أو راكب مسبقاً.
* `GET /api/auth/google` : بدء تسجيل الدخول عبر Google Sign-In.
* `GET /api/auth/google/callback` : استقبال استجابة Google وإصدار رمز الدخول.

### ثانياً: واجهات الأسطول والسائقين والتتبع (Fleet & Driver APIs)
* `GET /api/drivers/nearby?lat=31.9961&lon=44.3168` : جلب الكباتن المتواجدين في محيط الإحداثيات.
* `POST /api/driver/location` : بث الإحداثيات المباشرة للسائق، زاوية المركبة، والسرعة.
* `GET /api/driver/{driverId}/live` : جلب موقع كابتن معين لحظياً لتتبع الراكب.
* `GET /api/driver/{driverId}/bookings` : جلب جميع الرحلات والحجوزات المسندة للكابتن.
* `GET /api/driver/{driverId}/requests` : جلب طلبات الانضمام المعلقة بانتظار موافقة الكابتن.

### ثالثاً: واجهات الحجوزات والمسارات والمطابقة (Matching & Routes)
* `POST /api/matching/find-routes` : البحث عن خطوط السير اليومية المتطابقة بنظام PostGIS.
* `POST /api/bookings` : إنشاء حجز جديد في خط سير.
* `POST /api/routes` : قيام الكابتن بإنشاء خط سير منتظم جديد وتحديد المقاعد والأجرة.

### رابعاً: واجهات لوحة التحكم والعمليات (Admin APIs)
* `GET /api/admin/stats` : إحصائيات النظام الشاملة (المستخدمين، السائقين، الإيرادات، الحجوزات).
* `GET /api/admin/drivers/pending-verifications` : قائمة السائقين الجدد بانتظار فحص رخصهم ومستمسكاتهم.
* `POST /api/admin/documents/{docId}/verify` : اعتماد وتوثيق رخصة السائق وتفعيل حسابه (`{"approved": true}`).
* `POST /api/admin/driver/{driverId}/status` : تعديل حالة السائق (Approved / Suspended / Rejected).
* `DELETE /api/admin/driver/{driverId}` : حذف كابتن وكافة بياناته نهائياً (Cascade Delete).
* `DELETE /api/admin/customer/{customerId}` : حذف راكب نهائياً.
* `GET /api/admin/audit-logs` : جلب سجل التدقيق الأمني لجميع العمليات الإدارية.
* `GET /api/admin/backup/export` : تصدير لقطة حالة النظام بالكامل (Full State Backup).

---

## 🤖 5. برومبت التوجيه للذكاء الاصطناعي (AI Agent Master Prompt)
> **انسخ هذا النص وضعه في بداية محادثتك مع أي ذكاء اصطناعي:**
>
> "أنت تعمل كمطور برمجيات خبير على مشروع **منصة توصيلة (Taxi-Wisam)**، وهي منصة نقل ذكية لحجز المشاوير الفورية والخطوط التشاركية مخصصة حصرياً لمحافظة النجف الأشرف، العراق.
> يعتمد المشروع على خادم Node.js موحد على المنفذ 5050، وتطبيق Flutter للهاتف والويب، ولوحة تحكم Tailwind/Mapbox GL، وتخزين مزدوج (PostgreSQL + JSON State)، وبوت تليجرام، وخدمة WhatsApp Cloud API.
> كافة المعالم والإحداثيات محصورة في النجف (مركز المدينة: 31.9961, 44.3168).
> التزم دائماً بالحفاظ على التخزين المزدوج لعدم فقدان البيانات، واتباع معايير REST API الموثقة، وعدم استدعاء قواعد البيانات من تطبيق Flutter مباشرة بل عبر الـ Backend فقط."
