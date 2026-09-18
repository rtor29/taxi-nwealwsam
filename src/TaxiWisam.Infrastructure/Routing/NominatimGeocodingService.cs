using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Infrastructure.Routing;

public class NominatimGeocodingService : IGeocodingService
{
    private readonly HttpClient _httpClient;
    private readonly IRedisCacheService _cache;
    private readonly string _nominatimBaseUrl;
    private readonly ILogger<NominatimGeocodingService> _logger;

    public NominatimGeocodingService(
        HttpClient httpClient, 
        IRedisCacheService cache,
        IConfiguration configuration,
        ILogger<NominatimGeocodingService> logger)
    {
        _httpClient = httpClient;
        _cache = cache;
        _logger = logger;
        _nominatimBaseUrl = configuration["Routing:NominatimUrl"]?.TrimEnd('/') 
            ?? "https://nominatim.openstreetmap.org";

        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Add("User-Agent", "TaxiWisam-RoutingEngine/1.0 (support@taxi-wisam.iq)");
    }

    public async Task<List<GeocodePlaceResult>> SearchPlacesAsync(
        string query, 
        string countryCode = "iq", 
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(query)) return new List<GeocodePlaceResult>();

        string cacheKey = $"geo:search:{countryCode}:{query.Trim().ToLowerInvariant()}";
        var cached = await _cache.GetAsync<List<GeocodePlaceResult>>(cacheKey, cancellationToken);
        if (cached != null) return cached;

        string encodedQuery = Uri.EscapeDataString(query);
        string url = $"{_nominatimBaseUrl}/search?q={encodedQuery}&countrycodes={countryCode}&format=json&addressdetails=1&limit=5";

        var results = new List<GeocodePlaceResult>();

        try
        {
            var response = await _httpClient.GetAsync(url, cancellationToken);
            if (response.IsSuccessStatusCode)
            {
                var json = await response.Content.ReadAsStringAsync(cancellationToken);
                using var doc = JsonDocument.Parse(json);

                foreach (var item in doc.RootElement.EnumerateArray())
                {
                    string displayName = item.GetProperty("display_name").GetString() ?? "";
                    double lat = double.Parse(item.GetProperty("lat").GetString() ?? "0", CultureInfo.InvariantCulture);
                    double lon = double.Parse(item.GetProperty("lon").GetString() ?? "0", CultureInfo.InvariantCulture);

                    string? city = null, suburb = null, road = null;
                    if (item.TryGetProperty("address", out var addr))
                    {
                        if (addr.TryGetProperty("city", out var c)) city = c.GetString();
                        if (addr.TryGetProperty("suburb", out var s)) suburb = s.GetString();
                        if (addr.TryGetProperty("road", out var r)) road = r.GetString();
                    }

                    results.Add(new GeocodePlaceResult(displayName, lat, lon, city, suburb, road));
                }

                // Cache for 7 days in Redis
                if (results.Count > 0)
                {
                    await _cache.SetAsync(cacheKey, results, TimeSpan.FromDays(7), cancellationToken);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error while searching Nominatim for {Query}", query);
        }

        return results;
    }

    public async Task<string> ReverseGeocodeAsync(
        double latitude, 
        double longitude, 
        CancellationToken cancellationToken = default)
    {
        string cacheKey = string.Format(CultureInfo.InvariantCulture, "geo:reverse:{0:F4}:{1:F4}", latitude, longitude);
        var cached = await _cache.GetAsync<string>(cacheKey, cancellationToken);
        if (cached != null) return cached;

        string url = string.Format(CultureInfo.InvariantCulture,
            "{0}/reverse?lat={1:F6}&lon={2:F6}&format=json", _nominatimBaseUrl, latitude, longitude);

        try
        {
            var response = await _httpClient.GetAsync(url, cancellationToken);
            if (response.IsSuccessStatusCode)
            {
                var json = await response.Content.ReadAsStringAsync(cancellationToken);
                using var doc = JsonDocument.Parse(json);
                string address = doc.RootElement.GetProperty("display_name").GetString() ?? "موقع غير معروف";

                await _cache.SetAsync(cacheKey, address, TimeSpan.FromDays(7), cancellationToken);
                return address;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in reverse geocoding for {Lat},{Lon}", latitude, longitude);
        }

        return $"{latitude:F4}, {longitude:F4}";
    }
}
