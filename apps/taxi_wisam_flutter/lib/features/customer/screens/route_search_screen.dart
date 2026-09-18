import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';
import '../../../core/services/storage_service.dart';

class RouteSearchScreen extends StatefulWidget {
  final ApiClient apiClient;
  final String customerId;
  final StorageService storageService;

  const RouteSearchScreen({
    super.key,
    required this.apiClient,
    required this.customerId,
    required this.storageService,
  });

  @override
  State<RouteSearchScreen> createState() => _RouteSearchScreenState();
}

class _RouteSearchScreenState extends State<RouteSearchScreen> {
  final MapController _mapController = MapController();

  // Najaf landmarks default coordinates
  LatLng _pickupPoint = const LatLng(31.9961, 44.3168); // مرقد الإمام علي / ساحة ثورة العشرين
  LatLng _dropoffPoint = const LatLng(32.0300, 44.3700); // مسجد الكوفة / جامعة الكوفة

  final _pickupController = TextEditingController(text: 'مركز النجف الأشرف (ساحة ثورة العشرين)');
  final _dropoffController = TextEditingController(text: 'جامعة الكوفة - مجمع الكليات');

  // 'pickup' or 'dropoff' pin mode
  String _activePinMode = 'pickup';

  int _seatsNeeded = 1;
  bool _isSearching = false;
  List<dynamic> _matches = [];

  @override
  void initState() {
    super.initState();
    _searchMatchingRoutes();
  }

  double get _calculatedDistanceKm {
    const distance = Distance();
    return distance.as(LengthUnit.Kilometer, _pickupPoint, _dropoffPoint);
  }

  int get _estimatedFare {
    final km = _calculatedDistanceKm;
    return (3000 + (km * 450)).round();
  }

  Future<void> _setCurrentLocationAsPickup() async {
    try {
      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.whileInUse || permission == LocationPermission.always) {
        Position position = await Geolocator.getCurrentPosition();
        setState(() {
          _pickupPoint = LatLng(position.latitude, position.longitude);
          _pickupController.text = 'موقعي الحالي عبر الـ GPS 📍';
        });
        _mapController.move(_pickupPoint, 15.0);
        _searchMatchingRoutes();
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تعذر تحديد موقع GPS بدقة، تم التثبيت على مركز النجف')),
        );
      }
    }
  }

  void _onMapTapped(TapPosition tapPosition, LatLng point) {
    setState(() {
      if (_activePinMode == 'pickup') {
        _pickupPoint = point;
        _pickupController.text = 'موقع الانطلاق (${point.latitude.toStringAsFixed(3)}, ${point.longitude.toStringAsFixed(3)})';
      } else {
        _dropoffPoint = point;
        _dropoffController.text = 'وجهة الوصول (${point.latitude.toStringAsFixed(3)}, ${point.longitude.toStringAsFixed(3)})';
      }
    });
  }

  Future<void> _searchMatchingRoutes() async {
    setState(() {
      _isSearching = true;
      _matches = [];
    });

    try {
      final payload = {
        'pickupLat': _pickupPoint.latitude,
        'pickupLon': _pickupPoint.longitude,
        'dropoffLat': _dropoffPoint.latitude,
        'dropoffLon': _dropoffPoint.longitude,
        'desiredTime': '07:30:00',
        'seatsNeeded': _seatsNeeded,
        'maxDetourMeters': 1500.0,
      };

      final response = await widget.apiClient.dio.post(
        ApiEndpoints.findMatchingRoutes,
        data: payload,
      );

      if (mounted) {
        setState(() {
          _matches = response.data is List ? response.data : [];
        });
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('فشل البحث عن مسارات متطابقة')),
        );
      }
    } finally {
      if (mounted) setState(() => _isSearching = false);
    }
  }

  Future<void> _bookRoute(dynamic match) async {
    final routeId = match['driverRouteId'];

    try {
      final payload = {
        'customerId': widget.customerId,
        'driverRouteId': routeId,
        'driverName': match['driverName'],
        'seatsBooked': _seatsNeeded,
        'pickupName': _pickupController.text,
        'dropoffName': _dropoffController.text,
        'pickupLat': _pickupPoint.latitude,
        'pickupLon': _pickupPoint.longitude,
        'dropoffLat': _dropoffPoint.latitude,
        'dropoffLon': _dropoffPoint.longitude,
        'bookingDate': DateTime.now().toIso8601String().split('T').first,
      };

      final response = await widget.apiClient.dio.post(
        ApiEndpoints.createBooking,
        data: payload,
      );

      if (response.statusCode == 200 && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('تم تأكيد حجز مقعدك بنجاح مع ${match['driverName']}! 🚖'),
            backgroundColor: Colors.green,
          ),
        );
        Navigator.pop(context);
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تعذر إتمام الحجز، حاول مجدداً'), backgroundColor: Colors.red),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('تحديد المسار والخطوط في النجف'),
        backgroundColor: const Color(0xFF0F172A),
        foregroundColor: Colors.white,
      ),
      body: Column(
        children: [
          // 1. Map Area with Pickers
          SizedBox(
            height: 260,
            child: Stack(
              children: [
                FlutterMap(
                  mapController: _mapController,
                  options: MapOptions(
                    initialCenter: _pickupPoint,
                    initialZoom: 13.0,
                    onTap: _onMapTapped,
                  ),
                  children: [
                    TileLayer(
                      urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                      userAgentPackageName: 'com.taxiwisam.taxiWisamFlutter',
                    ),
                    PolylineLayer(
                      polylines: [
                        Polyline(
                          points: [_pickupPoint, _dropoffPoint],
                          strokeWidth: 4.0,
                          color: const Color(0xFFD97706),
                        ),
                      ],
                    ),
                    MarkerLayer(
                      markers: [
                        // Pickup Marker (Green)
                        Marker(
                          point: _pickupPoint,
                          width: 48,
                          height: 48,
                          child: const Column(
                            children: [
                              Icon(Icons.location_on, color: Colors.green, size: 36),
                            ],
                          ),
                        ),
                        // Dropoff Marker (Red)
                        Marker(
                          point: _dropoffPoint,
                          width: 48,
                          height: 48,
                          child: const Column(
                            children: [
                              Icon(Icons.location_on, color: Colors.red, size: 36),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ],
                ),

                // Top Controls: Mode Switcher & GPS
                Positioned(
                  top: 10,
                  left: 10,
                  right: 10,
                  child: Row(
                    children: [
                      Expanded(
                        child: Container(
                          padding: const EdgeInsets.all(4),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(12),
                            boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 4)],
                          ),
                          child: Row(
                            children: [
                              Expanded(
                                child: InkWell(
                                  onTap: () => setState(() => _activePinMode = 'pickup'),
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(vertical: 6),
                                    decoration: BoxDecoration(
                                      color: _activePinMode == 'pickup' ? Colors.green.shade600 : Colors.transparent,
                                      borderRadius: BorderRadius.circular(8),
                                    ),
                                    child: Center(
                                      child: Text(
                                        'الانطلاق 🟢',
                                        style: TextStyle(
                                          color: _activePinMode == 'pickup' ? Colors.white : Colors.black87,
                                          fontWeight: FontWeight.bold,
                                          fontSize: 12,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                              Expanded(
                                child: InkWell(
                                  onTap: () => setState(() => _activePinMode = 'dropoff'),
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(vertical: 6),
                                    decoration: BoxDecoration(
                                      color: _activePinMode == 'dropoff' ? Colors.red.shade600 : Colors.transparent,
                                      borderRadius: BorderRadius.circular(8),
                                    ),
                                    child: Center(
                                      child: Text(
                                        'الوصول 🔴',
                                        style: TextStyle(
                                          color: _activePinMode == 'dropoff' ? Colors.white : Colors.black87,
                                          fontWeight: FontWeight.bold,
                                          fontSize: 12,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      FloatingActionButton.small(
                        heroTag: 'gps_pickup_btn',
                        backgroundColor: Colors.white,
                        foregroundColor: const Color(0xFF0F172A),
                        onPressed: _setCurrentLocationAsPickup,
                        child: const Icon(Icons.my_location),
                      ),
                    ],
                  ),
                ),

                // Distance & Estimate Tag
                Positioned(
                  bottom: 8,
                  left: 10,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0F172A).withValues(alpha: 0.85),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      'المسافة: ${_calculatedDistanceKm.toStringAsFixed(1)} كم | الأجرة التقديرية: $_estimatedFare د.ع',
                      style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
              ],
            ),
          ),

          // 2. Location Inputs & Seats Selector
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _pickupController,
                        style: const TextStyle(fontSize: 13),
                        decoration: const InputDecoration(
                          labelText: 'نقطة الانطلاق (انقر على الخريطة 🟢)',
                          prefixIcon: Icon(Icons.trip_origin, color: Colors.green, size: 20),
                          isDense: true,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _dropoffController,
                        style: const TextStyle(fontSize: 13),
                        decoration: const InputDecoration(
                          labelText: 'وجهة الوصول (انقر على الخريطة 🔴)',
                          prefixIcon: Icon(Icons.location_on, color: Colors.red, size: 20),
                          isDense: true,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    const Text('المقاعد: ', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                    DropdownButton<int>(
                      value: _seatsNeeded,
                      items: [1, 2, 3, 4].map((n) => DropdownMenuItem(value: n, child: Text('$n مقعد'))).toList(),
                      onChanged: (val) => setState(() => _seatsNeeded = val ?? 1),
                    ),
                    const Spacer(),
                    ElevatedButton.icon(
                      onPressed: _isSearching ? null : _searchMatchingRoutes,
                      icon: const Icon(Icons.search, size: 18),
                      label: const Text('بحث ومطابقة الخطوط'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF0F172A),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),

          const Divider(height: 1),

          // 3. Matching Routes List
          Expanded(
            child: _isSearching
                ? const Center(child: CircularProgressIndicator())
                : _matches.isEmpty
                    ? const Center(
                        child: Text(
                          'لا توجد خطوط مطابقة حالياً. جرب تغيير النقطة أو زيادة النطاق.',
                          style: TextStyle(color: Colors.grey, fontSize: 13),
                        ),
                      )
                    : ListView.builder(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                        itemCount: _matches.length,
                        itemBuilder: (context, index) {
                          final m = _matches[index];
                          return Card(
                            elevation: 1.5,
                            margin: const EdgeInsets.only(bottom: 10),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                            child: Padding(
                              padding: const EdgeInsets.all(14),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                    children: [
                                      Text(
                                        m['routeName'] ?? 'خط سير منتظم',
                                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                      ),
                                      Container(
                                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                        decoration: BoxDecoration(
                                          color: Colors.amber.shade100,
                                          borderRadius: BorderRadius.circular(10),
                                        ),
                                        child: Text(
                                          '${m['pricePerSeat']} د.ع',
                                          style: TextStyle(
                                            fontWeight: FontWeight.bold,
                                            fontSize: 12,
                                            color: Colors.amber.shade900,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 6),
                                  Row(
                                    children: [
                                      const Icon(Icons.person, size: 16, color: Colors.blueGrey),
                                      const SizedBox(width: 4),
                                      Text('${m['driverName']} (★ ${m['driverRating'] ?? 5.0})', style: const TextStyle(fontSize: 12)),
                                      const Spacer(),
                                      const Icon(Icons.event_seat, size: 16, color: Colors.blueGrey),
                                      const SizedBox(width: 4),
                                      Text('متبقي ${m['availableSeats']} مقاعد', style: const TextStyle(fontSize: 12)),
                                    ],
                                  ),
                                  const SizedBox(height: 10),
                                  ElevatedButton(
                                    onPressed: () => _bookRoute(m),
                                    style: ElevatedButton.styleFrom(
                                      backgroundColor: const Color(0xFFD97706),
                                      foregroundColor: Colors.white,
                                      minimumSize: const Size.fromHeight(36),
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                    ),
                                    child: const Text('حجز مقعد في هذا الخط 🚖', style: TextStyle(fontWeight: FontWeight.bold)),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}
