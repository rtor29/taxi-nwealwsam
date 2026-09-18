using Microsoft.AspNetCore.SignalR;
using TaxiWisam.Api.Hubs;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Api.Services;

public class SignalRNotificationService : INotificationService
{
    private readonly IHubContext<TrackingHub, ITrackingClient> _hubContext;

    public SignalRNotificationService(IHubContext<TrackingHub, ITrackingClient> hubContext)
    {
        _hubContext = hubContext;
    }

    public async Task SendPushNotificationAsync(
        Guid userId, 
        string title, 
        string body, 
        string type, 
        object? data = null, 
        CancellationToken cancellationToken = default)
    {
        await _hubContext.Clients.User(userId.ToString()).ReceiveNotification(title, body, type);
    }

    public async Task BroadcastDriverLocationAsync(
        Guid driverId, 
        double latitude, 
        double longitude, 
        double heading, 
        CancellationToken cancellationToken = default)
    {
        await _hubContext.Clients.All.DriverLocationUpdated(driverId, latitude, longitude, heading);
    }
}
