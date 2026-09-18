using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using NetTopologySuite.Geometries;
using TaxiWisam.Application.Common.Interfaces;
using TaxiWisam.Domain.Entities;
using TaxiWisam.Domain.Enums;

namespace TaxiWisam.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class DriversController : ControllerBase
{
    private readonly IApplicationDbContext _context;
    private readonly IRedisCacheService _cache;

    public DriversController(IApplicationDbContext context, IRedisCacheService cache)
    {
        _context = context;
        _cache = cache;
    }

    /// <summary>
    /// Find nearby online drivers using PostGIS Spatial Functions
    /// </summary>
    [HttpGet("nearby")]
    public async Task<IActionResult> GetNearbyDrivers(
        [FromQuery] double lat, 
        [FromQuery] double lon, 
        [FromQuery] double radiusMeters = 5000)
    {
        var targetPoint = new Point(lon, lat) { SRID = 4326 };

        // PostGIS query on Spatial Index
        var drivers = await _context.Drivers
            .Include(d => d.User)
            .Where(d => d.Status == DriverStatus.Online 
                     && d.IsVerified 
                     && d.CurrentLocation != null 
                     && d.CurrentLocation.IsWithinDistance(targetPoint, radiusMeters / 111320.0))
            .Select(d => new
            {
                DriverId = d.Id,
                d.User.FullName,
                d.User.PhoneNumber,
                d.RatingAverage,
                d.TotalTrips,
                Latitude = d.CurrentLocation!.Y,
                Longitude = d.CurrentLocation!.X,
                d.CurrentHeading
            })
            .Take(25)
            .ToListAsync();

        return Ok(drivers);
    }

    /// <summary>
    /// Update Driver Status (Online/Offline) with Redis Fast State synchronization
    /// </summary>
    [HttpPost("{id:guid}/status")]
    public async Task<IActionResult> UpdateStatus(Guid id, [FromBody] UpdateStatusRequest request)
    {
        var driver = await _context.Drivers.FindAsync(id);
        if (driver == null) return NotFound();

        driver.Status = request.Status;
        driver.UpdatedAt = DateTime.UtcNow;

        // Synchronize with Redis fast temporary layer
        await _cache.SetDriverOnlineStatusAsync(id, request.Status == DriverStatus.Online);

        await _context.SaveChangesAsync();
        return Ok(new { driver.Id, Status = driver.Status.ToString() });
    }

    /// <summary>
    /// Create a recurring driver commute route with PostGIS LineString geometry
    /// </summary>
    [HttpPost("{id:guid}/routes")]
    public async Task<IActionResult> CreateRoute(Guid id, [FromBody] CreateRouteRequest request)
    {
        var driver = await _context.Drivers.FindAsync(id);
        if (driver == null) return NotFound();

        // Convert coordinate arrays to NetTopologySuite LineString
        var coordinates = request.Coordinates
            .Select(c => new Coordinate(c.Longitude, c.Latitude))
            .ToArray();

        var routeGeom = new LineString(coordinates) { SRID = 4326 };
        var startPoint = new Point(coordinates.First()) { SRID = 4326 };
        var endPoint = new Point(coordinates.Last()) { SRID = 4326 };

        var route = new DriverRoute
        {
            DriverId = id,
            RouteName = request.RouteName,
            StartName = request.StartName,
            EndName = request.EndName,
            StartPoint = startPoint,
            EndPoint = endPoint,
            RouteGeometry = routeGeom,
            BufferDistanceMeters = request.BufferDistanceMeters,
            DepartureTime = request.DepartureTime,
            AvailableSeats = request.AvailableSeats,
            PricePerSeat = request.PricePerSeat,
            IsRecurring = request.IsRecurring,
            RecurringDays = request.RecurringDays
        };

        _context.DriverRoutes.Add(route);
        await _context.SaveChangesAsync();

        return Ok(new { RouteId = route.Id, route.RouteName, route.AvailableSeats, route.PricePerSeat });
    }
}

public record UpdateStatusRequest(DriverStatus Status);

public record LatLonDto(double Latitude, double Longitude);

public record CreateRouteRequest(
    string RouteName,
    string StartName,
    string EndName,
    List<LatLonDto> Coordinates,
    decimal BufferDistanceMeters,
    TimeSpan DepartureTime,
    int AvailableSeats,
    decimal PricePerSeat,
    bool IsRecurring,
    string RecurringDays
);
