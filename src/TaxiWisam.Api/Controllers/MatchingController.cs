using Microsoft.AspNetCore.Mvc;
using NetTopologySuite.Geometries;
using TaxiWisam.Application.Features.Matching;

namespace TaxiWisam.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class MatchingController : ControllerBase
{
    private readonly IMatchingEngine _matchingEngine;

    public MatchingController(IMatchingEngine matchingEngine)
    {
        _matchingEngine = matchingEngine;
    }

    /// <summary>
    /// Find matching driver routes for a passenger's pickup and dropoff points
    /// </summary>
    [HttpPost("find-routes")]
    public async Task<IActionResult> FindMatchingRoutes([FromBody] FindMatchesRequest request)
    {
        var pickup = new Point(request.PickupLon, request.PickupLat) { SRID = 4326 };
        var dropoff = new Point(request.DropoffLon, request.DropoffLat) { SRID = 4326 };

        var matches = await _matchingEngine.FindMatchingRoutesAsync(
            pickup, 
            dropoff, 
            request.DesiredTime, 
            request.SeatsNeeded, 
            request.MaxDetourMeters);

        return Ok(matches);
    }
}

public record FindMatchesRequest(
    double PickupLat,
    double PickupLon,
    double DropoffLat,
    double DropoffLon,
    TimeSpan DesiredTime,
    int SeatsNeeded,
    double MaxDetourMeters = 1500.0
);
