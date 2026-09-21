import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../../../app_config.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';
import '../../../core/services/location_service.dart';
import '../../../core/services/storage_service.dart';
import '../../../core/widgets/custom_side_drawer.dart';
import '../services/driver_discovery_service.dart';
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
  DiscoveryResult? _discoveryResult;
  LatLng _clientLocation = const LatLng(AppConfig.najafCenterLat, AppConfig.najafCenterLon);
  final MapController _mapController = MapController();
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

    // Obtain live client GPS location
    try {
      final pos = await LocationService().getCurrentPosition();
      _clientLocation = LatLng(pos.latitude, pos.longitude);
    } catch (_) {}

    await Future.wait([
      _loadBookings(),
      _loadNearbyDrivers(),
    ]);
  }

  Future<void> _loadNearbyDrivers() async {
    try {
      final res = await widget.apiClient.dio.get(
        '${ApiEndpoints.nearbyDrivers}?latitude=${_clientLocation.latitude}&longitude=${_clientLocation.longitude}',
      );
      if (mounted && res.data is List) {
        final raw = res.data as List;
        final result = DriverDiscoveryService.evaluate(
          rawDrivers: raw,
          clientLocation: _clientLocation,
          immediateRadiusMeters: 50.0,
        );

        setState(() {
          _discoveryResult = result;
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

              // Discovery Status Banner (50m Proximity vs City-wide Fallback)
              if (_discoveryResult != null)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  margin: const EdgeInsets.only(bottom: 12),
                  decoration: BoxDecoration(
                    color: _discoveryResult!.hasImmediateDrivers
                        ? const Color(0xFFECFDF5)
                        : const Color(0xFFFEF3C7),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(
                      color: _discoveryResult!.hasImmediateDrivers
                          ? const Color(0xFF10B981)
                          : const Color(0xFFF59E0B),
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        _discoveryResult!.hasImmediateDrivers
                            ? Icons.radar_rounded
                            : Icons.explore_rounded,
                        color: _discoveryResult!.hasImmediateDrivers
                            ? const Color(0xFF059669)
                            : const Color(0xFFD97706),
                        size: 22,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          _discoveryResult!.statusMessage,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            color: _discoveryResult!.hasImmediateDrivers
                                ? const Color(0xFF065F46)
                                : const Color(0xFF92400E),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),

              // Interactive Najaf Map Card powered by Mapbox
              Container(
                height: 250,
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
                      mapController: _mapController,
                      options: MapOptions(
                        initialCenter: _clientLocation,
                        initialZoom: 14.5,
                      ),
                      children: [
                        TileLayer(
                          urlTemplate: AppConfig.mapboxTileUrl,
                          userAgentPackageName: 'com.taxiwisam.taxiWisamFlutter',
                        ),
                        // 50-meter Proximity Circle around Client Location
                        CircleLayer(
                          circles: [
                            CircleMarker(
                              point: _clientLocation,
                              radius: 50.0,
                              useRadiusInMeter: true,
                              color: const Color(0xFF3B82F6).withValues(alpha: 0.15),
                              borderColor: const Color(0xFF2563EB),
                              borderStrokeWidth: 2.0,
                            ),
                          ],
                        ),
                        MarkerLayer(
                          markers: [
                            // Current Client Location Marker
                            Marker(
                              point: _clientLocation,
                              width: 44,
                              height: 44,
                              child: Container(
                                decoration: BoxDecoration(
                                  color: Colors.blue.shade600,
                                  shape: BoxShape.circle,
                                  border: Border.all(color: Colors.white, width: 3),
                                  boxShadow: const [
                                    BoxShadow(color: Colors.black26, blurRadius: 6, offset: Offset(0, 3)),
                                  ],
                                ),
                                child: const Icon(Icons.person_pin_circle_rounded, color: Colors.white, size: 24),
                              ),
                            ),
                            // Active Drivers Markers (Color-coded: Green for <=50m, Amber for city fallback)
                            ...(_discoveryResult?.allCityDrivers ?? []).map((driver) {
                              final isImmediate = driver.isWithinImmediateRadius;
                              return Marker(
                                point: LatLng(driver.latitude, driver.longitude),
                                width: 56,
                                height: 56,
                                child: InkWell(
                                  onTap: () => _quickBookWithNearestDriver({
                                    'driverId': driver.driverId,
                                    'fullName': driver.fullName,
                                    'phoneNumber': driver.phoneNumber,
                                    'carModel': driver.carModel,
                                    'distanceKm': driver.distanceKm,
                                  }),
                                  child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Container(
                                        padding: const EdgeInsets.all(4),
                                        decoration: BoxDecoration(
                                          color: isImmediate ? const Color(0xFF10B981) : const Color(0xFFF59E0B),
                                          shape: BoxShape.circle,
                                          border: Border.all(color: Colors.white, width: 1.5),
                                          boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 4)],
                                        ),
                                        child: const Icon(Icons.directions_car, color: Color(0xFF0F172A), size: 18),
                                      ),
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                                        decoration: BoxDecoration(
                                          color: Colors.white,
                                          borderRadius: BorderRadius.circular(4),
                                          boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 2)],
                                        ),
                                        child: Text(
                                          driver.fullName.split(' ').first,
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
                          color: const Color(0xFF0F172A).withValues(alpha: 0.88),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.map_rounded, color: Colors.amber, size: 14),
                            const SizedBox(width: 4),
                            const Text(
                              'خرائط Mapbox • النجف الأشرف',
                              style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold),
                            ),
                          ],
                        ),
                      ),
                    ),
                    Positioned(
                      bottom: 10,
                      left: 10,
                      child: FloatingActionButton.small(
                        heroTag: 'recenterClient',
                        backgroundColor: Colors.white,
                        foregroundColor: const Color(0xFF0F172A),
                        onPressed: () {
                          _mapController.move(_clientLocation, 15.0);
                        },
                        child: const Icon(Icons.my_location_rounded),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),

              // Nearest Driver Quick Action Card
              if ((_discoveryResult?.allCityDrivers ?? []).isNotEmpty)
                Card(
                  elevation: 2,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      children: [
                        CircleAvatar(
                          backgroundColor: _discoveryResult!.hasImmediateDrivers
                              ? const Color(0xFFD1FAE5)
                              : const Color(0xFFFEF3C7),
                          radius: 22,
                          child: Icon(
                            Icons.local_taxi,
                            color: _discoveryResult!.hasImmediateDrivers
                                ? const Color(0xFF059669)
                                : const Color(0xFFD97706),
                            size: 26,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Text(
                                    _discoveryResult!.hasImmediateDrivers ? 'كابتن ضمن 50م: ' : 'أقرب كابتن متاح: ',
                                    style: const TextStyle(fontSize: 11, color: Colors.blueGrey),
                                  ),
                                  Text(
                                    _discoveryResult!.allCityDrivers.first.fullName,
                                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 2),
                              Text(
                                '${_discoveryResult!.allCityDrivers.first.carModel} • يبعد ${_discoveryResult!.allCityDrivers.first.formattedDistance}',
                                style: const TextStyle(fontSize: 11, color: Colors.grey),
                              ),
                            ],
                          ),
                        ),
                        ElevatedButton(
                          onPressed: () => _quickBookWithNearestDriver({
                            'driverId': _discoveryResult!.allCityDrivers.first.driverId,
                            'fullName': _discoveryResult!.allCityDrivers.first.fullName,
                            'phoneNumber': _discoveryResult!.allCityDrivers.first.phoneNumber,
                            'carModel': _discoveryResult!.allCityDrivers.first.carModel,
                            'distanceKm': _discoveryResult!.allCityDrivers.first.distanceKm,
                          }),
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
