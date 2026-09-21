import 'package:flutter/material.dart';

/// Official Google 'G' Logo Widget rendered via vector canvas
/// Zero network latency, crisp rendering across all screen densities.
class GoogleLogo extends StatelessWidget {
  final double size;

  const GoogleLogo({super.key, this.size = 22.0});

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size(size, size),
      painter: _GoogleLogoPainter(),
    );
  }
}

class _GoogleLogoPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final double width = size.width;
    final double height = size.height;

    // Outer bounding circle parameters
    final Rect rect = Rect.fromLTWH(0, 0, width, height);
    final double strokeWidth = width * 0.22;
    final Paint paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.butt;

    final Rect arcRect = rect.deflate(strokeWidth / 2);

    // 1. Red Arc (Top)
    paint.color = const Color(0xFFEA4335);
    canvas.drawArc(arcRect, 3.14159 * 1.05, 3.14159 * 0.65, false, paint);

    // 2. Yellow Arc (Left)
    paint.color = const Color(0xFFFBBC05);
    canvas.drawArc(arcRect, 3.14159 * 0.7, 3.14159 * 0.35, false, paint);

    // 3. Green Arc (Bottom)
    paint.color = const Color(0xFF34A853);
    canvas.drawArc(arcRect, 3.14159 * 0.15, 3.14159 * 0.55, false, paint);

    // 4. Blue Arc & Horizontal Bar (Right)
    paint.color = const Color(0xFF4285F4);
    canvas.drawArc(arcRect, -3.14159 * 0.28, 3.14159 * 0.43, false, paint);

    // Center horizontal bar for 'G'
    final Paint fillBarPaint = Paint()
      ..color = const Color(0xFF4285F4)
      ..style = PaintingStyle.fill;

    final Rect barRect = Rect.fromLTWH(
      width * 0.48,
      height * 0.5 - (strokeWidth / 2),
      width * 0.52,
      strokeWidth,
    );
    canvas.drawRect(barRect, fillBarPaint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
