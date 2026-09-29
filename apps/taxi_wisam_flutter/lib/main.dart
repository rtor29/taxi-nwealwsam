import 'dart:html' as html;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'core/network/api_client.dart';
import 'core/services/storage_service.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/screens/login_screen.dart';
import 'features/customer/screens/route_search_screen.dart';
import 'features/driver/screens/driver_home_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final storageService = StorageService();
  final apiClient = ApiClient(storageService);

  String? token;
  String? role;
  String? userId;

  // 1. On Web, check if Google OAuth redirect provided a login token in query parameters or fragment
  if (kIsWeb) {
    try {
      final queryParams = Map<String, String>.from(Uri.base.queryParameters);
      if ((!queryParams.containsKey('login_token') || queryParams['login_token']!.isEmpty) && Uri.base.hasFragment) {
        final frag = Uri.base.fragment;
        if (frag.contains('login_token')) {
          final fragUri = Uri.parse(frag.startsWith('/') ? frag : '/$frag');
          queryParams.addAll(fragUri.queryParameters);
        }
      }

      if (queryParams.containsKey('login_token') && queryParams['login_token']!.isNotEmpty) {
        token = queryParams['login_token'];
        userId = queryParams['userId'] ?? 'usr-google';
        role = queryParams['role'] ?? 'Customer';
        final fullName = (queryParams['fullName'] != null && queryParams['fullName']!.isNotEmpty)
            ? queryParams['fullName']!
            : 'مستخدم Google';

        await storageService.saveSession(
          token: token!,
          userId: userId,
          role: role,
          fullName: fullName,
        );
      }
    } catch (_) {}
  }

  // 2. Read persisted session (populated via index.html early sync or previous login)
  if (token == null || token.isEmpty) {
    token = await storageService.getToken();
    role = await storageService.getUserRole();
    userId = await storageService.getUserId();
  }

  runApp(TaxiWisamApp(
    storageService: storageService,
    apiClient: apiClient,
    initialToken: token,
    initialRole: role,
    initialUserId: userId,
  ));
}

class TaxiWisamApp extends StatelessWidget {
  final StorageService storageService;
  final ApiClient apiClient;
  final String? initialToken;
  final String? initialRole;
  final String? initialUserId;

  const TaxiWisamApp({
    super.key,
    required this.storageService,
    required this.apiClient,
    this.initialToken,
    this.initialRole,
    this.initialUserId,
  });

  @override
  Widget build(BuildContext context) {
    final bool isDriver = initialRole == 'Driver' || (kIsWeb && Uri.base.fragment.contains('driver'));
    final Widget home = isDriver
        ? DriverHome(apiClient: apiClient, storageService: storageService)
        : RouteSearchScreen(
            apiClient: apiClient,
            customerId: initialUserId ?? '',
            storageService: storageService,
          );

    return MaterialApp(
      title: 'توصيله',
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
      onGenerateRoute: (settings) {
        final rawName = settings.name ?? '/';
        final uri = Uri.parse(rawName);
        final path = uri.path;

        if (path.startsWith('/driver') || (initialRole == 'Driver' && (path == '/' || path.isEmpty))) {
          return MaterialPageRoute(
            builder: (_) => DriverHome(
              apiClient: apiClient,
              storageService: storageService,
            ),
            settings: settings,
          );
        }

        final customerId = uri.queryParameters['userId'] ?? initialUserId ?? '';
        return MaterialPageRoute(
          builder: (_) => RouteSearchScreen(
            apiClient: apiClient,
            customerId: customerId,
            storageService: storageService,
          ),
          settings: settings,
        );
      },
    );
  }
}
