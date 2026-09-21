import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

const Color emeraldColor = Color(0xFF10B981);

/// شاشة الملف الشخصي للزبون (Customer Profile) تتيح للسائق الاتصال أو مراسلته واتساب
class CustomerProfileScreen extends StatelessWidget {
  final String customerName;
  final String customerPhone;
  final String pickupLocation;
  final String dropoffLocation;
  final int seatsBooked;
  final int totalFare;
  final String status;

  const CustomerProfileScreen({
    super.key,
    required this.customerName,
    required this.customerPhone,
    required this.pickupLocation,
    required this.dropoffLocation,
    required this.seatsBooked,
    required this.totalFare,
    required this.status,
  });

  Future<void> _callCustomer(BuildContext context) async {
    final cleanPhone = customerPhone.replaceAll(RegExp(r'[^\d+]'), '');
    final Uri uri = Uri(scheme: 'tel', path: cleanPhone);
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri);
      } else {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      }
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذر إجراء الاتصال: $customerPhone')),
      );
    }
  }

  Future<void> _whatsappCustomer(BuildContext context) async {
    String intlPhone = customerPhone.replaceAll(RegExp(r'[^\d]'), '');
    if (intlPhone.startsWith('07')) {
      intlPhone = '964${intlPhone.substring(1)}';
    } else if (!intlPhone.startsWith('964')) {
      intlPhone = '964$intlPhone';
    }

    final msg = Uri.encodeComponent(
      'مرحباً $customerName، معك كابتن توصيله بخصوص طلبك من ($pickupLocation إلى $dropoffLocation). أنا بالخدمة!',
    );

    final appUri = Uri.parse('whatsapp://send?phone=$intlPhone&text=$msg');
    final webUri = Uri.parse('https://wa.me/$intlPhone?text=$msg');

    try {
      if (await canLaunchUrl(appUri)) {
        await launchUrl(appUri, mode: LaunchMode.externalApplication);
      } else if (await canLaunchUrl(webUri)) {
        await launchUrl(webUri, mode: LaunchMode.externalApplication);
      }
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تعذر فتح تطبيق واتساب')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('بيانات الزبون والتواصل'),
        centerTitle: true,
      ),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
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
              ),
              child: Column(
                children: [
                  CircleAvatar(
                    radius: 40,
                    backgroundColor: emeraldColor.withOpacity(0.15),
                    child: Text(
                      customerName.isNotEmpty ? customerName[0] : 'ز',
                      style: const TextStyle(fontSize: 30, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(customerName, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  Text(customerPhone, style: TextStyle(color: Colors.grey[600], fontSize: 14)),
                  const SizedBox(height: 10),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                    decoration: BoxDecoration(
                      color: status == 'Confirmed' ? emeraldColor.withOpacity(0.1) : Colors.amber.shade50,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(
                        color: status == 'Confirmed' ? emeraldColor : Colors.amber,
                      ),
                    ),
                    child: Text(
                      status == 'Confirmed' ? 'حجز مؤكد ✅' : 'طلب قيد المراجعة ⏳',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.bold,
                        color: status == 'Confirmed' ? emeraldColor : Colors.amber.shade900,
                      ),
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 20),

            // أزرار التواصل المباشر (Direct Contact)
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: () => _callCustomer(context),
                    icon: const Icon(Icons.phone, color: Colors.white),
                    label: const Text('اتصال بالزبون', style: TextStyle(fontWeight: FontWeight.bold)),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF0F172A),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: () => _whatsappCustomer(context),
                    icon: const Icon(Icons.chat, color: Colors.white),
                    label: const Text('واتساب الزبون', style: TextStyle(fontWeight: FontWeight.bold)),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF25D366),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                    ),
                  ),
                ),
              ],
            ),

            const SizedBox(height: 24),

            // تفاصيل المشوار
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
                  const Text('تفاصيل حجز الزبون', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                  const Divider(height: 20),
                  Row(
                    children: [
                      const Icon(Icons.pin_drop, color: Colors.green, size: 20),
                      const SizedBox(width: 8),
                      Text('مكان الركوب: $pickupLocation', style: const TextStyle(fontWeight: FontWeight.w600)),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      const Icon(Icons.flag, color: Colors.red, size: 20),
                      const SizedBox(width: 8),
                      Text('مكان النزول: $dropoffLocation', style: const TextStyle(fontWeight: FontWeight.w600)),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('عدد المقاعد المحجوزة: $seatsBooked'),
                      Text(
                        '$totalFare د.ع',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFFD97706)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
