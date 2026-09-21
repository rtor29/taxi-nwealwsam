import 'package:flutter/material.dart';

/// شعار تطبيق "توصيله" بتصميم احترافي يجمع بين سيارة الأجرة ونقطة الوصول الجغرافية
class TawseelaLogo extends StatelessWidget {
  final double size;
  final bool showText;
  final Color? textColor;

  const TawseelaLogo({
    super.key,
    this.size = 80,
    this.showText = true,
    this.textColor,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: const LinearGradient(
              colors: [Color(0xFFF59E0B), Color(0xFFD97706)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            boxShadow: [
              BoxShadow(
                color: const Color(0xFFF59E0B).withOpacity(0.35),
                blurRadius: 16,
                offset: const Offset(0, 8),
              ),
            ],
            border: Border.all(color: Colors.white, width: 3),
          ),
          child: Center(
            child: Stack(
              alignment: Alignment.center,
              children: [
                Icon(
                  Icons.local_taxi_rounded,
                  color: const Color(0xFF0F172A),
                  size: size * 0.55,
                ),
                Positioned(
                  top: size * 0.12,
                  right: size * 0.14,
                  child: Container(
                    padding: const EdgeInsets.all(2),
                    decoration: const BoxDecoration(
                      color: Color(0xFF10B981),
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.location_on,
                      color: Colors.white,
                      size: 14,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        if (showText) ...[
          const SizedBox(height: 10),
          Text(
            'توصيله',
            style: TextStyle(
              fontSize: size * 0.32,
              fontWeight: FontWeight.w900,
              color: textColor ?? const Color(0xFF0F172A),
              letterSpacing: 0.5,
            ),
          ),
          Text(
            'مشاويرك بأمان وسرعة في النجف',
            style: TextStyle(
              fontSize: size * 0.14,
              fontWeight: FontWeight.w600,
              color: (textColor ?? const Color(0xFF0F172A)).withOpacity(0.65),
            ),
          ),
        ],
      ],
    );
  }
}
