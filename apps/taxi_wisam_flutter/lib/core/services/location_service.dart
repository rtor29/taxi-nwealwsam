import 'dart:async';
import 'package:geolocator/geolocator.dart';
import '../../app_config.dart';

class LocationPermissionException implements Exception {
  final String message;
  final bool isPermanentlyDenied;

  LocationPermissionException(this.message, {this.isPermanentlyDenied = false});

  @override
  String toString() => message;
}

class LocationService {
  static final LocationService _instance = LocationService._internal();
  factory LocationService() => _instance;
  LocationService._internal();

  StreamSubscription<Position>? _positionStreamSubscription;
  final _positionController = StreamController<Position>.broadcast();

  Stream<Position> get positionStream => _positionController.stream;

  /// Check permissions and request if needed
  Future<bool> checkAndRequestPermission() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      throw LocationPermissionException('خدمات تحديد الموقع (GPS) معطلة. يرجى تفعيلها.');
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        throw LocationPermissionException('تم رفض إذن تحديد الموقع من قبل المستخدم.');
      }
    }

    if (permission == LocationPermission.deniedForever) {
      throw LocationPermissionException(
        'تم رفض إذن تحديد الموقع بشكل دائم. يرجى تفعيله من إعدادات الهاتف.',
        isPermanentlyDenied: true,
      );
    }

    return true;
  }

  /// Get current device position with fallback to Najaf Center
  Future<Position> getCurrentPosition({
    Duration timeout = const Duration(seconds: 10),
  }) async {
    try {
      await checkAndRequestPermission();
      return await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: timeout,
      );
    } catch (e) {
      // Fallback: Najaf Central baseline position
      return Position(
        latitude: AppConfig.najafCenterLat,
        longitude: AppConfig.najafCenterLon,
        timestamp: DateTime.now(),
        accuracy: 10.0,
        altitude: 30.0,
        altitudeAccuracy: 5.0,
        heading: 0.0,
        headingAccuracy: 0.0,
        speed: 0.0,
        speedAccuracy: 0.0,
      );
    }
  }

  /// Start live position updates for driver coordinate streaming
  Future<void> startLocationTracking({
    required Function(Position position) onPosition,
    int distanceFilter = 5,
  }) async {
    await checkAndRequestPermission();
    await stopLocationTracking();

    const locationSettings = LocationSettings(
      accuracy: LocationAccuracy.bestForNavigation,
      distanceFilter: 5,
    );

    _positionStreamSubscription =
        Geolocator.getPositionStream(locationSettings: locationSettings).listen(
      (Position position) {
        _positionController.add(position);
        onPosition(position);
      },
      onError: (err) {
        // Stream keep-alive on transient errors
      },
    );
  }

  /// Stop live position tracking
  Future<void> stopLocationTracking() async {
    await _positionStreamSubscription?.cancel();
    _positionStreamSubscription = null;
  }

  /// Calculate geographic distance in meters between two coordinates
  static double distanceBetween(
    double startLat,
    double startLon,
    double endLat,
    double endLon,
  ) {
    return Geolocator.distanceBetween(startLat, startLon, endLat, endLon);
  }

  void dispose() {
    stopLocationTracking();
    _positionController.close();
  }
}
