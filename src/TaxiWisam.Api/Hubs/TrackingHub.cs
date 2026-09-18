using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Api.Hubs;

public interface ITrackingClient
{
    Task DriverLocationUpdated(Guid driverId, double latitude, double longitude, double heading);
    Task TripStatusUpdated(Guid tripId, string status);
    Task ReceiveNotification(string title, string body, string type);
}

[Authorize]
public class TrackingHub : Hub<ITrackingClient>
{
    private readonly IRedisCacheService _cache;
    private readonly ILogger<TrackingHub> _logger;

    public TrackingHub(IRedisCacheService cache, ILogger<TrackingHub> logger)
    {
        _cache = cache;
        _logger = logger;
    }

    public async Task UpdateDriverLocation(double latitude, double longitude, double heading)
    {
        var userIdStr = Context.UserIdentifier;
        if (Guid.TryParse(userIdStr, out var driverId))
        {
            // 1. Update high-speed Redis cache
            await _cache.UpdateDriverLocationAsync(driverId, latitude, longitude);

            // 2. Broadcast to subscribed riders/trips
            await Clients.Others.DriverLocationUpdated(driverId, latitude, longitude, heading);
        }
    }

    public async Task JoinTripGroup(string tripId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, $"trip:{tripId}");
        _logger.LogInformation("Connection {ConnId} joined trip group {TripId}", Context.ConnectionId, tripId);
    }

    public async Task LeaveTripGroup(string tripId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"trip:{tripId}");
    }
}
