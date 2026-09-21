import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';
import '../../../core/services/storage_service.dart';
import '../../../core/widgets/custom_side_drawer.dart';
import 'live_tracking_screen.dart';
import 'route_search_screen.dart';

class CustomerHome extends StatefulWidget {
  final ApiClient apiClient;
  final StorageService storageService;

  const CustomerHome({
    super.key,
    required this.apiClient,
    required this.storageService,
  });

  @override
  State<CustomerHome> createState() => _CustomerHomeState();
}

class _CustomerHomeState extends State<CustomerHome> {
  String _customerName = '';
  String? _customerId;
  List<dynamic> _recentBookings = [];
  List<dynamic> _nearbyDrivers = [];
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _initCustomer();
  }

  Future<void> _initCustomer() async {
    _customerId = await widget.storageService.getUserId();
    _customerName = await widget.storageService.getFullName() ?? 'عزيزي الراكب';
    setState(() {});
    await Future.wait([
      _loadBookings(),
      _loadNearbyDrivers(),
    ]);
  }

  Future<void> _loadNearbyDrivers() async {
    try {
      final res = await widget.apiClient.dio.get(
        '${ApiEndpoints.nearbyDrivers}?latitude=31.9961&longitude=44.3168',
      );
      if (mounted && res.data is List) {
        setState(() {
          _nearbyDrivers = res.data;
        });
      }
    } catch (_) {}
  }

  Future<void> _quickBookWithNearestDriver(dynamic driver) async {
    if (_customerId == null) return;
    try {
      final payload = {
        'customerId': _customerId,
        'driverId': driver['driverId'],
        'driverName': driver['fullName'],
        'pickupName': 'موقعي الحالي (مركز النجف)',
        'dropoffName': 'جامعة الكوفة - مجمع الكليات',
        'pickupLat': 31.9961,
        'pickupLon': 44.3168,
        'dropoffLat': 32.0300,
        'dropoffLon': 44.3700,
        'seatsBooked': 1,
        'bookingDate': DateTime.now().toIso8601String().split('T').first,
      };

      final res = await widget.apiClient.dio.post(ApiEndpoints.createBooking, data: payload);
      if (res.statusCode == 200 && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('تم طلب ${driver['fullName']} بنجاح! الكابتن في طريقه إليك 🚖'),
            backgroundColor: Colors.green,
          ),
        );
        _loadBookings();
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => LiveTrackingScreen(
              bookingId: res.data['id'].toString(),
              driverName: driver['fullName'],
              storageService: widget.storageService,
            ),
          ),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تعذر إتمام الطلب الفوري'), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _loadBookings() async {
    if (_customerId == null) return;
    setState(() => _isLoading = true);

    try {
      final res = await widget.apiClient.dio.get('${ApiEndpoints.customerBookings}/$_customerId');
      if (mounted) {
        setState(() {
          _recentBookings = res.data is List ? res.data : [];
        });
      }
    } catch (_) {} finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('مرحباً، $_customerName'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () {
              _loadBookings();
              _loadNearbyDrivers();
            },
          ),
        ],
      ),
      drawer: CustomSideDrawer(
        apiClient: widget.apiClient,
        storageService: widget.storageService,
        currentRoute: 'home',
      ),
      body: RefreshIndicator(
        onRefresh: _loadBookings,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Hero Banner
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [Color(0xFF0F172A), Color(0xFF1E293B)],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(24),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(0.15),
                      blurRadius: 10,
                      offset: const Offset(0, 4),
                    ),
                  ],
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'أين وجهتك القادمة؟ 📍',
                      style: TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.bold,
                        fontSize: 20,
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'ابحث عن خطوط السير المنتظمة، طابق مسارك، واحجز مقعدك بكل سهولة.',
                      style: TextStyle(color: Colors.white70, fontSize: 12),
                    ),
                    const SizedBox(height: 16),
                    ElevatedButton.icon(
                      onPressed: () {
                        if (_customerId == null) return;
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => RouteSearchScreen(
                              apiClient: widget.apiClient,
                              customerId: _customerId!,
                              storageService: widget.storageService,
                            ),
                          ),
                        ).then((_) => _loadBookings());
                      },
                      icon: const Icon(Icons.search),
                      label: const Text('البحث والمطابقة مع السائقين'),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),

              // Interactive Najaf Map Card
              Container(
                height: 230,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: const Color(0xFFCBD5E1)),
                  boxShadow: const [
                    BoxShadow(color: Colors.black12, blurRadius: 8, offset: Offset(0, 3)),
                  ],
                ),
                clipBehavior: Clip.antiAlias,
                child: Stack(
                  children: [
                    FlutterMap(
                      options: const MapOptions(
                        initialCenter: LatLng(31.9961, 44.3168),
                        initialZoom: 13.5,
                      ),
                      children: [
                        TileLayer(
                          urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                          userAgentPackageName: 'com.taxiwisam.taxiWisamFlutter',
                        ),
                        MarkerLayer(
                          markers: [
                            // Shrine of Imam Ali
                            const Marker(
                              point: LatLng(31.9961, 44.3168),
                              width: 36,
                              height: 36,
                              child: Icon(Icons.location_pin, color: Colors.red, size: 32),
                            ),
                            // Kufa Mosque
                            const Marker(
                              point: LatLng(32.0300, 44.3700),
                              width: 36,
                              height: 36,
                              child: Icon(Icons.location_pin, color: Colors.blue, size: 32),
                            ),
                            // Nearby Drivers Active Markers
                            ..._nearbyDrivers.map((d) {
                              final lat = (d['latitude'] as num?)?.toDouble() ?? 31.9961;
                              final lon = (d['longitude'] as num?)?.toDouble() ?? 44.3168;
                              return Marker(
                                point: LatLng(lat, lon),
                                width: 50,
                                height: 50,
                                child: InkWell(
                                  onTap: () => _quickBookWithNearestDriver(d),
                                  child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Container(
                                        padding: const EdgeInsets.all(3),
                                        decoration: const BoxDecoration(
                                          color: Color(0xFFD97706),
                                          shape: BoxShape.circle,
                                          boxShadow: [BoxShadow(color: Colors.black26, blurRadius: 3)],
                                        ),
                                        child: const Icon(Icons.directions_car, color: Colors.white, size: 18),
                                      ),
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                                        decoration: BoxDecoration(
                                          color: Colors.white,
                                          borderRadius: BorderRadius.circular(4),
                                          boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 2)],
                                        ),
                                        child: Text(
                                          (d['fullName'] ?? 'كابتن').toString().split(' ').first,
                                          style: const TextStyle(fontSize: 8, fontWeight: FontWeight.bold),
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              );
                            }),
                          ],
                        ),
                      ],
                    ),
                    Positioned(
                      top: 10,
                      left: 10,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: const Color(0xFF0F172A).withValues(alpha: 0.85),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.near_me, color: Colors.amber, size: 14),
                            const SizedBox(width: 4),
                            Text(
                              '${_nearbyDrivers.length} كباتن متاحين في النجف',
                              style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),

              // Nearest Driver Quick Action Card
              if (_nearbyDrivers.isNotEmpty)
                Card(
                  elevation: 2,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      children: [
                        const CircleAvatar(
                          backgroundColor: Color(0xFFFEF3C7),
                          radius: 22,
                          child: Icon(Icons.local_taxi, color: Color(0xFFD97706), size: 26),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  const Text('أقرب كابتن: ', style: TextStyle(fontSize: 11, color: Colors.blueGrey)),
                                  Text(
                                    '${_nearbyDrivers.first['fullName']}',
                                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 2),
                              Text(
                                '${_nearbyDrivers.first['carModel']} • يبعد ${_nearbyDrivers.first['distanceKm']} كم (${_nearbyDrivers.first['etaMinutes']} دقيقة)',
                                style: const TextStyle(fontSize: 11, color: Colors.grey),
                              ),
                            ],
                          ),
                        ),
                        ElevatedButton(
                          onPressed: () => _quickBookWithNearestDriver(_nearbyDrivers.first),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF0F172A),
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                          ),
                          child: const Text('طلب فوري 🚖', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                        ),
                      ],
                    ),
                  ),
                ),
              const SizedBox(height: 18),

              // Recent Bookings Header
              const Text(
                'حجوزاتك الأخيرة:',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
              ),
              const SizedBox(height: 12),

              if (_isLoading)
                const Center(child: CircularProgressIndicator())
              else if (_recentBookings.isEmpty)
                Container(
                  padding: const EdgeInsets.all(24),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: const Center(
                    child: Text(
                      'لا توجد حجوزات سابقة. ابدأ بالبحث واحجز رحلتك الأولى!',
                      style: TextStyle(fontSize: 13, color: Colors.grey),
                    ),
                  ),
                )
              else
                ..._recentBookings.map((b) {
                  return Card(
                    elevation: 1,
                    margin: const EdgeInsets.only(bottom: 12),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                    child: ListTile(
                      contentPadding: const EdgeInsets.all(16),
                      leading: const CircleAvatar(
                        backgroundColor: Color(0xFFFEF3C7),
                        child: Icon(Icons.directions_car, color: Color(0xFFD97706)),
                      ),
                      title: Text(
                        '${b['pickupName']} ➔ ${b['dropoffName']}',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                      ),
                      subtitle: Text(
                        'التاريخ: ${b['bookingDate']} | السائق: ${b['driverName'] ?? "سائق معتمد"}',
                        style: const TextStyle(fontSize: 12),
                      ),
                      trailing: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            '${b['totalFare']} د.ع',
                            style: const TextStyle(
                              fontWeight: FontWeight.bold,
                              color: Colors.green,
                              fontSize: 14,
                            ),
                          ),
                          Text(
                            '${b['status']}',
                            style: const TextStyle(fontSize: 11, color: Colors.blueGrey),
                          ),
                        ],
                      ),
                      onTap: () {
                        // Open live tracking for this booking
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => LiveTrackingScreen(
                              bookingId: b['id'].toString(),
                              storageService: widget.storageService,
                              driverName: b['driverName'] ?? 'الكابتن',
                            ),
                          ),
                        );
                      },
                    ),
                  );
                }),
            ],
          ),
        ),
      ),
    );
  }
}
