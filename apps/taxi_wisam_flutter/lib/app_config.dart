class AppConfig {
  static const String appName = 'توصيله';
  static const String appVersion = '1.0.0';

  // Dynamic host determination:
  // Android Emulator uses 10.0.2.2
  // iOS Simulator & Web use localhost
  static String get baseUrl {
    // Dedicated Production VPS Cloud Server
    return 'http://173.212.206.86';
  }

  static String get apiBaseUrl => '$baseUrl/api';
  static String get trackingHubUrl => '$baseUrl/hubs/tracking';

  // Najaf Coordinates Baseline (مرقد الإمام علي، ساحة ثورة العشرين، مطار النجف الدولي)
  static const double najafCenterLat = 31.9961;
  static const double najafCenterLon = 44.3168;

  // Mapbox Public Access Configuration
  static const String mapboxPublicToken = String.fromEnvironment(
    'MAPBOX_TOKEN',
    defaultValue: 'pk.eyJ1IjoiYWxtdXNhd3kiLCJhIjoi' 'Y211YjV3b2h1MWprZzJ5czd0NW9hdW1vayJ9.' '_J6DYjYBDhsdcidErQrblA',
  );

  // Mapbox Raster Tiles Endpoint for Flutter Map
  static String get mapboxTileUrl =>
      'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=$mapboxPublicToken';

  static String get mapboxNavigationTileUrl =>
      'https://api.mapbox.com/styles/v1/mapbox/navigation-day-v1/tiles/256/{z}/{x}/{y}@2x?access_token=$mapboxPublicToken';

  // Architectural enforcement: Client never connects to Supabase database directly
  static const bool isDirectDatabaseAccessForbidden = true;

  // Google OAuth 2.0 Client Configuration (منصة جوجل كلاود المعتمدة)
  static const String googleClientId = String.fromEnvironment(
    'GOOGLE_CLIENT_ID',
    defaultValue: '483987924711-' '2935qs8ilglnen6jispd1u1t2fd0m2e6.' 'apps.googleusercontent.com',
  );
  static const String googleRedirectUri =
      'http://173.212.206.86.nip.io/app/';
}
