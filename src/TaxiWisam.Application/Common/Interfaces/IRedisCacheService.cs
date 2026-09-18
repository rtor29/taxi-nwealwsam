namespace TaxiWisam.Application.Common.Interfaces;

public interface IRedisCacheService
{
    Task<T?> GetAsync<T>(string key, CancellationToken cancellationToken = default);
    Task SetAsync<T>(string key, T value, TimeSpan? expiry = null, CancellationToken cancellationToken = default);
    Task<bool> RemoveAsync(string key, CancellationToken cancellationToken = default);

    // High-speed Geospatial & Driver tracking
    Task UpdateDriverLocationAsync(Guid driverId, double latitude, double longitude, TimeSpan? ttl = null);
    Task<IEnumerable<Guid>> GetNearbyDriverIdsAsync(double latitude, double longitude, double radiusKm);
    Task SetDriverOnlineStatusAsync(Guid driverId, bool isOnline);
    Task<bool> IsDriverOnlineAsync(Guid driverId);

    // Distributed Lock for Concurrency (e.g. Booking seat allocation)
    Task<bool> AcquireLockAsync(string lockKey, TimeSpan expiration);
    Task ReleaseLockAsync(string lockKey);
}
