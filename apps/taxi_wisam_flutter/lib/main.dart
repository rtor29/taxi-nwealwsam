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
    Widget home;
    if (initialToken != null && initialToken!.isNotEmpty) {
      if (initialRole == 'Driver') {
        home = DriverHome(apiClient: apiClient, storageService: storageService);
      } else {
        home = RouteSearchScreen(
          apiClient: apiClient,
          customerId: initialUserId ?? '',
          storageService: storageService,
        );
      }
    } else {
      if (kIsWeb) {
        try {
          html.window.location.replace('/');
        } catch (_) {}
        home = const Scaffold(
          backgroundColor: Color(0xFF0F172A),
          body: Center(
            child: CircularProgressIndicator(color: Color(0xFFF59E0B)),
          ),
        );
      } else {
        home = LoginScreen(apiClient: apiClient, storageService: storageService);
      }
    }

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
      routes: {
        '/': (context) {
          if (kIsWeb) {
            try {
              html.window.location.replace('/');
            } catch (_) {}
            return const Scaffold(
              backgroundColor: Color(0xFF0F172A),
              body: Center(child: CircularProgressIndicator(color: Color(0xFFF59E0B))),
            );
          }
          return LoginScreen(apiClient: apiClient, storageService: storageService);
        },
        '/login': (context) {
          if (kIsWeb) {
            try {
              html.window.location.replace('/');
            } catch (_) {}
            return const Scaffold(
              backgroundColor: Color(0xFF0F172A),
              body: Center(child: CircularProgressIndicator(color: Color(0xFFF59E0B))),
            );
          }
          return LoginScreen(apiClient: apiClient, storageService: storageService);
        },
        '/customer': (context) => RouteSearchScreen(apiClient: apiClient, customerId: initialUserId ?? '', storageService: storageService),
        '/driver': (context) => DriverHome(apiClient: apiClient, storageService: storageService),
      },
    );
  }
}
