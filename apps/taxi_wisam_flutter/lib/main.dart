import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'core/network/api_client.dart';
import 'core/services/storage_service.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/screens/login_screen.dart';
import 'features/customer/screens/customer_home_screen.dart';
import 'features/driver/screens/driver_home_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final storageService = StorageService();
  final apiClient = ApiClient(storageService);

  // Check initial session
  final token = await storageService.getToken();
  final role = await storageService.getUserRole();

  runApp(TaxiWisamApp(
    storageService: storageService,
    apiClient: apiClient,
    initialToken: token,
    initialRole: role,
  ));
}

class TaxiWisamApp extends StatelessWidget {
  final StorageService storageService;
  final ApiClient apiClient;
  final String? initialToken;
  final String? initialRole;

  const TaxiWisamApp({
    super.key,
    required this.storageService,
    required this.apiClient,
    this.initialToken,
    this.initialRole,
  });

  @override
  Widget build(BuildContext context) {
    Widget home;
    if (initialToken != null && initialToken!.isNotEmpty) {
      if (initialRole == 'Driver') {
        home = DriverHome(apiClient: apiClient, storageService: storageService);
      } else {
        home = CustomerHome(apiClient: apiClient, storageService: storageService);
      }
    } else {
      home = LoginScreen(apiClient: apiClient, storageService: storageService);
    }

    return MaterialApp(
      title: 'تاكسي وسام',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      locale: const Locale('ar'),
      supportedLocales: const [
        Locale('ar'),
        Locale('en'),
      ],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: home,
    );
  }
}
