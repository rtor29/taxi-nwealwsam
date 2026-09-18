using Microsoft.AspNetCore.Mvc;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class PricingController : ControllerBase
{
    private readonly IPricingService _pricingService;
    private readonly IRoutingService _routingService;

    public PricingController(
        IPricingService pricingService, 
        IRoutingService routingService)
    {
        _pricingService = pricingService;
        _routingService = routingService;
    }

    /// <summary>
    /// Estimate ride fare based on road distance, duration, and dynamic system settings
    /// </summary>
    [HttpPost("estimate")]
    public async Task<IActionResult> EstimateFare([FromBody] EstimateFareRequest request)
    {
        double distanceMeters = request.DistanceMeters ?? 0;
        double durationSeconds = request.DurationSeconds ?? 0;

        // If coordinates provided, fetch actual road distance and duration via OSRM
        if (request.StartLat.HasValue && request.StartLon.HasValue && 
            request.EndLat.HasValue && request.EndLon.HasValue)
        {
            var route = await _routingService.GetDrivingRouteAsync(
                request.StartLat.Value, 
                request.StartLon.Value, 
                request.EndLat.Value, 
                request.EndLon.Value);

            distanceMeters = route.DistanceMeters;
            durationSeconds = route.DurationSeconds;
        }

        var estimate = await _pricingService.CalculateTripFareAsync(
            distanceMeters, 
            durationSeconds, 
            request.SurgeMultiplier ?? 1.0m);

        return Ok(estimate);
    }
}

public record EstimateFareRequest(
    double? StartLat,
    double? StartLon,
    double? EndLat,
    double? EndLon,
    double? DistanceMeters,
    double? DurationSeconds,
    decimal? SurgeMultiplier
);
