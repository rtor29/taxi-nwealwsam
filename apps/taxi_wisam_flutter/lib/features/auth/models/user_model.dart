enum AppRole { Customer, Driver, Admin }

class UserModel {
  final String id;
  final String phoneNumber;
  final String fullName;
  final String? email;
  final AppRole role;
  final bool isDriverVerified;

  UserModel({
    required this.id,
    required this.phoneNumber,
    required this.fullName,
    this.email,
    required this.role,
    this.isDriverVerified = false,
  });

  factory UserModel.fromJson(Map<String, dynamic> json) {
    AppRole parsedRole = AppRole.Customer;
    final roleStr = json['role']?.toString().toLowerCase();
    if (roleStr == 'driver') {
      parsedRole = AppRole.Driver;
    } else if (roleStr == 'admin') {
      parsedRole = AppRole.Admin;
    }

    return UserModel(
      id: json['id'] ?? json['userId'] ?? '',
      phoneNumber: json['phoneNumber'] ?? '',
      fullName: json['fullName'] ?? '',
      email: json['email'],
      role: parsedRole,
      isDriverVerified: json['isDriverVerified'] ?? false,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'phoneNumber': phoneNumber,
        'fullName': fullName,
        'email': email,
        'role': role.name,
        'isDriverVerified': isDriverVerified,
      };
}
