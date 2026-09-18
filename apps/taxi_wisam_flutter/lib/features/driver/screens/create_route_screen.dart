import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';

class CreateRouteScreen extends StatefulWidget {
  final ApiClient apiClient;
  final String driverId;

  const CreateRouteScreen({
    super.key,
    required this.apiClient,
    required this.driverId,
  });

  @override
  State<CreateRouteScreen> createState() => _CreateRouteScreenState();
}

class _CreateRouteScreenState extends State<CreateRouteScreen> {
  final _routeNameController = TextEditingController();
  final _startNameController = TextEditingController();
  final _endNameController = TextEditingController();
  final _seatsController = TextEditingController(text: '4');
  final _priceController = TextEditingController(text: '5000');
  TimeOfDay _departureTime = const TimeOfDay(hour: 7, minute: 30);
  bool _isLoading = false;

  Future<void> _handleSaveRoute() async {
    final routeName = _routeNameController.text.trim();
    final startName = _startNameController.text.trim();
    final endName = _endNameController.text.trim();

    if (routeName.isEmpty || startName.isEmpty || endName.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('يرجى ملء جميع الحقول')),
      );
      return;
    }

    setState(() => _isLoading = true);

    try {
      final formattedTime =
          '${_departureTime.hour.toString().padLeft(2, '0')}:${_departureTime.minute.toString().padLeft(2, '0')}:00';

      final payload = {
        'routeName': routeName,
        'startName': startName,
        'endName': endName,
        'coordinates': [
          {'latitude': 31.9961, 'longitude': 44.3168}, // مرقد الإمام علي ع / المركز
          {'latitude': 32.0300, 'longitude': 44.3700}, // جامعة الكوفة
        ],
        'bufferDistanceMeters': 1000.0,
        'departureTime': formattedTime,
        'availableSeats': int.tryParse(_seatsController.text) ?? 4,
        'pricePerSeat': double.tryParse(_priceController.text) ?? 5000.0,
        'isRecurring': true,
        'recurringDays': '1,2,3,4,5',
      };

      final response = await widget.apiClient.dio.post(
        '${ApiEndpoints.createRoute}/${widget.driverId}/routes',
        data: payload,
      );

      if (response.statusCode == 200) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('تم إنشاء خط النقل بنجاح! 🛣️'),
            backgroundColor: Colors.green,
          ),
        );
        Navigator.pop(context);
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('فشل حفظ المسار'), backgroundColor: Colors.red),
      );
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('إنشاء خط نقل منتظم')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _routeNameController,
              decoration: const InputDecoration(
                labelText: 'اسم الخط (مثال: مركز النجف - جامعة الكوفة)',
                prefixIcon: Icon(Icons.route),
              ),
            ),
            const SizedBox(height: 16),

            TextField(
              controller: _startNameController,
              decoration: const InputDecoration(
                labelText: 'نقطة الانطلاق (البداية)',
                prefixIcon: Icon(Icons.trip_origin),
              ),
            ),
            const SizedBox(height: 16),

            TextField(
              controller: _endNameController,
              decoration: const InputDecoration(
                labelText: 'وجهة الوصول (النهاية)',
                prefixIcon: Icon(Icons.location_on),
              ),
            ),
            const SizedBox(height: 16),

            // Time Picker Tile
            ListTile(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
              tileColor: Colors.white,
              leading: const Icon(Icons.access_time, color: Color(0xFFF59E0B)),
              title: const Text('وقت الانطلاق اليومي:'),
              trailing: Text(
                _departureTime.format(context),
                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
              ),
              onTap: () async {
                final time = await showTimePicker(
                  context: context,
                  initialTime: _departureTime,
                );
                if (time != null) setState(() => _departureTime = time);
              },
            ),
            const SizedBox(height: 16),

            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _seatsController,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'المقاعد المتاحة',
                      prefixIcon: Icon(Icons.event_seat),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: _priceController,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'سعر المقعد (د.ع)',
                      prefixIcon: Icon(Icons.monetization_on),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),

            ElevatedButton(
              onPressed: _isLoading ? null : _handleSaveRoute,
              child: _isLoading
                  ? const CircularProgressIndicator(strokeWidth: 2)
                  : const Text('حفظ ونشر خط النقل'),
            ),
          ],
        ),
      ),
    );
  }
}
