class AppConfig {
  static const String appName = 'تاكسي وسام';
  static const String appVersion = '1.0.0';

  // Dynamic host determination:
  // Android Emulator uses 10.0.2.2
  // iOS Simulator & Web use localhost
  static String get baseUrl {
    // Cloudflare live secure tunnel allows real iPhone device connection from any network
    return 'https://collective-journal-engineers-alot.trycloudflare.com';
  }

  static String get apiBaseUrl => '$baseUrl/api';
  static String get trackingHubUrl => '$baseUrl/hubs/tracking';

  // Najaf Coordinates Baseline (مرقد الإمام علي، ساحة ثورة العشرين، مطار النجف الدولي)
  static const double najafCenterLat = 31.9961;
  static const double najafCenterLon = 44.3168;

  // Architectural enforcement: Client never connects to Supabase database directly
  static const bool isDirectDatabaseAccessForbidden = true;
}
