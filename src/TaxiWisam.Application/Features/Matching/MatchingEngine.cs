using Microsoft.EntityFrameworkCore;
using NetTopologySuite.Geometries;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Application.Features.Matching;

public class MatchingEngine : IMatchingEngine
{
    private readonly IApplicationDbContext _context;

    public MatchingEngine(IApplicationDbContext _context)
    {
        this._context = _context;
    }

    public async Task<List<RouteMatchResult>> FindMatchingRoutesAsync(
        Point pickupPoint,
        Point dropoffPoint,
        TimeSpan desiredTime,
        int seatsNeeded,
        double maxDetourMeters = 1500.0,
        CancellationToken cancellationToken = default)
    {
        // 1. Fetch active candidate routes that have sufficient seats
        var activeRoutes = await _context.DriverRoutes
            .Include(r => r.Driver)
                .ThenInclude(d => d.User)
            .Where(r => r.Status == "Active" && r.AvailableSeats >= seatsNeeded)
            .ToListAsync(cancellationToken);

        var matches = new List<RouteMatchResult>();

        foreach (var route in activeRoutes)
        {
            if (route.RouteGeometry == null) continue;

            // Compute distance in approximate meters (NetTopologySuite degree to meter factor ~ 111,320m)
            // Or using PostGIS / Geometry methods:
            double pickupDist = route.RouteGeometry.Distance(pickupPoint) * 111320.0;
            double dropoffDist = route.RouteGeometry.Distance(dropoffPoint) * 111320.0;

            if (pickupDist <= maxDetourMeters && dropoffDist <= maxDetourMeters)
            {
                double totalDetour = pickupDist + dropoffDist;
                
                // Calculate time difference in minutes
                double timeDiffMinutes = Math.Abs((route.DepartureTime - desiredTime).TotalMinutes);
                if (timeDiffMinutes > 60) continue; // Skip if outside 1-hour window

                // Calculate match score (0 - 100)
                double distancePenalty = (totalDetour / (maxDetourMeters * 2)) * 40.0; // max 40 points penalty
                double timePenalty = (timeDiffMinutes / 60.0) * 30.0; // max 30 points penalty
                double score = Math.Max(10.0, 100.0 - distancePenalty - timePenalty);

                matches.Add(new RouteMatchResult(
                    route.Id,
                    route.DriverId,
                    route.Driver.User.FullName,
                    route.PricePerSeat,
                    route.AvailableSeats,
                    OverlapPercentage: 85.0, // Baseline route corridor match
                    DetourDistanceMeters: Math.Round(totalDetour, 2),
                    MatchScore: Math.Round(score, 1)
                ));
            }
        }

        return matches.OrderByDescending(m => m.MatchScore).ToList();
    }
}
