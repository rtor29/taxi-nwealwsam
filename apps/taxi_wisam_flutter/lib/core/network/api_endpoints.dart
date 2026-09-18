class ApiEndpoints {
  // Auth
  static const String register = '/auth/register';
  static const String profile = '/auth/me';

  // Drivers
  static const String nearbyDrivers = '/drivers/nearby';
  static const String updateDriverStatus = '/drivers'; // + /{id}/status
  static const String createRoute = '/drivers';       // + /{id}/routes

  // Documents (Private Storage upload via ASP.NET Core)
  static const String uploadDocument = '/documents/upload';
  static const String documentSignedUrl = '/documents'; // + /{id}/signed-url

  // Bookings & Matching
  static const String createBooking = '/bookings';
  static const String customerBookings = '/bookings/customer';
  static const String findMatchingRoutes = '/matching/find-routes';
}
