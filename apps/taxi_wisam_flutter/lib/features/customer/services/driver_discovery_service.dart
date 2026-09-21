import 'package:latlong2/latlong.dart';
import '../../../core/services/location_service.dart';

class ProximityDriver {
  final String driverId;
  final String fullName;
  final String phoneNumber;
  final double latitude;
  final double longitude;
  final double heading;
  final double rating;
  final String carModel;
  final String plateNumber;
  final double distanceMeters;
  final bool isWithinImmediateRadius; // true if within 50m

  ProximityDriver({
    required this.driverId,
    required this.fullName,
    required this.phoneNumber,
    required this.latitude,
    required this.longitude,
    this.heading = 0.0,
    this.rating = 5.0,
    required this.carModel,
    required this.plateNumber,
    required this.distanceMeters,
    required this.isWithinImmediateRadius,
  });

  double get distanceKm => distanceMeters / 1000.0;

  String get formattedDistance {
    if (distanceMeters < 1000) {
      return '${distanceMeters.toStringAsFixed(0)} متر';
    } else {
      return '${distanceKm.toStringAsFixed(1)} كم';
    }
  }

  factory ProximityDriver.fromJson(
    Map<String, dynamic> json, {
    required double clientLat,
    required double clientLon,
    double immediateRadiusMeters = 50.0,
  }) {
    final lat = (json['latitude'] as num?)?.toDouble() ?? clientLat;
    final lon = (json['longitude'] as num?)?.toDouble() ?? clientLon;
    final dist = LocationService.distanceBetween(clientLat, clientLon, lat, lon);

    return ProximityDriver(
      driverId: json['driverId']?.toString() ?? '',
      fullName: json['fullName']?.toString() ?? 'كابتن توصيله',
      phoneNumber: json['phoneNumber']?.toString() ?? '',
      latitude: lat,
      longitude: lon,
      heading: (json['heading'] as num?)?.toDouble() ?? 0.0,
      rating: (json['rating'] as num?)?.toDouble() ?? 5.0,
      carModel: json['carModel']?.toString() ?? 'سيارة أجرة',
      plateNumber: json['plateNumber']?.toString() ?? 'النجف',
      distanceMeters: dist,
      isWithinImmediateRadius: dist <= immediateRadiusMeters,
    );
  }
}

class DiscoveryResult {
  final List<ProximityDriver> immediateDrivers; // <= 50m
  final List<ProximityDriver> allCityDrivers;    // entire city
  final bool hasImmediateDrivers;
  final String statusMessage;

  DiscoveryResult({
    required this.immediateDrivers,
    required this.allCityDrivers,
    required this.hasImmediateDrivers,
    required this.statusMessage,
  });
}

class DriverDiscoveryService {
  /// Evaluates driver list with 50-meter immediate proximity and fallback logic
  static DiscoveryResult evaluate({
    required List<dynamic> rawDrivers,
    required LatLng clientLocation,
    double immediateRadiusMeters = 50.0,
  }) {
    final List<ProximityDriver> parsed = rawDrivers.map((d) {
      if (d is Map<String, dynamic>) {
        return ProximityDriver.fromJson(
          d,
          clientLat: clientLocation.latitude,
          clientLon: clientLocation.longitude,
          immediateRadiusMeters: immediateRadiusMeters,
        );
      } else {
        return ProximityDriver.fromJson(
          Map<String, dynamic>.from(d),
          clientLat: clientLocation.latitude,
          clientLon: clientLocation.longitude,
          immediateRadiusMeters: immediateRadiusMeters,
        );
      }
    }).toList();

    // Sort by proximity
    parsed.sort((a, b) => a.distanceMeters.compareTo(b.distanceMeters));

    final immediate = parsed.where((d) => d.isWithinImmediateRadius).toList();

    if (parsed.isEmpty) {
      return DiscoveryResult(
        immediateDrivers: [],
        allCityDrivers: [],
        hasImmediateDrivers: false,
        statusMessage: 'لا يوجد كباتن متاحين حالياً في النجف الأشرف 📍',
      );
    } else if (immediate.isNotEmpty) {
      return DiscoveryResult(
        immediateDrivers: immediate,
        allCityDrivers: parsed,
        hasImmediateDrivers: true,
        statusMessage: 'تم العثور على ${immediate.length} كابتن في نطاقك المباشر (50 متر) 📍',
      );
    } else {
      return DiscoveryResult(
        immediateDrivers: [],
        allCityDrivers: parsed,
        hasImmediateDrivers: false,
        statusMessage:
            'لا توجد مركبات في نطاق 50 متر. تم توسيع البحث تلقائياً لعرض ${parsed.length} كباتن نشطين في النجف 🚗',
      );
    }
  }
}
