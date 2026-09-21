import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../../core/theme/app_theme.dart';
import '../../profile/screens/driver_profile_screen.dart';
import '../models/vacancy_ad_model.dart';
import 'create_vacancy_ad_screen.dart';

/// شاشة تصفح إعلانات الرحلات الشاغرة (Vacancy Ads Screen)
class VacancyAdsScreen extends StatefulWidget {
  final ApiClient apiClient;
  final bool isDriver;

  const VacancyAdsScreen({
    super.key,
    required this.apiClient,
    required this.isDriver,
  });

  @override
  State<VacancyAdsScreen> createState() => _VacancyAdsScreenState();
}

class _VacancyAdsScreenState extends State<VacancyAdsScreen> {
  List<VacancyAd> _ads = [];
  bool _isLoading = true;
  String _filterDestination = 'الكل';

  final List<String> _destinations = [
    'الكل',
    'الكوفة',
    'المدينة القديمة',
    'مطار النجف',
    'المشخاب',
    'المناذرة',
    'الحيدرية',
  ];

  @override
  void initState() {
    super.initState();
    _fetchVacancyAds();
  }

  Future<void> _fetchVacancyAds() async {
    setState(() => _isLoading = true);

    try {
      // استدعاء GET API لجلب الإعلانات المتاحة
      final response = await widget.apiClient.get('/ads/vacancies');
      if (response.statusCode == 200 && response.data != null) {
        final list = (response.data as List).map((j) => VacancyAd.fromJson(j)).toList();
        setState(() => _ads = list);
      } else {
        _loadDefaultNajafAds();
      }
    } catch (e) {
      // تحميل إعلانات افتراضية واقعية لمحافظة النجف الأشرف
      _loadDefaultNajafAds();
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  void _loadDefaultNajafAds() {
    setState(() {
      _ads = [
        VacancyAd(
          id: 'ad-njf-101',
          driverId: 'drv-ali-najaf',
          driverName: 'علي الكعبي',
          driverPhone: '07812345678',
          vehicleModel: 'تويوتا كورولا 2023',
          plateNumber: 'النجف 14502',
          rating: 4.95,
          fromLocation: 'ساحة ثورة العشرين - المركز',
          toLocation: 'جامعة الكوفة - مجمع الكليات',
          departureDate: 'اليوم',
          departureTime: '08:15 ص',
          availableSeats: 3,
          totalSeats: 4,
          pricePerSeatIqd: 3000,
          notes: 'تكييف بارد ومقاعد مريحة والانطلاق فوري عند اكتمال الركاب.',
        ),
        VacancyAd(
          id: 'ad-njf-102',
          driverId: 'drv-hassan-najaf',
          driverName: 'حسين الخفاجي',
          driverPhone: '07809876543',
          vehicleModel: 'هيونداي إلنترا 2021',
          plateNumber: 'النجف 8921',
          rating: 4.88,
          fromLocation: 'مرقد الإمام علي (ع) - المدينة القديمة',
          toLocation: 'مطار النجف الدولي',
          departureDate: 'اليوم',
          departureTime: '10:00 ص',
          availableSeats: 2,
          totalSeats: 4,
          pricePerSeatIqd: 5000,
          notes: 'خاص للمسافرين ولدينا مساحة واسعة للحقائب.',
        ),
        VacancyAd(
          id: 'ad-njf-103',
          driverId: 'drv-karrar-najaf',
          driverName: 'كرار الزيادي',
          driverPhone: '07705544332',
          vehicleModel: 'كيا فورتي 2022',
          plateNumber: 'النجف 3310',
          rating: 4.90,
          fromLocation: 'مركز قضاء المشخاب',
          toLocation: 'مركز مدينة النجف الأشرف',
          departureDate: 'اليوم',
          departureTime: '07:30 ص',
          availableSeats: 4,
          totalSeats: 4,
          pricePerSeatIqd: 4000,
          notes: 'خط دوام صباحي يومي للطلبة والموظفين.',
        ),
      ];
    });
  }

  @override
  Widget build(BuildContext context) {
    final filteredAds = _filterDestination == 'الكل'
        ? _ads
        : _ads.where((a) => a.toLocation.contains(_filterDestination) || a.fromLocation.contains(_filterDestination)).toList();

    return Scaffold(
      appBar: AppBar(
        title: const Text('إعلانات الرحلات الشاغرة'),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            onPressed: _fetchVacancyAds,
          ),
        ],
      ),
      floatingActionButton: widget.isDriver
          ? FloatingActionButton.extended(
              onPressed: () async {
                final res = await Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (context) => CreateVacancyAdScreen(apiClient: widget.apiClient),
                  ),
                );
                if (res == true) _fetchVacancyAds();
              },
              backgroundColor: AppTheme.primaryColor,
              foregroundColor: Colors.black,
              icon: const Icon(Icons.add_rounded),
              label: const Text('نشر رحلة شاغرة', style: TextStyle(fontWeight: FontWeight.bold)),
            )
          : null,
      body: Column(
        children: [
          // شريط الفلترة حسب المنطقة في النجف
          Container(
            height: 54,
            padding: const EdgeInsets.symmetric(vertical: 8),
            color: Colors.white,
            child: ListView.builder(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              itemCount: _destinations.length,
              itemBuilder: (ctx, i) {
                final dest = _destinations[i];
                final isSelected = _filterDestination == dest;
                return GestureDetector(
                  onTap: () => setState(() => _filterDestination = dest),
                  child: Container(
                    margin: const EdgeInsets.only(left: 8),
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    decoration: BoxDecoration(
                      color: isSelected ? AppTheme.primaryColor : Colors.grey[100],
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(
                        color: isSelected ? Colors.amber.shade800 : Colors.grey.shade300,
                      ),
                    ),
                    child: Center(
                      child: Text(
                        dest,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: isSelected ? FontWeight.bold : FontWeight.w600,
                          color: isSelected ? Colors.black : Colors.black87,
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),

          const Divider(height: 1),

          // قائمة الإعلانات المتاحة
          Expanded(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : filteredAds.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.directions_car_outlined, size: 64, color: Colors.grey[400]),
                            const SizedBox(height: 12),
                            const Text(
                              'لا توجد رحلات معلنة لهذه الوجهة حالياً',
                              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.grey),
                            ),
                          ],
                        ),
                      )
                    : ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: filteredAds.length,
                        itemBuilder: (ctx, i) {
                          final ad = filteredAds[i];
                          return _buildAdCard(ad);
                        },
                      ),
          ),
        ],
      ),
    );
  }

  Widget _buildAdCard(VacancyAd ad) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.04),
            blurRadius: 14,
            offset: const Offset(0, 4),
          ),
        ],
        border: Border.all(color: Colors.grey.shade200),
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(20),
        child: InkWell(
          borderRadius: BorderRadius.circular(20),
          onTap: () {
            // فتح ملف السائق للتواصل والحجز
            Navigator.push(
              context,
              MaterialPageRoute(
                builder: (context) => DriverProfileScreen(
                  ad: ad,
                  apiClient: widget.apiClient,
                ),
              ),
            );
          },
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // رأس البطاقة: السائق والتقييم
                Row(
                  children: [
                    CircleAvatar(
                      radius: 22,
                      backgroundColor: Colors.amber.shade100,
                      child: Text(
                        ad.driverName.isNotEmpty ? ad.driverName[0] : 'ك',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF0F172A), fontSize: 18),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Text(ad.driverName, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                              const SizedBox(width: 6),
                              const Icon(Icons.verified, color: Color(0xFF10B981), size: 16),
                            ],
                          ),
                          Text('${ad.vehicleModel} • ${ad.plateNumber}', style: TextStyle(color: Colors.grey[600], fontSize: 12)),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: Colors.amber.shade50,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: Colors.amber.shade200),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.star, color: Colors.amber, size: 14),
                          const SizedBox(width: 4),
                          Text('${ad.rating}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                        ],
                      ),
                    ),
                  ],
                ),

                const Divider(height: 22),

                // خط السير
                Row(
                  children: [
                    const Icon(Icons.trip_origin, color: Colors.green, size: 18),
                    const SizedBox(width: 8),
                    Expanded(child: Text(ad.fromLocation, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
                  ],
                ),
                Container(
                  margin: const EdgeInsets.only(right: 8),
                  height: 12,
                  width: 2,
                  color: Colors.grey[300],
                ),
                Row(
                  children: [
                    const Icon(Icons.location_on, color: Colors.red, size: 18),
                    const SizedBox(width: 8),
                    Expanded(child: Text(ad.toLocation, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
                  ],
                ),

                const SizedBox(height: 14),

                // أسفل البطاقة: المقاعد والسعر وزر التواصل
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0xFF10B981).withOpacity(0.12),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        'متبقي ${ad.availableSeats} مقاعد',
                        style: const TextStyle(color: Color(0xFF047857), fontWeight: FontWeight.bold, fontSize: 12),
                      ),
                    ),
                    Text(
                      '${ad.pricePerSeatIqd} د.ع / مقعد',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: Color(0xFFD97706)),
                    ),
                    ElevatedButton.icon(
                      onPressed: () {
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (context) => DriverProfileScreen(
                              ad: ad,
                              apiClient: widget.apiClient,
                            ),
                          ),
                        );
                      },
                      icon: const Icon(Icons.touch_app_rounded, size: 16),
                      label: const Text('التفاصيل والحجز', style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF0F172A),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
