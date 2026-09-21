import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../../../app_config.dart';
import '../../../core/services/signalr_service.dart';
import '../../../core/services/storage_service.dart';
import '../../../core/widgets/smooth_vehicle_marker.dart';

class LiveTrackingScreen extends StatefulWidget {
  final String bookingId;
  final String driverName;
  final StorageService storageService;
  final List<LatLng>? initialRoutePoints;

  const LiveTrackingScreen({
    super.key,
    required this.bookingId,
    required this.driverName,
    required this.storageService,
    this.initialRoutePoints,
  });

  @override
  State<LiveTrackingScreen> createState() => _LiveTrackingScreenState();
}

class _LiveTrackingScreenState extends State<LiveTrackingScreen> {
  late final SignalRService _signalRService;
  StreamSubscription? _locationSub;
  StreamSubscription? _routeSub;
  final MapController _mapController = MapController();

  // Najaf Center baseline (مرقد الإمام علي ع)
  double _driverLat = 31.9961;
  double _driverLon = 44.3168;
  double _heading = 0.0;
  List<LatLng> _routePoints = [];
  final String _status = 'السائق في طريقه إليك';

  @override
  void initState() {
    super.initState();
    if (widget.initialRoutePoints != null) {
      _routePoints = List.from(widget.initialRoutePoints!);
    }
    _signalRService = SignalRService(widget.storageService);
    _startLiveTracking();
  }

  Future<void> _startLiveTracking() async {
    await _signalRService.initConnection();
    await _signalRService.joinTrip(widget.bookingId);

    _locationSub = _signalRService.driverLocationStream.listen((data) {
      if (mounted) {
        setState(() {
          _driverLat = (data['latitude'] as num?)?.toDouble() ?? _driverLat;
          _driverLon = (data['longitude'] as num?)?.toDouble() ?? _driverLon;
          _heading = (data['heading'] as num?)?.toDouble() ?? _heading;
        });
        _mapController.move(LatLng(_driverLat, _driverLon), 16.0);
      }
    });

    // Listen for live route broadcast from admin dashboard or driver
    _routeSub = _signalRService.routeBroadcastStream.listen((data) {
      if (mounted && data['points'] != null) {
        final pts = data['points'] as List;
        final decoded = pts.map((p) {
          final lat = (p['latitude'] as num).toDouble();
          final lon = (p['longitude'] as num).toDouble();
          return LatLng(lat, lon);
        }).toList();

        setState(() {
          _routePoints = decoded;
        });
      }
    });
  }

  @override
  void dispose() {
    _locationSub?.cancel();
    _routeSub?.cancel();
    _signalRService.leaveTrip(widget.bookingId);
    _signalRService.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('تتبع الرحلة: ${widget.driverName}'),
        backgroundColor: const Color(0xFF0F172A),
        foregroundColor: Colors.white,
      ),
      body: Stack(
        children: [
          // Mapbox Maps SDK Tile Layer
          FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: LatLng(_driverLat, _driverLon),
              initialZoom: 15.5,
            ),
            children: [
              TileLayer(
                urlTemplate: AppConfig.mapboxNavigationTileUrl,
                userAgentPackageName: 'com.taxiwisam.taxiWisamFlutter',
              ),
              // Route Polyline Layer
              if (_routePoints.isNotEmpty)
                PolylineLayer(
                  polylines: [
                    Polyline(
                      points: _routePoints,
                      strokeWidth: 5.0,
                      color: const Color(0xFF2563EB),
                    ),
                  ],
                ),
              MarkerLayer(
                markers: [
                  Marker(
                    point: LatLng(_driverLat, _driverLon),
                    width: 70,
                    height: 70,
                    child: SmoothVehicleMarker(
                      targetPosition: LatLng(_driverLat, _driverLon),
                      targetHeading: _heading,
                      title: widget.driverName,
                    ),
                  ),
                ],
              ),
            ],
          ),

          // Najaf City Header Badge
          Positioned(
            top: 16,
            left: 16,
            right: 16,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              decoration: BoxDecoration(
                color: Colors.white.withOpacity(0.95),
                borderRadius: BorderRadius.circular(16),
                boxShadow: const [
                  BoxShadow(color: Colors.black12, blurRadius: 8, offset: Offset(0, 2)),
                ],
              ),
              child: Row(
                children: [
                  const Icon(Icons.location_on, color: Colors.red, size: 22),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text(
                      'محافظة النجف الأشرف | خريطة حية',
                      style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.green.shade50,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        CircleAvatar(radius: 4, backgroundColor: Colors.green),
                        SizedBox(width: 6),
                        Text('مباشر SignalR', style: TextStyle(fontSize: 10, color: Colors.green, fontWeight: FontWeight.bold)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),

          // Re-center Floating Action Button
          Positioned(
            bottom: 190,
            left: 16,
            child: FloatingActionButton.small(
              heroTag: 'recenter_driver',
              backgroundColor: Colors.white,
              foregroundColor: const Color(0xFF0F172A),
              onPressed: () {
                _mapController.move(LatLng(_driverLat, _driverLon), 16.0);
              },
              child: const Icon(Icons.my_location),
            ),
          ),

          // Bottom Trip Info Sheet
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              padding: const EdgeInsets.all(24),
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
                boxShadow: [
                  BoxShadow(color: Colors.black12, blurRadius: 10, offset: Offset(0, -2)),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(widget.driverName, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
                          const SizedBox(height: 2),
                          Text(_status, style: const TextStyle(color: Colors.green, fontSize: 12, fontWeight: FontWeight.bold)),
                          Text(
                            'الإحداثيات: ${_driverLat.toStringAsFixed(4)}, ${_driverLon.toStringAsFixed(4)}',
                            style: const TextStyle(color: Colors.blueGrey, fontSize: 11),
                          ),
                        ],
                      ),
                      const CircleAvatar(
                        radius: 24,
                        backgroundColor: Color(0xFFF59E0B),
                        child: Icon(Icons.phone, color: Colors.white),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  ElevatedButton(
                    onPressed: () => Navigator.pop(context),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF0F172A),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                    child: const Text('العودة للرئيسية', style: TextStyle(fontWeight: FontWeight.bold)),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
