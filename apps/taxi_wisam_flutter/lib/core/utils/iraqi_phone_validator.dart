import 'package:flutter/material.dart';

/// مشغلو شبكات الاتصال في العراق
enum IraqiTelecomOperator {
  asiacell,
  zain,
  korek,
  unsupported,
  unknown,
}

/// نتيجة فحص وتدقيق رقم الهاتف العراقي
class IraqiPhoneValidationResult {
  final bool isValid;
  final IraqiTelecomOperator operator;
  final String normalizedLocalNumber; // e.g. 07701234567
  final String normalizedE164Number;  // e.g. +9647701234567
  final String? errorMessage;

  const IraqiPhoneValidationResult({
    required this.isValid,
    required this.operator,
    required this.normalizedLocalNumber,
    required this.normalizedE164Number,
    this.errorMessage,
  });

  String get operatorDisplayName {
    switch (operator) {
      case IraqiTelecomOperator.asiacell:
        return 'آسيا سيل (Asiacell)';
      case IraqiTelecomOperator.zain:
        return 'زين العراق (Zain Iraq)';
      case IraqiTelecomOperator.korek:
        return 'كورك (غير مدعومة)';
      case IraqiTelecomOperator.unsupported:
      case IraqiTelecomOperator.unknown:
        return 'مشغل غير مدعوم';
    }
  }

  Color get operatorColor {
    switch (operator) {
      case IraqiTelecomOperator.asiacell:
        return const Color(0xFFE11D48); // Asiacell Red/Burgundy
      case IraqiTelecomOperator.zain:
        return const Color(0xFF0284C7); // Zain Blue/Cyan
      case IraqiTelecomOperator.korek:
        return const Color(0xFFEA580C); // Korek Orange
      case IraqiTelecomOperator.unsupported:
      case IraqiTelecomOperator.unknown:
        return const Color(0xFF64748B); // Slate Grey
    }
  }
}

/// مدقق وفاحص أرقام الهواتف العراقية الصارم (حصر شبكتي زين وآسيا سيل فقط)
class IraqiPhoneValidator {
  static const String invalidPhoneErrorMessage =
      'يرجى إدخال رقم هاتف عراقي صالح (زين أو آسيا سيل فقط)';

  // Regular expressions according to system specifications
  static final RegExp localRegex = RegExp(r'^(077|078|079)[0-9]{8}$');
  static final RegExp internationalRegex = RegExp(r'^(\+?964)(77|78|79)[0-9]{8}$');

  /// تنظيف وتجريد رقم الهاتف من الفراغات والرموز والشرطات
  static String sanitize(String input) {
    var cleaned = input.replaceAll(RegExp(r'[\s\-\(\)\.]'), '').trim();
    // تحويل الأرقام العربية والفارسية إلى أرقام إنجليزية
    const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    const englishDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    for (int i = 0; i < arabicDigits.length; i++) {
      cleaned = cleaned.replaceAll(arabicDigits[i], englishDigits[i]);
    }
    return cleaned;
  }

  /// كشف مشغل الشبكة في الوقت الحقيقي بمجرد كتابة أول 3 أرقام
  static IraqiTelecomOperator detectOperator(String input) {
    final clean = sanitize(input);
    if (clean.isEmpty) return IraqiTelecomOperator.unknown;

    String digits = clean;
    if (digits.startsWith('+964')) {
      digits = digits.substring(4);
    } else if (digits.startsWith('964')) {
      digits = digits.substring(3);
    } else if (digits.startsWith('00964')) {
      digits = digits.substring(5);
    } else if (digits.startsWith('0')) {
      digits = digits.substring(1);
    }

    if (digits.startsWith('77')) {
      return IraqiTelecomOperator.asiacell;
    } else if (digits.startsWith('78') || digits.startsWith('79')) {
      return IraqiTelecomOperator.zain;
    } else if (digits.startsWith('75')) {
      return IraqiTelecomOperator.korek;
    } else if (digits.length >= 2) {
      return IraqiTelecomOperator.unsupported;
    }

    return IraqiTelecomOperator.unknown;
  }

  /// التحقق الشامل والدقيق من صحة رقم الهاتف العراقي
  static IraqiPhoneValidationResult validate(String input) {
    final clean = sanitize(input);

    if (clean.isEmpty) {
      return const IraqiPhoneValidationResult(
        isValid: false,
        operator: IraqiTelecomOperator.unknown,
        normalizedLocalNumber: '',
        normalizedE164Number: '',
        errorMessage: invalidPhoneErrorMessage,
      );
    }

    final isLocalMatch = localRegex.hasMatch(clean);
    final isIntlMatch = internationalRegex.hasMatch(clean);

    if (!isLocalMatch && !isIntlMatch) {
      final detected = detectOperator(clean);
      return IraqiPhoneValidationResult(
        isValid: false,
        operator: detected,
        normalizedLocalNumber: clean,
        normalizedE164Number: clean,
        errorMessage: invalidPhoneErrorMessage,
      );
    }

    // استخراج الأرقام الـ 10 الأساسية (بعد الـ 0 أو بعد الـ 964)
    String coreDigits;
    if (clean.startsWith('+964')) {
      coreDigits = clean.substring(4);
    } else if (clean.startsWith('964')) {
      coreDigits = clean.substring(3);
    } else if (clean.startsWith('0')) {
      coreDigits = clean.substring(1);
    } else {
      coreDigits = clean;
    }

    final prefix = coreDigits.substring(0, 2);
    final IraqiTelecomOperator op = (prefix == '77')
        ? IraqiTelecomOperator.asiacell
        : IraqiTelecomOperator.zain;

    final localNumber = '0$coreDigits';
    final e164Number = '+964$coreDigits';

    return IraqiPhoneValidationResult(
      isValid: true,
      operator: op,
      normalizedLocalNumber: localNumber,
      normalizedE164Number: e164Number,
      errorMessage: null,
    );
  }
}
