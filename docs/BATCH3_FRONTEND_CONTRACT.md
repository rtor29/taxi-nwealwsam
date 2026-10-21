# عقد التكامل للدفعة 3 (تطوير الواجهة الأمامية - Frontend Contract)

> **تاريخ الإصدار:** 21 أكتوبر 2026  
> **النطاق:** واجهة الراكب والكابتن (`tawseela-web`)  

---

## 1. معدل تحديث موقع الكابتن (Driver Location Rate Limit)
- **المسار:** `POST /api/driver/location`
- **الحد البرمجي الصارم:** تم تفعيل محدد معدل موزع (Distributed Cluster Rate Limiter) في الباك إند عبر Redis:
  - الحد: **30 طلباً كحد أقصى لكل 30 ثانية** لكل كابتن (`30 req / 30s`).
  - أي طلبات تتجاوز هذا الحد ستُرفض فوراً بكود **`429 Too Many Requests`**.
- **المطلوب من الواجهة في الدفعة 3:**
  - يجب ضبط مؤقت إرسال إحداثيات GPS من المتصفح أو تطبيق الكابتن بحيث **لا يتجاوز طلباً واحداً كل 1.5 إلى 2 ثانية** (أو كحد أقصى مطلق: طلب واحد كل 1 ثانية عند الحركة السريعة فقط).
  - استخدام Throttling / Debouncing على مستمع `navigator.geolocation.watchPosition` لمنع إرسال طلبات متلاحقة عند تقلب دقة الإشارة (jitter).

---

## 2. معايير استجابة مسارات الحالة (Zero 404 Policy)
- المسارات:
  - `GET /api/driver/:id/active-ride`
  - `GET /api/ride/status/:id`
  - `GET /api/ride/:id`
- **السلوك المعتمد:** لا تُرجع هذه المسارات كود `404` عند عدم وجود رحلة نشطة، بل تُرجع دائماً كود **`200 OK`** مع:
  ```json
  {
    "success": true,
    "notFound": true,
    "request": null,
    "activeRide": null
  }
  ```
- **المطلوب من الواجهة:** التحقق من وجود الكائن `request` أو `activeRide` بدلاً من الاعتماد على التقاط خطأ 404 في الـ Catch block.

---

## 3. قناة الأحداث الحية (SSE)
- الاعتماد الكامل على Server-Sent Events (SSE):
  - للكابتن: `/api/events/driver/:id?token=...`
  - للراكب: `/api/ride/:id/stream?token=...`
- تفعيل إعادة الاتصال التلقائي (Automatic Reconnection) مع Backoff تدريجي عند انقطاع الشبكة.

---

## 4. تأكيد الكروة من الراكب (Rider Fare Confirmation)
- المسار: `POST /api/ride/confirm-fare`
  - المعاملات: `{ requestId: "...", confirmed: true/false, note: "..." }`
  - عند عدم التأكيد أو الاعتراض، تُوسم الرحلة بـ `pending_review` للمراجعة الإدارية.
