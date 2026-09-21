import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:taxi_wisam_flutter/core/services/mapbox_service.dart';

void main() {
  group('MapboxService and Route Result Tests', () {
    test('MapboxRouteResult calculates km and minutes accurately', () {
      final result = MapboxRouteResult(
        coordinates: [
          const LatLng(31.9961, 44.3168),
          const LatLng(32.0250, 44.3500),
        ],
        distanceMeters: 4500.0,
        durationSeconds: 540.0,
        summary: 'طريق الكوفة الرئيسي',
        rawGeoJson: {
          'type': 'LineString',
          'coordinates': [
            [44.3168, 31.9961],
            [44.3500, 32.0250]
          ]
        },
      );

      expect(result.distanceKm, 4.5);
      expect(result.durationMinutes, 9.0);
      expect(result.coordinates.length, 2);
      expect(result.summary, 'طريق الكوفة الرئيسي');
    });

    test('Fetches route or falls back reliably with valid coordinates', () async {
      final service = MapboxService();
      const origin = LatLng(31.9961, 44.3168);
      const destination = LatLng(32.0500, 44.3800);

      final route = await service.getDirections(origin: origin, destination: destination);

      expect(route, isNotNull);
      expect(route.coordinates.length, greaterThanOrEqualTo(2));
      // First coordinate is near origin (within ~100 meters due to road-snapping)
      expect(route.coordinates.first.latitude, closeTo(origin.latitude, 0.01));
      expect(route.coordinates.first.longitude, closeTo(origin.longitude, 0.01));
      // Last coordinate is near destination
      expect(route.coordinates.last.latitude, closeTo(destination.latitude, 0.01));
      expect(route.coordinates.last.longitude, closeTo(destination.longitude, 0.01));
      expect(route.distanceMeters, greaterThan(0));
      expect(route.durationSeconds, greaterThan(0));
      expect(route.summary.isNotEmpty, isTrue);
    });
  });
}
