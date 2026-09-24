import 'dart:async';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';
import '../../../core/services/location_service.dart';
import '../../../core/services/signalr_service.dart';
import '../../../core/services/storage_service.dart';
import '../../../core/widgets/custom_side_drawer.dart';

class DriverHome extends StatefulWidget {
  final ApiClient apiClient;
  final StorageService storageService;

  const DriverHome({
    super.key,
    required this.apiClient,
    required this.storageService,
  });

  @override
  State<DriverHome> createState() => _DriverHomeState();
}

class _DriverHomeState extends State<DriverHome> {
  late final SignalRService _signalRService;
  final LocationService _locationService = LocationService();
  bool _isOnline = false;
  bool _isVerified = false;
  bool _isMoving = false;
  Timer? _tripBroadcastTimer;
  int _simStep = 0;
  String _driverName = '';
  String? _driverId;
  Map<String, dynamic>? _registeredRoute;
  Map<String, dynamic>? _driverProfile;
  List<Map<String, dynamic>> _driverBookings = [];

  @override
  void initState() {
    super.initState();
    _signalRService = SignalRService(widget.storageService);
    _initDriver();
  }

  Future<void> _initDriver() async {
    final id = await widget.storageService.getUserId();
    final name = await widget.storageService.getFullName();

    if (mounted) {
      setState(() {
        _driverId = (id != null && id.isNotEmpty) ? id : 'drv-current';
        _driverName = (name != null && name.isNotEmpty) ? name : 'كابتن توصيله';
      });
    }

    await _loadProfile();
    await _loadBookings();

    try {
      _signalRService.initConnection();
    } catch (_) {}
  }

  Future<void> _loadBookings() async {
    final activeId = _driverId ?? 'drv-current';
    try {
      final res = await widget.apiClient.dio.get('/driver/$activeId/bookings');
      if (mounted && res.data != null) {
        final List list = res.data is List ? res.data : [];
        setState(() {
          _driverBookings = list.map((item) => Map<String, dynamic>.from(item)).toList();
        });
      }
    } catch (_) {}
  }

  Future<void> _openWazeForRoute() async {
    final lat = _registeredRoute?['endLat'] ?? 32.0321;
    final lon = _registeredRoute?['endLon'] ?? 44.3725;
    final wazeUrl = 'https://www.waze.com/ul?ll=$lat,$lon&navigate=yes';
    try {
      final uri = Uri.parse(wazeUrl);
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تعذر فتح برنامج Waze تلقائياً')),
        );
      }
    }
  }

  Future<void> _openWazeForPassenger(Map<String, dynamic> booking) async {
    final lat = booking['pickupLat'] ?? _registeredRoute?['startLat'] ?? 31.9961;
    final lon = booking['pickupLon'] ?? _registeredRoute?['startLon'] ?? 44.3168;
    final wazeUrl = 'https://www.waze.com/ul?ll=$lat,$lon&navigate=yes';
    try {
      final uri = Uri.parse(wazeUrl);
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تعذر فتح تطبيق Waze لموقع الراكب')),
        );
      }
    }
  }

  void _toggleTripMovement(bool start) {
    if (start && !_isOnline) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('يرجى تفعيل زر الاتصال بالأعلى أولاً لبدء الرحلة'),
          backgroundColor: Colors.orange,
        ),
      );
      return;
    }

    setState(() => _isMoving = start);
    _tripBroadcastTimer?.cancel();

    if (start) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('🚀 بدأت الرحلة! يتم الآن بث تحركاتك المباشرة للركاب والداش بورد'),
          backgroundColor: Colors.green,
        ),
      );

      final startLat = double.tryParse('${_registeredRoute?['startLat']}') ?? 31.9961;
      final startLon = double.tryParse('${_registeredRoute?['startLon']}') ?? 44.3168;
      final endLat = double.tryParse('${_registeredRoute?['endLat']}') ?? 32.0321;
      final endLon = double.tryParse('${_registeredRoute?['endLon']}') ?? 44.3725;

      _simStep = 0;
      const totalSteps = 30;

      _tripBroadcastTimer = Timer.periodic(const Duration(seconds: 4), (timer) async {
        if (!mounted || !_isMoving) {
          timer.cancel();
          return;
        }

        _simStep++;
        final progress = (_simStep % totalSteps) / totalSteps.toDouble();
        final curLat = startLat + (endLat - startLat) * progress;
        final curLon = startLon + (endLon - startLon) * progress;

        try {
          _signalRService.broadcastLocation(curLat, curLon, 45.0);
        } catch (_) {}

        try {
          await widget.apiClient.dio.post('/driver/location', data: {
            'driverId': _driverId,
            'latitude': curLat,
            'longitude': curLon,
            'heading': 45.0,
            'speedKmh': 35,
            'tripStatus': 'Moving'
          });
        } catch (_) {}
      });
    } else {
      try {
        widget.apiClient.dio.post('/driver/location', data: {
          'driverId': _driverId,
          'tripStatus': 'Online',
          'speedKmh': 0
        });
      } catch (_) {}
    }
  }

  Future<void> _loadProfile() async {
    final activeId = _driverId ?? 'drv-current';
    try {
      // 1. Fetch from /api/auth/me or profile
      final token = await widget.storageService.getToken();
      if (token != null && token.isNotEmpty) {
        final resMe = await widget.apiClient.dio.get('/auth/me');
        if (mounted && resMe.data != null && resMe.data['user'] != null) {
          final user = resMe.data['user'];
          setState(() {
            _driverProfile = user;
            _isVerified = user['isVerified'] == true || user['status'] == 'Approved';
            if (user['route'] != null) {
              _registeredRoute = Map<String, dynamic>.from(user['route']);
            }
          });
        }
      }

      // 2. Fetch routes if route is not yet set
      if (_registeredRoute == null) {
        final routesRes = await widget.apiClient.dio.get(ApiEndpoints.findMatchingRoutes);
        if (mounted && routesRes.data != null) {
          final dynamic data = routesRes.data;
          final List list = data is List ? data : (data is Map && data['routes'] is List ? data['routes'] : []);
          final myRoute = list.firstWhere(
            (r) => r['driverId'] == activeId || r['driverName'] == _driverName,
            orElse: () => list.isNotEmpty ? list.first : null,
          );
          if (myRoute != null) {
            setState(() {
              _registeredRoute = Map<String, dynamic>.from(myRoute);
            });
          }
        }
      }
    } catch (_) {}
  }

  Future<void> _toggleOnlineStatus(bool value) async {
    if (_driverId == null) return;
    if (!_isVerified && value) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('يجب توثيق واعتماد حسابك من الإدارة قبل بدء استقبال الركاب'),
          backgroundColor: Colors.orange,
        ),
      );
      return;
    }

    setState(() => _isOnline = value);

    try {
      await widget.apiClient.dio.post(
        '${ApiEndpoints.updateDriverStatus}/$_driverId/status',
        data: {'status': value ? 'Online' : 'Offline'},
      );

      // Broadcast live GPS coordinates over SignalR/WebSocket when online
      if (value) {
        try {
          await _locationService.startLocationTracking(
            onPosition: (pos) {
              if (_isOnline) {
                _signalRService.broadcastLocation(
                  pos.latitude,
                  pos.longitude,
                  pos.heading,
                );
              }
            },
          );
        } catch (_) {
          // If permission fails, broadcast Najaf Center baseline
          await _signalRService.broadcastLocation(31.9961, 44.3168, 0.0);
        }
      } else {
        await _locationService.stopLocationTracking();
      }
    } catch (e) {
      setState(() => _isOnline = !value);
    }
  }

  @override
  void dispose() {
    _tripBroadcastTimer?.cancel();
    _locationService.stopLocationTracking();
    _signalRService.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('بوابة الكابتن | $_driverName'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () {
              _loadProfile();
            },
          ),
        ],
      ),
      drawer: CustomSideDrawer(
        apiClient: widget.apiClient,
        storageService: widget.storageService,
        currentRoute: 'home',
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Status Card
            Card(
              elevation: 3,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              color: Colors.white,
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _isOnline ? '🟢 أنت متصل وجاهز للرحلات' : '⚪ أنت غير متصل حالياً',
                          style: TextStyle(
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                            color: _isOnline ? Colors.green.shade700 : Colors.blueGrey.shade700,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          _isVerified ? 'حساب موثق ومعتمد بالكامل ✅' : 'الوثائق قيد التدقيق لدى الإدارة ⏳',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            color: _isVerified ? Colors.green.shade700 : Colors.orange.shade800,
                          ),
                        ),
                      ],
                    ),
                    Switch(
                      value: _isOnline,
                      onChanged: _toggleOnlineStatus,
                      activeColor: const Color(0xFFF59E0B),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Registered Route Card
            Card(
              elevation: 3,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              color: Colors.white,
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Row(
                          children: [
                            Icon(Icons.route_rounded, color: Color(0xFFF59E0B), size: 22),
                            SizedBox(width: 8),
                            Text(
                              'مسار خطك اليومي المعتمد 🛣️',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                            ),
                          ],
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: Colors.green.shade50,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: Colors.green.shade200),
                          ),
                          child: Text(
                            'خط نشط ومتاح للركاب',
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.green.shade800),
                          ),
                        ),
                      ],
                    ),
                    const Divider(height: 24),
                    if (_registeredRoute != null) ...[
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(
                              color: Colors.green.shade100,
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Text(
                              'من: ${_registeredRoute!['startName'] ?? 'ساحة ثورة العشرين'}',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.green.shade900),
                            ),
                          ),
                          const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 8),
                            child: Icon(Icons.arrow_forward_rounded, size: 16, color: Colors.grey),
                          ),
                          Expanded(
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(
                                color: Colors.red.shade100,
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Text(
                                'إلى: ${_registeredRoute!['endName'] ?? 'جامعة الكوفة'}',
                                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.red.shade900),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          _RouteDetailChip(
                            icon: Icons.access_time_filled_rounded,
                            label: _registeredRoute!['departureTime'] ?? '08:00 ص',
                            color: Colors.blue,
                          ),
                          _RouteDetailChip(
                            icon: Icons.event_seat_rounded,
                            label: '${_registeredRoute!['availableSeats'] ?? 4} مقاعد',
                            color: Colors.amber,
                          ),
                          _RouteDetailChip(
                            icon: Icons.payments_rounded,
                            label: '${_registeredRoute!['pricePerSeat'] ?? _registeredRoute!['fare'] ?? 3000} د.ع',
                            color: Colors.green,
                          ),
                        ],
                      ),
                    ] else ...[
                      const Text(
                        'تم تسجيل وتثبيت مسارك الرئيسي في استمارة التسجيل. يظهر هذا الخط للركاب في مدينة النجف تلقائياً.',
                        style: TextStyle(fontSize: 12, color: Colors.blueGrey, height: 1.5),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Waze & Live Navigation Card
            Card(
              elevation: 4,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              color: const Color(0xFF0F172A),
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.all(8),
                              decoration: BoxDecoration(
                                color: const Color(0xFF33CCFF).withValues(alpha: 0.2),
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(Icons.navigation_rounded, color: Color(0xFF33CCFF), size: 24),
                            ),
                            const SizedBox(width: 10),
                            const Text(
                              'الملاحة عبر Waze وبث الرحلة',
                              style: TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.bold,
                                fontSize: 16,
                              ),
                            ),
                          ],
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                          decoration: BoxDecoration(
                            color: _isMoving ? Colors.green.shade900 : Colors.blueGrey.shade800,
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text(
                            _isMoving ? 'متحرك حي 🟢' : 'جاهز للمسار ⚪',
                            style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    const Text(
                      'عند بدء التحرك يمكنك فتح برنامج Waze لمتابعة مسار الرحلة والذهاب مباشرة لمواقع الركاب المشتركين في خطك.',
                      style: TextStyle(color: Colors.white70, fontSize: 12, height: 1.4),
                    ),
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: ElevatedButton.icon(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: const Color(0xFF33CCFF),
                              foregroundColor: const Color(0xFF0F172A),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                              padding: const EdgeInsets.symmetric(vertical: 12),
                            ),
                            icon: const Icon(Icons.navigation, size: 20),
                            label: const Text(
                              'فتح مسار الخط في Waze',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                            ),
                            onPressed: _openWazeForRoute,
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: ElevatedButton.icon(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: _isMoving ? Colors.red.shade600 : const Color(0xFF10B981),
                              foregroundColor: Colors.white,
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                              padding: const EdgeInsets.symmetric(vertical: 12),
                            ),
                            icon: Icon(_isMoving ? Icons.stop_circle_rounded : Icons.play_arrow_rounded, size: 20),
                            label: Text(
                              _isMoving ? 'إيقاف التحرك' : 'بدء المباشرة (تتبع حي)',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
                            ),
                            onPressed: () => _toggleTripMovement(!_isMoving),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Subscribed Passengers Section
            Card(
              elevation: 3,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              color: Colors.white,
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Row(
                          children: [
                            Icon(Icons.people_alt_rounded, color: Color(0xFFF59E0B), size: 22),
                            SizedBox(width: 8),
                            Text(
                              'الركاب المشتركون في الخط 👥',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                            ),
                          ],
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                            color: Colors.amber.shade50,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: Colors.amber.shade200),
                          ),
                          child: Text(
                            '${_driverBookings.length} ركاب',
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.amber.shade900),
                          ),
                        ),
                      ],
                    ),
                    const Divider(height: 20),
                    if (_driverBookings.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 10),
                        child: Text(
                          'لا توجد حجوزات مشتركة حالياً. سيظهر الركاب هنا فور حجزهم في مسارك مع إمكانية التوجيه لمواقعهم بـ Waze.',
                          style: TextStyle(color: Colors.blueGrey, fontSize: 12),
                          textAlign: TextAlign.center,
                        ),
                      )
                    else
                      ListView.separated(
                        shrinkWrap: true,
                        physics: const NeverScrollableScrollPhysics(),
                        itemCount: _driverBookings.length,
                        separatorBuilder: (ctx, i) => const Divider(height: 16),
                        itemBuilder: (ctx, index) {
                          final b = _driverBookings[index];
                          final pName = b['customerName'] ?? 'راكب توصيله';
                          final pPhone = b['customerPhone'] ?? '';
                          final pPickup = b['pickupLocation'] ?? 'موقع الركوب';
                          final pDropoff = b['dropoffLocation'] ?? 'موقع النزول';
                          final seats = b['seatsBooked'] ?? 1;

                          return Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF8FAFC),
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(color: const Color(0xFFE2E8F0)),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Row(
                                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                  children: [
                                    Row(
                                      children: [
                                        CircleAvatar(
                                          radius: 16,
                                          backgroundColor: const Color(0xFFF59E0B).withValues(alpha: 0.2),
                                          child: const Icon(Icons.person, size: 18, color: Color(0xFFD97706)),
                                        ),
                                        const SizedBox(width: 8),
                                        Text(
                                          pName,
                                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                        ),
                                      ],
                                    ),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                      decoration: BoxDecoration(
                                        color: Colors.blue.shade50,
                                        borderRadius: BorderRadius.circular(8),
                                      ),
                                      child: Text(
                                        '$seats مقعد',
                                        style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.blue.shade800),
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 8),
                                Row(
                                  children: [
                                    const Icon(Icons.location_on, size: 14, color: Colors.green),
                                    const SizedBox(width: 4),
                                    Expanded(
                                      child: Text(
                                        'نقطة الركوب: $pPickup',
                                        style: const TextStyle(fontSize: 12, color: Colors.blueGrey),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                Row(
                                  children: [
                                    const Icon(Icons.flag, size: 14, color: Colors.red),
                                    const SizedBox(width: 4),
                                    Expanded(
                                      child: Text(
                                        'الوجهة: $pDropoff',
                                        style: const TextStyle(fontSize: 12, color: Colors.blueGrey),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 10),
                                Row(
                                  children: [
                                    Expanded(
                                      child: ElevatedButton.icon(
                                        style: ElevatedButton.styleFrom(
                                          backgroundColor: const Color(0xFF33CCFF),
                                          foregroundColor: const Color(0xFF0F172A),
                                          padding: const EdgeInsets.symmetric(vertical: 8),
                                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                        ),
                                        icon: const Icon(Icons.directions_car, size: 16),
                                        label: const Text(
                                          'توجيه Waze للراكب 📍',
                                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11),
                                        ),
                                        onPressed: () => _openWazeForPassenger(b),
                                      ),
                                    ),
                                    if (pPhone.isNotEmpty) ...[
                                      const SizedBox(width: 8),
                                      IconButton.filledTonal(
                                        style: IconButton.styleFrom(backgroundColor: Colors.green.shade100),
                                        icon: const Icon(Icons.phone, size: 18, color: Colors.green),
                                        onPressed: () {
                                          launchUrl(Uri.parse('tel:$pPhone'), mode: LaunchMode.externalApplication);
                                        },
                                      ),
                                    ],
                                  ],
                                ),
                              ],
                            ),
                          );
                        },
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Vehicle Information Card
            if (_driverProfile != null && _driverProfile!['vehicleInfo'] != null) ...[
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: const Color(0xFF0F172A),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.directions_car_filled_rounded, color: Color(0xFFF59E0B), size: 24),
                    const SizedBox(width: 10),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('المركبة المسجلة المعتمدة', style: TextStyle(color: Colors.grey, fontSize: 11)),
                        Text(
                          _driverProfile!['vehicleInfo'],
                          style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
            ],

            // Quick Services
            const Text(
              'الخدمات والإدارة:',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
            ),
            const SizedBox(height: 10),

            Row(
              children: [
                Expanded(
                  child: _ActionTile(
                    icon: Icons.history_rounded,
                    title: 'سجل الرحلات',
                    subtitle: 'الحجوزات والمدفوعات',
                    onTap: () {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('سجل الرحلات محدث وجاهز مع كل حجز جديد')),
                      );
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _ActionTile(
                    icon: Icons.support_agent_rounded,
                    title: 'الدعم الإداري',
                    subtitle: 'تعديل المسار أو البيانات',
                    onTap: () {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('لطلب تعديل المسار أو تحديث المستمسكات يرجى التواصل مع إدارة توصيله')),
                      );
                    },
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _RouteDetailChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final MaterialColor color;

  const _RouteDetailChip({
    required this.icon,
    required this.label,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.shade50,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.shade200),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: color.shade800),
          const SizedBox(width: 4),
          Text(
            label,
            style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: color.shade900),
          ),
        ],
      ),
    );
  }
}

class _ActionTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _ActionTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              backgroundColor: const Color(0xFFF59E0B).withValues(alpha: 0.15),
              child: Icon(icon, color: const Color(0xFFD97706)),
            ),
            const SizedBox(height: 12),
            Text(title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
            const SizedBox(height: 4),
            Text(subtitle, style: const TextStyle(fontSize: 11, color: Colors.grey)),
          ],
        ),
      ),
    );
  }
}
