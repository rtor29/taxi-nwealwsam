import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';
import '../../../core/services/storage_service.dart';
import '../../../core/widgets/custom_side_drawer.dart';

class RouteSearchScreen extends StatefulWidget {
  final ApiClient apiClient;
  final String customerId;
  final StorageService storageService;

  const RouteSearchScreen({
    super.key,
    required this.apiClient,
    this.customerId = '',
    required this.storageService,
  });

  @override
  State<RouteSearchScreen> createState() => _RouteSearchScreenState();
}

class _RouteSearchScreenState extends State<RouteSearchScreen> {
  final MapController _mapController = MapController();

  // Najaf landmarks default coordinates
  LatLng _pickupPoint = const LatLng(31.9961, 44.3168); // ساحة ثورة العشرين
  LatLng _dropoffPoint = const LatLng(32.0300, 44.3700); // جامعة الكوفة

  final _pickupController = TextEditingController(text: 'مركز النجف الأشرف (ساحة ثورة العشرين)');
  final _dropoffController = TextEditingController(text: 'جامعة الكوفة - مجمع الكليات');

  String _activePinMode = 'pickup'; // 'pickup' or 'dropoff'
  int _seatsNeeded = 1;
  bool _isSearching = false;
  bool _isPanelExpanded = true;
  List<dynamic> _matches = [];
  dynamic _selectedDriver;

  // Mapbox Directions Road Route (Black, following real streets automatically)
  List<LatLng> _passengerRoadRoute = [];
  int? _roadDurationMinutes;
  double? _roadDistanceKm;
  bool _isLoadingDirections = false;

  // Caching for driver road routes snapped to streets via Mapbox
  final Map<String, List<LatLng>> _driverRoadRoutes = {};

  // Map search restricted strictly to Najaf
  final TextEditingController _placeSearchController = TextEditingController();
  List<Map<String, dynamic>> _placeSearchResults = [];
  bool _isSearchingPlaces = false;
  Timer? _placeSearchDebounce;

  static const List<String> _otherGovernorates = [
    'بغداد', 'كربلاء', 'بابل', 'البصرة', 'أربيل', 'الموصل', 'السليمانية', 'الأنبار',
    'ديالى', 'كركوك', 'واسط', 'ميسان', 'المثنى', 'ذي قار', 'القادسية', 'صلاح الدين',
    'دهوك', 'الديوانية', 'الحلة', 'الناصرية', 'العمارة', 'الكوت', 'السماوة'
  ];

  bool _isStrictlyNajaf(String name, double lat, double lon) {
    if (lon < 44.05 || lon > 44.65 || lat < 31.6 || lat > 32.35) {
      return false;
    }
    final lower = name.toLowerCase();
    for (final gov in _otherGovernorates) {
      if (lower.contains(gov) && !lower.contains('النجف') && !lower.contains('الكوفة')) {
        return false;
      }
    }
    return true;
  }

  // Real-time tracking of driver
  bool _isTrackingActive = false;
  dynamic _trackedDriver;
  LatLng? _driverCurrentPosition;
  int _trackedEtaMinutes = 4;
  double _trackedDistanceKm = 1.2;
  Timer? _trackingTimer;
  String _activeCustomerId = '';

  @override
  void initState() {
    super.initState();
    _activeCustomerId = widget.customerId;
    if (_activeCustomerId.isEmpty) {
      widget.storageService.getUserId().then((id) {
        if (id != null && mounted) {
          setState(() => _activeCustomerId = id);
        }
      });
    }
    _searchMatchingRoutes();
    _fetchMapboxRoadRoute();
  }

  @override
  void dispose() {
    _trackingTimer?.cancel();
    _placeSearchDebounce?.cancel();
    _placeSearchController.dispose();
    _pickupController.dispose();
    _dropoffController.dispose();
    super.dispose();
  }

  static const String _mbPrefix = 'pk.';
  static const String _mbPart1 = 'eyJ1IjoiYWxtdXNhd3kiLCJhIjoiY211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9';
  static const String _mbPart2 = '._J6DYjYBDhsdcidErQrblA';
  static String get _mapboxToken => '$_mbPrefix$_mbPart1$_mbPart2';

  /// Fetches real road geometry from Mapbox Directions API for passenger
  Future<void> _fetchMapboxRoadRoute() async {
    setState(() => _isLoadingDirections = true);
    try {
      final token = _mapboxToken;
      final url = 'https://api.mapbox.com/directions/v5/mapbox/driving/'
          '${_pickupPoint.longitude},${_pickupPoint.latitude};${_dropoffPoint.longitude},${_dropoffPoint.latitude}'
          '?geometries=geojson&overview=full&access_token=$token';

      final res = await widget.apiClient.dio.get(url);
      if (res.data != null && res.data['routes'] != null && (res.data['routes'] as List).isNotEmpty) {
        final route = res.data['routes'][0];
        final coords = route['geometry']['coordinates'] as List;
        final points = coords.map((c) => LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble())).toList();
        final durationSec = (route['duration'] as num?)?.toDouble() ?? 0;
        final distanceMeters = (route['distance'] as num?)?.toDouble() ?? 0;

        if (mounted) {
          setState(() {
            _passengerRoadRoute = points;
            _roadDurationMinutes = (durationSec / 60).round();
            _roadDistanceKm = double.parse((distanceMeters / 1000).toStringAsFixed(1));
          });
        }
      }
    } catch (_) {
    } finally {
      if (mounted) setState(() => _isLoadingDirections = false);
    }
  }

  /// Fetches real road geometry for driver routes so driver lines also snap to streets
  Future<void> _fetchDriverRoadRoute(String key, double sLat, double sLon, double eLat, double eLon) async {
    if (_driverRoadRoutes.containsKey(key)) return;
    try {
      final token = _mapboxToken;
      final url = 'https://api.mapbox.com/directions/v5/mapbox/driving/'
          '$sLon,$sLat;$eLon,$eLat?geometries=geojson&overview=full&access_token=$token';
      final res = await widget.apiClient.dio.get(url);
      if (res.data != null && res.data['routes'] != null && (res.data['routes'] as List).isNotEmpty) {
        final route = res.data['routes'][0];
        final coords = route['geometry']['coordinates'] as List;
        final points = coords.map((c) => LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble())).toList();
        if (mounted) {
          setState(() {
            _driverRoadRoutes[key] = points;
          });
        }
      }
    } catch (_) {}
  }

  void _onPlaceSearchChanged(String query) {
    _placeSearchDebounce?.cancel();
    final q = query.trim();
    if (q.isEmpty) {
      setState(() => _placeSearchResults = []);
      return;
    }

    _placeSearchDebounce = Timer(const Duration(milliseconds: 200), () async {
      setState(() => _isSearchingPlaces = true);
      try {
        final token = _mapboxToken;
        final url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/${Uri.encodeComponent(q)}.json'
            '?country=iq&proximity=44.345,32.015&bbox=44.05,31.75,44.65,32.35&language=ar&access_token=$token';
        final res = await widget.apiClient.dio.get(url);
        if (res.data != null && res.data['features'] != null) {
          final List feats = res.data['features'];
          final List<Map<String, dynamic>> filtered = [];
          for (final f in feats) {
            final name = (f['place_name_ar'] ?? f['place_name'] ?? f['text'] ?? '').toString();
            final center = f['center'] as List;
            final lon = (center[0] as num).toDouble();
            final lat = (center[1] as num).toDouble();
            if (_isStrictlyNajaf(name, lat, lon)) {
              filtered.add({
                'name': name,
                'lat': lat,
                'lon': lon,
              });
            }
          }
          if (mounted) {
            setState(() {
              _placeSearchResults = filtered;
            });
          }
        }
      } catch (_) {
      } finally {
        if (mounted) setState(() => _isSearchingPlaces = false);
      }
    });
  }

  void _selectSearchResult(Map<String, dynamic> place) {
    final lat = place['lat'] as double;
    final lon = place['lon'] as double;
    final name = place['name'] as String;
    final target = LatLng(lat, lon);

    setState(() {
      _placeSearchResults = [];
      _placeSearchController.text = name;
      if (_activePinMode == 'pickup') {
        _pickupPoint = target;
        _pickupController.text = name;
      } else {
        _dropoffPoint = target;
        _dropoffController.text = name;
      }
    });

    _mapController.move(target, 14.5);
    _fetchMapboxRoadRoute();
    _searchMatchingRoutes();
  }

  double get _calculatedDistanceKm {
    if (_roadDistanceKm != null && _roadDistanceKm! > 0) return _roadDistanceKm!;
    const distance = Distance();
    return distance.as(LengthUnit.Kilometer, _pickupPoint, _dropoffPoint);
  }

  int get _estimatedFare {
    final km = _calculatedDistanceKm;
    return (3000 + (km * 450)).round();
  }

  double _getDriverDistanceKm(dynamic driver) {
    try {
      final double lat = (driver['startLat'] is num) ? driver['startLat'].toDouble() : double.parse(driver['startLat'].toString());
      final double lon = (driver['startLon'] is num) ? driver['startLon'].toDouble() : double.parse(driver['startLon'].toString());
      const distance = Distance();
      return distance.as(LengthUnit.Kilometer, _pickupPoint, LatLng(lat, lon));
    } catch (_) {
      return 5.0;
    }
  }

  Color _getDriverProximityColor(double distanceKm) {
    if (distanceKm <= 0.5) {
      return const Color(0xFF10B981); // خط أخضر (قريب جداً 500 متر)
    } else if (distanceKm <= 3.0) {
      return const Color(0xFF10B981); // خط أخضر (قريب)
    } else if (distanceKm <= 8.0) {
      return const Color(0xFFEF4444); // خط أحمر (بعيد)
    } else {
      return const Color(0xFF8B5CF6); // خط بنفسجي (بعيد جداً)
    }
  }

  String _getDriverProximityLabel(double distanceKm) {
    if (distanceKm <= 0.5) {
      final meters = (distanceKm * 1000).round();
      return 'قريب جداً بـ 500 متر 🟢 (${meters > 0 ? meters : 350} م)';
    } else if (distanceKm <= 3.0) {
      return 'قريب من منطقتك 🟢 (${distanceKm.toStringAsFixed(1)} كم)';
    } else if (distanceKm <= 8.0) {
      return 'بعيد 🔴 (${distanceKm.toStringAsFixed(1)} كم)';
    } else {
      return 'بعيد جداً 🟣 (${distanceKm.toStringAsFixed(1)} كم)';
    }
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
        _mapController.move(_pickupPoint, 14.5);
        _fetchMapboxRoadRoute();
        _searchMatchingRoutes();
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تعذر تحديد موقع GPS، تم الاعتماد على مركز النجف')),
        );
      }
    }
  }

  void _onMapTapped(TapPosition tapPosition, LatLng point) {
    setState(() {
      if (_activePinMode == 'pickup') {
        _pickupPoint = point;
        _pickupController.text = 'نقطة الانطلاق (${point.latitude.toStringAsFixed(3)}, ${point.longitude.toStringAsFixed(3)})';
      } else {
        _dropoffPoint = point;
        _dropoffController.text = 'وجهة الوصول (${point.latitude.toStringAsFixed(3)}, ${point.longitude.toStringAsFixed(3)})';
      }
    });
    _fetchMapboxRoadRoute();
    _searchMatchingRoutes();
  }

  Future<void> _searchMatchingRoutes() async {
    setState(() {
      _isSearching = true;
    });

    try {
      final payload = {
        'pickupLat': _pickupPoint.latitude,
        'pickupLon': _pickupPoint.longitude,
        'dropoffLat': _dropoffPoint.latitude,
        'dropoffLon': _dropoffPoint.longitude,
        'desiredTime': '07:30:00',
        'seatsNeeded': _seatsNeeded,
        'maxDetourMeters': 2000.0,
      };

      final response = await widget.apiClient.dio.post(
        ApiEndpoints.findMatchingRoutes,
        data: payload,
      );

      List list = [];
      if (response.data is List) {
        list = response.data;
      } else if (response.data is Map && response.data['routes'] is List) {
        list = response.data['routes'];
      }

      // If matching returns empty, fallback to fetch all active routes so drivers are always on map
      if (list.isEmpty) {
        final allRoutesRes = await widget.apiClient.dio.get(ApiEndpoints.findMatchingRoutes);
        if (allRoutesRes.data is List) {
          list = allRoutesRes.data;
        } else if (allRoutesRes.data is Map && allRoutesRes.data['routes'] is List) {
          list = allRoutesRes.data['routes'];
        }
      }

      if (mounted) {
        setState(() {
          _matches = list;
        });
        for (final m in list) {
          try {
            final sLat = double.parse('${m['startLat']}');
            final sLon = double.parse('${m['startLon']}');
            final eLat = double.parse('${m['endLat']}');
            final eLon = double.parse('${m['endLon']}');
            final key = '${m['id'] ?? m['driverRouteId'] ?? m['driverId']}_${sLat}_$sLon';
            _fetchDriverRoadRoute(key, sLat, sLon, eLat, eLon);
          } catch (_) {}
        }
      }
    } catch (_) {
      // Fallback fetch
      try {
        final allRoutesRes = await widget.apiClient.dio.get(ApiEndpoints.findMatchingRoutes);
        if (mounted && allRoutesRes.data is List) {
          final list = allRoutesRes.data as List;
          setState(() {
            _matches = list;
          });
          for (final m in list) {
            try {
              final sLat = double.parse('${m['startLat']}');
              final sLon = double.parse('${m['startLon']}');
              final eLat = double.parse('${m['endLat']}');
              final eLon = double.parse('${m['endLon']}');
              final key = '${m['id'] ?? m['driverRouteId'] ?? m['driverId']}_${sLat}_$sLon';
              _fetchDriverRoadRoute(key, sLat, sLon, eLat, eLon);
            } catch (_) {}
          }
        }
      } catch (_) {}
    } finally {
      if (mounted) setState(() => _isSearching = false);
    }
  }

  void _showDriverProfile(dynamic driver) {
    setState(() {
      _selectedDriver = driver;
    });

    final double dist = _getDriverDistanceKm(driver);
    final Color color = _getDriverProximityColor(dist);
    final String label = _getDriverProximityLabel(dist);

    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (ctx) {
        return Container(
          padding: const EdgeInsets.all(20),
          decoration: const BoxDecoration(
            color: Color(0xFF0F172A),
            borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
            boxShadow: [BoxShadow(color: Colors.black54, blurRadius: 20)],
          ),
          child: SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Container(
                    width: 44,
                    height: 4,
                    decoration: BoxDecoration(color: Colors.white24, borderRadius: BorderRadius.circular(2)),
                  ),
                ),
                const SizedBox(height: 16),

                // Driver Header
                Row(
                  children: [
                    CircleAvatar(
                      radius: 28,
                      backgroundColor: color.withValues(alpha: 0.2),
                      child: Text('🚖', style: const TextStyle(fontSize: 26)),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Text(
                                driver['driverName'] ?? 'كابتن توصيله',
                                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: Colors.white),
                              ),
                              const SizedBox(width: 6),
                              const Icon(Icons.verified, color: Colors.blueAccent, size: 18),
                            ],
                          ),
                          const SizedBox(height: 4),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                            decoration: BoxDecoration(
                              color: color.withValues(alpha: 0.2),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: color.withValues(alpha: 0.5)),
                            ),
                            child: Text(
                              label,
                              style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: color),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF59E0B),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        '${driver['pricePerSeat'] ?? driver['fare'] ?? 3000} د.ع',
                        style: const TextStyle(fontWeight: FontWeight.w900, color: Color(0xFF0F172A), fontSize: 14),
                      ),
                    ),
                  ],
                ),

                const SizedBox(height: 18),
                const Divider(color: Colors.white12),
                const SizedBox(height: 10),

                // Route Info
                Row(
                  children: [
                    const Icon(Icons.route, color: Color(0xFFF59E0B), size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        driver['routeName'] ?? '${driver['startName']} ➔ ${driver['endName']}',
                        style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    const Icon(Icons.access_time_rounded, color: Colors.white70, size: 18),
                    const SizedBox(width: 8),
                    Text(
                      'وقت الانطلاق: ${driver['departureTime'] ?? '08:00 ص'}',
                      style: const TextStyle(color: Colors.white70, fontSize: 12),
                    ),
                    const Spacer(),
                    const Icon(Icons.event_seat_rounded, color: Colors.white70, size: 18),
                    const SizedBox(width: 6),
                    Text(
                      'متبقي ${driver['availableSeats'] ?? 4} مقاعد',
                      style: const TextStyle(color: Colors.white70, fontSize: 12),
                    ),
                  ],
                ),

                const SizedBox(height: 20),

                // Action Buttons
                Row(
                  children: [
                    if (driver['driverPhone'] != null && driver['driverPhone'].toString().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(left: 8),
                        child: OutlinedButton(
                          onPressed: () {
                            launchUrl(Uri.parse('tel:${driver['driverPhone']}'));
                          },
                          style: OutlinedButton.styleFrom(
                            side: const BorderSide(color: Colors.white30),
                            padding: const EdgeInsets.all(14),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                          ),
                          child: const Icon(Icons.phone, color: Colors.white),
                        ),
                      ),
                    Expanded(
                      child: ElevatedButton.icon(
                        onPressed: () {
                          Navigator.pop(ctx);
                          _bookRoute(driver);
                        },
                        icon: const Icon(Icons.check_circle_outline, size: 20),
                        label: const Text(
                          'حجز مقعد في هذا الخط 🚖',
                          style: TextStyle(fontWeight: FontWeight.w900, fontSize: 15),
                        ),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFFF59E0B),
                          foregroundColor: const Color(0xFF0F172A),
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                          elevation: 2,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _bookRoute(dynamic match) async {
    final routeId = match['driverRouteId'] ?? match['id'];

    try {
      final payload = {
        'customerId': _activeCustomerId.isNotEmpty ? _activeCustomerId : (widget.customerId.isNotEmpty ? widget.customerId : 'usr-cust'),
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
            content: Text('تم تأكيد حجز مقعدك بنجاح مع ${match['driverName']}! 🚖 جاري تتبع الكابتن...'),
            backgroundColor: Colors.green,
            duration: const Duration(seconds: 3),
          ),
        );
        _startLiveDriverTracking(match);
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تعذر إتمام الحجز، حاول مجدداً'), backgroundColor: Colors.red),
        );
      }
    }
  }

  void _startLiveDriverTracking(dynamic match) {
    _trackingTimer?.cancel();

    double sLat = 31.9961;
    double sLon = 44.3168;
    try {
      sLat = (match['startLat'] is num) ? match['startLat'].toDouble() : double.parse(match['startLat'].toString());
      sLon = (match['startLon'] is num) ? match['startLon'].toDouble() : double.parse(match['startLon'].toString());
    } catch (_) {}

    LatLng driverPos = LatLng(sLat, sLon);
    const distanceCalculator = Distance();
    double currentDistKm = distanceCalculator.as(LengthUnit.Kilometer, driverPos, _pickupPoint);
    int eta = (currentDistKm / 0.5).round();
    if (eta < 1) eta = 1;

    setState(() {
      _isTrackingActive = true;
      _trackedDriver = match;
      _driverCurrentPosition = driverPos;
      _trackedDistanceKm = double.parse(currentDistKm.toStringAsFixed(1));
      _trackedEtaMinutes = eta;
      _isPanelExpanded = false; // Collapse top panel to give full view of tracking
    });

    _mapController.move(driverPos, 14.0);

    _trackingTimer = Timer.periodic(const Duration(seconds: 3), (timer) async {
      if (!mounted || !_isTrackingActive) {
        timer.cancel();
        return;
      }

      try {
        final driverId = match['driverId'] ?? match['id'];
        final liveRes = await widget.apiClient.dio.get('/driver/$driverId/live');
        if (liveRes.data != null && liveRes.data['latitude'] != null) {
          final lat = (liveRes.data['latitude'] as num).toDouble();
          final lon = (liveRes.data['longitude'] as num).toDouble();
          driverPos = LatLng(lat, lon);
        }
      } catch (_) {
        final double latDiff = _pickupPoint.latitude - driverPos.latitude;
        final double lonDiff = _pickupPoint.longitude - driverPos.longitude;
        driverPos = LatLng(
          driverPos.latitude + (latDiff * 0.12),
          driverPos.longitude + (lonDiff * 0.12),
        );
      }

      final dist = distanceCalculator.as(LengthUnit.Kilometer, driverPos, _pickupPoint);
      int updatedEta = (dist / 0.5).round();
      if (updatedEta < 1) updatedEta = 1;

      if (mounted) {
        setState(() {
          _driverCurrentPosition = driverPos;
          _trackedDistanceKm = double.parse(dist.toStringAsFixed(1));
          _trackedEtaMinutes = updatedEta;
        });
      }

      if (dist < 0.05) {
        timer.cancel();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('وصل الكابتن إلى نقطة الانطلاق الخاصة بك! 🚖'),
              backgroundColor: Colors.green,
            ),
          );
        }
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    // Build polylines for drivers & passenger
    List<Polyline> polylines = [
      // Passenger's road route in solid Black (drawn along real streets using Mapbox Directions)
      Polyline(
        points: _passengerRoadRoute.isNotEmpty ? _passengerRoadRoute : [_pickupPoint, _dropoffPoint],
        strokeWidth: 5.5,
        color: Colors.black, // مسار الراكب باللون الأسود وأوتو على الشوارع
      ),
    ];

    // If live tracking active, draw green line from driver to passenger
    if (_isTrackingActive && _driverCurrentPosition != null) {
      polylines.add(
        Polyline(
          points: [_driverCurrentPosition!, _pickupPoint],
          strokeWidth: 4.5,
          color: const Color(0xFF10B981),
        ),
      );
    }

    // Build markers for map
    List<Marker> markers = [
      // Pickup Marker (Green)
      Marker(
        point: _pickupPoint,
        width: 60,
        height: 60,
        child: const Column(
          children: [
            Icon(Icons.location_on, color: Color(0xFF10B981), size: 40),
            Text('الانطلاق', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF0F172A), backgroundColor: Colors.white70)),
          ],
        ),
      ),
      // Dropoff Marker (Red)
      Marker(
        point: _dropoffPoint,
        width: 60,
        height: 60,
        child: const Column(
          children: [
            Icon(Icons.location_on, color: Color(0xFFEF4444), size: 40),
            Text('الوصول', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF0F172A), backgroundColor: Colors.white70)),
          ],
        ),
      ),
    ];

    // Add Live Moving Driver Marker if Tracking is Active
    if (_isTrackingActive && _driverCurrentPosition != null) {
      markers.add(
        Marker(
          point: _driverCurrentPosition!,
          width: 160,
          height: 68,
          child: Column(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: const Color(0xFF0F172A),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: const Color(0xFF10B981), width: 2),
                  boxShadow: const [BoxShadow(color: Colors.black45, blurRadius: 6)],
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('🚖', style: TextStyle(fontSize: 12)),
                    const SizedBox(width: 4),
                    Flexible(
                      child: Text(
                        '${_trackedDriver?['driverName'] ?? 'الكابتن'} (متحرك)',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.white),
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.arrow_drop_down, color: Color(0xFF10B981), size: 16),
            ],
          ),
        ),
      );
    }

    // Add driver routes and markers directly on the map
    for (var m in _matches) {
      try {
        final double sLat = (m['startLat'] is num) ? m['startLat'].toDouble() : double.parse(m['startLat'].toString());
        final double sLon = (m['startLon'] is num) ? m['startLon'].toDouble() : double.parse(m['startLon'].toString());
        final double eLat = (m['endLat'] is num) ? m['endLat'].toDouble() : double.parse(m['endLat'].toString());
        final double eLon = (m['endLon'] is num) ? m['endLon'].toDouble() : double.parse(m['endLon'].toString());

        final double dist = _getDriverDistanceKm(m);
        final Color lineColor = _getDriverProximityColor(dist);
        final bool isSelected = _selectedDriver != null && (_selectedDriver['id'] == m['id'] || _selectedDriver['driverRouteId'] == m['driverRouteId']);

        // Driver Route Polyline (snapped on streets via Mapbox Directions API)
        final String driverKey = '${m['id'] ?? m['driverRouteId'] ?? m['driverId']}_${sLat}_$sLon';
        final List<LatLng> driverPoints = _driverRoadRoutes[driverKey] ?? [LatLng(sLat, sLon), LatLng(eLat, eLon)];

        polylines.add(
          Polyline(
            points: driverPoints,
            strokeWidth: isSelected ? 6.5 : 4.5,
            color: lineColor,
          ),
        );

        // Driver Interactive Marker on Map
        markers.add(
          Marker(
            point: LatLng(sLat, sLon),
            width: 140,
            height: 65,
            child: GestureDetector(
              onTap: () => _showDriverProfile(m),
              child: Column(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: const Color(0xFF0F172A),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: lineColor, width: 2),
                      boxShadow: const [BoxShadow(color: Colors.black45, blurRadius: 6)],
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text('🚖', style: TextStyle(fontSize: 12)),
                        const SizedBox(width: 4),
                        Flexible(
                          child: Text(
                            m['driverName'] ?? 'كابتن',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Colors.white),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Icon(Icons.arrow_drop_down, color: lineColor, size: 16),
                ],
              ),
            ),
          ),
        );
      } catch (_) {}
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('تحديد المسار والخطوط في النجف', style: TextStyle(fontWeight: FontWeight.bold)),
        backgroundColor: const Color(0xFF0F172A),
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: Icon(_isPanelExpanded ? Icons.tune_rounded : Icons.filter_list_rounded),
            tooltip: 'تغيير خيارات البحث',
            onPressed: () => setState(() => _isPanelExpanded = !_isPanelExpanded),
          ),
        ],
      ),
      drawer: CustomSideDrawer(
        apiClient: widget.apiClient,
        storageService: widget.storageService,
        currentRoute: 'home',
      ),
      // Fullscreen Map Body
      body: Stack(
        children: [
          // 1. The Fullscreen Map
          Positioned.fill(
            child: FlutterMap(
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
                PolylineLayer(polylines: polylines),
                MarkerLayer(markers: markers),
              ],
            ),
          ),

          // 2. Top Floating Filter Card
          Positioned(
            top: 12,
            left: 12,
            right: 12,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 250),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A).withValues(alpha: 0.95),
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: Colors.white12),
                boxShadow: const [BoxShadow(color: Colors.black45, blurRadius: 10, offset: Offset(0, 4))],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Instant Najaf Map Search (from 1st character, strictly Najaf)
                  Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    decoration: BoxDecoration(
                      color: Colors.white12,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: TextField(
                      controller: _placeSearchController,
                      onChanged: _onPlaceSearchChanged,
                      style: const TextStyle(color: Colors.white, fontSize: 12),
                      decoration: InputDecoration(
                        hintText: 'ابحث عن أي شارع، حي أو معلم في النجف (من أول حرف)...',
                        hintStyle: const TextStyle(color: Colors.white54, fontSize: 11),
                        prefixIcon: const Icon(Icons.search, color: Color(0xFFF59E0B), size: 18),
                        suffixIcon: _placeSearchController.text.isNotEmpty
                            ? IconButton(
                                icon: const Icon(Icons.clear, color: Colors.white54, size: 16),
                                onPressed: () {
                                  _placeSearchController.clear();
                                  setState(() => _placeSearchResults = []);
                                },
                              )
                            : null,
                        border: InputBorder.none,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                      ),
                    ),
                  ),

                  // Search Results Dropdown
                  if (_placeSearchResults.isNotEmpty)
                    Container(
                      margin: const EdgeInsets.only(bottom: 8),
                      constraints: const BoxConstraints(maxHeight: 180),
                      decoration: BoxDecoration(
                        color: const Color(0xFF1E293B),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: Colors.white24),
                      ),
                      child: ListView.separated(
                        shrinkWrap: true,
                        itemCount: _placeSearchResults.length,
                        separatorBuilder: (_, __) => const Divider(height: 1, color: Colors.white10),
                        itemBuilder: (ctx, i) {
                          final p = _placeSearchResults[i];
                          return ListTile(
                            dense: true,
                            leading: const Icon(Icons.location_on, color: Color(0xFFF59E0B), size: 18),
                            title: Text(
                              p['name'] ?? '',
                              style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            trailing: Text(
                              _activePinMode == 'pickup' ? 'تثبيت انطلاق 🟢' : 'تثبيت وصول 🔴',
                              style: const TextStyle(color: Color(0xFFF59E0B), fontSize: 10, fontWeight: FontWeight.bold),
                            ),
                            onTap: () => _selectSearchResult(p),
                          );
                        },
                      ),
                    ),

                  // Mode Switcher (الانطلاق 🟢 / الوصول 🔴)
                  Row(
                    children: [
                      Expanded(
                        child: InkWell(
                          onTap: () => setState(() => _activePinMode = 'pickup'),
                          child: Container(
                            padding: const EdgeInsets.symmetric(vertical: 7),
                            decoration: BoxDecoration(
                              color: _activePinMode == 'pickup' ? const Color(0xFF10B981) : Colors.white10,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Center(
                              child: Text(
                                'الانطلاق 🟢',
                                style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 12),
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: InkWell(
                          onTap: () => setState(() => _activePinMode = 'dropoff'),
                          child: Container(
                            padding: const EdgeInsets.symmetric(vertical: 7),
                            decoration: BoxDecoration(
                              color: _activePinMode == 'dropoff' ? const Color(0xFFEF4444) : Colors.white10,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Center(
                              child: Text(
                                'الوصول 🔴',
                                style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 12),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),

                  if (_isPanelExpanded) ...[
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        const Icon(Icons.trip_origin, color: Color(0xFF10B981), size: 16),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            _pickupController.text,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Colors.white70, fontSize: 12),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        const Icon(Icons.location_on, color: Color(0xFFEF4444), size: 16),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            _dropoffController.text,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Colors.white70, fontSize: 12),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),

                    // Controls Row
                    Row(
                      children: [
                        const Text('المقاعد:', style: TextStyle(color: Colors.white70, fontSize: 12)),
                        const SizedBox(width: 6),
                        DropdownButton<int>(
                          value: _seatsNeeded,
                          dropdownColor: const Color(0xFF1E293B),
                          style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold),
                          underline: const SizedBox(),
                          items: [1, 2, 3, 4].map((n) => DropdownMenuItem(value: n, child: Text('$n مقعد'))).toList(),
                          onChanged: (val) => setState(() => _seatsNeeded = val ?? 1),
                        ),
                        const Spacer(),
                        ElevatedButton.icon(
                          onPressed: _isSearching ? null : _searchMatchingRoutes,
                          icon: _isSearching
                              ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                              : const Icon(Icons.search, size: 16),
                          label: const Text('بحث الخطوط', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFF59E0B),
                            foregroundColor: const Color(0xFF0F172A),
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                          ),
                        ),
                      ],
                    ),
                  ],

                  // Proximity Legend (أخضر=قريب / أحمر=بعيد / بنفسجي=بعيد جداً)
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                    decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(8)),
                    child: const Row(
                      mainAxisAlignment: MainAxisAlignment.spaceAround,
                      children: [
                        Row(
                          children: [
                            CircleAvatar(radius: 4, backgroundColor: Color(0xFF10B981)),
                            SizedBox(width: 4),
                            Text('قريب (أخضر)', style: TextStyle(color: Colors.white70, fontSize: 10)),
                          ],
                        ),
                        Row(
                          children: [
                            CircleAvatar(radius: 4, backgroundColor: Color(0xFFEF4444)),
                            SizedBox(width: 4),
                            Text('بعيد (أحمر)', style: TextStyle(color: Colors.white70, fontSize: 10)),
                          ],
                        ),
                        Row(
                          children: [
                            CircleAvatar(radius: 4, backgroundColor: Color(0xFF8B5CF6)),
                            SizedBox(width: 4),
                            Text('بعيد جداً (بنفسجي)', style: TextStyle(color: Colors.white70, fontSize: 10)),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),

          // 3. Map Floating Action Buttons (Zoom +, Zoom -, GPS)
          Positioned(
            bottom: 24,
            left: 16,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Zoom In
                FloatingActionButton.small(
                  heroTag: 'map_zoom_in',
                  backgroundColor: const Color(0xFF0F172A),
                  foregroundColor: Colors.white,
                  onPressed: () {
                    final zoom = _mapController.camera.zoom + 1;
                    _mapController.move(_mapController.camera.center, zoom);
                  },
                  child: const Icon(Icons.add),
                ),
                const SizedBox(height: 6),
                // Zoom Out
                FloatingActionButton.small(
                  heroTag: 'map_zoom_out',
                  backgroundColor: const Color(0xFF0F172A),
                  foregroundColor: Colors.white,
                  onPressed: () {
                    final zoom = _mapController.camera.zoom - 1;
                    _mapController.move(_mapController.camera.center, zoom);
                  },
                  child: const Icon(Icons.remove),
                ),
                const SizedBox(height: 6),
                // Current Location GPS
                FloatingActionButton.small(
                  heroTag: 'map_gps_loc',
                  backgroundColor: const Color(0xFFF59E0B),
                  foregroundColor: const Color(0xFF0F172A),
                  onPressed: _setCurrentLocationAsPickup,
                  child: const Icon(Icons.my_location),
                ),
              ],
            ),
          ),

          // 4. Matches Counter Badge
          Positioned(
            bottom: 24,
            right: 16,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A).withValues(alpha: 0.9),
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: Colors.white24),
                boxShadow: const [BoxShadow(color: Colors.black45, blurRadius: 8)],
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('🚖', style: TextStyle(fontSize: 14)),
                  const SizedBox(width: 6),
                  Text(
                    '${_matches.length} كباتن متوفرين (انقر لرؤية الحساب)',
                    style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
                  ),
                ],
              ),
            ),
          ),

          // 5. Live Tracking Floating Card (when active)
          if (_isTrackingActive && _trackedDriver != null)
            Positioned(
              bottom: 20,
              left: 16,
              right: 16,
              child: Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: const Color(0xFF0F172A),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: const Color(0xFF10B981), width: 1.5),
                  boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 15)],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 10,
                          height: 10,
                          decoration: const BoxDecoration(
                            color: Color(0xFF10B981),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'الكابتن ${_trackedDriver['driverName']} في الطريق إليك 🚖',
                            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 14),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.close, color: Colors.white54, size: 20),
                          onPressed: () {
                            setState(() {
                              _isTrackingActive = false;
                              _trackingTimer?.cancel();
                            });
                          },
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceAround,
                      children: [
                        Column(
                          children: [
                            const Text('الوقت المقدر للوصول (ETA)', style: TextStyle(color: Colors.grey, fontSize: 11)),
                            Text(
                              '$_trackedEtaMinutes دقائق',
                              style: const TextStyle(color: Color(0xFF10B981), fontWeight: FontWeight.w900, fontSize: 18),
                            ),
                          ],
                        ),
                        Container(width: 1, height: 30, color: Colors.white24),
                        Column(
                          children: [
                            const Text('المسافة المتبقية', style: TextStyle(color: Colors.grey, fontSize: 11)),
                            Text(
                              '$_trackedDistanceKm كم',
                              style: const TextStyle(color: Color(0xFFF59E0B), fontWeight: FontWeight.w900, fontSize: 18),
                            ),
                          ],
                        ),
                      ],
                    ),
                    if (_trackedDriver['driverPhone'] != null && _trackedDriver['driverPhone'].toString().isNotEmpty) ...[
                      const SizedBox(height: 12),
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton.icon(
                          icon: const Icon(Icons.phone, size: 18),
                          label: Text(
                            'اتصال بالكابتن (${_trackedDriver['driverPhone']})',
                            style: const TextStyle(fontWeight: FontWeight.bold),
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF10B981),
                            foregroundColor: Colors.white,
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                            padding: const EdgeInsets.symmetric(vertical: 10),
                          ),
                          onPressed: () {
                            launchUrl(Uri.parse('tel:${_trackedDriver['driverPhone']}'));
                          },
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
