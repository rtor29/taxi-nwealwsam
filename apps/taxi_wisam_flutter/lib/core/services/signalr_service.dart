import 'dart:async';
import 'package:signalr_netcore/signalr_client.dart';
import '../../app_config.dart';
import 'storage_service.dart';

typedef DriverLocationCallback = void Function(
    String driverId, double latitude, double longitude, double heading);
typedef TripStatusCallback = void Function(String tripId, String status);

class SignalRService {
  final StorageService _storageService;
  HubConnection? _hubConnection;

  // Stream Controllers for Reactive UI
  final _driverLocationController = StreamController<Map<String, dynamic>>.broadcast();
  final _tripStatusController = StreamController<Map<String, dynamic>>.broadcast();
  final _routeBroadcastController = StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get driverLocationStream => _driverLocationController.stream;
  Stream<Map<String, dynamic>> get tripStatusStream => _tripStatusController.stream;
  Stream<Map<String, dynamic>> get routeBroadcastStream => _routeBroadcastController.stream;

  SignalRService(this._storageService);

  bool get isConnected => _hubConnection?.state == HubConnectionState.Connected;

  Future<void> initConnection() async {
    final token = await _storageService.getToken();

    _hubConnection = HubConnectionBuilder()
        .withUrl(
          AppConfig.trackingHubUrl,
          options: HttpConnectionOptions(
            accessTokenFactory: () async => token ?? '',
          ),
        )
        .withAutomaticReconnect(retryDelays: [2000, 5000, 10000, 20000])
        .build();

    // Listen to DriverLocationUpdated event
    _hubConnection?.on('DriverLocationUpdated', (arguments) {
      if (arguments != null && arguments.length >= 4) {
        final driverId = arguments[0].toString();
        final lat = (arguments[1] as num).toDouble();
        final lon = (arguments[2] as num).toDouble();
        final heading = (arguments[3] as num).toDouble();

        _driverLocationController.add({
          'driverId': driverId,
          'latitude': lat,
          'longitude': lon,
          'heading': heading,
        });
      }
    });

    // Listen to RouteBroadcasted event (admin interactive route plot)
    _hubConnection?.on('RouteBroadcasted', (arguments) {
      if (arguments != null && arguments.isNotEmpty) {
        final data = arguments[0];
        if (data is Map) {
          _routeBroadcastController.add(Map<String, dynamic>.from(data));
        }
      }
    });

    // Listen to TripStatusUpdated event
    _hubConnection?.on('TripStatusUpdated', (arguments) {
      if (arguments != null && arguments.length >= 2) {
        _tripStatusController.add({
          'tripId': arguments[0].toString(),
          'status': arguments[1].toString(),
        });
      }
    });

    try {
      await _hubConnection?.start();
    } catch (e) {
      // Reconnect will happen automatically
    }
  }

  // Driver action: Send current GPS coordinates to Backend
  Future<void> broadcastLocation(double lat, double lon, double heading) async {
    if (isConnected) {
      await _hubConnection?.invoke('UpdateDriverLocation', args: [lat, lon, heading]);
    }
  }

  // Broadcast route points
  Future<void> broadcastRouteUpdate(Map<String, dynamic> routeData) async {
    if (isConnected) {
      await _hubConnection?.invoke('BroadcastRoute', args: [routeData]);
    }
  }

  // Passenger action: Subscribe to live tracking of a specific trip
  Future<void> joinTrip(String tripId) async {
    if (isConnected) {
      await _hubConnection?.invoke('JoinTripGroup', args: [tripId]);
    }
  }

  Future<void> leaveTrip(String tripId) async {
    if (isConnected) {
      await _hubConnection?.invoke('LeaveTripGroup', args: [tripId]);
    }
  }

  Future<void> dispose() async {
    await _hubConnection?.stop();
    await _driverLocationController.close();
    await _tripStatusController.close();
    await _routeBroadcastController.close();
  }
}
