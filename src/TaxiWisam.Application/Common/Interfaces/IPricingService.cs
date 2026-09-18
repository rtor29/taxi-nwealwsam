namespace TaxiWisam.Application.Common.Interfaces;

public record TripFareEstimate(
    decimal TotalFare,
    decimal BaseFare,
    decimal DistanceFare,
    decimal TimeFare,
    double DistanceKm,
    double DurationMinutes,
    decimal SurgeMultiplier,
    string Currency
);

public interface IPricingService
{
    Task<TripFareEstimate> CalculateTripFareAsync(
        double distanceMeters, 
        double durationSeconds, 
        decimal surgeMultiplier = 1.0m,
        CancellationToken cancellationToken = default);
}
