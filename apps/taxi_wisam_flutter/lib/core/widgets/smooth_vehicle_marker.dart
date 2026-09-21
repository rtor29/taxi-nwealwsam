import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';

/// Smoothly animates a vehicle marker between consecutive GPS coordinates
/// using spherical/linear coordinate interpolation and heading rotation.
class SmoothVehicleMarker extends StatefulWidget {
  final LatLng targetPosition;
  final double targetHeading;
  final String title;
  final bool isAvailable;
  final VoidCallback? onTap;

  const SmoothVehicleMarker({
    super.key,
    required this.targetPosition,
    required this.targetHeading,
    this.title = '',
    this.isAvailable = true,
    this.onTap,
  });

  @override
  State<SmoothVehicleMarker> createState() => _SmoothVehicleMarkerState();
}

class _SmoothVehicleMarkerState extends State<SmoothVehicleMarker>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _animation;

  late LatLng _startPosition;
  late LatLng _endPosition;
  late double _startHeading;
  late double _endHeading;

  LatLng _currentPosition = const LatLng(0, 0);
  double _currentHeading = 0.0;

  @override
  void initState() {
    super.initState();
    _startPosition = widget.targetPosition;
    _endPosition = widget.targetPosition;
    _startHeading = widget.targetHeading;
    _endHeading = widget.targetHeading;
    _currentPosition = widget.targetPosition;
    _currentHeading = widget.targetHeading;

    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    );

    _animation = CurvedAnimation(parent: _controller, curve: Curves.easeInOut);

    _controller.addListener(() {
      final t = _animation.value;
      setState(() {
        _currentPosition = LatLng(
          _startPosition.latitude + (_endPosition.latitude - _startPosition.latitude) * t,
          _startPosition.longitude + (_endPosition.longitude - _startPosition.longitude) * t,
        );
        _currentHeading = _interpolateHeading(_startHeading, _endHeading, t);
      });
    });
  }

  double _interpolateHeading(double start, double end, double t) {
    double diff = (end - start) % 360.0;
    if (diff > 180.0) diff -= 360.0;
    if (diff < -180.0) diff += 360.0;
    return (start + diff * t) % 360.0;
  }

  @override
  void didUpdateWidget(covariant SmoothVehicleMarker oldWidget) {
    super.didUpdateWidget(oldWidget);

    final hasMoved = oldWidget.targetPosition.latitude != widget.targetPosition.latitude ||
        oldWidget.targetPosition.longitude != widget.targetPosition.longitude;
    final hasRotated = oldWidget.targetHeading != widget.targetHeading;

    if (hasMoved || hasRotated) {
      _startPosition = _currentPosition;
      _endPosition = widget.targetPosition;
      _startHeading = _currentHeading;
      _endHeading = widget.targetHeading;

      _controller.forward(from: 0.0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final headingRad = _currentHeading * (math.pi / 180.0);

    return GestureDetector(
      onTap: widget.onTap,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (widget.title.isNotEmpty)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              margin: const EdgeInsets.only(bottom: 2),
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A).withOpacity(0.88),
                borderRadius: BorderRadius.circular(8),
                boxShadow: const [
                  BoxShadow(color: Colors.black26, blurRadius: 4, offset: Offset(0, 2)),
                ],
              ),
              child: Text(
                widget.title,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 10,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: widget.isAvailable ? const Color(0xFFF59E0B) : Colors.grey.shade600,
              shape: BoxShape.circle,
              border: Border.all(color: Colors.white, width: 2.5),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.35),
                  blurRadius: 8,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: Transform.rotate(
              angle: headingRad,
              child: const Center(
                child: Icon(
                  Icons.navigation_rounded,
                  color: Color(0xFF0F172A),
                  size: 26,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
