import 'dart:html' as html;
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../../core/services/storage_service.dart';
import '../../../core/utils/iraqi_phone_validator.dart';

class RegisterScreen extends StatefulWidget {
  final ApiClient apiClient;
  final StorageService storageService;
  final String? initialEmail;

  const RegisterScreen({
    super.key,
    required this.apiClient,
    required this.storageService,
    this.initialEmail,
  });

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _phoneController = TextEditingController();
  final _routeController = TextEditingController();
  final _addressController = TextEditingController();
  final _passwordController = TextEditingController();

  bool _obscurePassword = true;
  bool _isLoading = false;
  String? _errorMessage;

  @override
  void dispose() {
    _nameController.dispose();
    _phoneController.dispose();
    _routeController.dispose();
    _addressController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  String _normalizePhone(String phone) {
    const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    String p = phone;
    for (int i = 0; i < arabicDigits.length; i++) {
      p = p.replaceAll(arabicDigits[i], i.toString());
    }
    String digits = p.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.startsWith('00964')) digits = digits.substring(5);
    if (digits.startsWith('964')) digits = digits.substring(3);
    if (digits.length == 10 && digits.startsWith('7')) digits = '0$digits';
    return digits;
  }

  Future<void> _handleRegister() async {
    setState(() => _errorMessage = null);

    final name = _nameController.text.trim();
    final phone = _phoneController.text.trim();
    final route = _routeController.text.trim();
    final address = _addressController.text.trim();
    final password = _passwordController.text.trim();

    if (name.isEmpty) {
      setState(() => _errorMessage = 'يرجى إدخال الاسم الكامل.');
      return;
    }

    final normPhone = _normalizePhone(phone);
    final phoneRes = IraqiPhoneValidator.validate(normPhone);
    if (!phoneRes.isValid) {
      setState(() => _errorMessage = phoneRes.errorMessage ?? 'يرجى إدخال رقم هاتف عراقي صالح يبدأ بـ 07.');
      return;
    }

    if (route.isEmpty) {
      setState(() => _errorMessage = 'يرجى إدخال المسار المطلوب (خط السير).');
      return;
    }

    if (address.isEmpty) {
      setState(() => _errorMessage = 'يرجى إدخال العنوان بالتفصيل.');
      return;
    }

    if (password.length < 4) {
      setState(() => _errorMessage = 'يجب أن لا تقل كلمة المرور عن 4 خانات.');
      return;
    }

    setState(() => _isLoading = true);

    try {
      final response = await widget.apiClient.dio.post(
        '/auth/complete-passenger-registration',
        data: {
          'fullName': name,
          'phoneNumber': normPhone,
          'route': route,
          'address': address,
          'password': password,
        },
      );

      final data = response.data;
      if (data['success'] == true) {
        if (!mounted) return;

        // Auto-redirect to Login Screen with phone pre-filled
        if (kIsWeb) {
          try {
            html.window.history.pushState(null, '', '/?phone=${Uri.encodeComponent(normPhone)}&registered=true');
          } catch (_) {}
        }

        Navigator.pop(context, {
          'phone': normPhone,
          'registered': true,
        });
      } else {
        setState(() {
          _errorMessage = data['error'] ?? 'فشل في تسجيل الحساب.';
        });
      }
    } catch (e) {
      String errMsg = 'هذا الرقم مسجل بالفعل';
      if (e is DioException && e.response?.data != null) {
        final d = e.response!.data;
        if (d is Map && d.containsKey('error')) {
          errMsg = d['error'].toString();
        }
      }
      setState(() => _errorMessage = errMsg);
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        title: const Text(
          'تسجيل راكب جديد',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18, color: Color(0xFF0F172A)),
        ),
        centerTitle: true,
        backgroundColor: Colors.white,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, color: Color(0xFF0F172A)),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 16.0),
            child: Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Center(
                    child: CircleAvatar(
                      radius: 36,
                      backgroundColor: Color(0xFFEFF6FF),
                      child: Text('📝', style: TextStyle(fontSize: 34)),
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'إنشاء حساب راكب جديد',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF0F172A),
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'أدخل بياناتك وسيتم توجيهك فوراً لتسجيل الدخول بكلمة المرور',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13, color: Colors.grey),
                  ),
                  const SizedBox(height: 24),

                  if (_errorMessage != null) ...[
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 300),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.red.shade50,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: Colors.red.shade200),
                      ),
                      child: Row(
                        children: [
                          Icon(Icons.error_outline_rounded, color: Colors.red.shade700, size: 20),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              _errorMessage!,
                              style: TextStyle(
                                color: Colors.red.shade800,
                                fontSize: 13,
                                fontWeight: FontWeight.bold,
                              ),
                              textAlign: TextAlign.right,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],

                  // 1. الاسم الكامل
                  TextField(
                    controller: _nameController,
                    textInputAction: TextInputAction.next,
                    decoration: InputDecoration(
                      labelText: 'الاسم الكامل *',
                      hintText: 'مثال: علي حسن النجفي',
                      prefixIcon: const Icon(Icons.person_outline_rounded),
                      filled: true,
                      fillColor: const Color(0xFFF8FAFC),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFF2563EB), width: 2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),

                  // 2. رقم الهاتف
                  TextField(
                    controller: _phoneController,
                    keyboardType: TextInputType.phone,
                    textDirection: TextDirection.ltr,
                    textInputAction: TextInputAction.next,
                    decoration: InputDecoration(
                      labelText: 'رقم الهاتف العراقي *',
                      hintText: '07701234567',
                      prefixIcon: const Icon(Icons.phone_android_rounded),
                      filled: true,
                      fillColor: const Color(0xFFF8FAFC),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFF2563EB), width: 2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),

                  // 3. المسار
                  TextField(
                    controller: _routeController,
                    textInputAction: TextInputAction.next,
                    decoration: InputDecoration(
                      labelText: 'المسار (خط السير المطلوب) *',
                      hintText: 'مثال: حي الجامعة - جامعة الكوفة',
                      prefixIcon: const Icon(Icons.route_rounded),
                      filled: true,
                      fillColor: const Color(0xFFF8FAFC),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFF2563EB), width: 2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),

                  // 4. العنوان
                  TextField(
                    controller: _addressController,
                    textInputAction: TextInputAction.next,
                    decoration: InputDecoration(
                      labelText: 'العنوان بالتفصيل *',
                      hintText: 'مثال: النجف - حي الأمير - قرب المسجد',
                      prefixIcon: const Icon(Icons.location_on_outlined),
                      filled: true,
                      fillColor: const Color(0xFFF8FAFC),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFF2563EB), width: 2),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),

                  // 5. كلمة المرور
                  TextField(
                    controller: _passwordController,
                    obscureText: _obscurePassword,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _handleRegister(),
                    decoration: InputDecoration(
                      labelText: 'كلمة المرور (الباسوورد للحساب) *',
                      hintText: '••••••••',
                      prefixIcon: const Icon(Icons.lock_outline_rounded),
                      filled: true,
                      fillColor: const Color(0xFFF8FAFC),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.grey.shade300),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: Color(0xFF2563EB), width: 2),
                      ),
                      suffixIcon: IconButton(
                        icon: Icon(
                          _obscurePassword ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                          size: 20,
                        ),
                        onPressed: () {
                          setState(() => _obscurePassword = !_obscurePassword);
                        },
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),

                  // Submit Button
                  ElevatedButton(
                    onPressed: _isLoading ? null : _handleRegister,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF2563EB),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 15),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                      elevation: 2,
                    ),
                    child: _isLoading
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : const Text(
                            'إكمال التسجيل والمتابعة 🚀',
                            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                          ),
                  ),
                  const SizedBox(height: 14),

                  // Back to Login link
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text(
                      'لديك حساب بالفعل؟ تسجيل الدخول',
                      style: TextStyle(
                        color: Color(0xFF64748B),
                        fontWeight: FontWeight.bold,
                        fontSize: 13,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
