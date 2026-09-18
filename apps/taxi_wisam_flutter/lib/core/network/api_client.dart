import 'package:dio/dio.dart';
import '../../app_config.dart';
import '../services/storage_service.dart';

class ApiClient {
  late final Dio dio;
  final StorageService _storageService;

  ApiClient(this._storageService) {
    dio = Dio(
      BaseOptions(
        baseUrl: AppConfig.apiBaseUrl,
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 15),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      ),
    );

    // Request Interceptor: Automatically injects JWT Bearer Token
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await _storageService.getToken();
          if (token != null && token.isNotEmpty) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          return handler.next(options);
        },
        onError: (DioException error, handler) {
          // Centralized error handling
          return handler.next(error);
        },
      ),
    );
  }

  // File Upload Helper (Used for Driver Documents -> Private Supabase Bucket)
  Future<Response> uploadFile({
    required String path,
    required FormData formData,
    ProgressCallback? onSendProgress,
  }) async {
    return await dio.post(
      path,
      data: formData,
      options: Options(contentType: 'multipart/form-data'),
      onSendProgress: onSendProgress,
    );
  }
}
