/// نموذج إعلان الرحلة الشاغرة (Vacancy Ad)
class VacancyAd {
  final String id;
  final String driverId;
  final String driverName;
  final String driverPhone;
  final String vehicleModel;
  final String plateNumber;
  final double rating;
  final String fromLocation;
  final String toLocation;
  final String departureDate;
  final String departureTime;
  final int availableSeats;
  final int totalSeats;
  final int pricePerSeatIqd;
  final String notes;
  final String status; // Open, Full, Completed

  VacancyAd({
    required this.id,
    required this.driverId,
    required this.driverName,
    required this.driverPhone,
    required this.vehicleModel,
    required this.plateNumber,
    required this.rating,
    required this.fromLocation,
    required this.toLocation,
    required this.departureDate,
    required this.departureTime,
    required this.availableSeats,
    required this.totalSeats,
    required this.pricePerSeatIqd,
    required this.notes,
    this.status = 'Open',
  });

  factory VacancyAd.fromJson(Map<String, dynamic> json) {
    return VacancyAd(
      id: json['id'] ?? 'ad-${DateTime.now().millisecondsSinceEpoch}',
      driverId: json['driverId'] ?? 'drv-1',
      driverName: json['driverName'] ?? 'كابتن توصيله',
      driverPhone: json['driverPhone'] ?? '07801234567',
      vehicleModel: json['vehicleModel'] ?? 'تويوتا كورولا 2022',
      plateNumber: json['plateNumber'] ?? 'النجف 1029',
      rating: (json['rating'] ?? 4.9).toDouble(),
      fromLocation: json['fromLocation'] ?? 'مركز النجف',
      toLocation: json['toLocation'] ?? 'الكوفة',
      departureDate: json['departureDate'] ?? 'اليوم',
      departureTime: json['departureTime'] ?? '08:00 ص',
      availableSeats: json['availableSeats'] ?? 3,
      totalSeats: json['totalSeats'] ?? 4,
      pricePerSeatIqd: json['pricePerSeatIqd'] ?? 3000,
      notes: json['notes'] ?? 'تكييف مريح والإنطلاق بالموعد المحدد',
      status: json['status'] ?? 'Open',
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'driverId': driverId,
    'driverName': driverName,
    'driverPhone': driverPhone,
    'vehicleModel': vehicleModel,
    'plateNumber': plateNumber,
    'rating': rating,
    'fromLocation': fromLocation,
    'toLocation': toLocation,
    'departureDate': departureDate,
    'departureTime': departureTime,
    'availableSeats': availableSeats,
    'totalSeats': totalSeats,
    'pricePerSeatIqd': pricePerSeatIqd,
    'notes': notes,
    'status': status,
  };
}
