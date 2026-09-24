import 'package:flutter/material.dart';
import '../../../core/network/api_client.dart';
import '../../../core/services/storage_service.dart';
import 'route_search_screen.dart';

class CustomerHome extends StatefulWidget {
  final ApiClient apiClient;
  final StorageService storageService;

  const CustomerHome({
    super.key,
    required this.apiClient,
    required this.storageService,
  });

  @override
  State<CustomerHome> createState() => _CustomerHomeState();
}

class _CustomerHomeState extends State<CustomerHome> {
  String? _customerId;

  @override
  void initState() {
    super.initState();
    _loadUser();
  }

  Future<void> _loadUser() async {
    final id = await widget.storageService.getUserId();
    if (mounted) {
      setState(() => _customerId = id);
    }
  }

  @override
  Widget build(BuildContext context) {
    return RouteSearchScreen(
      apiClient: widget.apiClient,
      customerId: _customerId ?? '',
      storageService: widget.storageService,
    );
  }
}
