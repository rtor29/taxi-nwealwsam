import 'dart:html' as html;
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/network/api_client.dart';
import '../../../core/services/storage_service.dart';
import '../../../core/utils/iraqi_phone_validator.dart';
import '../../../core/services/google_auth_service.dart';
import '../widgets/google_sign_in_button.dart';
import '../../customer/screens/customer_home_screen.dart';
import '../../customer/screens/route_search_screen.dart';
import '../../driver/screens/driver_home_screen.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  final ApiClient apiClient;
  final StorageService storageService;

  const LoginScreen({
    super.key,
    required this.apiClient,
    required this.storageService,
  });

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _identifierController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _obscurePassword = true;
  bool _isLoading = false;
  bool _isGoogleLoading = false;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkIncomingGoogleAuth();
    });
  }

  Future<void> _checkIncomingGoogleAuth() async {
    // 1. Check if session already active in storage
    final savedToken = await widget.storageService.getToken();
    if (savedToken != null && savedToken.isNotEmpty) {
      final role = await widget.storageService.getUserRole() ?? 'Customer';
      final userId = await widget.storageService.getUserId() ?? '';
      final fullName = await widget.storageService.getFullName() ?? 'مستخدم';
      if (mounted) {
        _navigateAfterLogin({
          'token': savedToken,
          'role': role,
          'userId': userId,
          'fullName': fullName,
        });
      }
      return;
    }

    // 2. On Web, check if Google OAuth redirect provided a login token in URL
    if (kIsWeb) {
      try {
        final query = Map<String, String>.from(Uri.base.queryParameters);
        if ((!query.containsKey('login_token') || query['login_token']!.isEmpty) && Uri.base.hasFragment) {
          final frag = Uri.base.fragment;
          if (frag.contains('login_token')) {
            final fragUri = Uri.parse(frag.startsWith('/') ? frag : '/$frag');
            query.addAll(fragUri.queryParameters);
          }
        }

        if (query.containsKey('login_token') && query['login_token']!.isNotEmpty) {
          final token = query['login_token']!;
          final userId = query['userId'] ?? 'usr-google';
          final role = query['role'] ?? 'Customer';
          final fullName = (query['fullName'] != null && query['fullName']!.isNotEmpty)
              ? query['fullName']!
              : 'مستخدم Google';

          await widget.storageService.saveSession(
            token: token,
            userId: userId,
            role: role,
            fullName: fullName,
          );

          if (mounted) {
            _navigateAfterLogin({
              'token': token,
              'role': role,
              'userId': userId,
              'fullName': fullName,
            });
          }
          return;
        }

        if (query.containsKey('error')) {
          final err = query['error']!;
          setState(() {
            _errorMessage = 'فشلت عملية المصادقة عبر Google ($err). يرجى المحاولة مرة أخرى.';
          });
        }

        if (query.containsKey('phone') && query['phone']!.isNotEmpty) {
          final phoneParam = query['phone']!;
          setState(() {
            _identifierController.text = phoneParam;
          });
          if (query['registered'] == 'true' && mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text(
                  'تم إنشاء حسابك بنجاح! 🚖 أدخل كلمة المرور لتسجيل الدخول مباشرة.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                backgroundColor: Color(0xFF10B981),
                duration: Duration(seconds: 4),
              ),
            );
          }
        }
      } catch (_) {}
    }

    // 3. Fallback for direct token callback in fragment/query
    final authService = GoogleAuthService(
      apiClient: widget.apiClient,
      storageService: widget.storageService,
    );
    final tokens = authService.extractTokensFromCurrentUrl();
    if (tokens.isNotEmpty && (tokens.containsKey('id_token') || tokens.containsKey('access_token'))) {
      setState(() => _isGoogleLoading = true);
      final res = await authService.authenticateWithBackend(
        idToken: tokens['id_token'],
        accessToken: tokens['access_token'],
      );
      if (mounted) {
        setState(() => _isGoogleLoading = false);
        if (res.success && res.userData != null) {
          _navigateAfterLogin(res.userData!);
        } else if (res.errorMessage != null) {
          setState(() => _errorMessage = res.errorMessage);
        }
      }
    }
  }

  Future<void> _handleGoogleSignIn() async {
    setState(() {
      _isGoogleLoading = true;
      _errorMessage = null;
    });

    final authService = GoogleAuthService(
      apiClient: widget.apiClient,
      storageService: widget.storageService,
    );

    try {
      await authService.launchGoogleSignInFlow();
    } catch (e) {
      setState(() {
        _errorMessage = 'تعذر فتح نافذة تسجيل الدخول بحساب Google: $e';
        _isGoogleLoading = false;
      });
    }
  }

  void _navigateAfterLogin(Map<String, dynamic> data) {
    final role = data['role'] ?? 'Customer';
    final userId = data['userId']?.toString() ?? '';
    if (!mounted) return;
    if (role == 'Driver') {
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => DriverHome(
            apiClient: widget.apiClient,
            storageService: widget.storageService,
          ),
        ),
      );
    } else {
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => RouteSearchScreen(
            apiClient: widget.apiClient,
            customerId: userId,
            storageService: widget.storageService,
          ),
        ),
      );
    }
  }

  Future<void> _handleLogin() async {
    final rawIdentifier = _identifierController.text.trim();
    final password = _passwordController.text.trim();
    if (rawIdentifier.isEmpty) {
      setState(() => _errorMessage = 'يرجى إدخال رقم الهاتف للمتابعة');
      return;
    }
    if (password.isEmpty) {
      setState(() => _errorMessage = 'يرجى إدخال كلمة المرور (الباسوورد) للمتابعة');
      return;
    }

    String identifier = rawIdentifier;
    const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    for (int i = 0; i < arabicDigits.length; i++) {
      identifier = identifier.replaceAll(arabicDigits[i], i.toString());
    }
    if (!identifier.contains('@')) {
      identifier = identifier.replaceAll(RegExp(r'[^0-9]'), '');
      if (identifier.startsWith('00964')) identifier = identifier.substring(5);
      if (identifier.startsWith('964')) identifier = identifier.substring(3);
      if (identifier.length == 10 && identifier.startsWith('7')) identifier = '0$identifier';
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final response = await widget.apiClient.dio.post(
        '/auth/login',
        data: {
          'identifier': identifier,
          'password': password,
          'phoneNumber': !identifier.contains('@') ? identifier : null,
          'email': identifier.contains('@') ? identifier : null,
        },
      );

      final data = response.data;
      final role = data['role'] ?? 'Customer';
      final userId = data['userId'] ?? 'usr-local';
      final fullName = data['fullName'] ?? 'مستخدم';
      final token = data['token'] ?? 'jwt_session_$userId';

      await widget.storageService.saveSession(
        token: token,
        userId: userId,
        role: role,
        fullName: fullName,
      );

      if (!mounted) return;

      if (role == 'Driver') {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(
            builder: (_) => DriverHome(
              apiClient: widget.apiClient,
              storageService: widget.storageService,
            ),
          ),
        );
      } else {
        Navigator.pushReplacement(
          context,
          MaterialPageRoute(
            builder: (_) => RouteSearchScreen(
              apiClient: widget.apiClient,
              customerId: userId,
              storageService: widget.storageService,
            ),
          ),
        );
      }
    } catch (e) {
      if (e is DioException && e.response?.statusCode == 403) {
        final errMessage = e.response?.data?['error']?.toString() ??
            'تم حظر هذا الحساب من قبل إدارة منصة توصيله.';
        if (mounted) {
          showDialog(
            context: context,
            barrierDismissible: false,
            builder: (ctx) => AlertDialog(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              title: const Row(
                children: [
                  Icon(Icons.block_rounded, color: Colors.red, size: 28),
                  SizedBox(width: 8),
                  Text('الحساب محظور', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                ],
              ),
              content: Text(
                errMessage,
                style: const TextStyle(fontSize: 14, height: 1.5),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('حسناً', style: TextStyle(fontWeight: FontWeight.bold)),
                ),
              ],
            ),
          );
        }
        return;
      }

      if (e is DioException && (e.response?.statusCode == 404 || e.response?.data?['notFound'] == true)) {
        if (mounted) {
          showDialog(
            context: context,
            builder: (ctx) => AlertDialog(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              title: const Row(
                children: [
                  Icon(Icons.person_add_alt_1_rounded, color: Color(0xFFF59E0B), size: 28),
                  SizedBox(width: 8),
                  Text('الحساب غير مسجل', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                ],
              ),
              content: Text(
                'رقم الهاتف ($identifier) غير مسجل في المنصة حتى الآن.\n\nهل ترغب في الانتقال إلى صفحة التسجيل والتوثيق؟',
                style: const TextStyle(fontSize: 14, height: 1.5),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('إلغاء'),
                ),
                ElevatedButton(
                  onPressed: () {
                    Navigator.pop(ctx);
                    const url = '/register';
                    try {
                      if (kIsWeb) {
                        html.window.location.href = url;
                        return;
                      }
                    } catch (_) {}
                    launchUrl(Uri.parse(url), mode: LaunchMode.platformDefault);
                  },
                  child: const Text('تسجيل حساب جديد'),
                ),
              ],
            ),
          );
        }
        return;
      }

      String userMsg = 'رقم الهاتف أو كلمة المرور غير صحيحة. يرجى التأكد والمحاولة مرة أخرى.';
      if (e is DioException && e.response?.data is Map && e.response?.data['error'] != null) {
        userMsg = e.response?.data['error'].toString() ?? userMsg;
      }

      if (mounted) {
        setState(() {
          _errorMessage = userMsg;
        });
      }
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (kIsWeb) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        try {
          html.window.location.replace('/');
        } catch (_) {}
      });
      return const Scaffold(
        backgroundColor: Color(0xFF0F172A),
        body: Center(
          child: CircularProgressIndicator(color: Color(0xFFF59E0B)),
        ),
      );
    }

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24.0),
            child: AutofillGroup(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Center(
                    child: CircleAvatar(
                      radius: 44,
                      backgroundColor: Color(0xFFF59E0B),
                      child: Text('🚖', style: TextStyle(fontSize: 42)),
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'توصيله',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 28,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF0F172A),
                    ),
                  ),
                  const Text(
                    'منصة النقل والمطابقة الذكية',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 14, color: Colors.grey),
                  ),
                  const SizedBox(height: 32),

                  if (_errorMessage != null) ...[
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.red.shade50,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: Colors.red.shade200),
                      ),
                      child: Text(
                        _errorMessage!,
                        style: TextStyle(color: Colors.red.shade800, fontSize: 13),
                        textAlign: TextAlign.center,
                      ),
                    ),
                    const SizedBox(height: 16),
                  ],

                  TextField(
                    controller: _identifierController,
                    keyboardType: TextInputType.phone,
                    autofillHints: const [
                      AutofillHints.telephoneNumber,
                    ],
                    textInputAction: TextInputAction.next,
                    decoration: InputDecoration(
                      labelText: 'رقم الهاتف',
                      hintText: '07701234567',
                      prefixIcon: const Icon(Icons.phone_android_rounded),
                      suffixIcon: _identifierController.text.isNotEmpty
                          ? IconButton(
                              icon: const Icon(Icons.clear, size: 20),
                              onPressed: () {
                                setState(() {
                                  _identifierController.clear();
                                });
                              },
                            )
                          : null,
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 16),

                  // Password TextField
                  TextField(
                    controller: _passwordController,
                    obscureText: _obscurePassword,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _handleLogin(),
                    decoration: InputDecoration(
                      labelText: 'كلمة المرور (الباسوورد)',
                      hintText: '••••••••',
                      prefixIcon: const Icon(Icons.lock_outline_rounded),
                      suffixIcon: IconButton(
                        icon: Icon(
                          _obscurePassword ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                          size: 20,
                        ),
                        onPressed: () {
                          setState(() {
                            _obscurePassword = !_obscurePassword;
                          });
                        },
                      ),
                    ),
                  ),
                  
                  // Forgot Password Link -> WhatsApp 07706204066
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: () {
                        const whatsappUrl = 'https://wa.me/9647706204066?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7%D9%8B%D8%8C%20%D8%A3%D9%88%D8%AF%20%D8%A7%D8%B3%D8%AA%D8%B9%D8%A7%D8%AF%D8%A9%20%D9%83%D9%84%D9%85%D8%A9%20%D8%A7%D9%84%D9%85%D8%B1%D9%88%D8%B1%20%D9%84%D8%AD%D8%B3%D8%A7%D8%A8%D9%8A%20%D9%81%D9%8A%20%D8%AA%D8%B7%D8%A8%D9%8A%D9%82%20%D8%AA%D9%88%D8%B5%D9%8A%D9%84%D8%A9.';
                        try {
                          if (kIsWeb) {
                            html.window.open(whatsappUrl, '_blank');
                            return;
                          }
                        } catch (_) {}
                        launchUrl(Uri.parse(whatsappUrl), mode: LaunchMode.externalApplication);
                      },
                      icon: const Icon(Icons.support_agent_rounded, size: 16, color: Color(0xFF2563EB)),
                      label: const Text(
                        'نسيت كلمة المرور؟',
                        style: TextStyle(
                          color: Color(0xFF2563EB),
                          fontSize: 13,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),

                  // Login Button with smooth interaction
                  ElevatedButton(
                    onPressed: _isLoading ? null : _handleLogin,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF2563EB),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      elevation: 2,
                    ),
                    child: _isLoading
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : const Text('تسجيل الدخول', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  ),
                  const SizedBox(height: 14),

                  // Unified Dark Portal Button (Passenger Registration + Captain Onboarding)
                  OutlinedButton.icon(
                    onPressed: () {
                      const url = '/register';
                      try {
                        if (kIsWeb) {
                          html.window.location.href = url;
                          return;
                        }
                      } catch (_) {}
                      launchUrl(Uri.parse(url), mode: LaunchMode.platformDefault);
                    },
                    icon: const Icon(Icons.app_registration_rounded, color: Color(0xFF2563EB)),
                    label: const Text(
                      'ليس لديك حساب؟ تسجيل راكب جديد أو انضمام كابتن 📝',
                      style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Color(0xFF2563EB)),
                    ),
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      side: const BorderSide(color: Color(0xFF2563EB), width: 1.5),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Divider OR
                  Row(
                    children: [
                      Expanded(child: Divider(color: Colors.grey.shade300, thickness: 1)),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: Text('أو المتابعة السريعة عبر', style: TextStyle(color: Colors.grey.shade500, fontSize: 13)),
                      ),
                      Expanded(child: Divider(color: Colors.grey.shade300, thickness: 1)),
                    ],
                  ),
                  const SizedBox(height: 16),

                  // Google Sign-In Official Button
                  GoogleSignInButton(
                    isLoading: _isGoogleLoading,
                    onPressed: _handleGoogleSignIn,
                    text: 'المتابعة باستخدام حساب Google',
                  ),
                  const SizedBox(height: 12),


                  // Captain Login at the very bottom of the page
                  const SizedBox(height: 24),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFFFBEB),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: const Color(0xFFFDE68A)),
                    ),
                    child: Column(
                      children: [
                        const Text(
                          'هل أنت كابتن (سائق) مسجل في المنصة؟',
                          style: TextStyle(fontSize: 12, color: Color(0xFF92400E), fontWeight: FontWeight.bold),
                        ),
                        const SizedBox(height: 8),
                        ElevatedButton.icon(
                          onPressed: () {
                            const url = '/captain-login';
                            try {
                              if (kIsWeb) {
                                html.window.location.href = url;
                                return;
                              }
                            } catch (_) {}
                            launchUrl(Uri.parse(url), mode: LaunchMode.platformDefault);
                          },
                          icon: const Icon(Icons.local_taxi_rounded, color: Color(0xFF0F172A), size: 20),
                          label: const Text(
                            'تسجيل الدخول للكباتن 🚖',
                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: Color(0xFF0F172A)),
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFFF59E0B),
                            foregroundColor: const Color(0xFF0F172A),
                            elevation: 0,
                            minimumSize: const Size.fromHeight(46),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          ),
                        ),
                      ],
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
