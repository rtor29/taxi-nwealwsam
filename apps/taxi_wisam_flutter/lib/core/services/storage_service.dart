import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class StorageService {
  final FlutterSecureStorage _storage = const FlutterSecureStorage(
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
  );

  static const String _keyToken = 'auth_token';
  static const String _keyUserId = 'user_id';
  static const String _keyUserRole = 'user_role';
  static const String _keyFullName = 'user_fullname';

  Future<void> saveSession({
    required String token,
    required String userId,
    required String role,
    required String fullName,
  }) async {
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_keyToken, token);
      await prefs.setString(_keyUserId, userId);
      await prefs.setString(_keyUserRole, role);
      await prefs.setString(_keyFullName, fullName);
      return;
    }
    try {
      await _storage.write(key: _keyToken, value: token);
      await _storage.write(key: _keyUserId, value: userId);
      await _storage.write(key: _keyUserRole, value: role);
      await _storage.write(key: _keyFullName, value: fullName);
    } catch (_) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_keyToken, token);
      await prefs.setString(_keyUserId, userId);
      await prefs.setString(_keyUserRole, role);
      await prefs.setString(_keyFullName, fullName);
    }
  }

  Future<String?> getToken() async {
    String? val;
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      val = prefs.getString(_keyToken);
    } else {
      try {
        val = await _storage.read(key: _keyToken);
        if (val != null && val.isNotEmpty) return val.replaceAll('"', '').trim();
      } catch (_) {}
      final prefs = await SharedPreferences.getInstance();
      val = prefs.getString(_keyToken);
    }
    return val?.replaceAll('"', '').trim();
  }

  Future<String?> getUserId() async {
    String? val;
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      val = prefs.getString(_keyUserId);
    } else {
      try {
        val = await _storage.read(key: _keyUserId);
        if (val != null && val.isNotEmpty) return val.replaceAll('"', '').trim();
      } catch (_) {}
      final prefs = await SharedPreferences.getInstance();
      val = prefs.getString(_keyUserId);
    }
    return val?.replaceAll('"', '').trim();
  }

  Future<String?> getUserRole() async {
    String? val;
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      val = prefs.getString(_keyUserRole);
    } else {
      try {
        val = await _storage.read(key: _keyUserRole);
        if (val != null && val.isNotEmpty) return val.replaceAll('"', '').trim();
      } catch (_) {}
      final prefs = await SharedPreferences.getInstance();
      val = prefs.getString(_keyUserRole);
    }
    return val?.replaceAll('"', '').trim();
  }

  Future<String?> getFullName() async {
    String? val;
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      val = prefs.getString(_keyFullName);
    } else {
      try {
        val = await _storage.read(key: _keyFullName);
        if (val != null && val.isNotEmpty) return val.replaceAll('"', '').trim();
      } catch (_) {}
      final prefs = await SharedPreferences.getInstance();
      val = prefs.getString(_keyFullName);
    }
    return val?.replaceAll('"', '').trim();
  }

  Future<String?> getUserName() => getFullName();

  Future<void> clearSession() async {
    if (!kIsWeb) {
      try {
        await _storage.deleteAll();
      } catch (_) {}
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
  }
}
