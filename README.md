# 🚖 منصة توصيلة (Taxi-Wisam) | Tawseela IQ Platform
### المنصة الذكية المتكاملة لإدارة الرحلات والخطوط التشاركية - محافظة النجف الأشرف
**Comprehensive Technical Documentation & Architecture Reference for Developers and AI Agents**

---

## 📑 فهرس المحتويات (Table of Contents)
1. [نظرة عامة على المشروع (Overview)](#-نظرة-عامة-على-المشروع-overview)
2. [الروابط الرسمية وبيانات الاعتماد (Official URLs & Access)](#-الروابط-الرسمية-وبيانات-الاعتماد-official-urls--access)
3. [المعمارية التقنية الشاملة (System Architecture)](#-المعمارية-التقنية-الشاملة-system-architecture)
4. [هيكل المجلدات ومخطط الكود (Repository Structure)](#-هيكل-المجلدات-ومخطط-الكود-repository-structure)
5. [تطبيق الهاتف والويب (Flutter Mobile & Web App)](#-تطبيق-الهاتف-والويب-flutter-mobile--web-app)
6. [الخلفية البرمجية وخادم المنصة (Unified Backend Engine)](#-الخلفية-البرمجية-وخادم-المنصة-unified-backend-engine)
7. [لوحة التحكم الإدارية (Admin Dashboard)](#-لوحة-التحكم-الإدارية-admin-dashboard)
8. [نظام التحقق وتوثيق أرقام الهواتف (WhatsApp OTP & Meta API)](#-نظام-التحقق-وتوثيق-أرقام-الهواتف-whatsapp-otp--meta-api)
9. [بوت التليجرام التفاعلي (Telegram Bot Integration)](#-بوت-التليجرام-التفاعلي-telegram-bot-integration)
10. [المحرك الجغرافي المكاني وقاعدة البيانات (PostgreSQL & PostGIS)](#-المحرك-الجغرافي-المكاني-وقاعدة-البيانات-postgresql--postgis)
11. [توثيق واجهات برمجة التطبيقات (API Reference)](#-توثيق-واجهات-برمجة-التطبيقات-api-reference)
12. [طريقة التشغيل والتطوير المحلي (Local Development Setup)](#-طريقة-التشغيل-والتطوير-المحلي-local-development-setup)
13. [دليل النشر على سيرفر سحابي (Production VPS Deployment)](#-دليل-النشر-على-سيرفر-سحابي-production-vps-deployment)
14. [إرشادات المطورين والذكاء الاصطناعي (Developer & AI Guidelines)](#-إرشادات-المطورين-والذكاء-الاصطناعي-developer--ai-guidelines)

---

## 📌 نظرة عامة على المشروع (Overview)

منصة **توصيلة (Taxi-Wisam)** هي منظومة نقل ذكية مخصصة لخدمة **محافظة النجف الأشرف**، تجمع بين:
- **خدمة المشاوير الفورية:** ربط الراكب بأقرب كابتن تكسي متاح في النجف بدقة مكانية وسرعة فائقة.
- **خدمة الخطوط المنتظمة التشاركية:** مطابقة الركاب الذين يسلكون نفس المسار يومياً (مثل خطوط جامعة الكوفة، الموظفين، والمطار) بحساب التداخل ومسافة الانحراف وتقاسم الأجرة.
- **لوحة تحكم إدارية مركزية:** إدارة وتوثيق السائقين ورخص القيادة، مراقبة الأسطول اللحظي على الخريطة، وحساب الإحصائيات والإيرادات.
- **قنوات تواصل ذكية متكاملة:** إرسال رموز التحقق عبر واتساب (WhatsApp Cloud API) وبوت تليجرام تفاعلي لحجز ومتابعة الرحلات.

### 📍 النطاق الجغرافي الحصري (Najaf Spatial Bounds):
- **مركز المحافظة ومرقد الإمام علي (ع):** `(31.9961, 44.3168)`
- **مسجد الكوفة المعظم وجامعة الكوفة:** `(32.0300, 44.3700)`
- **مطار النجف الدولي:** `(31.9900, 44.4040)`
- **المناطق المشمولة:** المدينة القديمة، الحنانة، حي السعد، حي الغدير، حي الضباط، الكوفة، الحيدرية، المشخاب، والمناذرة.

---

## 🌐 الروابط الرسمية وبيانات الاعتماد (Official URLs & Access)

### 1. الروابط على الدومين الرسمي (`tawseelaiq.app`):
- **الموقع الرئيسي وتطبيق الويب:** [https://tawseelaiq.app/](https://tawseelaiq.app/)
- **لوحة التحكم الإدارية:** [https://tawseelaiq.app/dashboard/](https://tawseelaiq.app/dashboard/)
- **بوابة تسجيل دخول الكباتن:** [https://tawseelaiq.app/captain-login](https://tawseelaiq.app/captain-login)
- **تطبيق Flutter Web المدمج:** [https://tawseelaiq.app/app-view/](https://tawseelaiq.app/app-view/)

### 2. بيانات الدخول للوحة التحكم:
- **اسم المستخدم:** `admin` (أو `الادارة`)
- **كلمة المرور:** `1122` (أو `١١٢٢`)

---

## 🏛️ المعمارية التقنية الشاملة (System Architecture)

يعتمد النظام على بنية هجينة احترافية تفصل طبقات العرض عن المنطق الحسابي وقواعد البيانات:

```
                      ┌────────────────────────────────────────────────────────┐
                      │              Flutter Multi-Platform Client             │
                      │           (iOS / Android / Flutter Web SPA)            │
                      └───────────────────────────┬────────────────────────────┘
                                                  │
                                HTTPS REST / WSS  │  SignalR Hub / Webhook
                                                  │
                                                  ▼
                      ┌────────────────────────────────────────────────────────┐
                      │             Unified Backend Gateway Server             │
                      │       (Node.js High-Perf Engine & .NET 9.0 API)        │
                      └──────────────┬─────────────────────────┬───────────────┘
                                     │                         │
                  ┌──────────────────┴────────┐                └───────────────┐
                  ▼                           ▼                                ▼
         ┌─────────────────┐         ┌─────────────────┐              ┌─────────────────┐
         │  PostgreSQL 16  │         │  Telegram Bot   │              │ Meta WhatsApp   │
         │ + PostGIS Ext   │         │  & State Engine │              │ Cloud API Engine│
         │ (Spatial Query) │         │ (Interactive)   │              │ (Graph v21.0)   │
         └─────────────────┘         └─────────────────┘              └─────────────────┘
                  ▲
                  │
         ┌────────────────────────────────────────────────────────┐
         │               Admin Management Dashboard               │
         │           (Tailwind CSS / Mapbox GL JS / SPA)          │
         └────────────────────────────────────────────────────────┘
```

---

## 📂 هيكل المجلدات ومخطط الكود (Repository Structure)

```
taxi-wisam/
├── apps/
│   └── taxi_wisam_flutter/          # تطبيق الهاتف المحمول والويب (Flutter)
│       ├── lib/
│       │   ├── app_config.dart      # الإعدادات العامة وعناوين الخادم والإحداثيات
│       │   ├── core/                # الخدمات الأساسية (الشبكة، SignalR، التخزين، Mapbox)
│       │   │   ├── network/         # ApiClient عبر Dio و ApiEndpoints
│       │   │   ├── services/        # SignalRService و LocationService و MapboxService
│       │   │   └── utils/           # التحقق من أرقام الهواتف العراقية
│       │   ├── features/
│       │   │   ├── auth/            # شاشات تسجيل الدخول، إنشاء الحساب، والتحقق
│       │   │   ├── customer/        # شاشات الراكب (الرئيسية، تحديد المسار، التتبع)
│       │   │   ├── driver/          # شاشات السائق (البوابة، إنشاء خط، رفع المستندات)
│       │   │   └── ads/             # إعلانات المقاعد الشاغرة
│       │   └── main.dart            # نقطة انطلاق التطبيق والفحص التلقائي للجلسة
│       ├── ios/                     # إعدادات وبناء نظام iOS
│       ├── android/                 # إعدادات وبناء نظام Android
│       └── web/                     # إعدادات وبناء Flutter Web
├── src/                             
│   ├── backend/                     # خادم Node.js الموحد (Production Engine)
│   │   ├── config/                  # ضبط البيئة، المسارات، ومفاتيح الربط
│   │   ├── db/                      # محرك PostgreSQL وطبقة التزامن مع JSON
│   │   ├── modules/                 # وحدات النظام (Admin, Auth, WhatsApp, Telegram, Backup)
│   │   │   ├── admin/               # واجهات لوحة التحكم والتحقق من السائقين
│   │   │   ├── auth/                # واجهات تسجيل الدخول و Google Sign-In
│   │   │   ├── whatsapp/            # خدمة WhatsApp Cloud API و OTP
│   │   │   ├── telegram/            # بوت التليجرام التفاعلي
│   │   │   └── backup/              # النسخ الاحتياطي التلقائي
│   │   └── server.js                # الخادم المركزي ومعالج الطلبات والـ Rate Limiting
│   └── TaxiWisam.*                  # مشاريع .NET 9.0 Clean Architecture
│       ├── TaxiWisam.Api/           # Controllers و SignalR Hubs و wwwroot/dashboard
│       ├── TaxiWisam.Application/   # حالات الاستخدام ومحرك المطابقة
│       ├── TaxiWisam.Domain/        # الكيانات (Entities) ونماذج البيانات
│       └── TaxiWisam.Infrastructure/# PostGIS و Redis و OSRM Routing
├── data/                            # مجلد البيانات المحلية والنسخ الاحتياطية
│   ├── state.json                   # لقطة الحالة اللحظية (Zero Data Loss)
│   ├── backups/                     # ملفات النسخ الاحتياطي الدورية (JSON / SQL)
│   └── uploads/                     # صور المستمسكات ورخص القيادة المرفوعة
├── scripts/
│   ├── serve-dashboard.js           # خادم التشغيل الفوري للوحة التحكم والـ APIs
│   ├── apply-migrations.sh          # سكربت تطبيق جداول ودوال قاعدة البيانات
│   └── run-mobile.sh                # تشغيل تطبيق الفلاتر
├── supabase/migrations/             # ملفات SQL لقاعدة البيانات ودوال PostGIS
├── docker-compose.yml               # تشغيل PostgreSQL و Redis محلياً
├── package.json                     # إعدادات وتوابع Node.js
└── .env.example                     # نموذج المتغيرات البيئية الشامل
```

---

## 📱 تطبيق الهاتف والويب (Flutter Mobile & Web App)

يقع كود التطبيق في المجلد `apps/taxi_wisam_flutter`.

### الميزات والشاشات الرئيسية:
1. **شاشات المصادقة (`lib/features/auth/`):**
   - دعم كامل لأرقام الهواتف العراقية مع التنسيق التلقائي (+964 / 078 / 077 / 075).
   - تسجيل الدخول المباشر وتسجيل الدخول عبر **Google Sign-In**.
   - إدخال بيانات المركبة ورقم رخصة القيادة للكباتن.
2. **شاشة الراكب الرئيسية (`customer_home_screen.dart`):**
   - خريطة تفاعلية حية لمدينة النجف الأشرف مع OpenStreetMap و Mapbox.
   - عرض سيارات الكباتن المتاحين كمركبات متحركة بسلاسة (`SmoothVehicleMarker`).
   - بطاقة **"أقرب كابتن متاح"** مع حساب زمن الوصول وطلب فوري.
3. **شاشة تحديد المسار وحجز المقاعد (`route_search_screen.dart`):**
   - تحديد نقطة الانطلاق (🟢) والوصول (🔴) بالنقر المباشر على الخريطة أو عبر GPS.
   - حساب فوري للمسافة، المسار، والأجرة التقديرية.
   - مطابقة الخطوط التشاركية القريبة وحجز المقاعد.
4. **شاشة تتبع الكابتن المباشر (`live_tracking_screen.dart`):**
   - بث موقع الكابتن اللحظي وزاوية اتجاه المركبة عبر SignalR / WebSocket.
5. **بوابة السائق (`driver_home_screen.dart`):**
   - تفعيل/تعطيل التواجد (Online/Offline) وبث الإحداثيات للمنصة.
   - رفع الوثائق الرسمية (إجازة السوق، بطاقة السكن) لتوثيق الحساب.
   - إنشاء خط نقل منتظم يومي وتحديد الأجرة وعدد المقاعد الشاغرة.

---

## 🖥️ لوحة التحكم الإدارية (Admin Dashboard)

تقع لوحة التحكم داخل `src/TaxiWisam.Api/wwwroot/dashboard/` ويتم تشغيلها محلياً أو سحابياً عبر المنفذ `5050`.

### أقسام وميزات لوحة التحكم:
1. **نظرة عامة والمؤشرات (Overview):** إجمالي المستخدمين، السائقين المعتمدين، الحجوزات، والإيرادات الكلية.
2. **توثيق السائقين الجدد (Driver Verifications):**
   - استعراض بيانات السائق والوثائق المرفوعة (الهوية ورخصة القيادة).
   - زر **اعتماد فوري** ينقل السائق لحالة معتمد `Active` ويرسل له إشعاراً وبيانات الدخول.
   - زر **رفض** مع تحديد سبب الرفض وإشعار السائق.
3. **إدارة السائقين والركاب (Drivers & Customers):**
   - تصفية، بحث، تعديل، وحظر/فك حظر الحسابات مع سجل مفصل لكل مستخدم.
4. **خريطة الأسطول اللحظية (Live Fleet Map):**
   - تتبع مباشر لكافة الكباتن المتواجدين في شوارع النجف الأشرف باستخدام Mapbox GL JS.
5. **المسارات والحجوزات (Routes & Bookings):**
   - متابعة خطوط السير المنتظمة وحالة المقاعد المحجوزة والشاغرة.
6. **الشكاوى والبلاغات (Complaints):**
   - متابعة الشكاوى الواردة والتحقيق فيها وتغيير حالتها.
7. **إعدادات التسعير وسجل التدقيق (Pricing & Audit Logs):**
   - تعديل أسعار الكيلومتر والدقيقة وفتحة العداد في النجف.
   - سجل أمني دقيق ومؤرخ لكافة العمليات الإدارية وأرقام الـ IP المنفذة لها.

---

## 💬 نظام التحقق وتوثيق أرقام الهواتف (WhatsApp OTP & Meta API)

تم دمج خدمة **Meta WhatsApp Cloud API (Graph API v21.0)** للتحقق من هوية المستخدمين وإرسال رموز OTP ورسائل الاعتماد:

- **معرف رقم الهاتف (Phone Number ID):** `1404147582779377`
- **معرف حساب الأعمال (WABA ID):** `25795264216635389`
- **رمز التحقق من الويب هوك (Verify Token):** `Musaonline33`
- **اسم قالب الـ OTP:** `auth_otp`

### واجهات الـ API المخصصة للواتساب:
* **إرسال رمز OTP:** `POST /api/auth/send-whatsapp-otp`
  ```json
  { "phoneNumber": "07801234567" }
  ```
* **التحقق من رمز OTP:** `POST /api/auth/verify-whatsapp-otp`
  ```json
  { "phoneNumber": "07801234567", "code": "123456" }
  ```
* **استقبال الأحداث (Webhook):** `GET / POST /api/webhook/whatsapp`

---

## 🤖 بوت التليجرام التفاعلي (Telegram Bot Integration)

يحتوي النظام على بوت تليجرام تفاعلي متكامل (`src/backend/modules/telegram/telegramBot.js`):

- **توكن البوت (BOT_TOKEN):** `8317462517:AAH1T0_nE1ErDKrolstrvpTyDV46hVq62R4`
- **معرف المدير (ADMIN_CHAT_ID):** `391762837`

### وظائف البوت:
1. الترحيب بالمستخدم وعرض أزرار اختيار الدور (راكب 👤 أو كابتن 🚗).
2. التحقق من رقم الهاتف عبر كود OTP تفاعلي داخل الشات.
3. حفظ وتثبيت الموقع الدائم وموقع النزول عبر مشاركة الموقع الجغرافي (Live Location).
4. إرسال روابط تسجيل الدخول التلقائية المشفرة (`login_token`).
5. إشعار المشرفين فور تسجيل كابتن جديد للمراجعة والاعتماد.

---

## 🌍 المحرك الجغرافي المكاني وقاعدة البيانات (PostgreSQL & PostGIS)

تعمل المنصة بنظام تخزين مزدوج فائق الموثوقية:
1. **قاعدة بيانات PostgreSQL مع PostGIS:** لإجراء العمليات الهندسية المعقدة وحساب المسافات والتداخل عبر مؤشرات `GiST`.
2. **طبقة التزامن التلقائي (`data/state.json`):** تضمن حفظ نسخة محدثة لحظياً من حالة النظام لتجنب أي فقدان للبيانات في حال تعطل الخادم أو إعادة تشغيله.

### دوال SQL المكانية الأساسية:
- `fn_find_nearby_drivers(lat, lon, radius_meters)`: البحث الفوري عن أقرب الكباتن المتاحين في محيط الراكب.
- `fn_calculate_route_overlap(route_a, route_b, buffer_meters)`: حساب النسبة المئوية لتطابق خط سير السائق مع مسار الراكب.
- `fn_is_point_along_route(pickup, dropoff, route, buffer_meters)`: التأكد من وقوع نقطة الصعود والنزول على نفس خط سير المركبة.

---

## 🔌 توثيق واجهات برمجة التطبيقات (API Reference)

### 1. المصادقة والحسابات (Authentication)
* **تسجيل حساب جديد:** `POST /api/auth/register`
* **تسجيل الدخول:** `POST /api/auth/login`
* **المصادقة عبر جوجل:** `GET /api/auth/google` و `GET /api/auth/google/callback`

### 2. السائقين والتتبع اللحظي (Drivers & Tracking)
* **جلب الكباتن المتاحين:** `GET /api/drivers/nearby?lat=31.9961&lon=44.3168`
* **تحديث موقع الكابتن:** `POST /api/driver/location`
* **موقع الكابتن المباشر للراكب:** `GET /api/driver/{driverId}/live`

### 3. مطابقة المسارات والحجوزات (Routes & Bookings)
* **البحث عن مسار مطابق:** `POST /api/matching/find-routes`
* **إنشاء حجز جديد:** `POST /api/bookings`
* **جلب حجوزات السائق:** `GET /api/driver/{driverId}/bookings`

### 4. الإدارة والتوثيق (Admin & Operations)
* **إحصائيات النظام العامة:** `GET /api/admin/stats`
* **السائقين بانتظار التوثيق:** `GET /api/admin/drivers/pending-verifications`
* **اعتماد مستند / سائق:** `POST /api/admin/documents/{docId}/verify`
* **سجل التدقيق الأمني:** `GET /api/admin/audit-logs`

---

## 🛠️ طريقة التشغيل والتطوير المحلي (Local Development Setup)

### 1. المتطلبات:
- **Node.js** (إصدار `>= 18.0.0`)
- **Flutter SDK** (إصدار `>= 3.24.0`)
- **Docker** (اختياري لتشغيل PostgreSQL و Redis محلياً)

### 2. تشغيل خادم لوحة التحكم والـ APIs:
```bash
cd /Users/mu_it/Documents/Twssela_iq/taxi-wisam

# تشغيل خادم المنصة على المنفذ 5050
node scripts/serve-dashboard.js
```
- افتح المتصفح على: [http://localhost:5050/dashboard/index.html](http://localhost:5050/dashboard/index.html)
- بيانات الدخول: `admin` / `1122`

### 3. تشغيل تطبيق الموبايل (Flutter):
```bash
cd apps/taxi_wisam_flutter

# تثبيت الحزم
flutter pub get

# تشغيل التطبيق على الويب
flutter run -d chrome

# أو تشغيل التطبيق على محاكي الهاتف
flutter run
```

---

## ☁️ دليل النشر على سيرفر سحابي (Production VPS Deployment)

1. **تحديث الحزم وتثبيت المتطلبات على Ubuntu 24.04:**
   ```bash
   sudo apt update && sudo apt install -y nodejs npm nginx git certbot python3-certbot-nginx
   sudo npm install -g pm2
   ```

2. **سحب الكود وإعداد المسارات:**
   ```bash
   mkdir -p /var/www
   cd /var/www
   git clone https://github.com/rtor29/taxi-nwealwsam.git taxi-wisam
   cd taxi-wisam
   npm install
   ```

3. **تشغيل الخادم عبر PM2:**
   ```bash
   pm2 start scripts/serve-dashboard.js --name "taxi-wisam-api" --cwd /var/www/taxi-wisam --time
   pm2 save
   pm2 startup
   ```

4. **إعداد Nginx كـ Reverse Proxy:**
   ```nginx
   server {
       listen 80;
       server_name tawseelaiq.app www.tawseelaiq.app 173.212.206.86;

       location / {
           proxy_pass http://127.0.0.1:5050;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       }
   }
   ```
   تفعيل الشهادة:
   ```bash
   sudo certbot --nginx -d tawseelaiq.app -d www.tawseelaiq.app
   ```

---

## 🤖 إرشادات المطورين والذكاء الاصطناعي (Developer & AI Guidelines)

إذا كنت مطوراً بشرياً أو عميل ذكاء اصطناعي (AI Agent) تساهم في تطوير هذا المشروع، يرجى مراعاة القواعد التالية:

1. **سلامة وأمن البيانات:** لا تقم برفع ملفات `.env` أو مفاتيح سرية خاصة إلى المستودع العام. استخدم دائماً `.env.example` كمرجع للمتغيرات.
2. **التكامل مع النطاق الجغرافي:** كافة الحسابات المكانية يجب أن تركز على محافظة النجف الأشرف ونواحيها (`(31.9961, 44.3168)`).
3. **هيكلية التخزين المزدوج:** عند إضافة أو تعديل أي مسارات أو كائنات جديدة في الـ Backend، احرص على تحديث كل من دالة الـ Memory State وكتابة استعلام PostgreSQL المتوافق.
4. **توافق لوحة التحكم:** واجهة لوحة التحكم (`app.js` و `index.html`) تعتمد على استدعاءات REST مباشرة إلى `/api/admin/*` مع مصادقة `localStorage.getItem('tawseela_admin_auth')`.
5. **توافق تطبيق Flutter:** يستخدم التطبيق `AppConfig.baseUrl` الذي يحدد الرابط ديناميكياً (Origin في الويب، والرابط الثابت في تطبيق الهاتف).

---

### 👨‍💻 الترخيص والمطورون
- **المشروع:** منصة توصيلة (Taxi-Wisam).
- **المستودع الرسمي:** [https://github.com/rtor29/taxi-nwealwsam](https://github.com/rtor29/taxi-nwealwsam)
- **النطاق المعتمد:** [https://tawseelaiq.app/](https://tawseelaiq.app/)
- **الموقع الجغرافي:** محافظة النجف الأشرف، جمهورية العراق.
