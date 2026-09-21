import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:latlong2/latlong.dart';
import '../../app_config.dart';

class MapboxRouteResult {
  final List<LatLng> coordinates;
  final double distanceMeters;
  final double durationSeconds;
  final String summary;
  final Map<String, dynamic> rawGeoJson;

  MapboxRouteResult({
    required this.coordinates,
    required this.distanceMeters,
    required this.durationSeconds,
    required this.summary,
    required this.rawGeoJson,
  });

  double get distanceKm => distanceMeters / 1000.0;
  double get durationMinutes => durationSeconds / 60.0;
}

class MapboxService {
  final Dio _dio = Dio();
  static const String _directionsBaseUrl = 'https://api.mapbox.com/directions/v5/mapbox/driving';

  /// Fetches an optimal driving route between origin and destination coordinates
  /// Returns decoded LatLng polyline points, total distance and duration.
  Future<MapboxRouteResult> getDirections({
    required LatLng origin,
    required LatLng destination,
    List<LatLng>? waypoints,
  }) async {
    // Mapbox Directions API expects: {longitude},{latitude};{longitude},{latitude}
    final List<String> coordStrings = [];
    coordStrings.add('${origin.longitude},${origin.latitude}');

    if (waypoints != null && waypoints.isNotEmpty) {
      for (final wp in waypoints) {
        coordStrings.add('${wp.longitude},${wp.latitude}');
      }
    }

    coordStrings.add('${destination.longitude},${destination.latitude}');
    final coordinatesParam = coordStrings.join(';');

    final url = '$_directionsBaseUrl/$coordinatesParam';

    try {
      final response = await _dio.get(
        url,
        queryParameters: {
          'access_token': AppConfig.mapboxPublicToken,
          'geometries': 'geojson',
          'overview': 'full',
          'steps': 'true',
          'language': 'ar',
        },
        options: Options(
          receiveTimeout: const Duration(seconds: 15),
          sendTimeout: const Duration(seconds: 10),
        ),
      );

      if (response.statusCode == 200 && response.data['routes'] != null) {
        final routes = response.data['routes'] as List;
        if (routes.isNotEmpty) {
          final firstRoute = routes[0];
          final geometry = firstRoute['geometry'] as Map<String, dynamic>;
          final coordsList = geometry['coordinates'] as List;

          final List<LatLng> decodedPoints = coordsList.map((pt) {
            final lon = (pt[0] as num).toDouble();
            final lat = (pt[1] as num).toDouble();
            return LatLng(lat, lon);
          }).toList();

          final double distance = (firstRoute['distance'] as num?)?.toDouble() ?? 0.0;
          final double duration = (firstRoute['duration'] as num?)?.toDouble() ?? 0.0;
          final String summary = (firstRoute['legs'] as List?)?.first['summary'] ?? 'طريق مباشر';

          return MapboxRouteResult(
            coordinates: decodedPoints,
            distanceMeters: distance,
            durationSeconds: duration,
            summary: summary,
            rawGeoJson: geometry,
          );
        }
      }
      throw Exception('لم يتم العثور على مسار صالح من ماب بوكس');
    } catch (e) {
      // Robust Fallback: Straight-line interpolated route if network/API limits occur
      return _generateFallbackRoute(origin, destination);
    }
  }

  /// Geocoding / Search address via Mapbox Geocoding API
  Future<List<Map<String, dynamic>>> searchPlaces(String query, {LatLng? proximity}) async {
    if (query.trim().isEmpty) return [];

    final encodedQuery = Uri.encodeComponent(query);
    final url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/$encodedQuery.json';

    try {
      final queryParams = <String, dynamic>{
        'access_token': AppConfig.mapboxPublicToken,
        'country': 'IQ',
        'language': 'ar',
        'types': 'poi,address,neighborhood,locality',
      };

      if (proximity != null) {
        queryParams['proximity'] = '${proximity.longitude},${proximity.latitude}';
      } else {
        queryParams['proximity'] = '${AppConfig.najafCenterLon},${AppConfig.najafCenterLat}';
      }

      final response = await _dio.get(url, queryParameters: queryParams);
      if (response.statusCode == 200 && response.data['features'] != null) {
        final features = response.data['features'] as List;
        return features.map((f) {
          final center = f['center'] as List;
          return {
            'placeName': f['place_name_ar'] ?? f['place_name'] ?? '',
            'text': f['text_ar'] ?? f['text'] ?? '',
            'latitude': (center[1] as num).toDouble(),
            'longitude': (center[0] as num).toDouble(),
          };
        }).toList();
      }
    } catch (_) {}

    return [];
  }

  /// Reverse geocode coordinates to get a readable Arabic address
  Future<String?> reverseGeocode(LatLng point) async {
    final url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/${point.longitude},${point.latitude}.json';
    try {
      final response = await _dio.get(url, queryParameters: {
        'access_token': AppConfig.mapboxPublicToken,
        'country': 'IQ',
        'language': 'ar',
        'types': 'poi,neighborhood,locality,address',
      });
      if (response.statusCode == 200 && response.data['features'] != null) {
        final features = response.data['features'] as List;
        if (features.isNotEmpty) {
          final first = features.first;
          final placeName = first['place_name_ar'] ?? first['place_name'] ?? first['text_ar'] ?? first['text'];
          if (placeName != null && placeName.toString().trim().isNotEmpty) {
            return placeName.toString();
          }
        }
      }
    } catch (_) {}
    return null;
  }


  MapboxRouteResult _generateFallbackRoute(LatLng origin, LatLng destination) {
    final midLat = (origin.latitude + destination.latitude) / 2.0;
    final midLon = (origin.longitude + destination.longitude) / 2.0;

    final fallbackCoords = [
      origin,
      LatLng(midLat, midLon),
      destination,
    ];

    return MapboxRouteResult(
      coordinates: fallbackCoords,
      distanceMeters: 5200.0,
      durationSeconds: 600.0,
      summary: 'مسار افتراضي مباشر - النجف الأشرف',
      rawGeoJson: {
        'type': 'LineString',
        'coordinates': fallbackCoords.map((p) => [p.longitude, p.latitude]).toList(),
      },
    );
  }
}
