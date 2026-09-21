import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../../../app_config.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';
import '../../../core/services/location_service.dart';
import '../../../core/services/mapbox_service.dart';

enum RouteMapMode {
  setStart,
  setEnd,
  drawWaypoints,
}

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
  final _routeNameController = TextEditingController(text: 'خط النجف - الكوفة اليومي');
  final _startNameController = TextEditingController(text: 'مرقد الإمام علي (ع) - مركز النجف');
  final _endNameController = TextEditingController(text: 'جامعة الكوفة - مجمع الكليات');
  final _seatsController = TextEditingController(text: '4');
  final _priceController = TextEditingController(text: '3000');
  TimeOfDay _departureTime = const TimeOfDay(hour: 7, minute: 30);

  final MapboxService _mapboxService = MapboxService();
  final LocationService _locationService = LocationService();
  final MapController _mapController = MapController();

  LatLng _startPoint = const LatLng(31.9961, 44.3168); // Najaf Center
  LatLng _endPoint = const LatLng(32.0300, 44.3700);   // Kufa University
  final List<LatLng> _waypoints = [];

  RouteMapMode _activeMode = RouteMapMode.setStart;
  bool _isAutoRoute = true;

  List<LatLng> _routePolyline = [];
  double _routeDistanceKm = 0.0;
  double _routeDurationMinutes = 0.0;
  String _routeSummary = '';
  Map<String, dynamic>? _rawGeoJson;

  bool _isLoading = false;
  bool _isFetchingRoute = false;
  bool _isLocatingCurrentGps = false;

  @override
  void initState() {
    super.initState();
    _traceRouteWithMapbox();
  }

  @override
  void dispose() {
    _routeNameController.dispose();
    _startNameController.dispose();
    _endNameController.dispose();
    _seatsController.dispose();
    _priceController.dispose();
    super.dispose();
  }

  /// حساب المسار تلقائياً عبر Mapbox Directions API
  Future<void> _traceRouteWithMapbox() async {
    setState(() => _isFetchingRoute = true);
    try {
      final result = await _mapboxService.getDirections(
        origin: _startPoint,
        destination: _endPoint,
        waypoints: _waypoints.isNotEmpty ? _waypoints : null,
      );

      setState(() {
        _routePolyline = result.coordinates;
        _routeDistanceKm = result.distanceKm;
        _routeDurationMinutes = result.durationMinutes;
        _routeSummary = result.summary;
        _rawGeoJson = result.rawGeoJson;
      });

      if (_routePolyline.isNotEmpty) {
        final bounds = LatLngBounds.fromPoints(_routePolyline);
        _mapController.fitCamera(
          CameraFit.bounds(bounds: bounds, padding: const EdgeInsets.all(48)),
        );
      }
    } catch (_) {
      setState(() {
        _routePolyline = [_startPoint, ..._waypoints, _endPoint];
      });
    } finally {
      if (mounted) setState(() => _isFetchingRoute = false);
    }
  }

  /// تحديد الموقع الجغرافي الحالي للسائق عبر GPS وتعيينه كنقطة انطلاق
  Future<void> _setCurrentLocationAsStart() async {
    setState(() => _isLocatingCurrentGps = true);
    try {
      final position = await _locationService.getCurrentPosition();
      final currentLatLng = LatLng(position.latitude, position.longitude);

      setState(() {
        _startPoint = currentLatLng;
      });

      _mapController.move(currentLatLng, 15.0);

      // عكس الإحداثيات إلى اسم باللغة العربية
      final placeName = await _mapboxService.reverseGeocode(currentLatLng);
      if (placeName != null && placeName.isNotEmpty) {
        setState(() {
          _startNameController.text = placeName;
        });
      } else {
        setState(() {
          _startNameController.text =
              'موقعي الحالي (${position.latitude.toStringAsFixed(4)}, ${position.longitude.toStringAsFixed(4)})';
        });
      }

      await _traceRouteWithMapbox();

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('تم تحديد موقعك الحالي كنقطة الانطلاق بنجاح! 📍'),
          backgroundColor: Colors.green,
          duration: Duration(seconds: 2),
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('تعذر تحديد الموقع: $e'),
            backgroundColor: Colors.orange,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isLocatingCurrentGps = false);
    }
  }

  /// نافذة البحث التفاعلي عن المناطق والأحياء (Geocoding)
  void _openPlaceSearchModal({required bool isStart}) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) {
        return _PlaceSearchBottomSheet(
          mapboxService: _mapboxService,
          isStart: isStart,
          proximity: isStart ? _startPoint : _endPoint,
          onPlaceSelected: (name, latLng) {
            Navigator.pop(ctx);
            setState(() {
              if (isStart) {
                _startPoint = latLng;
                _startNameController.text = name;
              } else {
                _endPoint = latLng;
                _endNameController.text = name;
              }
            });
            _mapController.move(latLng, 14.5);
            _traceRouteWithMapbox();
          },
        );
      },
    );
  }

  /// التعامل مع النقر على الخريطة بحسب النمط المختار
  void _handleMapTap(LatLng point) async {
    switch (_activeMode) {
      case RouteMapMode.setStart:
        setState(() {
          _startPoint = point;
        });
        _traceRouteWithMapbox();
        final addr = await _mapboxService.reverseGeocode(point);
        if (mounted) {
          setState(() {
            _startNameController.text = addr ??
                'نقطة انطلاق (${point.latitude.toStringAsFixed(4)}, ${point.longitude.toStringAsFixed(4)})';
          });
        }
        break;

      case RouteMapMode.setEnd:
        setState(() {
          _endPoint = point;
        });
        _traceRouteWithMapbox();
        final addr = await _mapboxService.reverseGeocode(point);
        if (mounted) {
          setState(() {
            _endNameController.text = addr ??
                'نقطة وصول (${point.latitude.toStringAsFixed(4)}, ${point.longitude.toStringAsFixed(4)})';
          });
        }
        break;

      case RouteMapMode.drawWaypoints:
        setState(() {
          _waypoints.add(point);
        });
        _traceRouteWithMapbox();
        break;
    }
  }

  /// حفظ ونشر خط النقل
  Future<void> _handleSaveRoute() async {
    final routeName = _routeNameController.text.trim();
    final startName = _startNameController.text.trim();
    final endName = _endNameController.text.trim();

    if (routeName.isEmpty || startName.isEmpty || endName.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('يرجى إدخال اسم الخط ونقاط الانطلاق والوصول')),
      );
      return;
    }

    setState(() => _isLoading = true);

    try {
      final formattedTime =
          '${_departureTime.hour.toString().padLeft(2, '0')}:${_departureTime.minute.toString().padLeft(2, '0')}:00';

      final List<Map<String, double>> coordsList = _routePolyline.isNotEmpty
          ? _routePolyline.map((p) => {'latitude': p.latitude, 'longitude': p.longitude}).toList()
          : [
              {'latitude': _startPoint.latitude, 'longitude': _startPoint.longitude},
              ..._waypoints.map((w) => {'latitude': w.latitude, 'longitude': w.longitude}),
              {'latitude': _endPoint.latitude, 'longitude': _endPoint.longitude},
            ];

      final payload = {
        'routeName': routeName,
        'startName': startName,
        'endName': endName,
        'coordinates': coordsList,
        'waypoints': _waypoints.map((w) => {'latitude': w.latitude, 'longitude': w.longitude}).toList(),
        'geoJsonPolyline': _rawGeoJson,
        'distanceKm': _routeDistanceKm,
        'durationMinutes': _routeDurationMinutes,
        'bufferDistanceMeters': 1000.0,
        'departureTime': formattedTime,
        'availableSeats': int.tryParse(_seatsController.text) ?? 4,
        'pricePerSeat': double.tryParse(_priceController.text) ?? 3000.0,
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
            content: Text('تم إنشاء وتثبيت خط النقل بنجاح مع مسار Mapbox! 🛣️'),
            backgroundColor: Colors.green,
          ),
        );
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('فشل حفظ المسار'), backgroundColor: Colors.red),
        );
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDesktopOrTablet = MediaQuery.of(context).size.width >= 850;

    return Scaffold(
      appBar: AppBar(
        title: const Text('تخطيط وإنشاء خط السير (Mapbox)'),
        backgroundColor: const Color(0xFF0F172A),
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: 'تحديث المسار',
            onPressed: _traceRouteWithMapbox,
            icon: _isFetchingRoute
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                : const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: isDesktopOrTablet
          ? Row(
              children: [
                // لوحة التحكم وإدخال البيانات (شاشات الحاسوب والآيباد)
                SizedBox(
                  width: 420,
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.all(24),
                    child: _buildFormControls(),
                  ),
                ),
                const VerticalDivider(width: 1, color: Color(0xFFCBD5E1)),
                // الخريطة التفاعلية الموسعة
                Expanded(
                  child: _buildMapSection(isExpanded: true),
                ),
              ],
            )
          : SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // الخريطة في أعلى شاشة الهاتف
                  SizedBox(
                    height: 360,
                    child: _buildMapSection(isExpanded: false),
                  ),
                  // الحقول والإعدادات أسفل الخريطة
                  Padding(
                    padding: const EdgeInsets.all(20),
                    child: _buildFormControls(),
                  ),
                ],
              ),
            ),
    );
  }

  /// ودجت الخريطة التفاعلية مع أزرار التحكم والأنماط
  Widget _buildMapSection({required bool isExpanded}) {
    return Stack(
      children: [
        FlutterMap(
          mapController: _mapController,
          options: MapOptions(
            initialCenter: _startPoint,
            initialZoom: 13.0,
            onTap: (tapPosition, point) => _handleMapTap(point),
          ),
          children: [
            TileLayer(
              urlTemplate: AppConfig.mapboxNavigationTileUrl,
              userAgentPackageName: 'com.taxiwisam.taxiWisamFlutter',
            ),
            // خط المسار Polyline
            if (_routePolyline.isNotEmpty)
              PolylineLayer(
                polylines: [
                  Polyline(
                    points: _routePolyline,
                    strokeWidth: 5.5,
                    color: const Color(0xFF2563EB),
                  ),
                ],
              ),
            // العلامات Markers
            MarkerLayer(
              markers: [
                // نقطة البداية
                Marker(
                  point: _startPoint,
                  width: 50,
                  height: 50,
                  child: Tooltip(
                    message: 'نقطة الانطلاق: ${_startNameController.text}',
                    child: const Icon(Icons.trip_origin_rounded, color: Colors.green, size: 40),
                  ),
                ),
                // نقاط وسيطة مخصصة (Waypoints)
                ..._waypoints.asMap().entries.map((entry) {
                  final idx = entry.key + 1;
                  final pt = entry.value;
                  return Marker(
                    point: pt,
                    width: 32,
                    height: 32,
                    child: Container(
                      decoration: const BoxDecoration(
                        color: Colors.amber,
                        shape: BoxShape.circle,
                        boxShadow: [BoxShadow(color: Colors.black38, blurRadius: 4)],
                      ),
                      alignment: Alignment.center,
                      child: Text(
                        '$idx',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.black, fontSize: 13),
                      ),
                    ),
                  );
                }),
                // نقطة النهاية
                Marker(
                  point: _endPoint,
                  width: 50,
                  height: 50,
                  child: Tooltip(
                    message: 'نقطة الوصول: ${_endNameController.text}',
                    child: const Icon(Icons.location_on_rounded, color: Colors.red, size: 40),
                  ),
                ),
              ],
            ),
          ],
        ),

        // شريط الأنماط العلوي (تحديد الانطلاق، تحديد الوصول، رسم مسار يدوي)
        Positioned(
          top: 12,
          left: 12,
          right: 12,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: BoxDecoration(
              color: const Color(0xFF0F172A).withValues(alpha: 0.92),
              borderRadius: BorderRadius.circular(16),
              boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 8)],
            ),
            child: Row(
              children: [
                Expanded(
                  child: _buildModeTab(
                    mode: RouteMapMode.setStart,
                    title: 'نقطة الانطلاق',
                    icon: Icons.trip_origin_rounded,
                    activeColor: Colors.green,
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _buildModeTab(
                    mode: RouteMapMode.setEnd,
                    title: 'نقطة الوصول',
                    icon: Icons.location_on_rounded,
                    activeColor: Colors.red,
                  ),
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: _buildModeTab(
                    mode: RouteMapMode.drawWaypoints,
                    title: 'رسم يدوي',
                    icon: Icons.polyline_rounded,
                    activeColor: Colors.amber,
                  ),
                ),
              ],
            ),
          ),
        ),

        // بطاقة ملخص المسار السفلية
        Positioned(
          bottom: 12,
          left: 12,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: const Color(0xFF0F172A).withValues(alpha: 0.88),
              borderRadius: BorderRadius.circular(12),
              boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 6)],
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.alt_route_rounded, color: Colors.amber, size: 18),
                const SizedBox(width: 8),
                Text(
                  _isFetchingRoute
                      ? 'جاري رسم المسار عبر Mapbox...'
                      : 'المسافة: ${_routeDistanceKm.toStringAsFixed(1)} كم • ${_routeDurationMinutes.toStringAsFixed(0)} دقيقة${_routeSummary.isNotEmpty ? " • $_routeSummary" : ""}',
                  style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.bold),
                ),
              ],
            ),
          ),
        ),

        // زر تحديد الموقع عبر GPS وزر التراجع عن نقاط الرسم
        Positioned(
          bottom: 12,
          right: 12,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_waypoints.isNotEmpty) ...[
                FloatingActionButton.small(
                  heroTag: 'undoWaypoint',
                  backgroundColor: Colors.red.shade700,
                  foregroundColor: Colors.white,
                  tooltip: 'مسح النقاط الوسيطة المرسومة',
                  onPressed: () {
                    setState(() {
                      _waypoints.clear();
                    });
                    _traceRouteWithMapbox();
                  },
                  child: const Icon(Icons.clear_rounded, size: 20),
                ),
                const SizedBox(height: 8),
              ],
              FloatingActionButton.small(
                heroTag: 'gpsCurrentLocation',
                backgroundColor: Colors.white,
                foregroundColor: const Color(0xFF0F172A),
                tooltip: 'تحديد موقعي الحالي (GPS)',
                onPressed: _isLocatingCurrentGps ? null : _setCurrentLocationAsStart,
                child: _isLocatingCurrentGps
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.my_location_rounded, color: Color(0xFF2563EB)),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildModeTab({
    required RouteMapMode mode,
    required String title,
    required IconData icon,
    required Color activeColor,
  }) {
    final isSelected = _activeMode == mode;
    return InkWell(
      onTap: () {
        setState(() {
          _activeMode = mode;
        });
      },
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
        decoration: BoxDecoration(
          color: isSelected ? activeColor.withValues(alpha: 0.25) : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
          border: isSelected ? Border.all(color: activeColor, width: 1.5) : null,
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 16, color: isSelected ? activeColor : Colors.white70),
            const SizedBox(width: 4),
            Text(
              title,
              style: TextStyle(
                color: isSelected ? Colors.white : Colors.white70,
                fontSize: 11,
                fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// عناصر التحكم ونموذج إدخال بيانات المسار
  Widget _buildFormControls() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _routeNameController,
          decoration: const InputDecoration(
            labelText: 'اسم الخط اليومي (مثال: خط نقل الكوفة - النجف)',
            prefixIcon: Icon(Icons.route_rounded, color: Color(0xFF2563EB)),
          ),
        ),
        const SizedBox(height: 16),

        // نقطة الانطلاق مع أزرار البحث وتحديد الموقع الحالي
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.green.shade50.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: Colors.green.shade200),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.play_circle_fill_rounded, color: Colors.green, size: 22),
                  const SizedBox(width: 8),
                  const Text('نقطة الانطلاق (البداية)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  const Spacer(),
                  // زر موقعي الحالي
                  TextButton.icon(
                    onPressed: _isLocatingCurrentGps ? null : _setCurrentLocationAsStart,
                    icon: const Icon(Icons.my_location_rounded, size: 16),
                    label: const Text('موقعي الحالي', style: TextStyle(fontSize: 12)),
                    style: TextButton.styleFrom(
                      foregroundColor: Colors.green.shade800,
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _startNameController,
                decoration: InputDecoration(
                  hintText: 'انقر على الخريطة أو ابحث عن المنطقة',
                  filled: true,
                  fillColor: Colors.white,
                  suffixIcon: IconButton(
                    icon: const Icon(Icons.search_rounded, color: Colors.green),
                    tooltip: 'البحث عن منطقة الانطلاق بالاسم',
                    onPressed: () => _openPlaceSearchModal(isStart: true),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),

        // نقطة الوصول مع زر البحث
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.red.shade50.withValues(alpha: 0.6),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: Colors.red.shade200),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.stop_circle_rounded, color: Colors.red, size: 22),
                  const SizedBox(width: 8),
                  const Text('نقطة الوصول (الوجهة)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  const Spacer(),
                  TextButton.icon(
                    onPressed: () => _openPlaceSearchModal(isStart: false),
                    icon: const Icon(Icons.search_rounded, size: 16),
                    label: const Text('بحث بالاسم', style: TextStyle(fontSize: 12)),
                    style: TextButton.styleFrom(
                      foregroundColor: Colors.red.shade800,
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _endNameController,
                decoration: InputDecoration(
                  hintText: 'انقر على الخريطة أو ابحث عن المنطقة',
                  filled: true,
                  fillColor: Colors.white,
                  suffixIcon: IconButton(
                    icon: const Icon(Icons.search_rounded, color: Colors.red),
                    tooltip: 'البحث عن منطقة الوصول بالاسم',
                    onPressed: () => _openPlaceSearchModal(isStart: false),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),

        // طريقة رسم المسار: تلقائي (Mapbox Directions) أو يدوي
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFE2E8F0)),
          ),
          child: Row(
            children: [
              const Icon(Icons.alt_route_rounded, color: Color(0xFF2563EB)),
              const SizedBox(width: 10),
              const Expanded(
                child: Text('حساب المسار التلقائي (Mapbox Auto)', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
              ),
              Switch(
                value: _isAutoRoute,
                activeThumbColor: const Color(0xFF2563EB),
                onChanged: (val) {
                  setState(() {
                    _isAutoRoute = val;
                    if (val) {
                      _waypoints.clear();
                    }
                  });
                  _traceRouteWithMapbox();
                },
              ),
            ],
          ),
        ),
        if (!_isAutoRoute) ...[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: Colors.amber.shade50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Colors.amber.shade300),
            ),
            child: Row(
              children: [
                const Icon(Icons.info_outline_rounded, color: Colors.amber, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'النمط اليدوي مفعل: انقر على الخريطة لإضافة نقاط مرورية (${_waypoints.length} نقاط مضافة)',
                    style: TextStyle(color: Colors.amber.shade900, fontSize: 12),
                  ),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 14),

        // وقت الانطلاق
        ListTile(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: const BorderSide(color: Color(0xFFE2E8F0)),
          ),
          tileColor: Colors.white,
          leading: const Icon(Icons.access_time_filled_rounded, color: Color(0xFFF59E0B)),
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
        const SizedBox(height: 14),

        // المقاعد والسعر
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _seatsController,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'المقاعد المتاحة',
                  prefixIcon: Icon(Icons.event_seat_rounded),
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
                  prefixIcon: Icon(Icons.monetization_on_rounded),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),

        ElevatedButton(
          onPressed: _isLoading ? null : _handleSaveRoute,
          style: ElevatedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 14),
            backgroundColor: const Color(0xFF0F172A),
            foregroundColor: Colors.amber,
          ),
          child: _isLoading
              ? const CircularProgressIndicator(strokeWidth: 2, color: Colors.amber)
              : const Text('حفظ ونشر خط النقل مع مسار Mapbox 🛣️', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
        ),
      ],
    );
  }
}

/// ودجت نافذة البحث التفاعلي عن المناطق والأحياء
class _PlaceSearchBottomSheet extends StatefulWidget {
  final MapboxService mapboxService;
  final bool isStart;
  final LatLng proximity;
  final Function(String name, LatLng point) onPlaceSelected;

  const _PlaceSearchBottomSheet({
    required this.mapboxService,
    required this.isStart,
    required this.proximity,
    required this.onPlaceSelected,
  });

  @override
  State<_PlaceSearchBottomSheet> createState() => _PlaceSearchBottomSheetState();
}

class _PlaceSearchBottomSheetState extends State<_PlaceSearchBottomSheet> {
  final TextEditingController _queryController = TextEditingController();
  List<Map<String, dynamic>> _searchResults = [];
  bool _isSearching = false;

  final List<Map<String, dynamic>> _popularNajafPlaces = [
    {'placeName': 'مرقد الإمام علي (ع) - المدينة القديمة', 'lat': 31.9961, 'lon': 44.3168},
    {'placeName': 'جامعة الكوفة - شارع الكوفة ومجمع الكليات', 'lat': 32.0152, 'lon': 44.3725},
    {'placeName': 'مطار النجف الأشرف الدولي', 'lat': 31.9902, 'lon': 44.4042},
    {'placeName': 'مسجد الكوفة المعظم', 'lat': 32.0289, 'lon': 44.4011},
    {'placeName': 'ساحة ثورة العشرين - مركز النجف', 'lat': 32.0085, 'lon': 44.3312},
    {'placeName': 'حي السعد - شارع الروان', 'lat': 32.0190, 'lon': 44.3400},
    {'placeName': 'حي الأمير - شارع كربلاء والنجف', 'lat': 32.0310, 'lon': 44.3250},
    {'placeName': 'جامعة جابر بن حيان الطبية', 'lat': 32.0220, 'lon': 44.3580},
  ];

  void _search(String query) async {
    if (query.trim().isEmpty) {
      setState(() => _searchResults = []);
      return;
    }

    setState(() => _isSearching = true);
    try {
      final results = await widget.mapboxService.searchPlaces(
        query,
        proximity: widget.proximity,
      );
      if (mounted) {
        setState(() {
          _searchResults = results;
        });
      }
    } catch (_) {
    } finally {
      if (mounted) setState(() => _isSearching = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.8,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      expand: false,
      builder: (context, scrollController) {
        return Column(
          children: [
            const SizedBox(height: 12),
            Container(width: 44, height: 4, decoration: BoxDecoration(color: Colors.grey[300], borderRadius: BorderRadius.circular(2))),
            const SizedBox(height: 14),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Row(
                children: [
                  Icon(
                    widget.isStart ? Icons.trip_origin_rounded : Icons.location_on_rounded,
                    color: widget.isStart ? Colors.green : Colors.red,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    widget.isStart ? 'البحث عن منطقة الانطلاق' : 'البحث عن منطقة الوصول',
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: TextField(
                controller: _queryController,
                autofocus: true,
                onChanged: _search,
                decoration: InputDecoration(
                  hintText: 'ابحث عن حي، شارع، معلم، جامعة...',
                  prefixIcon: const Icon(Icons.search_rounded),
                  suffixIcon: _queryController.text.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear_rounded),
                          onPressed: () {
                            _queryController.clear();
                            setState(() => _searchResults = []);
                          },
                        )
                      : null,
                ),
              ),
            ),
            const SizedBox(height: 10),
            if (_isSearching)
              const LinearProgressIndicator(minHeight: 2)
            else
              const Divider(height: 1),
            Expanded(
              child: ListView(
                controller: scrollController,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                children: [
                  if (_searchResults.isNotEmpty) ...[
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8, horizontal: 8),
                      child: Text('نتائج البحث المباشرة (Mapbox Geocoding):', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.grey)),
                    ),
                    ..._searchResults.map((res) {
                      final title = res['text'] as String? ?? '';
                      final fullAddress = res['placeName'] as String? ?? '';
                      final lat = res['latitude'] as double;
                      final lon = res['longitude'] as double;

                      return ListTile(
                        leading: Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(color: Colors.blue.shade50, shape: BoxShape.circle),
                          child: const Icon(Icons.place_rounded, color: Color(0xFF2563EB)),
                        ),
                        title: Text(title.isNotEmpty ? title : fullAddress, style: const TextStyle(fontWeight: FontWeight.bold)),
                        subtitle: Text(fullAddress, style: TextStyle(fontSize: 12, color: Colors.grey[600])),
                        onTap: () {
                          widget.onPlaceSelected(title.isNotEmpty ? title : fullAddress, LatLng(lat, lon));
                        },
                      );
                    }),
                  ] else ...[
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8, horizontal: 8),
                      child: Text('أشهر المعالم والمناطق في النجف الأشرف:', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: Colors.grey)),
                    ),
                    ..._popularNajafPlaces.map((p) {
                      return ListTile(
                        leading: Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(color: Colors.amber.shade50, shape: BoxShape.circle),
                          child: const Icon(Icons.star_rounded, color: Colors.amber),
                        ),
                        title: Text(p['placeName'], style: const TextStyle(fontWeight: FontWeight.w600)),
                        subtitle: const Text('محافظة النجف الأشرف', style: TextStyle(fontSize: 12)),
                        onTap: () {
                          widget.onPlaceSelected(p['placeName'], LatLng(p['lat'], p['lon']));
                        },
                      );
                    }),
                  ],
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}
