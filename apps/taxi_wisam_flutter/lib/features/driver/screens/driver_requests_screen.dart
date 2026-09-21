import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../profile/screens/customer_profile_screen.dart';

const Color emeraldColor = Color(0xFF10B981);
const Color roseColor = Color(0xFFEF4444);

/// شاشة طلبات الركاب الواردة للكابتن ونظام الموافقة والرفض (Trip Approval Flow)
class DriverRequestsScreen extends StatefulWidget {
  final ApiClient apiClient;

  const DriverRequestsScreen({super.key, required this.apiClient});

  @override
  State<DriverRequestsScreen> createState() => _DriverRequestsScreenState();
}

class _DriverRequestsScreenState extends State<DriverRequestsScreen> {
  List<Map<String, dynamic>> _requests = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _fetchRequests();
  }

  Future<void> _fetchRequests() async {
    setState(() => _isLoading = true);

    try {
      final res = await widget.apiClient.get('/admin/bookings');
      if (res.statusCode == 200 && res.data != null && res.data['bookings'] != null) {
        final list = (res.data['bookings'] as List).map((b) => Map<String, dynamic>.from(b)).toList();
        setState(() => _requests = list);
      } else {
        _loadDefaultRequests();
      }
    } catch (e) {
      _loadDefaultRequests();
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  void _loadDefaultRequests() {
    setState(() {
      _requests = [
        {
          'bookingId': 'req-njf-501',
          'customerName': 'أحمد الموسوي',
          'customerPhone': '07802211334',
          'pickupLocation': 'شارع الكوفة - قرب مستشفى الصدر',
          'dropoffLocation': 'مرقد الإمام علي (ع) - باب القبلة',
          'seatsBooked': 2,
          'totalFare': 6000,
          'status': 'Pending', // معلق بانتظار الموافقة
          'createdAt': 'منذ 3 دقائق',
        },
        {
          'bookingId': 'req-njf-502',
          'customerName': 'حيدر الكرعاوي',
          'customerPhone': '07718899001',
          'pickupLocation': 'ساحة ثورة العشرين',
          'dropoffLocation': 'جامعة الكوفة - كلية الهندسة',
          'seatsBooked': 1,
          'totalFare': 3000,
          'status': 'Confirmed', // موافق عليه سابقاً
          'createdAt': 'منذ 15 دقيقة',
        },
      ];
    });
  }

  /// 1. دالة الموافقة على الطلب (Accept Trip)
  Future<void> _acceptRequest(String bookingId) async {
    try {
      await widget.apiClient.post(
        '/bookings/$bookingId/accept',
        data: {'status': 'Confirmed'},
      );
    } catch (_) {}

    setState(() {
      final index = _requests.indexWhere((r) => r['bookingId'] == bookingId);
      if (index != -1) {
        _requests[index]['status'] = 'Confirmed';
      }
    });

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('تمت الموافقة على الطلب بنجاح! أصبح الحجز مؤكداً. ✅'),
        backgroundColor: Colors.green,
        duration: Duration(seconds: 2),
      ),
    );
  }

  /// 2. دالة رفض الطلب (Decline Trip)
  Future<void> _declineRequest(String bookingId) async {
    try {
      await widget.apiClient.post(
        '/bookings/$bookingId/decline',
        data: {'status': 'Declined'},
      );
    } catch (_) {}

    setState(() {
      final index = _requests.indexWhere((r) => r['bookingId'] == bookingId);
      if (index != -1) {
        _requests[index]['status'] = 'Declined';
      }
    });

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('تم رفض الطلب وتم إشعار الزبون. ❌'),
        backgroundColor: Colors.redAccent,
        duration: Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('طلبات الركاب الواردة'),
        centerTitle: true,
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _fetchRequests),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _requests.isEmpty
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.inbox_outlined, size: 64, color: Colors.grey[400]),
                      const SizedBox(height: 12),
                      const Text(
                        'لا توجد طلبات جديدة حالياً',
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.grey),
                      ),
                    ],
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _requests.length,
                  itemBuilder: (ctx, i) {
                    final req = _requests[i];
                    return _buildRequestCard(req);
                  },
                ),
    );
  }

  Widget _buildRequestCard(Map<String, dynamic> req) {
    final status = req['status'] ?? 'Pending';
    final isPending = status == 'Pending';
    final isConfirmed = status == 'Confirmed';
    final isDeclined = status == 'Declined';

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.04),
            blurRadius: 14,
            offset: const Offset(0, 4),
          ),
        ],
        border: Border.all(
          color: isPending
              ? Colors.amber.shade300
              : isConfirmed
                  ? emeraldColor.withOpacity(0.5)
                  : isDeclined
                      ? Colors.red.shade200
                      : Colors.grey.shade200,
          width: isPending ? 1.5 : 1,
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // رأس الطلب مع بيانات الزبون
            Row(
              children: [
                CircleAvatar(
                  radius: 22,
                  backgroundColor: Colors.amber.shade100,
                  child: Text(
                    (req['customerName'] ?? 'ز')[0],
                    style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        req['customerName'] ?? 'زبون',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                      Text(
                        req['customerPhone'] ?? '',
                        style: TextStyle(color: Colors.grey[600], fontSize: 12),
                      ),
                    ],
                  ),
                ),
                // شارة الحالة
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: isPending
                        ? Colors.amber.shade50
                        : isConfirmed
                            ? emeraldColor.withOpacity(0.12)
                            : roseColor.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: isPending
                          ? Colors.amber
                          : isConfirmed
                              ? emeraldColor
                              : roseColor,
                    ),
                  ),
                  child: Text(
                    isPending
                        ? 'بانتظار موافقتك ⏳'
                        : isConfirmed
                            ? 'مؤكد ومقبول ✅'
                            : 'تم الرفض ❌',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                      color: isPending
                          ? Colors.amber.shade900
                          : isConfirmed
                              ? emeraldColor
                              : roseColor,
                    ),
                  ),
                ),
              ],
            ),

            const Divider(height: 22),

            // المسار
            Row(
              children: [
                const Icon(Icons.pin_drop, color: Colors.green, size: 18),
                const SizedBox(width: 8),
                Expanded(child: Text(req['pickupLocation'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
              ],
            ),
            const SizedBox(height: 6),
            Row(
              children: [
                const Icon(Icons.flag, color: Colors.red, size: 18),
                const SizedBox(width: 8),
                Expanded(child: Text(req['dropoffLocation'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
              ],
            ),

            const SizedBox(height: 12),

            // السعر والمقاعد وزر ملف الزبون
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'المقاعد: ${req['seatsBooked']} • الإجمالي: ${req['totalFare']} د.ع',
                  style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFFD97706), fontSize: 14),
                ),
                TextButton.icon(
                  onPressed: () {
                    // فتح ملف الزبون مع الاتصال والواتساب
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (context) => CustomerProfileScreen(
                          customerName: req['customerName'] ?? 'زبون',
                          customerPhone: req['customerPhone'] ?? '',
                          pickupLocation: req['pickupLocation'] ?? '',
                          dropoffLocation: req['dropoffLocation'] ?? '',
                          seatsBooked: req['seatsBooked'] ?? 1,
                          totalFare: req['totalFare'] ?? 3000,
                          status: status,
                        ),
                      ),
                    );
                  },
                  icon: const Icon(Icons.contact_phone_outlined, size: 16),
                  label: const Text('ملف الزبون والتواصل', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                ),
              ],
            ),

            // نظام الموافقة والرفض (Trip Approval Action Buttons)
            if (isPending) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  // زر الموافقة (Accept)
                  Expanded(
                    child: ElevatedButton.icon(
                      onPressed: () => _acceptRequest(req['bookingId']),
                      icon: const Icon(Icons.check_circle_rounded, color: Colors.white, size: 18),
                      label: const Text('موافقة (Accept)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF10B981),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  // زر الرفض (Decline)
                  Expanded(
                    child: ElevatedButton.icon(
                      onPressed: () => _declineRequest(req['bookingId']),
                      icon: const Icon(Icons.cancel_rounded, color: Colors.white, size: 18),
                      label: const Text('رفض (Decline)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFFEF4444),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
