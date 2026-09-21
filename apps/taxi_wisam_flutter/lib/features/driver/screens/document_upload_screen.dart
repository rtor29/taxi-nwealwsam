import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../../../core/network/api_client.dart';
import '../../../core/theme/app_theme.dart';

/// شاشة رفع المستمسكات والوثائق للسائق (مع دعم الاستوديو والكاميرا والمعاينة)
class DocumentUploadScreen extends StatefulWidget {
  final ApiClient apiClient;
  final String driverId;

  const DocumentUploadScreen({
    super.key,
    required this.apiClient,
    required this.driverId,
  });

  @override
  State<DocumentUploadScreen> createState() => _DocumentUploadScreenState();
}

class _DocumentUploadScreenState extends State<DocumentUploadScreen> {
  String _selectedDocType = 'DrivingLicense';
  Uint8List? _fileBytes;
  String _fileName = '';
  bool _isUploading = false;
  String? _uploadStatus;
  final ImagePicker _imagePicker = ImagePicker();

  final Map<String, String> _docTypes = {
    'DrivingLicense': 'إجازة السوق (رخصة القيادة)',
    'NationalId': 'البطاقة الوطنية الموحدة',
    'VehicleRegistration': 'سنوية المركبة (ملكية السيارة)',
    'BackgroundCheck': 'شهادة عدم المحكومية',
  };

  /// 1. اختيار صورة من الاستوديو (المعرض)
  Future<void> _pickFromGallery() async {
    try {
      final picked = await _imagePicker.pickImage(
        source: ImageSource.gallery,
        maxWidth: 1600,
        maxHeight: 1600,
        imageQuality: 85,
      );
      if (picked != null) {
        final bytes = await picked.readAsBytes();
        setState(() {
          _fileBytes = bytes;
          _fileName = picked.name;
          _uploadStatus = null;
        });
      }
    } catch (e) {
      debugPrint('Error picking from gallery: $e');
    }
  }

  /// 2. التقاط صورة مباشرة من الكاميرا
  Future<void> _pickFromCamera() async {
    try {
      final picked = await _imagePicker.pickImage(
        source: ImageSource.camera,
        maxWidth: 1600,
        maxHeight: 1600,
        imageQuality: 85,
      );
      if (picked != null) {
        final bytes = await picked.readAsBytes();
        setState(() {
          _fileBytes = bytes;
          _fileName = picked.name;
          _uploadStatus = null;
        });
      }
    } catch (e) {
      debugPrint('Error picking from camera: $e');
    }
  }

  void _showPickerSourceModal() {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(width: 40, height: 4, decoration: BoxDecoration(color: Colors.grey[300], borderRadius: BorderRadius.circular(2))),
              const SizedBox(height: 16),
              const Text('اختيار مصدر المستند', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
              const SizedBox(height: 20),
              ListTile(
                leading: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: Colors.amber.shade50, shape: BoxShape.circle),
                  child: const Icon(Icons.photo_library_rounded, color: Colors.amber),
                ),
                title: const Text('الدخول إلى الاستوديو (معرض الصور)', style: TextStyle(fontWeight: FontWeight.bold)),
                subtitle: const Text('اختر صورة المستمسك المخزنة في جهازك'),
                onTap: () {
                  Navigator.pop(ctx);
                  _pickFromGallery();
                },
              ),
              ListTile(
                leading: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: Colors.green.shade50, shape: BoxShape.circle),
                  child: const Icon(Icons.camera_alt_rounded, color: Color(0xFF10B981)),
                ),
                title: const Text('التقاط صورة بالكاميرا', style: TextStyle(fontWeight: FontWeight.bold)),
                subtitle: const Text('تصوير الهوية أو الرخصة مباشرة الآن'),
                onTap: () {
                  Navigator.pop(ctx);
                  _pickFromCamera();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// رفع الوثيقة إلى السيرفر
  Future<void> _uploadDocument() async {
    if (_fileBytes == null) return;

    setState(() {
      _isUploading = true;
      _uploadStatus = 'جاري رفع المستند وتشفيره...';
    });

    try {
      final base64String = base64Encode(_fileBytes!);

      final response = await widget.apiClient.post(
        '/documents/upload',
        data: {
          'driverId': widget.driverId,
          'documentType': _selectedDocType,
          'fileName': _fileName.isNotEmpty ? _fileName : 'doc_${DateTime.now().millisecondsSinceEpoch}.jpg',
          'fileBase64': base64String,
        },
      );

      if (response.statusCode == 200) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('تم رفع المستمسك بنجاح وسيتلقى المشرف إشعاراً للتدقيق! ✅'),
            backgroundColor: Colors.green,
            duration: Duration(seconds: 3),
          ),
        );
        Navigator.pop(context);
      }
    } catch (e) {
      setState(() {
        _uploadStatus = 'تعذر الرفع، يرجى المحاولة مرة أخرى أو فحص الاتصال.';
      });
    } finally {
      if (mounted) setState(() => _isUploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final hasFile = _fileBytes != null;

    return Scaffold(
      appBar: AppBar(
        title: const Text('رفع المستمسكات والوثائق'),
        centerTitle: true,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // شريط الحماية
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.blue.shade50,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.blue.shade200),
              ),
              child: const Row(
                children: [
                  Icon(Icons.verified_user_rounded, color: Colors.blue),
                  SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'جميع الوثائق تُحفظ في خادم آمن وخاص للمشرفين فقط بالنجف الأشرف، لتوثيق حسابك وضمان أمان الرحلات.',
                      style: TextStyle(fontSize: 12, color: Colors.blueGrey),
                    ),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 24),

            // نوع المستند
            const Text(
              'اختر نوع الوثيقة:',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _selectedDocType,
              items: _docTypes.entries.map((e) {
                return DropdownMenuItem(value: e.key, child: Text(e.value, style: const TextStyle(fontSize: 14)));
              }).toList(),
              decoration: InputDecoration(
                filled: true,
                fillColor: Colors.grey[100],
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
              ),
              onChanged: (val) {
                if (val != null) setState(() => _selectedDocType = val);
              },
            ),

            const SizedBox(height: 24),

            // زر وحاوية اختيار الملف أو معاينته
            GestureDetector(
              onTap: _isUploading ? null : _showPickerSourceModal,
              child: Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                    color: hasFile ? const Color(0xFF10B981) : Colors.amber.shade400,
                    width: 2,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.04),
                      blurRadius: 10,
                      offset: const Offset(0, 4),
                    ),
                  ],
                ),
                child: Column(
                  children: [
                    if (_fileBytes != null)
                      ClipRRect(
                        borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
                        child: Image.memory(
                          _fileBytes!,
                          height: 220,
                          width: double.infinity,
                          fit: BoxFit.cover,
                        ),
                      )
                    else
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 16),
                        child: Column(
                          children: [
                            Container(
                              padding: const EdgeInsets.all(16),
                              decoration: BoxDecoration(
                                color: Colors.amber.shade50,
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(Icons.add_photo_alternate_rounded, size: 48, color: Color(0xFFD97706)),
                            ),
                            const SizedBox(height: 14),
                            const Text(
                              'اضغط لاختيار صورة من الاستوديو أو التقاطها بالكاميرا',
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'يدعم صور الهوية ورخصة القيادة والسنوية (JPG, PNG)',
                              style: TextStyle(fontSize: 12, color: Colors.grey[600]),
                            ),
                          ],
                        ),
                      ),

                    // اسم الملف وزر التغيير
                    if (hasFile)
                      Container(
                        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
                        color: Colors.grey[50],
                        child: Row(
                          children: [
                            const Icon(Icons.check_circle, color: Color(0xFF10B981), size: 20),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                _fileName.isNotEmpty ? _fileName : 'تم تحديد الصورة بنجاح',
                                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            TextButton.icon(
                              onPressed: _showPickerSourceModal,
                              icon: const Icon(Icons.refresh, size: 16),
                              label: const Text('تغيير'),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),

            const SizedBox(height: 20),

            if (_uploadStatus != null) ...[
              Text(
                _uploadStatus!,
                style: const TextStyle(fontSize: 13, color: Colors.red, fontWeight: FontWeight.bold),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
            ],

            // زر الرفع
            SizedBox(
              height: 52,
              child: ElevatedButton.icon(
                onPressed: (!hasFile || _isUploading) ? null : _uploadDocument,
                icon: _isUploading
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
                    : const Icon(Icons.cloud_upload_rounded),
                label: Text(
                  _isUploading ? 'جاري الرفع والاعتماد...' : 'رفع المستمسك للاعتماد',
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.primaryColor,
                  foregroundColor: Colors.black,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                  elevation: 2,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
