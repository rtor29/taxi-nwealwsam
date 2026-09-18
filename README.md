# 🚖 Taxi-Wisam Backend Infrastructure
### Supabase PostgreSQL (PostGIS) + ASP.NET Core Enterprise Clean Architecture

---

## 📌 نظرة عامة على النظام (System Overview)

مشروع **Taxi-Wisam** يعتمد على نموذج معماري هجين واحترافي يجمع بين قوة خدمات **Supabase** كبنية تحتية موثوقة للبيانات والتخزين، مع الحفاظ الكامل على **ASP.NET Core (Clean Architecture)** كطبقة المعالجة والأعمال والتحكم في النظام (Business Logic, Matching Engine, Authorization, Outbox, Realtime).

```
                ┌────────────────────────┐
                │   Flutter App (Client) │
                │   (Android / iOS / Web)│
                └───────────┬────────────┘
                            │
              REST API / WSS (SignalR)
                            │
                            ▼
                ┌────────────────────────┐
                │    ASP.NET Core API    │
                │  (Matching, Auth, Bl)  │
                └───────────┬────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
   ┌───────────┐      ┌────────────┐     ┌────────────┐
   │   Redis   │      │  SignalR   │     │  Hangfire  │
   │ (Fast Geo)│      │ (Tracking) │     │ (Scheduler)│
   └───────────┘      └────────────┘     └─────┬──────┘
                                               │
                                               ▼
                                      ┌─────────────────┐
                                      │ Outbox Worker   │
                                      └────────┬────────┘
                                               │
                                               ▼
                          ┌─────────────────────────────┐
                          │    Supabase PostgreSQL     │
                          │   + PostGIS (24 Tables)     │
                          └─────────────────────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────────┐
                          │   Supabase Storage Engine   │
                          │  (Private & Public Buckets) │
                          └─────────────────────────────┘
```

---

## 🏛️ المبادئ المعمارية الصارمة (Strict Architectural Rules)

1. **Flutter لا يتصل بقاعدة البيانات مباشرة**:
   - تطبيق الهاتف يتصل **فقط** عبر واجهات برمجية آمنة (ASP.NET Core REST API & SignalR).
   - مفتاح `SUPABASE_SERVICE_ROLE_KEY` وكلمة مرور قاعدة البيانات **محظور وضعهما داخل تطبيق العميل نهائياً**، ويبقيان داخل بيئة الخادم المشفرة.
2. **Supabase PostgreSQL هو مصدر الحقيقة الدائم (Source of Truth)**:
   - يحتوي على كافة البيانات الدائمة والعمليات الحسابية المكانية (PostGIS).
3. **Redis هو طبقة البيانات الفائقة السرعة (High-Speed Ephemeral Layer)**:
   - يُستخدم فقط لتخزين الإحداثيات اللحظية للسائقين عبر (GEOADD / GEORADIUS)، وحالة الاتصال (Online/Offline)، والقفل التوزيعي (Distributed Locks) لضمان حجز المقاعد دون تعارض.
4. **حماية وثائق السائقين الحساسة (Private Buckets & Signed URLs)**:
   - صور الهويات ورخص القيادة والوثائق الرسمية تخزن في Bucket خاص `driver-documents` (Private).
   - لا يمكن للعامة الوصول للملفات؛ يقوم الـ Backend بتوليد روابط مؤقتة مشفرة ومحددة بوقت (**Signed URLs**) للمشرفين المصرح لهم فقط.
5. **النمط الإجرائي الموثوق للأحداث (Transactional Outbox Pattern)**:
   - يتم حجز الرحلة وتخفيض المقاعد وتسجيل حدث الـ Outbox داخل معاملة واحدة ذرية (`DbTransaction`).
   - يقوم Hangfire بمعالجة الأحداث وإرسال التنبيهات عبر SignalR و FCM تلقائياً مع إعادة المحاولة في حال الفشل.

---

## 🗄️ جداول قاعدة البيانات الـ 24 (Database Tables)

| # | اسم الجدول (Table) | الوصف والدور | الميزات الجغرافية / الخاصة |
|---|---|---|---|
| 1 | `users` | الحسابات الرئيسية (ركاب، سائقون، مشرفون) | أرقام هواتف فريدة، أدوار النظام |
| 2 | `drivers` | بيانات السائق وحالته وتقييمه | موقع جغرافي `Point(4326)` + مؤشر `GiST` |
| 3 | `customers` | ملفات الركاب وأرقام الطوارئ | تقييم الركاب، وسيلة الدفع المفضلة |
| 4 | `vehicles` | بيانات المركبات والمقاعد المتوفرة | بيانات صور السيارات JSONB |
| 5 | `driver_documents` | مستمسكات السائقين ووثائق التحقق | مسارات التخزين في الـ Private Bucket |
| 6 | `driver_routes` | خطوط النقل المنتظمة للسائقين | هندسة المسار `LineString(4326)` + نقط البداية/النهاية |
| 7 | `route_points` | محطات التوقف على طول المسار | `Point(4326)` + الفترات الزمنية المتوقعة |
| 8 | `route_areas` | مناطق ونطاقات التغطية الجغرافية | مضلعات جغرافية `Polygon(4326)` |
| 9 | `bookings` | حجوزات الركاب للمقاعد | نقاط الصعود والنزول `Point(4326)` |
| 10 | `transport_requests` | طلبات التوصيل الدورية للركاب | نقاط الانطلاق والوصول المرغوبة |
| 11 | `short_trip_requests` | طلبات المشاوير السريعة الفورية | مسار الرحلة الفعلي `LineString(4326)` |
| 12 | `driver_ads` | إعلانات السائقين للرحلات المشتركة والشارتر | مسار الرحلة المعلنة وتاريخ الانتهاء |
| 13 | `customer_ads` | إعلانات وبحث الركاب عن خطوط مشتركة | نقاط التجمع المرغوبة والميزانية |
| 14 | `matches` | نتائج محرك المطابقة بين الركاب والسائقين | نسبة التداخل، مسافة الانحراف، درجة التطابق |
| 15 | `notifications` | إشعارات النظام وتنبيهات الرحلات | حمولة البيانات JSONB، حالة القراءة |
| 16 | `ratings` | تقييمات الرحلات المتبادلة | درجات 1-5 وتعليقات المراجعة |
| 17 | `complaints` | الشكاوى المرفوعة مع المرفقات | مسارات صور الشكاوى المشفرة |
| 18 | `payments` | مدفوعات الرحلات والاشتراكات | ZainCash, AsiaHawala, Cash |
| 19 | `subscriptions` | اشتراكات السائقين الشهرية في المنصة | فترات التجديد التلقائي وحالة الاشتراك |
| 20 | `invoices` | الفواتير الضريبية والمالية | أرقام فواتير فريدة وروابط PDF |
| 21 | `outbox_messages` | سجل الأحداث الموثوقة (Outbox Pattern) | معالجة الحالات، إعادة المحاولة، تقارير الأخطاء |
| 22 | `audit_logs` | سجل تدقيق العمليات الحساسة | القيم السابقة والجديدة للمراجعة الأمنية |
| 23 | `system_settings` | إعدادات الأسعار ومسافات الانحراف | قيم بصيغة JSONB قابلة للتعديل ديناميكياً |
| 24 | `refresh_tokens` | إدارة جلسات الدخول وتجديد الـ JWT | منع تزوير الجلسات وتأمين الأجهزة |

---

## 🌍 دوال PostGIS المكانية (Spatial Functions)

تم إنشاء دوال مخصصة داخل `supabase/migrations/20260917000002_spatial_functions.sql`:
1. `fn_find_nearby_drivers(lat, lon, radius_meters)`:
   - البحث فائق السرعة عن أقرب السائقين النشطين (Online) باستخدام `ST_DWithin` و Spatial GiST Indexes.
2. `fn_calculate_route_overlap(route_a, route_b, buffer_meters)`:
   - حساب نسبة التطابق والتداخل بين مسار السائق ومسار الراكب بوحدة الأمتار والنسبة المئوية.
3. `fn_is_point_along_route(pickup, dropoff, route, buffer_meters)`:
   - التأكد من وقوع نقطتي صعود ونزول الراكب ضمن الرواق المسموح لمسار السائق، وبالاتجاه الصحيح للمسار (`ST_LineLocatePoint`).

---

## 📦 إدارة التخزين (Supabase Storage)

| اسم الـ Bucket | نوع الوصول (Access) | نوع المحتوى | سياسة الأمان (Security Policy) |
|---|---|---|---|
| `driver-documents` | **Strictly Private** | هويات، رخص قيادة، شهادات عدم محكومية | لا وصول مباشر. المشرف يطلب رابط موقّع (**Signed URL**) مؤقت الصلاحية من الـ Backend |
| `complaint-attachments` | **Strictly Private** | صور وفيديوهات إثبات الشكاوى | محمي بمفتاح Service Role ومتاح فقط للتحقيق الإداري |
| `vehicle-photos` | **Public Read** | صور السيارات والمركبات | قراءة عامة للتطبيق + رفع حصري عبر الـ API |
| `user-avatars` | **Public Read** | الصور الشخصية للمستخدمين | قراءة عامة للصور الشخصية |

---

## 🚀 كيفية ربط Supabase وتطبيق التحديثات (Deployment & Migration)

المشروع مرتبط بمعرّف المشروع الخاص بكم:
- **Project Ref**: `zterexrspluhomwgdjzp`
- **Supabase URL**: `https://zterexrspluhomwgdjzp.supabase.co`

### الطريقة الأولى: عبر Supabase CLI (الموصى بها)
1. افتح الطرفية وتأكد من تسجيل الدخول:
   ```bash
   supabase login
   ```
2. اربط المشروع ببيانات الاعتماد الخاصة بك:
   ```bash
   supabase link --project-ref zterexrspluhomwgdjzp
   ```
   *(سيُطلب منك إدخال كلمة مرور قاعدة البيانات الخاصة بحسابك).*
3. ارفع ملفات الـ Migrations مباشرة:
   ```bash
   supabase db push
   ```

أو ببساطة شغل السكربت الجاهز:
```bash
./scripts/apply-migrations.sh
```

### الطريقة الثانية: عبر لوحة تحكم Supabase (SQL Editor)
يمكنك نسخ ولصق محتويات الملفات الموجودة في مجلد `supabase/migrations/` بالترتيب في **Supabase Dashboard -> SQL Editor**:
1. `20260917000001_initial_schema.sql` (الجداول والفهارس المكانية)
2. `20260917000002_spatial_functions.sql` (الدوال الجغرافية)
3. `20260917000003_storage_buckets.sql` (إعدادات الـ Buckets وسياسات الأمان)
4. `20260917000004_seed_data.sql` (إعدادات النظام الافتراضية)

---

## 💻 تشغيل طبقة الـ Backend (ASP.NET Core API)

### 1. المتطلبات:
- .NET 9.0 SDK
- خادم Redis (يمكن تشغيله محلياً عبر Docker: `docker-compose up -d`)

### 2. تهيئة الاتصال في `appsettings.json` أو المتغيرات البيئية:
```json
{
  "ConnectionStrings": {
    "DefaultConnection": "Host=db.zterexrspluhomwgdjzp.supabase.co;Port=5432;Database=postgres;Username=postgres;Password=YOUR_PASSWORD;SSL Mode=Require;Trust Server Certificate=true;",
    "Redis": "localhost:6379"
  },
  "Supabase": {
    "Url": "https://zterexrspluhomwgdjzp.supabase.co",
    "AnonKey": "sb_publishable_ezUbJXBc8m5EiRmqXpoK7Q__V1VrZVl",
    "ServiceRoleKey": "YOUR_SERVER_SIDE_SERVICE_ROLE_KEY"
  }
}
```

### 3. بناء وتشغيل المشروع:
```bash
dotnet build TaxiWisam.sln
dotnet run --project src/TaxiWisam.Api
```

- رابط وثائق الـ API التفاعلية: `http://localhost:5000/swagger`
- رابط لوحة متابعة المهام الخلفية: `http://localhost:5000/hangfire`
- نقطة نهاية التتبع اللحظي: `ws://localhost:5000/hubs/tracking`
