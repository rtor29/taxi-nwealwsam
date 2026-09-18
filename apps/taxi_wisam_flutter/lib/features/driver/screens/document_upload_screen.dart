import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_endpoints.dart';

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
  String _selectedDocType = 'NationalId';
  PlatformFile? _pickedFile;
  bool _isUploading = false;
  String? _uploadStatus;

  final Map<String, String> _docTypes = {
    'NationalId': 'البطاقة الوطنية الموحدة',
    'DrivingLicense': 'إجازة السوق (رخصة القيادة)',
    'VehicleRegistration': 'سنوية المركبة (ملكية السيارة)',
    'BackgroundCheck': 'شهادة عدم المحكومية',
  };

  Future<void> _pickFile() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['jpg', 'jpeg', 'png', 'pdf'],
      withData: true,
    );

    if (result != null && result.files.isNotEmpty) {
      setState(() {
        _pickedFile = result.files.first;
      });
    }
  }

  Future<void> _uploadDocument() async {
    if (_pickedFile == null) return;

    setState(() {
      _isUploading = true;
      _uploadStatus = 'جاري رفع المستند بأمان...';
    });

    try {
      final multipartFile = MultipartFile.fromBytes(
        _pickedFile!.bytes!,
        filename: _pickedFile!.name,
      );

      final formData = FormData.fromMap({
        'driverId': widget.driverId,
        'documentType': _selectedDocType,
        'file': multipartFile,
      });

      final response = await widget.apiClient.uploadFile(
        path: ApiEndpoints.uploadDocument,
        formData: formData,
      );

      if (response.statusCode == 200) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('تم رفع المستند بنجاح وحفظه في الـ Private Bucket للتدقيق! ✅'),
            backgroundColor: Colors.green,
          ),
        );
        Navigator.pop(context);
      }
    } catch (e) {
      setState(() {
        _uploadStatus = 'فشل الرفع. تأكد من اتصال الخادم والملف المحدد.';
      });
    } finally {
      if (mounted) setState(() => _isUploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('رفع المستمسكات والوثائق')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.blue.shade50,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.blue.shade200),
              ),
              child: const Row(
                children: [
                  Icon(Icons.shield, color: Colors.blue),
                  SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'المستندات مشفرة وتخضع لحماية كاملة. لا يتم إتاحتها للعامة، وتُراجع فقط من قبل المشرفين المخولين.',
                      style: TextStyle(fontSize: 12, color: Colors.blueGrey),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            const Text(
              'نوع المستند:',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
            ),
            const SizedBox(height: 8),

            DropdownButtonFormField<String>(
              value: _selectedDocType,
              items: _docTypes.entries.map((e) {
                return DropdownMenuItem(value: e.key, child: Text(e.value));
              }).toList(),
              onChanged: (val) {
                if (val != null) setState(() => _selectedDocType = val);
              },
            ),
            const SizedBox(height: 24),

            // File Selector Box
            InkWell(
              onTap: _isUploading ? null : _pickFile,
              borderRadius: BorderRadius.circular(16),
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                    color: _pickedFile != null ? Colors.green : const Color(0xFFCBD5E1),
                    width: 2,
                    style: BorderStyle.solid,
                  ),
                ),
                child: Column(
                  children: [
                    Icon(
                      _pickedFile != null ? Icons.check_circle : Icons.cloud_upload_outlined,
                      size: 48,
                      color: _pickedFile != null ? Colors.green : const Color(0xFFF59E0B),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      _pickedFile != null
                          ? 'الملف المحدد: ${_pickedFile!.name}'
                          : 'اضغط لاختيار صورة الهوية أو المستند (JPG, PNG, PDF)',
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        fontSize: 13,
                        color: _pickedFile != null ? Colors.green.shade800 : Colors.black87,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),

            if (_uploadStatus != null) ...[
              Text(
                _uploadStatus!,
                style: const TextStyle(fontSize: 12, color: Colors.red),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
            ],

            ElevatedButton(
              onPressed: (_pickedFile == null || _isUploading) ? null : _uploadDocument,
              child: _isUploading
                  ? const SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('رفع المستند للمراجعة والاعتماد'),
            ),
          ],
        ),
      ),
    );
  }
}
