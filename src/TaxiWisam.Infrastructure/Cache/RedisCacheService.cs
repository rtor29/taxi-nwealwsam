using System.Text.Json;
using StackExchange.Redis;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Infrastructure.Cache;

public class RedisCacheService : IRedisCacheService
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IDatabase _db;
    private const string DriverLocationsGeoKey = "geo:driver_locations";
    private const string OnlineDriversSetKey = "set:drivers:online";

    public RedisCacheService(IConnectionMultiplexer redis)
    {
        _redis = redis;
        _db = _redis.GetDatabase();
    }

    public async Task<T?> GetAsync<T>(string key, CancellationToken cancellationToken = default)
    {
        var value = await _db.StringGetAsync(key);
        if (value.IsNullOrEmpty) return default;
        return JsonSerializer.Deserialize<T>(value!);
    }

    public async Task SetAsync<T>(string key, T value, TimeSpan? expiry = null, CancellationToken cancellationToken = default)
    {
        var serialized = JsonSerializer.Serialize(value);
        await _db.StringSetAsync(key, serialized, expiry);
    }

    public async Task<bool> RemoveAsync(string key, CancellationToken cancellationToken = default)
    {
        return await _db.KeyDeleteAsync(key);
    }

    public async Task UpdateDriverLocationAsync(Guid driverId, double latitude, double longitude, TimeSpan? ttl = null)
    {
        // 1. Update Geospatial Index
        await _db.GeoAddAsync(DriverLocationsGeoKey, longitude, latitude, driverId.ToString());

        // 2. Update Fast Lookup Key with TTL
        string driverKey = $"driver:loc:{driverId}";
        var payload = JsonSerializer.Serialize(new { lat = latitude, lon = longitude, time = DateTime.UtcNow });
        await _db.StringSetAsync(driverKey, payload, ttl ?? TimeSpan.FromMinutes(5));
    }

    public async Task<IEnumerable<Guid>> GetNearbyDriverIdsAsync(double latitude, double longitude, double radiusKm)
    {
        var results = await _db.GeoRadiusAsync(DriverLocationsGeoKey, longitude, latitude, radiusKm, GeoUnit.Kilometers);
        var driverIds = new List<Guid>();

        foreach (var result in results)
        {
            if (Guid.TryParse(result.Member.ToString(), out var id))
            {
                driverIds.Add(id);
            }
        }

        return driverIds;
    }

    public async Task SetDriverOnlineStatusAsync(Guid driverId, bool isOnline)
    {
        if (isOnline)
        {
            await _db.SetAddAsync(OnlineDriversSetKey, driverId.ToString());
        }
        else
        {
            await _db.SetRemoveAsync(OnlineDriversSetKey, driverId.ToString());
            await _db.GeoRemoveAsync(DriverLocationsGeoKey, driverId.ToString());
        }
    }

    public async Task<bool> IsDriverOnlineAsync(Guid driverId)
    {
        return await _db.SetContainsAsync(OnlineDriversSetKey, driverId.ToString());
    }

    public async Task<bool> AcquireLockAsync(string lockKey, TimeSpan expiration)
    {
        string lockValue = Guid.NewGuid().ToString();
        return await _db.LockTakeAsync(lockKey, lockValue, expiration);
    }

    public async Task ReleaseLockAsync(string lockKey)
    {
        // Simple key release fallback or token release
        await _db.KeyDeleteAsync(lockKey);
    }
}
