using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using NetTopologySuite.Geometries;
using TaxiWisam.Application.Common.Interfaces;
using TaxiWisam.Domain.Entities;
using TaxiWisam.Domain.Enums;

namespace TaxiWisam.Application.Features.Bookings;

public record CreateBookingRequest(
    Guid CustomerId,
    Guid DriverRouteId,
    int SeatsBooked,
    string PickupName,
    string DropoffName,
    double PickupLat,
    double PickupLon,
    double DropoffLat,
    double DropoffLon,
    DateOnly BookingDate
);

public record BookingResponse(
    Guid BookingId,
    BookingStatus Status,
    decimal TotalFare,
    string Message
);

public interface IBookingService
{
    Task<BookingResponse> CreateBookingAsync(CreateBookingRequest request, CancellationToken cancellationToken = default);
}

public class BookingService : IBookingService
{
    private readonly IApplicationDbContext _context;
    private readonly IRedisCacheService _cache;

    public BookingService(IApplicationDbContext context, IRedisCacheService cache)
    {
        _context = context;
        _cache = cache;
    }

    public async Task<BookingResponse> CreateBookingAsync(
        CreateBookingRequest request, 
        CancellationToken cancellationToken = default)
    {
        string lockKey = $"lock:route_seats:{request.DriverRouteId}";
        bool lockAcquired = await _cache.AcquireLockAsync(lockKey, TimeSpan.FromSeconds(10));
        
        if (!lockAcquired)
        {
            return new BookingResponse(Guid.Empty, BookingStatus.Cancelled, 0, "System busy processing route bookings, please retry.");
        }

        try
        {
            var route = await _context.DriverRoutes
                .FirstOrDefaultAsync(r => r.Id == request.DriverRouteId, cancellationToken);

            if (route == null)
            {
                return new BookingResponse(Guid.Empty, BookingStatus.Cancelled, 0, "Selected route not found.");
            }

            if (route.AvailableSeats < request.SeatsBooked)
            {
                return new BookingResponse(Guid.Empty, BookingStatus.Cancelled, 0, "Insufficient seats available on this route.");
            }

            decimal totalFare = route.PricePerSeat * request.SeatsBooked;

            // 1. Decrement Available Seats
            route.AvailableSeats -= request.SeatsBooked;
            route.UpdatedAt = DateTime.UtcNow;

            // 2. Create Booking Entity
            var booking = new Booking
            {
                CustomerId = request.CustomerId,
                DriverRouteId = request.DriverRouteId,
                SeatsBooked = request.SeatsBooked,
                PickupName = request.PickupName,
                DropoffName = request.DropoffName,
                PickupPoint = new Point(request.PickupLon, request.PickupLat) { SRID = 4326 },
                DropoffPoint = new Point(request.DropoffLon, request.DropoffLat) { SRID = 4326 },
                BookingDate = request.BookingDate,
                TotalFare = totalFare,
                Status = BookingStatus.Confirmed
            };
            _context.Bookings.Add(booking);

            // 3. Create OutboxMessage (Transactional Outbox Pattern)
            var outboxPayload = new
            {
                BookingId = booking.Id,
                CustomerId = request.CustomerId,
                DriverRouteId = request.DriverRouteId,
                SeatsBooked = request.SeatsBooked,
                TotalFare = totalFare,
                CreatedAt = DateTime.UtcNow
            };

            var outboxMessage = new OutboxMessage
            {
                EventType = "BookingCreated",
                AggregateType = "Booking",
                AggregateId = booking.Id.ToString(),
                PayloadJson = JsonSerializer.Serialize(outboxPayload)
            };
            _context.OutboxMessages.Add(outboxMessage);

            // 4. Save Changes atomically
            await _context.SaveChangesAsync(cancellationToken);

            return new BookingResponse(booking.Id, booking.Status, totalFare, "Booking confirmed successfully.");
        }
        finally
        {
            await _cache.ReleaseLockAsync(lockKey);
        }
    }
}
