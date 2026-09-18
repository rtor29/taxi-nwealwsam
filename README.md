# 🚖 منصة تكسي وسام | Taxi-Wisam Platform
### المنصة الذكية المتكاملة لحجز الرحلات والخطوط المنتظمة - محافظة النجف الأشرف
**Comprehensive Technical Documentation & Architecture Reference for Developers and AI Agents**

---

## 📑 فهرس المحتويات (Table of Contents)
1. [نظرة عامة على المشروع (Overview)](#-نظرة-عامة-على-المشروع-overview)
2. [المعمارية التقنية الشاملة (System Architecture)](#-المعمارية-التقنية-الشاملة-system-architecture)
3. [هيكل المجلدات ومخطط الكود (Repository Structure)](#-هيكل-المجلدات-ومخطط-الكود-repository-structure)
4. [تطبيق الهاتف المحمول (Flutter Mobile App)](#-تطبيق-الهاتف-المحمول-flutter-mobile-app)
5. [الخلفية البرمجية وخادم المنصة (Backend Services)](#-الخلفية-البرمجية-وخادم-المنصة-backend-services)
6. [لوحة التحكم الإدارية (Admin Dashboard)](#-لوحة-التحكم-الإدارية-admin-dashboard)
7. [المحرك الجغرافي المكاني وقاعدة البيانات (PostGIS & Database)](#-المحرك-الجغرافي-المكاني-وقاعدة-البيانات-postgis--database)
8. [توثيق واجهات برمجة التطبيقات (API Reference)](#-توثيق-واجهات-برمجة-التطبيقات-api-reference)
9. [طريقة التشغيل والتطوير المحلي (Local Development Setup)](#-طريقة-التشغيل-والتطوير-المحلي-local-development-setup)
10. [دليل النشر على سيرفر سحابي (Production VPS Deployment - Hostinger)](#-دليل-النشر-على-سيرفر-سحابي-production-vps-deployment)
11. [إرشادات المطورين والذكاء الاصطناعي (Developer & AI Guidelines)](#-إرشادات-المطورين-والذكاء-الاصطناعي-developer--ai-guidelines)

---

## 📌 نظرة عامة على المشروع (Overview)

منصة **تكسي وسام (Taxi-Wisam)** هي منظومة نقل ذكية مخصصة لخدمة **محافظة النجف الأشرف**، تجمع بين:
- **خدمة المشاوير الفورية:** ربط الراكب بأقرب كابتن تكسي متاح في النجف.
- **خدمة الخطوط المنتظمة التشاركية:** مطابقة الركاب الذين يسلكون نفس المسار يومياً (مثل خطوط الجامعات، الموظفين، والمطار) بنظام PostGIS لحساب التداخل ومسافة الانحراف وتقاسم الأجرة.
- **لوحة تحكم إدارية مركزية:** إدارة وتوثيق السائقين ورخص القيادة، مراقبة الرحلات، وحساب الإحصائيات والإيرادات.

### 📍 النطاق الجغرافي الحصري (Najaf Governorate Spatial Bounds):
- **مركز المحافظة ومرقد الإمام علي (ع):** `(31.9961, 44.3168)`
- **مسجد الكوفة المعظم وجامعة الكوفة:** `(32.0300, 44.3700)`
- **مطار النجف الدولي:** `(31.9900, 44.4040)`
- **المناطق المشمولة:** المدينة القديمة، الحنانة، حي السعد، الكوفة، الحيدرية، المشخاب، والمناذرة.

---

## 🏛️ المعمارية التقنية الشاملة (System Architecture)

يعتمد النظام على بنية هجينة احترافية تفصل طبقات العرض عن المنطق الحسابي وقواعد البيانات:

```
                      ┌─────────────────────────────────────────┐
                      │        Flutter Client Application       │
                      │       (iOS / Android / iPadOS)          │
                      └────────────────────┬────────────────────┘
                                           │
                        HTTPS REST API     │     WebSocket (SignalR)
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │           API Gateway / Backend         │
                      │   (ASP.NET Core 9.0 / Node.js Engine)   │
                      └─────────┬───────────────────┬───────────┘
                                │                   │
                 ┌──────────────┴──────────┐        └─────────────┐
                 ▼                         ▼                      ▼
        ┌────────────────┐        ┌────────────────┐     ┌────────────────┐
        │  PostgreSQL +  │        │  Redis Cache   │     │ Supabase S3    │
        │ PostGIS Engine │        │ (Fast Spatial) │     │ Private Bucket │
        │  (24 Tables)   │        │  (Ephemeral)   │     │ (Driver Docs)  │
        └────────────────┘        └────────────────┘     └────────────────┘
                 ▲
                 │
        ┌─────────────────────────────────────────┐
        │       Admin Management Dashboard        │
        │    (SPA Tailwind CSS / REST Admin APIs) │
        └─────────────────────────────────────────┘
```

---

## 📂 هيكل المجلدات ومخطط الكود (Repository Structure)

```
taxi-wisam/
├── apps/
│   └── taxi_wisam_flutter/          # تطبيق الهاتف المحمول (Flutter)
│       ├── lib/
│       │   ├── app_config.dart      # الإعدادات العامة وعناوين الخادم والإحداثيات
│       │   ├── core/                # الخدمات الأساسية (الشبكة، SignalR، التخزين)
│       │   │   ├── network/         # ApiClient عبر Dio و ApiEndpoints
│       │   │   └── services/        # SignalRService و StorageService
│       │   ├── features/
│       │   │   ├── auth/            # شاشات تسجيل الدخول، إنشاء الحساب، والنماذج
│       │   │   ├── customer/        # شاشات الراكب (الرئيسية، تحديد المسار، التتبع)
│       │   │   └── driver/          # شاشات السائق (البوابة، إنشاء خط، رفع المستندات)
│       │   └── main.dart            # نقطة انطلاق التطبيق والفحص التلقائي للجلسة
│       ├── ios/                     # إعدادات وأيقونات وبناء نظام iOS
│       └── android/                 # إعدادات وبناء نظام Android
├── src/                             # مشاريع Backend المبنية بنمط Clean Architecture
│   ├── TaxiWisam.Api/               # طبقة الـ API و Controllers و SignalR Hubs
│   │   └── wwwroot/dashboard/       # واجهة لوحة التحكم الإدارية (HTML, JS, CSS)
│   ├── TaxiWisam.Application/       # طبقة حالات الاستخدام ومحرك المطابقة والـ Interfaces
│   ├── TaxiWisam.Domain/            # الكيانات، الجداول، والـ Enums
│   └── TaxiWisam.Infrastructure/    # الاتصال بقاعدة البيانات، Redis، OSRM، والتخزين
├── scripts/
│   ├── serve-dashboard.js           # خادم التشغيل الفوري للوحة التحكم والـ Mock APIs
│   ├── apply-migrations.sh          # سكربت تطبيق جداول ودوال قاعدة البيانات
│   └── deploy-to-iphone.sh          # سكربت التثبيت التلقائي على أجهزة الآيفون
├── supabase/
│   └── migrations/                  # ملفات SQL لبناء الجداول والدوال الجغرافية
├── docker-compose.yml               # ملف تشغيل Redis وقاعدة البيانات محلياً
└── TaxiWisam.sln                    # ملف الحل البرمجي لـ .NET
```

---

## 📱 تطبيق الهاتف المحمول (Flutter Mobile App)

يقع كود التطبيق في المجلد `apps/taxi_wisam_flutter`.

### الميزات والشاشات الرئيسية:
1. **شاشة الدخول والتسجيل (`lib/features/auth/screens/`):**
   - دعم الإكمال التلقائي الذكي لبريد الآيفون/الأندرويد واختصارات `@gmail.com` و `@icloud.com`.
   - اختيار الدور (راكب `Customer` أو كابتن `Driver`).
   - إدخال رقم إجازة السوق للسائق لربطه آلياً بملف التوثيق.
2. **شاشة الراكب الرئيسية (`customer_home_screen.dart`):**
   - خريطة تفاعلية حية لمدينة النجف الأشرف (`flutter_map` مع طبقات OpenStreetMap).
   - عرض سيارات الكباتن المتواجدين حالياً في النجف كمركبات متحركة.
   - بطاقة **"أقرب كابتن متاح"** (الاسم، المسافة بالكيلومتر، زمن الوصول المتوقع) مع زر طلب فوري.
   - سجل الحجوزات السابقة ومتابعة الرحلات.
3. **شاشة تحديد المسار وحجز المقاعد (`route_search_screen.dart`):**
   - **خريطة تفاعلية لاختيار المواقع:** النقر باللمس لتحديد نقطة الانطلاق (دبوس أخضر 🟢) ووجهة الوصول (دبوس أحمر 🔴).
   - **زر GPS موقعي الحالي 📍:** لتحديد مكان الراكب عبر الـ GPS تلقائياً.
   - **حساب الأجرة والمسافة:** حساب فوري للمسافة بالكيلومتر والسعر التقديري ورسم خط المسار.
   - **مطابقة الخطوط المنتظمة:** استعراض الخطوط المتطابقة وحجز مقاعد فورية.
4. **شاشة تتبع الكابتن المباشر (`live_tracking_screen.dart`):**
   - بث مباشر لموقع الكابتن عبر **SignalR** وتحديث زاويته واتجاه مركبته على الخريطة لحظياً.
5. **بوابة السائق (`driver_home_screen.dart`):**
   - التبديل بين متاح/غير متاح (Online / Offline).
   - بث إحداثيات السائق الحالية للمنصة.
   - رفع المستمسكات الرسمية وإجازة السوق (`document_upload_screen.dart`).
   - إنشاء خط نقل منتظم وتحديد المقاعد والأسعار (`create_route_screen.dart`).

---

## 🖥️ لوحة التحكم الإدارية (Admin Dashboard)

تقع لوحة التحكم داخل `src/TaxiWisam.Api/wwwroot/dashboard/` ويتم تشغيلها محلياً أو سحابياً عبر المنفذ `5050`.

### أقسام لوحة التحكم:
1. **المؤشرات ونظرة عامة (Overview):** إجمالي المستخدمين، السائقين المعتمدين، الحجوزات، والطلبات المعلقة.
2. **توثيق السائقين (Driver Verifications):**
   - جدول السائقين الجدد غير الموثقين.
   - زر **فحص** لمعاينة رخصة القيادة والوثائق الرسمية عبر روابط مشفرة مؤقتة (Signed URLs).
   - زر **اعتماد وتوثيق المستند** ينقل السائق فوراً لحالة معتمد `Active / Online` ويحدث العدادات وسجل التدقيق.
3. **إدارة السائقين (Drivers Management):** قائمة بكافة السائقين مع أرقام هواتفهم، أرقام الرخص، والتقييمات.
4. **إدارة الركاب (Customers Management):** قائمة الركاب النشطين وحساباتهم.
5. **المسارات والحجوزات (Routes & Bookings):** مراقبة خطوط السير التشاركية والرحلات الحالية.
6. **الشكاوى والبلاغات (Complaints):** متابعة بلاغات الركاب والسائقين والتحقيق فيها.
7. **إعدادات التسعير (Pricing Settings):** ضبط فتحة العداد، سعر الكيلومتر، وسعر الدقيقة، ومضاعف الذروة.
8. **سجل التدقيق الأمني (Audit Logs):** تسجيل شامل لكافة العمليات الحساسة (توقيتها، المنفذ، وعنوان IP).

---

## 🌍 المحرك الجغرافي المكاني وقاعدة البيانات (PostGIS & Database)

تعتمد المنصة على PostgreSQL مع امتداد **PostGIS** لإجراء الحسابات الهندسية بدقة فائقة:

### 1. دوال SQL المكانية (`supabase/migrations/20260917000002_spatial_functions.sql`):
- `fn_find_nearby_drivers(lat, lon, radius_meters)`:
  تستخدم `ST_DWithin` ومؤشرات `GiST` المكانية للبحث عن أقرب السائقين في محيط جغرافي معين خلال أجزاء من الثانية.
- `fn_calculate_route_overlap(route_a, route_b, buffer_meters)`:
  حساب نسبة التداخل المشترك بين مسار السائق ومسار الراكب بالنسبة المئوية.
- `fn_is_point_along_route(pickup, dropoff, route, buffer_meters)`:
  التأكد من أن نقطة الصعود ونقطة النزول تقعان على نفس اتجاه المسار وضمن النطاق المسموح به (`ST_LineLocatePoint`).

### 2. سياسات التخزين المشفر (Storage Security):
- الحاوية `driver-documents`: حاوية خاصة ومحمية (**Strictly Private**). لا يمكن الوصول إليها بروابط عامة، بل تُنتج الخوادم روابط مؤقتة (**Signed URLs**) صالحة لمدة محدودة للمشرفين فقط.

---

## 🔌 توثيق واجهات برمجة التطبيقات (API Reference)

### 1. المصادقة والحسابات (Authentication)
* **تسجيل حساب جديد:** `POST /api/auth/register`
  ```json
  {
    "fullName": "موسى هاشم",
    "phoneNumber": "07801234567",
    "email": "mousa@example.com",
    "role": "Customer", // أو "Driver"
    "licenseNumber": "NJF-1234" // مطلوب فقط في حال كان السائق
  }
  ```
* **تسجيل الدخول:** `POST /api/auth/login`
  ```json
  { "identifier": "07801234567" }
  ```

### 2. السائقين والتتبع (Drivers & Tracking)
* **جلب أقرب السائقين:** `GET /api/drivers/nearby?latitude=31.9961&longitude=44.3168`
* **تحديث حالة السائق:** `POST /api/drivers/{driverId}/status`
* **بث الموقع اللحظي:** عبر SignalR Hub على الرابط `/hubs/tracking` (الدالة: `SendLocation(lat, lon, heading)`).

### 3. مطابقة المسارات والحجوزات (Matching & Bookings)
* **البحث عن مسارات متطابقة:** `POST /api/matching/find-routes`
  ```json
  {
    "pickupLat": 31.9961,
    "pickupLon": 44.3168,
    "dropoffLat": 32.0300,
    "dropoffLon": 44.3700,
    "desiredTime": "07:30:00",
    "seatsNeeded": 1
  }
  ```
* **إنشاء حجز رحلة:** `POST /api/bookings`
* **جلب حجوزات الراكب:** `GET /api/bookings/customer/{customerId}`

### 4. الإدارة والتوثيق (Admin & Verification)
* **إحصائيات النظام:** `GET /api/admin/stats`
* **قائمة السائقين قيد التوثيق:** `GET /api/admin/drivers/pending-verifications`
* **اعتماد مستند السائق:** `POST /api/admin/documents/{docId}/verify` (`{"approved": true}`)
* **سجل التدقيق الأمني:** `GET /api/admin/audit-logs`

---

## 🛠️ طريقة التشغيل والتطوير المحلي (Local Development Setup)

### 1. المتطلبات المسبقة:
- تثبيت **Flutter SDK** (إصدار `>= 3.24.0`).
- تثبيت **Node.js** (إصدار `>= 18.0.0`) أو **.NET 9.0 SDK**.
- تثبيت **Xcode** لنظام macOS (لتشغيل محاكي الآيفون أو تثبيت التطبيق على جهاز حقيقي).

### 2. تشغيل لوحة التحكم والـ Backend المحلي:
```bash
# الانتقال لمجلد المشروع
cd taxi-wisam

# تشغيل خادم لوحة التحكم والـ APIs على المنفذ 5050
node scripts/serve-dashboard.js
```
- افتح المتصفح على: `http://localhost:5050/dashboard/index.html`

### 3. تشغيل تطبيق الهاتف (Flutter App):
```bash
cd apps/taxi_wisam_flutter

# جلب الحزم
flutter pub get

# فحص خلو الكود من الأخطاء
flutter analyze

# تشغيل التطبيق على المحاكي أو الجهاز المتصل
flutter run
```

---

## ☁️ دليل النشر على سيرفر سحابي (Production VPS Deployment)

لنشر النظام على سيرفر افتراضي خاص (**KVM VPS على Hostinger أو أي مزود آخر بنظام Ubuntu 24.04**):

### 1. إعداد السيرفر وتحديث الحزم:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose git nginx certbot python3-certbot-nginx
sudo systemctl enable --now docker
```

### 2. سحب الكود وتشغيل الحاويات:
```bash
git clone https://github.com/rtor29/taxi-nwealwsam.git
cd taxi-nwealwsam

# تشغيل قاعدة البيانات و Redis
docker-compose up -d

# تشغيل خادم النظام
nohup node scripts/serve-dashboard.js > server.log 2>&1 &
```

### 3. إعداد Nginx وشهادة الأمان SSL (HTTPS):
أنشئ ملف إعداد Nginx:
```nginx
server {
    server_name api.taxiwisam.com;

    location / {
        proxy_pass http://localhost:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```
ثم تفعيل التشفير مجاناً عبر Let's Encrypt:
```bash
sudo certbot --nginx -d api.taxiwisam.com
```

### 4. تحديث رابط التطبيق:
في ملف `apps/taxi_wisam_flutter/lib/app_config.dart`، عدّل `baseUrl`:
```dart
static String get baseUrl => 'https://api.taxiwisam.com';
```

---

## 🤖 إرشادات المطورين والذكاء الاصطناعي (Developer & AI Guidelines)

إذا كنت مطوراً بشرياً أو عميل ذكاء اصطناعي (AI Agent) تعمل على هذا المشروع، يجب الالتزام بالقواعد التالية:

1. **الأمان الصارم للبيانات:** يمنع منعاً باتاً استدعاء قاعدة البيانات أو تمرير `SERVICE_ROLE_KEY` داخل كود تطبيق Flutter. كافة العمليات تمر حتماً عبر الـ Backend API.
2. **الحدود الجغرافية:** جميع المعالم، أسماء المناطق، والإحداثيات الافتراضية يجب أن تكون محصورة بمحافظة النجف الأشرف (`31.9961, 44.3168`). لا تضف أي بيانات تجريبية تخص مدن أخرى.
3. **المعالجة الذرية (Transactional Outbox):** عند إنشاء حجز، يجب التأكد من تعديل المقاعد وإرسال الإشعار وتسجيل التدقيق ضمن معيار Transaction متكامل.
4. **تكامل لوحة التحكم:** جدول التوثيق في لوحة التحكم ينتظر كائنات سائقين تحتوي مصفوفة `documents` بحالة `Pending` ونوع مستند `DrivingLicense`.
5. **الخرائط التفاعلية:** استخدم دائماً مكتبة `flutter_map` مع OpenStreetMap ومكتبة `latlong2` للتعامل مع الإحداثيات المكانية.

---

### 👨‍💻 الترخيص والمطورون
- **المشروع:** منصة تكسي وسام (Taxi-Wisam).
- **المستودع الرسمي:** [https://github.com/rtor29/taxi-nwealwsam](https://github.com/rtor29/taxi-nwealwsam)
- **النطاق:** محافظة النجف الأشرف، جمهورية العراق.
