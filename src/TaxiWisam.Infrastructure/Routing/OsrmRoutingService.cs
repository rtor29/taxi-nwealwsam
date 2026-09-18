using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using NetTopologySuite.Geometries;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Infrastructure.Routing;

public class OsrmRoutingService : IRoutingService
{
    private readonly HttpClient _httpClient;
    private readonly string _osrmBaseUrl;
    private readonly ILogger<OsrmRoutingService> _logger;

    public OsrmRoutingService(
        HttpClient httpClient, 
        IConfiguration configuration,
        ILogger<OsrmRoutingService> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
        _osrmBaseUrl = configuration["Routing:OsrmUrl"]?.TrimEnd('/') 
            ?? "https://router.project-osrm.org";
    }

    public async Task<DrivingRouteResult> GetDrivingRouteAsync(
        double startLat, 
        double startLon, 
        double endLat, 
        double endLon, 
        CancellationToken cancellationToken = default)
    {
        // OSRM expects coordinates in {lon},{lat} format
        string coords = string.Format(CultureInfo.InvariantCulture, "{0:F6},{1:F6};{2:F6},{3:F6}",
            startLon, startLat, endLon, endLat);

        string url = $"{_osrmBaseUrl}/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=true";

        try
        {
            var response = await _httpClient.GetAsync(url, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("OSRM request failed with status: {Status}", response.StatusCode);
                return FallbackStraightLineRoute(startLat, startLon, endLat, endLon);
            }

            var json = await response.Content.ReadAsStringAsync(cancellationToken);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (!root.TryGetProperty("routes", out var routes) || routes.GetArrayLength() == 0)
            {
                return FallbackStraightLineRoute(startLat, startLon, endLat, endLon);
            }

            var primaryRoute = routes[0];
            double distance = primaryRoute.GetProperty("distance").GetDouble();
            double duration = primaryRoute.GetProperty("duration").GetDouble();

            // Extract LineString coordinates from GeoJSON
            var geometry = primaryRoute.GetProperty("geometry");
            var coordElements = geometry.GetProperty("coordinates");

            var coordinateList = new List<Coordinate>();
            foreach (var coordPair in coordElements.EnumerateArray())
            {
                double lon = coordPair[0].GetDouble();
                double lat = coordPair[1].GetDouble();
                coordinateList.Add(new Coordinate(lon, lat));
            }

            var lineString = new LineString(coordinateList.ToArray()) { SRID = 4326 };

            // Extract turn-by-turn steps
            var stepsList = new List<RouteStepDto>();
            if (primaryRoute.TryGetProperty("legs", out var legs))
            {
                foreach (var leg in legs.EnumerateArray())
                {
                    if (leg.TryGetProperty("steps", out var steps))
                    {
                        foreach (var step in steps.EnumerateArray())
                        {
                            double stepDist = step.GetProperty("distance").GetDouble();
                            double stepDur = step.GetProperty("duration").GetDouble();
                            string roadName = step.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "";
                            string instruction = step.TryGetProperty("maneuver", out var m) && m.TryGetProperty("type", out var t)
                                ? t.GetString() ?? "continue" : "continue";

                            stepsList.Add(new RouteStepDto(instruction, stepDist, stepDur, roadName));
                        }
                    }
                }
            }

            return new DrivingRouteResult(lineString, distance, duration, stepsList, coordinateList);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch routing from OSRM, falling back to Euclidean calculation");
            return FallbackStraightLineRoute(startLat, startLon, endLat, endLon);
        }
    }

    public async Task<double> CalculateDrivingDistanceAsync(
        double startLat, 
        double startLon, 
        double endLat, 
        double endLon, 
        CancellationToken cancellationToken = default)
    {
        var route = await GetDrivingRouteAsync(startLat, startLon, endLat, endLon, cancellationToken);
        return route.DistanceMeters;
    }

    private DrivingRouteResult FallbackStraightLineRoute(double startLat, double startLon, double endLat, double endLon)
    {
        var coords = new[]
        {
            new Coordinate(startLon, startLat),
            new Coordinate(endLon, endLat)
        };

        var line = new LineString(coords) { SRID = 4326 };
        // Approximate distance in meters: 1 degree ~ 111,320m
        double dx = (endLon - startLon) * 111320.0 * Math.Cos(startLat * Math.PI / 180.0);
        double dy = (endLat - startLat) * 111320.0;
        double dist = Math.Sqrt(dx * dx + dy * dy) * 1.35; // 1.35 road network detour factor
        double duration = (dist / 10.0); // Assuming average city speed ~36 km/h (10 m/s)

        return new DrivingRouteResult(line, dist, duration, new List<RouteStepDto>(), coords.ToList());
    }
}
