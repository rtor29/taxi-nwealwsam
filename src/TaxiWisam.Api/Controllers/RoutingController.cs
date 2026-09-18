using Microsoft.AspNetCore.Mvc;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class RoutingController : ControllerBase
{
    private readonly IRoutingService _routingService;
    private readonly IGeocodingService _geocodingService;

    public RoutingController(
        IRoutingService routingService, 
        IGeocodingService geocodingService)
    {
        _routingService = routingService;
        _geocodingService = geocodingService;
    }

    /// <summary>
    /// Calculate exact road network route, distance, duration, and GeoJSON geometry via OSRM
    /// </summary>
    [HttpGet("route")]
    public async Task<IActionResult> GetRoute(
        [FromQuery] double startLat, 
        [FromQuery] double startLon, 
        [FromQuery] double endLat, 
        [FromQuery] double endLon)
    {
        var result = await _routingService.GetDrivingRouteAsync(startLat, startLon, endLat, endLon);

        return Ok(new
        {
            DistanceMeters = result.DistanceMeters,
            DistanceKm = Math.Round(result.DistanceMeters / 1000.0, 2),
            DurationSeconds = result.DurationSeconds,
            DurationMinutes = Math.Round(result.DurationSeconds / 60.0, 1),
            Steps = result.Steps,
            Points = result.PolylinePoints.Select(p => new { Latitude = p.Y, Longitude = p.X })
        });
    }

    /// <summary>
    /// Search for places/addresses in Iraq using Nominatim with Redis cache
    /// </summary>
    [HttpGet("search-address")]
    public async Task<IActionResult> SearchAddress(
        [FromQuery] string query, 
        [FromQuery] string countryCode = "iq")
    {
        var places = await _geocodingService.SearchPlacesAsync(query, countryCode);
        return Ok(places);
    }

    /// <summary>
    /// Reverse geocode GPS coordinates to street / neighborhood name
    /// </summary>
    [HttpGet("reverse")]
    public async Task<IActionResult> ReverseGeocode(
        [FromQuery] double lat, 
        [FromQuery] double lon)
    {
        var address = await _geocodingService.ReverseGeocodeAsync(lat, lon);
        return Ok(new { Latitude = lat, Longitude = lon, Address = address });
    }
}
