import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../../core/network/api_client.dart';
import '../../../core/services/storage_service.dart';
import '../../../core/utils/iraqi_phone_validator.dart';
import '../../customer/screens/customer_home_screen.dart';
import '../../driver/screens/driver_home_screen.dart';
import '../widgets/iraqi_phone_input_field.dart';

/// شاشة التحقق من رقم الهاتف العراقي وإرسال رمز التحقق OTP (زين وآسيا سيل فقط)
class PhoneOtpVerificationScreen extends StatefulWidget {
  final ApiClient apiClient;
  final StorageService storageService;
  final String role; // 'Customer' or 'Driver'

  const PhoneOtpVerificationScreen({
    super.key,
    required this.apiClient,
    required this.storageService,
    this.role = 'Customer',
  });

  @override
  State<PhoneOtpVerificationScreen> createState() => _PhoneOtpVerificationScreenState();
}

class _PhoneOtpVerificationScreenState extends State<PhoneOtpVerificationScreen> {
  final TextEditingController _phoneController = TextEditingController();
  final TextEditingController _otpController = TextEditingController();

  IraqiPhoneValidationResult _validationResult = const IraqiPhoneValidationResult(
    isValid: false,
    operator: IraqiTelecomOperator.unknown,
    normalizedLocalNumber: '',
    normalizedE164Number: '',
  );

  bool _isCodeSent = false;
  bool _isLoading = false;
  String? _serverErrorMessage;
  String? _serverSuccessMessage;
  String? _maskedPhone;

  @override
  void dispose() {
    _phoneController.dispose();
    _otpController.dispose();
    super.dispose();
  }

  /// 1. إرسال رمز التحقق OTP إلى شبكة زين أو آسيا سيل
  Future<void> _handleSendOtp() async {
    // Client-side verification guard
    if (!_validationResult.isValid) {
      setState(() {
        _serverErrorMessage = IraqiPhoneValidator.invalidPhoneErrorMessage;
      });
      return;
    }

    setState(() {
      _isLoading = true;
      _serverErrorMessage = null;
      _serverSuccessMessage = null;
    });

    try {
      final response = await widget.apiClient.dio.post(
        '/auth/send-otp',
        data: {
          'phoneNumber': _validationResult.normalizedLocalNumber,
          'e164Number': _validationResult.normalizedE164Number,
          'role': widget.role,
        },
      );

      if (response.statusCode == 200 || response.statusCode == 201) {
        final data = response.data;
        setState(() {
          _isCodeSent = true;
          _serverSuccessMessage = data['message'] ?? 'تم إرسال رمز التحقق بنجاح.';
          _maskedPhone = _validationResult.normalizedLocalNumber;
        });
      }
    } on DioException catch (e) {
      if (e.response?.statusCode == 422) {
        // Backend strictly rejected invalid provider / operator
        final errorMsg = e.response?.data?['error']?.toString() ??
            IraqiPhoneValidator.invalidPhoneErrorMessage;
        setState(() {
          _serverErrorMessage = errorMsg;
        });
      } else if (e.response?.statusCode == 403) {
        final errorMsg = e.response?.data?['error']?.toString() ??
            'تم حظر هذا الحساب من قبل إدارة المنصة.';
        setState(() {
          _serverErrorMessage = errorMsg;
        });
      } else {
        setState(() {
          _serverErrorMessage = 'تعذر إرسال رمز التحقق. يرجى التحقق من اتصال الإنترنت.';
        });
      }
    } catch (_) {
      setState(() {
        _serverErrorMessage = 'حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.';
      });
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  /// 2. تأكيد رمز التحقق وتسجيل الدخول
  Future<void> _handleVerifyOtp() async {
    final code = _otpController.text.trim();
    if (code.length < 4) {
      setState(() => _serverErrorMessage = 'يرجى إدخال رمز التحقق المكون من 4 إلى 6 أرقام');
      return;
    }

    setState(() {
      _isLoading = true;
      _serverErrorMessage = null;
    });

    try {
      final response = await widget.apiClient.dio.post(
        '/auth/verify-otp',
        data: {
          'phoneNumber': _validationResult.normalizedLocalNumber,
          'otp': code,
          'role': widget.role,
        },
      );

      final data = response.data;
      final role = data['role'] ?? widget.role;
      final userId = data['userId'] ?? 'usr-${DateTime.now().millisecondsSinceEpoch}';
      final fullName = data['fullName'] ?? 'مستخدم توصيله';
      final token = data['token'] ?? 'jwt_token_$userId';

      await widget.storageService.saveSession(
        token: token,
        userId: userId,
        role: role,
        fullName: fullName,
      );

      if (!mounted) return;

      if (role == 'Driver') {
        Navigator.pushAndRemoveUntil(
          context,
          MaterialPageRoute(
            builder: (_) => DriverHome(
              apiClient: widget.apiClient,
              storageService: widget.storageService,
            ),
          ),
          (r) => false,
        );
      } else {
        Navigator.pushAndRemoveUntil(
          context,
          MaterialPageRoute(
            builder: (_) => CustomerHome(
              apiClient: widget.apiClient,
              storageService: widget.storageService,
            ),
          ),
          (r) => false,
        );
      }
    } on DioException catch (e) {
      final errorMsg = e.response?.data?['error']?.toString() ??
          'رمز التحقق غير صحيح أو انتهت صلاحيته.';
      setState(() => _serverErrorMessage = errorMsg);
    } catch (_) {
      setState(() => _serverErrorMessage = 'فشل التحقق من الرمز.');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('التحقق عبر رقم الهاتف (زين / آسيا سيل)'),
        backgroundColor: const Color(0xFF0F172A),
        foregroundColor: Colors.white,
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Header Icon
                Center(
                  child: Container(
                    padding: const EdgeInsets.all(20),
                    decoration: BoxDecoration(
                      color: Colors.amber.shade50,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(Icons.phonelink_ring_rounded, size: 52, color: Color(0xFFD97706)),
                  ),
                ),
                const SizedBox(height: 18),

                const Text(
                  'تسجيل الدخول الذكي',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: Color(0xFF0F172A)),
                ),
                const SizedBox(height: 6),
                const Text(
                  'النظام يدعم حصرياً شبكتي زين العراق وآسيا سيل لحماية الحسابات',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, color: Colors.grey),
                ),
                const SizedBox(height: 28),

                // Error Message Display
                if (_serverErrorMessage != null) ...[
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.red.shade50,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: Colors.red.shade200),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.error_outline_rounded, color: Colors.red.shade700, size: 20),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _serverErrorMessage!,
                            style: TextStyle(color: Colors.red.shade800, fontSize: 13, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                ],

                // Success Message Display
                if (_serverSuccessMessage != null) ...[
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.green.shade50,
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: Colors.green.shade200),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.check_circle_outline_rounded, color: Colors.green, size: 20),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _serverSuccessMessage!,
                            style: const TextStyle(color: Colors.green, fontSize: 13, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                ],

                // Phone Input Field
                if (!_isCodeSent) ...[
                  IraqiPhoneInputField(
                    controller: _phoneController,
                    onValidationChanged: (res) {
                      setState(() {
                        _validationResult = res;
                        _serverErrorMessage = null;
                      });
                    },
                    onSubmitted: _handleSendOtp,
                  ),
                  const SizedBox(height: 24),

                  // Send Code Button (Disabled until valid Zain or Asiacell format entered)
                  ElevatedButton(
                    onPressed: (_validationResult.isValid && !_isLoading) ? _handleSendOtp : null,
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      backgroundColor: const Color(0xFF0F172A),
                      foregroundColor: Colors.white,
                      disabledBackgroundColor: Colors.grey.shade300,
                      disabledForegroundColor: Colors.grey.shade500,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                    child: _isLoading
                        ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.send_rounded, size: 18),
                              SizedBox(width: 8),
                              Text('إرسال رمز التحقق (OTP) 📱', style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
                            ],
                          ),
                  ),
                ] else ...[
                  // Step 2: OTP Entry Field
                  Text(
                    'تم إرسال رمز التحقق إلى الرقم $_maskedPhone',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                  ),
                  const SizedBox(height: 16),

                  TextField(
                    controller: _otpController,
                    keyboardType: TextInputType.number,
                    textAlign: TextAlign.center,
                    inputFormatters: [
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(6),
                    ],
                    style: const TextStyle(fontSize: 24, letterSpacing: 8, fontWeight: FontWeight.bold),
                    decoration: InputDecoration(
                      hintText: '• • • •',
                      hintStyle: const TextStyle(letterSpacing: 8),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                  ),
                  const SizedBox(height: 20),

                  ElevatedButton(
                    onPressed: _isLoading ? null : _handleVerifyOtp,
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      backgroundColor: Colors.amber.shade700,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                    child: _isLoading
                        ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Text('تأكيد الرمز وتسجيل الدخول ✅', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  ),
                  const SizedBox(height: 12),

                  TextButton(
                    onPressed: () {
                      setState(() {
                        _isCodeSent = false;
                        _otpController.clear();
                      });
                    },
                    child: const Text('تغيير رقم الهاتف'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
