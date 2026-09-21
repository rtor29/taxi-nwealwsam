import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../features/ads/screens/vacancy_ads_screen.dart';
import '../../features/driver/screens/document_upload_screen.dart';
import '../../features/driver/screens/driver_requests_screen.dart';
import '../../features/support/screens/contact_support_screen.dart';
import '../network/api_client.dart';
import '../services/storage_service.dart';
import '../theme/app_theme.dart';
import 'tawseela_logo.dart';

/// القائمة الجانبية المخصصة لتطبيقي السائق والزبون (Custom Side Drawer)
class CustomSideDrawer extends StatefulWidget {
  final ApiClient apiClient;
  final StorageService storageService;
  final String currentRoute;

  const CustomSideDrawer({
    super.key,
    required this.apiClient,
    required this.storageService,
    required this.currentRoute,
  });

  @override
  State<CustomSideDrawer> createState() => _CustomSideDrawerState();
}

class _CustomSideDrawerState extends State<CustomSideDrawer> {
  String _fullName = 'مستخدم توصيله';
  String _phoneNumber = '07800000000';
  String _role = 'Customer';
  String? _avatarPath;
  final ImagePicker _picker = ImagePicker();

  @override
  void initState() {
    super.initState();
    _loadUserData();
  }

  Future<void> _loadUserData() async {
    final name = await widget.storageService.getUserName();
    final role = await widget.storageService.getUserRole();
    final prefs = await SharedPreferences.getInstance();
    final phone = prefs.getString('user_phone') ?? '07801234567';
    final savedAvatar = prefs.getString('user_avatar_path');

    if (mounted) {
      setState(() {
        if (name != null && name.isNotEmpty) _fullName = name;
        if (role != null && role.isNotEmpty) _role = role;
        _phoneNumber = phone;
        _avatarPath = savedAvatar;
      });
    }
  }

  /// اختيار صورة شخصية جديدة من الاستوديو أو الكاميرا
  Future<void> _pickAvatar(ImageSource source) async {
    try {
      final picked = await _picker.pickImage(
        source: source,
        maxWidth: 600,
        maxHeight: 600,
        imageQuality: 85,
      );

      if (picked != null) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('user_avatar_path', picked.path);

        setState(() {
          _avatarPath = picked.path;
        });

        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('تم تحديث الصورة الشخصية بنجاح! ✅'),
            backgroundColor: Colors.green,
            duration: Duration(seconds: 2),
          ),
        );
      }
    } catch (e) {
      debugPrint('Error picking avatar: $e');
    }
  }

  void _showImageSourceDialog() {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: Colors.grey[300],
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'تغيير الصورة الشخصية',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 20),
              ListTile(
                leading: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Colors.amber[50],
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.photo_library_rounded, color: Colors.amber),
                ),
                title: const Text('اختيار من الاستوديو (المعرض)', style: TextStyle(fontWeight: FontWeight.w600)),
                onTap: () {
                  Navigator.pop(ctx);
                  _pickAvatar(ImageSource.gallery);
                },
              ),
              ListTile(
                leading: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: const BoxDecoration(
                    color: Color(0xFFECFDF5),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.camera_alt_rounded, color: Color(0xFF10B981)),
                ),
                title: const Text('التقاط صورة بالكاميرا', style: TextStyle(fontWeight: FontWeight.w600)),
                onTap: () {
                  Navigator.pop(ctx);
                  _pickAvatar(ImageSource.camera);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final isDriver = _role.toLowerCase() == 'driver';

    return Drawer(
      child: Container(
        color: Colors.white,
        child: Column(
          children: [
            // 1. بروفايل المستخدم باستخدام UserAccountsDrawerHeader
            UserAccountsDrawerHeader(
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [Color(0xFF0F172A), Color(0xFF1E293B)],
                  begin: Alignment.topRight,
                  end: Alignment.bottomLeft,
                ),
              ),
              currentAccountPicture: Stack(
                children: [
                  GestureDetector(
                    onTap: _showImageSourceDialog,
                    child: CircleAvatar(
                      radius: 36,
                      backgroundColor: Colors.amber,
                      backgroundImage: _avatarPath != null
                          ? FileImage(File(_avatarPath!))
                          : null,
                      child: _avatarPath == null
                          ? Text(
                              _fullName.isNotEmpty ? _fullName[0] : 'ت',
                              style: const TextStyle(
                                fontSize: 26,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF0F172A),
                              ),
                            )
                          : null,
                    ),
                  ),
                  Positioned(
                    bottom: 0,
                    right: 0,
                    child: GestureDetector(
                      onTap: _showImageSourceDialog,
                      child: Container(
                        padding: const EdgeInsets.all(4),
                        decoration: BoxDecoration(
                          color: Colors.amber,
                          shape: BoxShape.circle,
                          border: Border.all(color: const Color(0xFF0F172A), width: 2),
                        ),
                        child: const Icon(
                          Icons.camera_alt,
                          size: 14,
                          color: Color(0xFF0F172A),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              accountName: Row(
                children: [
                  Text(
                    _fullName,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: isDriver ? Colors.amber : const Color(0xFF10B981),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      isDriver ? 'كابتن توصيله' : 'زبون',
                      style: const TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                  ),
                ],
              ),
              accountEmail: Text(
                _phoneNumber,
                style: const TextStyle(
                  fontSize: 13,
                  color: Colors.white70,
                ),
              ),
            ),

            // 2. بنود القائمة
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 8),
                children: [
                  _buildDrawerItem(
                    icon: Icons.home_rounded,
                    title: 'الرئيسية (الخريطة)',
                    isActive: widget.currentRoute == 'home',
                    onTap: () => Navigator.pop(context),
                  ),
                  _buildDrawerItem(
                    icon: Icons.campaign_rounded,
                    title: 'إعلانات الرحلات الشاغرة',
                    badge: 'جديد',
                    isActive: widget.currentRoute == 'ads',
                    onTap: () {
                      Navigator.pop(context);
                      Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (context) => VacancyAdsScreen(
                            apiClient: widget.apiClient,
                            isDriver: isDriver,
                          ),
                        ),
                      );
                    },
                  ),
                  if (isDriver) ...[
                    _buildDrawerItem(
                      icon: Icons.notifications_active_rounded,
                      title: 'طلبات الحجز الواردة',
                      badge: 'فوري',
                      badgeColor: Colors.amber,
                      isActive: widget.currentRoute == 'requests',
                      onTap: () {
                        Navigator.pop(context);
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (context) => DriverRequestsScreen(
                              apiClient: widget.apiClient,
                            ),
                          ),
                        );
                      },
                    ),
                    _buildDrawerItem(
                      icon: Icons.verified_user_rounded,
                      title: 'رفع المستمسكات والوثائق',
                      isActive: widget.currentRoute == 'documents',
                      onTap: () async {
                        Navigator.pop(context);
                        final userId = await widget.storageService.getUserId() ?? 'usr-driver';
                        if (!context.mounted) return;
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (context) => DocumentUploadScreen(
                              apiClient: widget.apiClient,
                              driverId: userId,
                            ),
                          ),
                        );
                      },
                    ),
                  ],
                  _buildDrawerItem(
                    icon: Icons.support_agent_rounded,
                    title: 'الدعم الفني والشكاوى',
                    isActive: widget.currentRoute == 'support',
                    onTap: () {
                      Navigator.pop(context);
                      Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (context) => ContactSupportScreen(
                            apiClient: widget.apiClient,
                            storageService: widget.storageService,
                          ),
                        ),
                      );
                    },
                  ),
                  const Divider(height: 24),
                  _buildDrawerItem(
                    icon: Icons.info_outline_rounded,
                    title: 'حول تطبيق توصيله',
                    onTap: () {
                      Navigator.pop(context);
                      showAboutDialog(
                        context: context,
                        applicationName: 'توصيله - النجف الأشرف',
                        applicationVersion: '1.0.0 (Release)',
                        applicationIcon: const TawseelaLogo(size: 48, showText: false),
                        children: const [
                          Text('تطبيق النقل الذكي الأول المخصص لمحافظة النجف الأشرف.'),
                        ],
                      );
                    },
                  ),
                  _buildDrawerItem(
                    icon: Icons.logout_rounded,
                    title: 'تسجيل الخروج',
                    color: Colors.redAccent,
                    onTap: () async {
                      await widget.storageService.clearSession();
                      if (!context.mounted) return;
                      Navigator.pushNamedAndRemoveUntil(context, '/', (route) => false);
                    },
                  ),
                ],
              ),
            ),

            // Footer
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.bolt, color: Colors.amber, size: 16),
                  const SizedBox(width: 4),
                  Text(
                    'توصيله v1.0 • النجف الأشرف',
                    style: TextStyle(fontSize: 11, color: Colors.grey[500]),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDrawerItem({
    required IconData icon,
    required String title,
    required VoidCallback onTap,
    bool isActive = false,
    String? badge,
    Color? badgeColor,
    Color? color,
  }) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      decoration: BoxDecoration(
        color: isActive ? Colors.amber.withOpacity(0.12) : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
      ),
      child: ListTile(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        leading: Icon(
          icon,
          color: isActive ? Colors.amber[800] : (color ?? const Color(0xFF334155)),
          size: 22,
        ),
        title: Text(
          title,
          style: TextStyle(
            fontSize: 14,
            fontWeight: isActive ? FontWeight.bold : FontWeight.w600,
            color: isActive ? Colors.amber[900] : (color ?? const Color(0xFF0F172A)),
          ),
        ),
        trailing: badge != null
            ? Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: badgeColor ?? const Color(0xFF10B981),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  badge,
                  style: const TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              )
            : null,
        onTap: onTap,
      ),
    );
  }
}

extension on Colors {
  static get slate => _SlateColors();
}

class _SlateColors {
  Color get shade700 => const Color(0xFF334155);
}
