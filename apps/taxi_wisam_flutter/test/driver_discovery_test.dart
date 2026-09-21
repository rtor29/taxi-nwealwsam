import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:taxi_wisam_flutter/features/customer/services/driver_discovery_service.dart';

void main() {
  group('DriverDiscoveryService Proximity & Fallback Tests', () {
    const clientNajaf = LatLng(31.9961, 44.3168);

    test('Identifies drivers within immediate 50-meter radius', () {
      // Driver A is ~20 meters away
      // Driver B is ~45 meters away
      // Driver C is ~800 meters away
      final rawDrivers = [
        {
          'driverId': 'drv-immediate-1',
          'fullName': 'كابتن حيدر القريب',
          'phoneNumber': '07801122334',
          'latitude': 31.99625, // ~17m north
          'longitude': 44.3168,
          'rating': 4.9,
          'carModel': 'كيا أوبتيما',
          'plateNumber': 'النجف 1122',
        },
        {
          'driverId': 'drv-immediate-2',
          'fullName': 'كابتن علي القريب',
          'phoneNumber': '07802233445',
          'latitude': 31.9961,
          'longitude': 44.3172, // ~38m east
          'rating': 4.8,
          'carModel': 'تويوتا كورولا',
          'plateNumber': 'النجف 3344',
        },
        {
          'driverId': 'drv-far-1',
          'fullName': 'كابتن سجاد البعيد',
          'phoneNumber': '07803344556',
          'latitude': 32.0030, // ~770m away
          'longitude': 44.3168,
          'rating': 5.0,
          'carModel': 'هيونداي إلنترا',
          'plateNumber': 'النجف 5566',
        }
      ];

      final result = DriverDiscoveryService.evaluate(
        rawDrivers: rawDrivers,
        clientLocation: clientNajaf,
        immediateRadiusMeters: 50.0,
      );

      expect(result.hasImmediateDrivers, isTrue);
      expect(result.immediateDrivers.length, 2);
      expect(result.allCityDrivers.length, 3);
      expect(result.immediateDrivers.first.driverId, 'drv-immediate-1');
      expect(result.immediateDrivers[1].driverId, 'drv-immediate-2');
      expect(result.immediateDrivers.first.isWithinImmediateRadius, isTrue);
      expect(result.immediateDrivers.first.distanceMeters, lessThanOrEqualTo(50.0));
      expect(result.statusMessage, contains('تم العثور على 2 كابتن في نطاقك المباشر'));
    });

    test('Seamlessly falls back to city-wide drivers when 0 drivers in 50m', () {
      // All drivers are farther than 50 meters
      final rawDrivers = [
        {
          'driverId': 'drv-city-1',
          'fullName': 'كابتن الكوفة',
          'phoneNumber': '07805566778',
          'latitude': 32.0200, // ~2.6 km
          'longitude': 44.3400,
          'rating': 4.9,
          'carModel': 'كيا سيراتو',
          'plateNumber': 'النجف 7788',
        },
        {
          'driverId': 'drv-city-2',
          'fullName': 'كابتن المشخاب',
          'phoneNumber': '07809988776',
          'latitude': 31.9800, // ~1.8 km
          'longitude': 44.3100,
          'rating': 4.7,
          'carModel': 'تويوتا كامري',
          'plateNumber': 'النجف 9900',
        }
      ];

      final result = DriverDiscoveryService.evaluate(
        rawDrivers: rawDrivers,
        clientLocation: clientNajaf,
        immediateRadiusMeters: 50.0,
      );

      expect(result.hasImmediateDrivers, isFalse);
      expect(result.immediateDrivers.isEmpty, isTrue);
      expect(result.allCityDrivers.length, 2);
      // Verify sorted by distance
      expect(result.allCityDrivers.first.distanceMeters, lessThan(result.allCityDrivers[1].distanceMeters));
      expect(result.statusMessage, contains('لا توجد مركبات في نطاق 50 متر'));
      expect(result.statusMessage, contains('كباتن نشطين في النجف'));
    });

    test('Handles empty driver list gracefully without crash', () {
      final result = DriverDiscoveryService.evaluate(
        rawDrivers: [],
        clientLocation: clientNajaf,
        immediateRadiusMeters: 50.0,
      );

      expect(result.hasImmediateDrivers, isFalse);
      expect(result.immediateDrivers.isEmpty, isTrue);
      expect(result.allCityDrivers.isEmpty, isTrue);
      expect(result.statusMessage, contains('لا يوجد كباتن متاحين حالياً'));
    });
  });
}
