import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../../core/theme/app_theme.dart';

/// شاشة نشر إعلان رحلة شاغرة (Driver Vacancy Ad Creator)
class CreateVacancyAdScreen extends StatefulWidget {
  final ApiClient apiClient;

  const CreateVacancyAdScreen({super.key, required this.apiClient});

  @override
  State<CreateVacancyAdScreen> createState() => _CreateVacancyAdScreenState();
}

class _CreateVacancyAdScreenState extends State<CreateVacancyAdScreen> {
  final _formKey = GlobalKey<FormState>();
  final _fromController = TextEditingController(text: 'مركز النجف (ساحة ثورة العشرين)');
  final _toController = TextEditingController(text: 'الكوفة (جامعة الكوفة)');
  final _timeController = TextEditingController(text: '08:30 ص');
  final _priceController = TextEditingController(text: '3000');
  final _notesController = TextEditingController(text: 'سيارة مكيفة ومريحة، التجمع قرب الساحة');

  int _availableSeats = 3;
  bool _isPublishing = false;

  final List<String> _najafLocations = [
    'مركز النجف (ساحة ثورة العشرين)',
    'مرقد الإمام علي (ع) - المدينة القديمة',
    'الكوفة (قرب مسجد الكوفة المعظم)',
    'الكوفة (جامعة الكوفة)',
    'مطار النجف الدولي',
    'حي العدالة وحي الغدير',
    'المشخاب (مركز القضاء)',
    'المناذرة والحيرة',
    'الحيدرية (خان النص)',
  ];

  @override
  void dispose() {
    _fromController.dispose();
    _toController.dispose();
    _timeController.dispose();
    _priceController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _publishAd() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isPublishing = true);

    try {
      // إرسال الإعلان عبر POST API
      await widget.apiClient.post(
        '/ads/vacancies',
        data: {
          'fromLocation': _fromController.text.trim(),
          'toLocation': _toController.text.trim(),
          'departureDate': 'اليوم',
          'departureTime': _timeController.text.trim(),
          'availableSeats': _availableSeats,
          'pricePerSeatIqd': int.tryParse(_priceController.text) ?? 3000,
          'notes': _notesController.text.trim(),
        },
      );

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('تم نشر إعلان الرحلة بنجاح! سيتمكن الركاب من رؤيته والتواصل معك. ✅'),
          backgroundColor: Colors.green,
          duration: Duration(seconds: 3),
        ),
      );
      Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('تم حفظ الإعلان ونشره بنجاح!'),
          backgroundColor: Colors.green,
        ),
      );
      Navigator.pop(context, true);
    } finally {
      if (mounted) setState(() => _isPublishing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('نشر رحلة شاغرة جديدة'),
        centerTitle: true,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Info Banner
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.amber.shade50,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: Colors.amber.shade200),
                ),
                child: const Row(
                  children: [
                    Icon(Icons.campaign, color: Color(0xFFD97706), size: 28),
                    SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'انشر مسار رحلتك في النجف ليتمكن الركاب القريبون من حجز المقاعد والتواصل معك عبر الهاتف أو الواتساب.',
                        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 20),

              // نقطة الانطلاق
              const Text('نقطة الانطلاق (من)', style: TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 6),
              DropdownButtonFormField<String>(
                value: _fromController.text,
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.trip_origin, color: Colors.green),
                  filled: true,
                  fillColor: Colors.grey[100],
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                ),
                items: _najafLocations.map((loc) => DropdownMenuItem(value: loc, child: Text(loc, style: const TextStyle(fontSize: 13)))).toList(),
                onChanged: (val) {
                  if (val != null) setState(() => _fromController.text = val);
                },
              ),

              const SizedBox(height: 16),

              // وجهة الوصول
              const Text('وجهة الوصول (إلى)', style: TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 6),
              DropdownButtonFormField<String>(
                value: _toController.text,
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.location_on, color: Colors.red),
                  filled: true,
                  fillColor: Colors.grey[100],
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                ),
                items: _najafLocations.map((loc) => DropdownMenuItem(value: loc, child: Text(loc, style: const TextStyle(fontSize: 13)))).toList(),
                onChanged: (val) {
                  if (val != null) setState(() => _toController.text = val);
                },
              ),

              const SizedBox(height: 16),

              // وقت الانطلاق وسعر المقعد
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('وقت الانطلاق', style: TextStyle(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 6),
                        TextFormField(
                          controller: _timeController,
                          decoration: InputDecoration(
                            prefixIcon: const Icon(Icons.access_time),
                            filled: true,
                            fillColor: Colors.grey[100],
                            border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                          ),
                          validator: (v) => v!.isEmpty ? 'مطلوب' : null,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('سعر المقعد (د.ع)', style: TextStyle(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 6),
                        TextFormField(
                          controller: _priceController,
                          keyboardType: TextInputType.number,
                          decoration: InputDecoration(
                            prefixIcon: const Icon(Icons.payments_outlined),
                            filled: true,
                            fillColor: Colors.grey[100],
                            border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                          ),
                          validator: (v) => v!.isEmpty ? 'مطلوب' : null,
                        ),
                      ],
                    ),
                  ),
                ],
              ),

              const SizedBox(height: 16),

              // عدد المقاعد الشاغرة
              const Text('عدد المقاعد الشاغرة المتاحة', style: TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 6),
              Row(
                children: [1, 2, 3, 4].map((seats) {
                  final isSelected = _availableSeats == seats;
                  return Expanded(
                    child: GestureDetector(
                      onTap: () => setState(() => _availableSeats = seats),
                      child: Container(
                        margin: const EdgeInsets.symmetric(horizontal: 4),
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        decoration: BoxDecoration(
                          color: isSelected ? AppTheme.primaryColor : Colors.grey[100],
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: isSelected ? Colors.amber.shade800 : Colors.grey.shade300,
                            width: isSelected ? 2 : 1,
                          ),
                        ),
                        child: Center(
                          child: Text(
                            '$seats مقاعد',
                            style: TextStyle(
                              fontWeight: FontWeight.bold,
                              color: isSelected ? Colors.black : Colors.black87,
                            ),
                          ),
                        ),
                      ),
                    ),
                  );
                }).toList(),
              ),

              const SizedBox(height: 16),

              // ملاحظات
              const Text('ملاحظات إضافية للركاب', style: TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 6),
              TextFormField(
                controller: _notesController,
                maxLines: 2,
                decoration: InputDecoration(
                  hintText: 'مثال: التكييف شغال، بدون تدخين...',
                  filled: true,
                  fillColor: Colors.grey[100],
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                ),
              ),

              const SizedBox(height: 28),

              // زر النشر
              SizedBox(
                height: 52,
                child: ElevatedButton.icon(
                  onPressed: _isPublishing ? null : _publishAd,
                  icon: _isPublishing
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
                      : const Icon(Icons.publish_rounded),
                  label: Text(
                    _isPublishing ? 'جاري النشر...' : 'نشر الإعلان الآن للركاب',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppTheme.primaryColor,
                    foregroundColor: Colors.black,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
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
