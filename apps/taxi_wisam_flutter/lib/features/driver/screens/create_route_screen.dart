import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../../../app_config.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';
import '../../../core/services/mapbox_service.dart';

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
  final _startNameController = TextEditingController(text: 'مرقد الإمام علي (ع) - مركز النجف');
  final _endNameController = TextEditingController(text: 'جامعة الكوفة - مجمع الكليات');
  final _seatsController = TextEditingController(text: '4');
  final _priceController = TextEditingController(text: '3000');
  TimeOfDay _departureTime = const TimeOfDay(hour: 7, minute: 30);

  final MapboxService _mapboxService = MapboxService();
  final MapController _mapController = MapController();

  LatLng _startPoint = const LatLng(31.9961, 44.3168); // Najaf Center
  LatLng _endPoint = const LatLng(32.0300, 44.3700);   // Kufa University
  List<LatLng> _routePolyline = [];
  double _routeDistanceKm = 0.0;
  double _routeDurationMinutes = 0.0;
  String _routeSummary = '';
  Map<String, dynamic>? _rawGeoJson;

  bool _isLoading = false;
  bool _isFetchingRoute = false;

  @override
  void initState() {
    super.initState();
    _traceRouteWithMapbox();
  }

  Future<void> _traceRouteWithMapbox() async {
    setState(() => _isFetchingRoute = true);
    try {
      final result = await _mapboxService.getDirections(
        origin: _startPoint,
        destination: _endPoint,
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
          CameraFit.bounds(bounds: bounds, padding: const EdgeInsets.all(40)),
        );
      }
    } catch (_) {
      // Fallback polyline
      setState(() {
        _routePolyline = [_startPoint, _endPoint];
      });
    } finally {
      if (mounted) setState(() => _isFetchingRoute = false);
    }
  }

  Future<void> _handleSaveRoute() async {
    final routeName = _routeNameController.text.trim();
    final startName = _startNameController.text.trim();
    final endName = _endNameController.text.trim();

    if (routeName.isEmpty || startName.isEmpty || endName.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('يرجى ملء جميع الحقول الأساسية')),
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
              {'latitude': _endPoint.latitude, 'longitude': _endPoint.longitude},
            ];

      final payload = {
        'routeName': routeName,
        'startName': startName,
        'endName': endName,
        'coordinates': coordsList,
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
    return Scaffold(
      appBar: AppBar(
        title: const Text('تخطيط خط سير الكابتن (Mapbox)'),
        backgroundColor: const Color(0xFF0F172A),
        foregroundColor: Colors.white,
      ),
      body: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Interactive Mapbox Preview Card
            Container(
              height: 260,
              decoration: const BoxDecoration(
                border: Border(bottom: BorderSide(color: Color(0xFFE2E8F0))),
              ),
              child: Stack(
                children: [
                  FlutterMap(
                    mapController: _mapController,
                    options: MapOptions(
                      initialCenter: _startPoint,
                      initialZoom: 13.0,
                      onTap: (tapPosition, point) {
                        setState(() {
                          _endPoint = point;
                          _endNameController.text =
                              'نقطة مختارة (${point.latitude.toStringAsFixed(4)}, ${point.longitude.toStringAsFixed(4)})';
                        });
                        _traceRouteWithMapbox();
                      },
                    ),
                    children: [
                      TileLayer(
                        urlTemplate: AppConfig.mapboxNavigationTileUrl,
                        userAgentPackageName: 'com.taxiwisam.taxiWisamFlutter',
                      ),
                      if (_routePolyline.isNotEmpty)
                        PolylineLayer(
                          polylines: [
                            Polyline(
                              points: _routePolyline,
                              strokeWidth: 5.0,
                              color: const Color(0xFF2563EB),
                            ),
                          ],
                        ),
                      MarkerLayer(
                        markers: [
                          Marker(
                            point: _startPoint,
                            width: 44,
                            height: 44,
                            child: const Icon(Icons.trip_origin_rounded, color: Colors.green, size: 36),
                          ),
                          Marker(
                            point: _endPoint,
                            width: 44,
                            height: 44,
                            child: const Icon(Icons.location_on_rounded, color: Colors.red, size: 36),
                          ),
                        ],
                      ),
                    ],
                  ),
                  // Map Info Overlay
                  Positioned(
                    top: 12,
                    left: 12,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      decoration: BoxDecoration(
                        color: const Color(0xFF0F172A).withValues(alpha: 0.85),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.alt_route_rounded, color: Colors.amber, size: 16),
                          const SizedBox(width: 6),
                          Text(
                            _isFetchingRoute
                                ? 'جاري رسم المسار عبر Mapbox...'
                                : 'المسافة: ${_routeDistanceKm.toStringAsFixed(1)} كم • ${_routeDurationMinutes.toStringAsFixed(0)} دقيقة${_routeSummary.isNotEmpty ? " • $_routeSummary" : ""}',
                            style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
                          ),
                        ],
                      ),
                    ),
                  ),
                  Positioned(
                    bottom: 12,
                    right: 12,
                    child: FloatingActionButton.small(
                      heroTag: 'refreshRoute',
                      backgroundColor: Colors.white,
                      foregroundColor: const Color(0xFF0F172A),
                      onPressed: _traceRouteWithMapbox,
                      child: _isFetchingRoute
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.refresh_rounded),
                    ),
                  ),
                ],
              ),
            ),

            // Form Inputs
            Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextField(
                    controller: _routeNameController,
                    decoration: const InputDecoration(
                      labelText: 'اسم الخط (مثال: نقل صباحي الكوفة - النجف)',
                      prefixIcon: Icon(Icons.route_rounded),
                    ),
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _startNameController,
                    decoration: const InputDecoration(
                      labelText: 'نقطة الانطلاق (البداية)',
                      prefixIcon: Icon(Icons.play_circle_fill_rounded, color: Colors.green),
                    ),
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _endNameController,
                    decoration: const InputDecoration(
                      labelText: 'نقطة الوصول (النهاية)',
                      prefixIcon: Icon(Icons.stop_circle_rounded, color: Colors.red),
                    ),
                  ),
                  const SizedBox(height: 14),

                  // Time Picker
                  ListTile(
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
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
                    ),
                    child: _isLoading
                        ? const CircularProgressIndicator(strokeWidth: 2)
                        : const Text('حفظ ونشر خط النقل مع مسار Mapbox 🛣️'),
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
