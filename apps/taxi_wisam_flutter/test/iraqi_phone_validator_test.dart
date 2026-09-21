import 'package:flutter_test/flutter_test.dart';
import 'package:taxi_wisam_flutter/core/utils/iraqi_phone_validator.dart';

void main() {
  group('IraqiPhoneValidator Strict Operator & Format Tests', () {
    test('07701234567 -> Valid (Asiacell)', () {
      final result = IraqiPhoneValidator.validate('07701234567');
      expect(result.isValid, isTrue);
      expect(result.operator, equals(IraqiTelecomOperator.asiacell));
      expect(result.normalizedLocalNumber, equals('07701234567'));
      expect(result.normalizedE164Number, equals('+9647701234567'));
      expect(result.errorMessage, isNull);
    });

    test('07801234567 -> Valid (Zain)', () {
      final result = IraqiPhoneValidator.validate('07801234567');
      expect(result.isValid, isTrue);
      expect(result.operator, equals(IraqiTelecomOperator.zain));
      expect(result.normalizedLocalNumber, equals('07801234567'));
      expect(result.normalizedE164Number, equals('+9647801234567'));
      expect(result.errorMessage, isNull);
    });

    test('07901234567 -> Valid (Zain)', () {
      final result = IraqiPhoneValidator.validate('07901234567');
      expect(result.isValid, isTrue);
      expect(result.operator, equals(IraqiTelecomOperator.zain));
      expect(result.normalizedLocalNumber, equals('07901234567'));
      expect(result.normalizedE164Number, equals('+9647901234567'));
      expect(result.errorMessage, isNull);
    });

    test('07501234567 -> Invalid (Rejected - Korek)', () {
      final result = IraqiPhoneValidator.validate('07501234567');
      expect(result.isValid, isFalse);
      expect(result.operator, equals(IraqiTelecomOperator.korek));
      expect(result.errorMessage, equals(IraqiPhoneValidator.invalidPhoneErrorMessage));
    });

    test('07601234567 -> Invalid (Rejected)', () {
      final result = IraqiPhoneValidator.validate('07601234567');
      expect(result.isValid, isFalse);
      expect(result.errorMessage, equals(IraqiPhoneValidator.invalidPhoneErrorMessage));
    });

    test('123456 -> Invalid length', () {
      final result = IraqiPhoneValidator.validate('123456');
      expect(result.isValid, isFalse);
      expect(result.errorMessage, equals(IraqiPhoneValidator.invalidPhoneErrorMessage));
    });

    test('International format +9647701234567 -> Valid (Asiacell)', () {
      final result = IraqiPhoneValidator.validate('+9647701234567');
      expect(result.isValid, isTrue);
      expect(result.operator, equals(IraqiTelecomOperator.asiacell));
      expect(result.normalizedLocalNumber, equals('07701234567'));
      expect(result.normalizedE164Number, equals('+9647701234567'));
    });

    test('International format 9647801234567 -> Valid (Zain)', () {
      final result = IraqiPhoneValidator.validate('9647801234567');
      expect(result.isValid, isTrue);
      expect(result.operator, equals(IraqiTelecomOperator.zain));
      expect(result.normalizedLocalNumber, equals('07801234567'));
      expect(result.normalizedE164Number, equals('+9647801234567'));
    });

    test('Real-time operator detection for first 3 digits', () {
      expect(IraqiPhoneValidator.detectOperator('077'), equals(IraqiTelecomOperator.asiacell));
      expect(IraqiPhoneValidator.detectOperator('078'), equals(IraqiTelecomOperator.zain));
      expect(IraqiPhoneValidator.detectOperator('079'), equals(IraqiTelecomOperator.zain));
      expect(IraqiPhoneValidator.detectOperator('075'), equals(IraqiTelecomOperator.korek));
      expect(IraqiPhoneValidator.detectOperator('071'), equals(IraqiTelecomOperator.unsupported));
    });
  });
}
