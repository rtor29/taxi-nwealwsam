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
    try {
      return await _storage.read(key: _keyToken);
    } catch (_) {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_keyToken);
    }
  }

  Future<String?> getUserId() async {
    try {
      return await _storage.read(key: _keyUserId);
    } catch (_) {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_keyUserId);
    }
  }

  Future<String?> getUserRole() async {
    try {
      return await _storage.read(key: _keyUserRole);
    } catch (_) {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_keyUserRole);
    }
  }

  Future<String?> getFullName() async {
    try {
      return await _storage.read(key: _keyFullName);
    } catch (_) {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_keyFullName);
    }
  }

  Future<void> clearSession() async {
    try {
      await _storage.deleteAll();
    } catch (_) {}
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
  }
}
