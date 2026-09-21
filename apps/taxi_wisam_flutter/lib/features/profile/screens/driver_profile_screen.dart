import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/network/api_client.dart';
import '../../../core/theme/app_theme.dart';
import '../../ads/models/vacancy_ad_model.dart';

/// شاشة الملف الشخصي للكابتن (Driver Profile) مع الاتصال المباشر والواتساب
class DriverProfileScreen extends StatefulWidget {
  final VacancyAd ad;
  final ApiClient apiClient;

  const DriverProfileScreen({
    super.key,
    required this.ad,
    required this.apiClient,
  });

  @override
  State<DriverProfileScreen> createState() => _DriverProfileScreenState();
}

class _DriverProfileScreenState extends State<DriverProfileScreen> {
  bool _isBooking = false;
  int _seatsToBook = 1;

  /// إجراء مكالمة هاتفية مباشرة
  Future<void> _makePhoneCall(String phoneNumber) async {
    // تنظيف الرقم وإعداده
    final cleanPhone = phoneNumber.replaceAll(RegExp(r'[^\d+]'), '');
    final Uri launchUri = Uri(
      scheme: 'tel',
      path: cleanPhone,
    );

    try {
      if (await canLaunchUrl(launchUri)) {
        await launchUrl(launchUri);
      } else {
        await launchUrl(launchUri, mode: LaunchMode.externalApplication);
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذر فتح تطبيق الاتصال: $phoneNumber')),
      );
    }
  }

  /// فتح محادثة واتساب مباشرة
  Future<void> _openWhatsApp(String phoneNumber) async {
    // تحويل الرقم إلى الصيغة الدولية للعراق (+964) إذا بدأ بـ 07
    String intlPhone = phoneNumber.replaceAll(RegExp(r'[^\d]'), '');
    if (intlPhone.startsWith('07')) {
      intlPhone = '964${intlPhone.substring(1)}';
    } else if (!intlPhone.startsWith('964')) {
      intlPhone = '964$intlPhone';
    }

    final message = Uri.encodeComponent(
      'مرحباً كابتن ${widget.ad.driverName}، أنا بخصوص رحلتك في تطبيق توصيله (${widget.ad.fromLocation} إلى ${widget.ad.toLocation})، هل المقاعد ما زالت متاحة؟',
    );

    // محاولة الرابطين: scheme الأصلي للواتساب ورابط الويب
    final Uri appUri = Uri.parse('whatsapp://send?phone=$intlPhone&text=$message');
    final Uri webUri = Uri.parse('https://wa.me/$intlPhone?text=$message');

    try {
      if (await canLaunchUrl(appUri)) {
        await launchUrl(appUri, mode: LaunchMode.externalApplication);
      } else if (await canLaunchUrl(webUri)) {
        await launchUrl(webUri, mode: LaunchMode.externalApplication);
      } else {
        throw 'WhatsApp not found';
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تطبيق واتساب غير مثبت أو تعذر تشغيله')),
      );
    }
  }

  /// إرسال طلب حجز رحلة (Pending Approval)
  Future<void> _requestBooking() async {
    setState(() => _isBooking = true);

    try {
      await widget.apiClient.post(
        '/bookings',
        data: {
          'routeId': widget.ad.id,
          'driverId': widget.ad.driverId,
          'seatsBooked': _seatsToBook,
          'pickupLocation': widget.ad.fromLocation,
          'dropoffLocation': widget.ad.toLocation,
          'status': 'Pending', // حالة الطلب معلقة حتى يوافق السائق
        },
      );

      if (!mounted) return;
      showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
          title: const Row(
            children: [
              Icon(Icons.hourglass_top_rounded, color: Colors.amber, size: 28),
              SizedBox(width: 8),
              Text('تم إرسال الطلب!'),
            ],
          ),
          content: Text(
            'تم إرسال طلب حجز $_seatsToBook مقعد إلى الكابتن ${widget.ad.driverName}.\nطلبك الآن قيد المراجعة والموافقة من الكابتن (Pending). ستتلقى إشعاراً فور قبوله.',
          ),
          actions: [
            TextButton(
              onPressed: () {
                Navigator.pop(ctx);
                Navigator.pop(context);
              },
              child: const Text('حسناً فهمت', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ],
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم تسجيل الطلب وإرسال إشعار للكابتن للموافقة!')),
      );
      Navigator.pop(context);
    } finally {
      if (mounted) setState(() => _isBooking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('ملف الكابتن والتواصل'),
        centerTitle: true,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Driver Card
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(24),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.06),
                    blurRadius: 16,
                    offset: const Offset(0, 4),
                  ),
                ],
                border: Border.all(color: Colors.grey.shade200),
              ),
              child: Column(
                children: [
                  Stack(
                    alignment: Alignment.bottomRight,
                    children: [
                      CircleAvatar(
                        radius: 44,
                        backgroundColor: Colors.amber.shade100,
                        child: Text(
                          widget.ad.driverName.isNotEmpty ? widget.ad.driverName[0] : 'ك',
                          style: const TextStyle(
                            fontSize: 34,
                            fontWeight: FontWeight.bold,
                            color: Color(0xFF0F172A),
                          ),
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.all(4),
                        decoration: const BoxDecoration(
                          color: Color(0xFF10B981),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.verified, color: Colors.white, size: 18),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(
                    widget.ad.driverName,
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.star, color: Colors.amber, size: 18),
                      const SizedBox(width: 4),
                      Text(
                        '${widget.ad.rating} (موثّق رسمياً بالنجف)',
                        style: TextStyle(fontWeight: FontWeight.w600, color: Colors.grey[700], fontSize: 13),
                      ),
                    ],
                  ),
                  const Divider(height: 28),

                  // Vehicle Details
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      _buildInfoBadge(Icons.directions_car, 'المركبة', widget.ad.vehicleModel),
                      _buildInfoBadge(Icons.pin, 'رقم اللوحة', widget.ad.plateNumber),
                      _buildInfoBadge(Icons.airline_seat_recline_normal, 'المقاعد المتبقية', '${widget.ad.availableSeats} من ${widget.ad.totalSeats}'),
                    ],
                  ),
                ],
              ),
            ),

            const SizedBox(height: 20),

            // التواصل المباشر (Direct Contact Buttons: Call & WhatsApp)
            const Text(
              'التواصل المباشر مع الكابتن',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                // زر الاتصال الهاتفي (tel:)
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: () => _makePhoneCall(widget.ad.driverPhone),
                    icon: const Icon(Icons.phone_in_talk_rounded, color: Colors.white),
                    label: const Text(
                      'اتصال هاتفي',
                      style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                    ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF0F172A),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                      elevation: 2,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                // زر مراسلة واتساب (whatsapp://)
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: () => _openWhatsApp(widget.ad.driverPhone),
                    icon: const Icon(Icons.chat_bubble_rounded, color: Colors.white),
                    label: const Text(
                      'مراسلة واتساب',
                      style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                    ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF25D366), // WhatsApp Green
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                      elevation: 2,
                    ),
                  ),
                ),
              ],
            ),

            const SizedBox(height: 24),

            // Trip Details Card
            Container(
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: Colors.grey.shade200),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'تفاصيل الرحلة والمسار',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      const Icon(Icons.radio_button_checked, color: Color(0xFF10B981), size: 20),
                      const SizedBox(width: 8),
                      Text('من: ${widget.ad.fromLocation}', style: const TextStyle(fontWeight: FontWeight.w600)),
                    ],
                  ),
                  Container(
                    margin: const EdgeInsets.only(right: 9),
                    height: 18,
                    width: 2,
                    color: Colors.grey[300],
                  ),
                  Row(
                    children: [
                      const Icon(Icons.location_on, color: Colors.redAccent, size: 20),
                      const SizedBox(width: 8),
                      Text('إلى: ${widget.ad.toLocation}', style: const TextStyle(fontWeight: FontWeight.w600)),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          const Icon(Icons.access_time, size: 18, color: Colors.grey),
                          const SizedBox(width: 4),
                          Text('${widget.ad.departureDate} • ${widget.ad.departureTime}', style: const TextStyle(fontSize: 13)),
                        ],
                      ),
                      Text(
                        '${widget.ad.pricePerSeatIqd} د.ع / مقعد',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFFD97706)),
                      ),
                    ],
                  ),
                  if (widget.ad.notes.isNotEmpty) ...[
                    const Divider(height: 20),
                    Text(
                      'ملاحظات الكابتن: ${widget.ad.notes}',
                      style: TextStyle(fontSize: 12, color: Colors.grey[700]),
                    ),
                  ],
                ],
              ),
            ),

            const SizedBox(height: 24),

            // عداد المقاعد وزر الحجز
            Row(
              children: [
                const Text('عدد المقاعد:', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.remove_circle_outline),
                  onPressed: _seatsToBook > 1 ? () => setState(() => _seatsToBook--) : null,
                ),
                Text('$_seatsToBook', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                IconButton(
                  icon: const Icon(Icons.add_circle_outline),
                  onPressed: _seatsToBook < widget.ad.availableSeats ? () => setState(() => _seatsToBook++) : null,
                ),
              ],
            ),

            const SizedBox(height: 16),

            SizedBox(
              height: 52,
              child: ElevatedButton.icon(
                onPressed: _isBooking ? null : _requestBooking,
                icon: _isBooking
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
                    : const Icon(Icons.check_circle_outline_rounded),
                label: Text(
                  _isBooking ? 'جاري إرسال الطلب...' : 'إرسال طلب الحجز للكابتن (${_seatsToBook * widget.ad.pricePerSeatIqd} د.ع)',
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.primaryColor,
                  foregroundColor: Colors.black,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  elevation: 3,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInfoBadge(IconData icon, String label, String value) {
    return Column(
      children: [
        Icon(icon, size: 22, color: Colors.amber.shade800),
        const SizedBox(height: 4),
        Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
        const SizedBox(height: 2),
        Text(value, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
      ],
    );
  }
}
