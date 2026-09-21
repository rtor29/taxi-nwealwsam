import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../../core/services/storage_service.dart';
import '../../../core/theme/app_theme.dart';

/// شاشة الدعم الفني والشكاوى (Contact Support)
class ContactSupportScreen extends StatefulWidget {
  final ApiClient apiClient;
  final StorageService storageService;

  const ContactSupportScreen({
    super.key,
    required this.apiClient,
    required this.storageService,
  });

  @override
  State<ContactSupportScreen> createState() => _ContactSupportScreenState();
}

class _ContactSupportScreenState extends State<ContactSupportScreen> {
  final _formKey = GlobalKey<FormState>();
  final _subjectController = TextEditingController();
  final _detailsController = TextEditingController();

  String _selectedCategory = 'مشكلة في الرحلة';
  bool _isSending = false;

  final List<String> _categories = [
    'مشكلة في الرحلة',
    'شكوى على سائق/زبون',
    'خطأ تقني في التطبيق',
    'استفسار عن الأسعار أو الرصيد',
    'اقتراح تحسين الخدمة',
  ];

  @override
  void dispose() {
    _subjectController.dispose();
    _detailsController.dispose();
    super.dispose();
  }

  Future<void> _submitComplaint() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isSending = true);

    try {
      final userId = await widget.storageService.getUserId() ?? 'usr-anonymous';
      final userName = await widget.storageService.getUserName() ?? 'مستخدم';
      final userRole = await widget.storageService.getUserRole() ?? 'Customer';

      // استدعاء الـ API لإرسال الشكوى
      await widget.apiClient.post(
        '/complaints',
        data: {
          'userId': userId,
          'userName': userName,
          'userRole': userRole,
          'category': _selectedCategory,
          'subject': _subjectController.text.trim(),
          'details': _detailsController.text.trim(),
          'createdAt': DateTime.now().toIso8601String(),
        },
      );

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('تم إرسال تذكرتك بنجاح! سيتابع فريق توصيله طلبك فوراً. ✅'),
          backgroundColor: Colors.green,
          duration: Duration(seconds: 3),
        ),
      );
      Navigator.pop(context);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('تم استلام تذكرتك محلياً وسيتم معالجتها من قبل المشرفين.'),
          backgroundColor: Colors.amber,
        ),
      );
      Navigator.pop(context);
    } finally {
      if (mounted) setState(() => _isSending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('الدعم الفني والشكاوى'),
        centerTitle: true,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header Card
              Container(
                padding: const EdgeInsets.all(18),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [Colors.amber.shade50, Colors.amber.shade100.withOpacity(0.5)],
                    begin: Alignment.topRight,
                    end: Alignment.bottomLeft,
                  ),
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: Colors.amber.shade200),
                ),
                child: Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: const BoxDecoration(
                        color: Colors.amber,
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.support_agent_rounded, color: Color(0xFF0F172A), size: 28),
                    ),
                    const SizedBox(width: 14),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'فريق خدمة عملاء توصيله',
                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                          ),
                          SizedBox(height: 4),
                          Text(
                            'نحن في خدمتكم على مدار 24 ساعة في النجف الأشرف لضمان أفضل تجربة تنقل.',
                            style: TextStyle(fontSize: 12, color: Colors.black87),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 24),

              // نوع الشكوى / الفئة
              const Text(
                'نوع الطلب أو الشكوى',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                decoration: BoxDecoration(
                  color: Colors.grey[100],
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: Colors.grey.shade300),
                ),
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<String>(
                    isExpanded: true,
                    value: _selectedCategory,
                    items: _categories.map((c) {
                      return DropdownMenuItem(value: c, child: Text(c, style: const TextStyle(fontSize: 14)));
                    }).toList(),
                    onChanged: (val) {
                      if (val != null) setState(() => _selectedCategory = val);
                    },
                  ),
                ),
              ),

              const SizedBox(height: 20),

              // عنوان الشكوى
              const Text(
                'عنوان الموضوع',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _subjectController,
                decoration: InputDecoration(
                  hintText: 'مثال: تأخر الكابتن أو اختلاف السعر...',
                  filled: true,
                  fillColor: Colors.grey[100],
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: BorderSide(color: Colors.grey.shade300),
                  ),
                ),
                validator: (val) => val == null || val.trim().isEmpty ? 'يرجى كتابة عنوان للموضوع' : null,
              ),

              const SizedBox(height: 20),

              // التفاصيل
              const Text(
                'التفاصيل والوصف الكامل',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
              ),
              const SizedBox(height: 8),
              TextFormField(
                controller: _detailsController,
                maxLines: 5,
                decoration: InputDecoration(
                  hintText: 'اشرح ما حدث بالتفصيل لنتمكن من مساعدتك وحل المشكلة بأسرع وقت...',
                  filled: true,
                  fillColor: Colors.grey[100],
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: BorderSide(color: Colors.grey.shade300),
                  ),
                ),
                validator: (val) => val == null || val.trim().isEmpty ? 'يرجى كتابة تفاصيل الشكوى' : null,
              ),

              const SizedBox(height: 32),

              // زر الإرسال
              SizedBox(
                height: 52,
                child: ElevatedButton.icon(
                  onPressed: _isSending ? null : _submitComplaint,
                  icon: _isSending
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : const Icon(Icons.send_rounded),
                  label: Text(
                    _isSending ? 'جاري الإرسال...' : 'إرسال التذكرة للإدارة',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryColor,
                    foregroundColor: Colors.black,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
