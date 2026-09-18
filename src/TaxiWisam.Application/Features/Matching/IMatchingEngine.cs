using NetTopologySuite.Geometries;

namespace TaxiWisam.Application.Features.Matching;

public record RouteMatchResult(
    Guid DriverRouteId,
    Guid DriverId,
    string DriverName,
    decimal PricePerSeat,
    int AvailableSeats,
    double OverlapPercentage,
    double DetourDistanceMeters,
    double MatchScore
);

public interface IMatchingEngine
{
    Task<List<RouteMatchResult>> FindMatchingRoutesAsync(
        Point pickupPoint,
        Point dropoffPoint,
        TimeSpan desiredTime,
        int seatsNeeded,
        double maxDetourMeters = 1500.0,
        CancellationToken cancellationToken = default);
}
