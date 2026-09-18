using NetTopologySuite.Geometries;

namespace TaxiWisam.Application.Common.Interfaces;

public record RouteStepDto(
    string Instruction,
    double DistanceMeters,
    double DurationSeconds,
    string RoadName
);

public record DrivingRouteResult(
    LineString RouteGeometry,
    double DistanceMeters,
    double DurationSeconds,
    List<RouteStepDto> Steps,
    List<Coordinate> PolylinePoints
);

public interface IRoutingService
{
    Task<DrivingRouteResult> GetDrivingRouteAsync(
        double startLat, 
        double startLon, 
        double endLat, 
        double endLon, 
        CancellationToken cancellationToken = default);

    Task<double> CalculateDrivingDistanceAsync(
        double startLat, 
        double startLon, 
        double endLat, 
        double endLon, 
        CancellationToken cancellationToken = default);
}
