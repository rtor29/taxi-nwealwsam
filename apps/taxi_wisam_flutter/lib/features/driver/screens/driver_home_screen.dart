import 'package:flutter/material.dart';
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
  String _driverName = '';
  String? _driverId;
  Map<String, dynamic>? _registeredRoute;
  Map<String, dynamic>? _driverProfile;

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

    try {
      _signalRService.initConnection();
    } catch (_) {}
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
