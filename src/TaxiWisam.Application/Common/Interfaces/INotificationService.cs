namespace TaxiWisam.Application.Common.Interfaces;

public interface INotificationService
{
    Task SendPushNotificationAsync(
        Guid userId, 
        string title, 
        string body, 
        string type, 
        object? data = null, 
        CancellationToken cancellationToken = default);

    Task BroadcastDriverLocationAsync(
        Guid driverId, 
        double latitude, 
        double longitude, 
        double heading, 
        CancellationToken cancellationToken = default);
}
