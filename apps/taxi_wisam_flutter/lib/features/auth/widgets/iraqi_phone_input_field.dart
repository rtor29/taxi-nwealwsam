import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../../core/utils/iraqi_phone_validator.dart';

/// حقل إدخال رقم الهاتف العراقي مع كشف الشبكة الحي (زين أو آسيا سيل فقط)
class IraqiPhoneInputField extends StatefulWidget {
  final TextEditingController controller;
  final ValueChanged<IraqiPhoneValidationResult> onValidationChanged;
  final VoidCallback? onSubmitted;
  final String labelText;
  final String hintText;

  const IraqiPhoneInputField({
    super.key,
    required this.controller,
    required this.onValidationChanged,
    this.onSubmitted,
    this.labelText = 'رقم الهاتف (زين أو آسيا سيل)',
    this.hintText = '0770xxxxxxx أو 0780xxxxxxx',
  });

  @override
  State<IraqiPhoneInputField> createState() => _IraqiPhoneInputFieldState();
}

class _IraqiPhoneInputFieldState extends State<IraqiPhoneInputField> {
  IraqiPhoneValidationResult _result = const IraqiPhoneValidationResult(
    isValid: false,
    operator: IraqiTelecomOperator.unknown,
    normalizedLocalNumber: '',
    normalizedE164Number: '',
  );

  bool _hasTouched = false;

  @override
  void initState() {
    super.initState();
    _validateCurrentText(widget.controller.text);
    widget.controller.addListener(_handleControllerChange);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_handleControllerChange);
    super.dispose();
  }

  void _handleControllerChange() {
    _validateCurrentText(widget.controller.text);
  }

  void _validateCurrentText(String text) {
    final res = IraqiPhoneValidator.validate(text);
    if (mounted) {
      setState(() {
        _result = res;
      });
    }
    widget.onValidationChanged(res);
  }

  @override
  Widget build(BuildContext context) {
    final showInlineError = _hasTouched && !_result.isValid && widget.controller.text.isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: widget.controller,
          keyboardType: TextInputType.phone,
          textDirection: TextDirection.ltr,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9\+\s\-\(\)]')),
            LengthLimitingTextInputFormatter(16),
          ],
          onChanged: (_) {
            if (!_hasTouched) setState(() => _hasTouched = true);
          },
          onSubmitted: (_) {
            if (widget.onSubmitted != null && _result.isValid) {
              widget.onSubmitted!();
            }
          },
          decoration: InputDecoration(
            labelText: widget.labelText,
            hintText: widget.hintText,
            prefixIcon: const Icon(Icons.phone_iphone_rounded),
            suffixIcon: _buildOperatorBadge(),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(14),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(14),
              borderSide: BorderSide(
                color: _result.isValid
                    ? Colors.green.shade600
                    : (showInlineError ? Colors.red.shade400 : Colors.grey.shade300),
                width: _result.isValid ? 1.8 : 1.0,
              ),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(14),
              borderSide: BorderSide(
                color: _result.isValid ? Colors.green.shade600 : const Color(0xFF2563EB),
                width: 2.0,
              ),
            ),
          ),
        ),
        if (showInlineError) ...[
          const SizedBox(height: 6),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Row(
              children: [
                Icon(Icons.error_outline_rounded, size: 15, color: Colors.red.shade700),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    _result.errorMessage ?? IraqiPhoneValidator.invalidPhoneErrorMessage,
                    style: TextStyle(
                      color: Colors.red.shade700,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  Widget? _buildOperatorBadge() {
    if (widget.controller.text.isEmpty) return null;

    final op = _result.operator;
    if (op == IraqiTelecomOperator.unknown) {
      return null;
    }

    String label;
    Color bgColor;
    Color textColor;
    IconData icon;

    switch (op) {
      case IraqiTelecomOperator.asiacell:
        label = 'آسيا سيل';
        bgColor = const Color(0xFFE11D48).withValues(alpha: 0.12);
        textColor = const Color(0xFFBE123C);
        icon = Icons.cell_tower_rounded;
        break;
      case IraqiTelecomOperator.zain:
        label = 'زين العراق';
        bgColor = const Color(0xFF0284C7).withValues(alpha: 0.12);
        textColor = const Color(0xFF0369A1);
        icon = Icons.sim_card_rounded;
        break;
      case IraqiTelecomOperator.korek:
        label = 'غير مدعوم (كورك)';
        bgColor = Colors.orange.shade50;
        textColor = Colors.orange.shade900;
        icon = Icons.warning_amber_rounded;
        break;
      case IraqiTelecomOperator.unsupported:
      default:
        label = 'غير مدعوم';
        bgColor = Colors.red.shade50;
        textColor = Colors.red.shade800;
        icon = Icons.cancel_outlined;
        break;
    }

    return Padding(
      padding: const EdgeInsets.only(left: 8, right: 8),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: bgColor,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: textColor.withValues(alpha: 0.4)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 14, color: textColor),
                const SizedBox(width: 4),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    color: textColor,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
