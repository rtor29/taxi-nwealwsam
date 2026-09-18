import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';
import '../../../core/services/signalr_service.dart';
import '../../../core/services/storage_service.dart';
import '../../auth/screens/login_screen.dart';
import 'create_route_screen.dart';
import 'document_upload_screen.dart';

class DriverHome extends StatefulWidget {
  final ApiClient apiClient;
  final StorageService storageService;

  const DriverHome({
    super.key,
    required this.apiClient,
    required this.storageService,
  });

  @override
  State<DriverHome> createState() => _DriverHomeState();
}

class _DriverHomeState extends State<DriverHome> {
  late final SignalRService _signalRService;
  bool _isOnline = false;
  bool _isVerified = false;
  String _driverName = '';
  String? _driverId;

  @override
  void initState() {
    super.initState();
    _signalRService = SignalRService(widget.storageService);
    _initDriver();
  }

  Future<void> _initDriver() async {
    _driverId = await widget.storageService.getUserId();
    _driverName = await widget.storageService.getFullName() ?? 'كابتن';

    await _signalRService.initConnection();
    await _loadProfile();
  }

  Future<void> _loadProfile() async {
    if (_driverId == null) return;
    try {
      final res = await widget.apiClient.dio.get('${ApiEndpoints.profile}?userId=$_driverId');
      if (mounted) {
        setState(() {
          _isVerified = res.data['isDriverVerified'] ?? false;
        });
      }
    } catch (_) {}
  }

  Future<void> _toggleOnlineStatus(bool value) async {
    if (_driverId == null) return;
    if (!_isVerified && value) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('يجب توثيق مستمسكاتك أولاً قبل بدء استقبال الركاب'),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }

    setState(() => _isOnline = value);

    try {
      await widget.apiClient.dio.post(
        '${ApiEndpoints.updateDriverStatus}/$_driverId/status',
        data: {'status': value ? 'Online' : 'Offline'},
      );

      // Broadcast initial location over SignalR if online
      if (value) {
        // Najaf coordinates baseline
        await _signalRService.broadcastLocation(31.9961, 44.3168, 0.0);
      }
    } catch (e) {
      setState(() => _isOnline = !value);
    }
  }

  @override
  void dispose() {
    _signalRService.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('بوابة السائق | $_driverName'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await widget.storageService.clearSession();
              if (!context.mounted) return;
              Navigator.pushReplacement(
                context,
                MaterialPageRoute(
                  builder: (_) => LoginScreen(
                    apiClient: widget.apiClient,
                    storageService: widget.storageService,
                  ),
                ),
              );
            },
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Status Card
            Card(
              elevation: 3,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
              color: Colors.white,
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _isOnline ? '🟢 أنت متصل وجاهز للرحلات' : '⚪ أنت غير متصل حالياً',
                          style: TextStyle(
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                            color: _isOnline ? Colors.green.shade700 : Colors.blueGrey.shade700,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          _isVerified ? 'حساب موثق بالكامل ✅' : 'بانتظار مراجعة الوثائق ⚠️',
                          style: TextStyle(
                            fontSize: 12,
                            color: _isVerified ? Colors.green : Colors.orange.shade800,
                          ),
                        ),
                      ],
                    ),
                    Switch(
                      value: _isOnline,
                      onChanged: _toggleOnlineStatus,
                      activeColor: const Color(0xFFF59E0B),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 20),

            // Driver Document Verification Banner
            if (!_isVerified) ...[
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.amber.shade50,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: Colors.amber.shade300),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '🪪 توثيق الحساب والمستمسكات',
                      style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'يرجى رفع الهوية ورخصة القيادة وسنوية السيارة للبدء بالعمل. الوثائق محمية ومخزنة بأمان في Supabase Private Buckets.',
                      style: TextStyle(fontSize: 12, color: Colors.black87),
                    ),
                    const SizedBox(height: 12),
                    ElevatedButton.icon(
                      onPressed: () {
                        if (_driverId == null) return;
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => DocumentUploadScreen(
                              apiClient: widget.apiClient,
                              driverId: _driverId!,
                            ),
                          ),
                        ).then((_) => _loadProfile());
                      },
                      icon: const Icon(Icons.upload_file),
                      label: const Text('رفع المستمسكات الآن'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF0F172A),
                        foregroundColor: Colors.white,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
            ],

            // Actions Grid
            const Text(
              'الخدمات والإدارة:',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const SizedBox(height: 12),

            Row(
              children: [
                Expanded(
                  child: _ActionTile(
                    icon: Icons.add_road,
                    title: 'إنشاء خط نقل',
                    subtitle: 'تحديد مسار دوري ومقاعد',
                    onTap: () {
                      if (_driverId == null) return;
                      Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => CreateRouteScreen(
                            apiClient: widget.apiClient,
                            driverId: _driverId!,
                          ),
                        ),
                      );
                    },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _ActionTile(
                    icon: Icons.history,
                    title: 'سجل الرحلات',
                    subtitle: 'الحجوزات والمدفوعات',
                    onTap: () {},
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _ActionTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: const Color(0xFFE2E8F0)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              backgroundColor: const Color(0xFFF59E0B).withOpacity(0.15),
              child: Icon(icon, color: const Color(0xFFD97706)),
            ),
            const SizedBox(height: 12),
            Text(title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
            const SizedBox(height: 4),
            Text(subtitle, style: const TextStyle(fontSize: 11, color: Colors.grey)),
          ],
        ),
      ),
    );
  }
}
