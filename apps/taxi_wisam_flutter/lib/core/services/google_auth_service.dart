import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../app_config.dart';
import '../network/api_client.dart';
import 'storage_service.dart';

class GoogleAuthResult {
  final bool success;
  final String? errorMessage;
  final Map<String, dynamic>? userData;

  GoogleAuthResult({
    required this.success,
    this.errorMessage,
    this.userData,
  });
}

class GoogleAuthService {
  final ApiClient apiClient;
  final StorageService storageService;

  GoogleAuthService({
    required this.apiClient,
    required this.storageService,
  });

  /// Check if URL fragment contains OAuth credentials (after OAuth redirect on Web)
  Map<String, String> extractTokensFromCurrentUrl() {
    if (!kIsWeb) return {};
    try {
      final fragment = Uri.base.fragment;
      if (fragment.isNotEmpty && (fragment.contains('id_token=') || fragment.contains('access_token='))) {
        return Uri.splitQueryString(fragment);
      }
      final query = Uri.base.queryParameters;
      if (query.containsKey('id_token') || query.containsKey('access_token')) {
        return query;
      }
    } catch (_) {}
    return {};
  }

  /// Authenticate with backend using retrieved Google token or profile
  Future<GoogleAuthResult> authenticateWithBackend({
    String? idToken,
    String? accessToken,
    String? email,
    String? fullName,
    String? picture,
  }) async {
    try {
      final response = await apiClient.dio.post(
        '/auth/google',
        data: {
          if (idToken != null) 'idToken': idToken,
          if (accessToken != null) 'accessToken': accessToken,
          if (email != null) 'email': email,
          if (fullName != null) 'fullName': fullName,
          if (picture != null) 'picture': picture,
        },
      );

      final data = response.data;
      final userId = data['userId'] ?? 'usr-g-local';
      final role = data['role'] ?? 'Customer';
      final name = data['fullName'] ?? 'مستخدم Google';
      final token = data['token'] ?? 'jwt_session_$userId';

      await storageService.saveSession(
        token: token,
        userId: userId,
        role: role,
        fullName: name,
      );

      return GoogleAuthResult(
        success: true,
        userData: Map<String, dynamic>.from(data),
      );
    } catch (e) {
      return GoogleAuthResult(
        success: false,
        errorMessage: 'فشل إكمال تسجيل الدخول عبر Google: ${e.toString()}',
      );
    }
  }

  /// Launch Google OAuth 2.0 Flow via server-side authorization code exchange
  Future<void> launchGoogleSignInFlow() async {
    const callbackUri = 'http://173.212.206.86.nip.io/api/auth/google/callback';

    final authUrl = Uri.parse(
      'https://accounts.google.com/o/oauth2/v2/auth'
      '?client_id=${AppConfig.googleClientId}'
      '&redirect_uri=${Uri.encodeComponent(callbackUri)}'
      '&response_type=code'
      '&scope=openid%20email%20profile'
      '&access_type=offline'
      '&prompt=select_account',
    );

    await launchUrl(
      authUrl,
      mode: kIsWeb ? LaunchMode.platformDefault : LaunchMode.externalApplication,
      webOnlyWindowName: '_self',
    );
  }
}
