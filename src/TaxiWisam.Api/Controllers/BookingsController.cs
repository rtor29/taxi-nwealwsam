using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TaxiWisam.Application.Common.Interfaces;
using TaxiWisam.Application.Features.Bookings;

namespace TaxiWisam.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class BookingsController : ControllerBase
{
    private readonly IBookingService _bookingService;
    private readonly IApplicationDbContext _context;

    public BookingsController(IBookingService bookingService, IApplicationDbContext context)
    {
        _bookingService = bookingService;
        _context = context;
    }

    /// <summary>
    /// Transactional booking creation with seat reservation & Outbox message dispatch
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> CreateBooking([FromBody] CreateBookingRequest request)
    {
        var response = await _bookingService.CreateBookingAsync(request);
        if (response.BookingId == Guid.Empty)
        {
            return BadRequest(response);
        }

        return Ok(response);
    }

    /// <summary>
    /// Get passenger bookings list
    /// </summary>
    [HttpGet("customer/{customerId:guid}")]
    public async Task<IActionResult> GetCustomerBookings(Guid customerId)
    {
        var bookings = await _context.Bookings
            .Include(b => b.DriverRoute)
                .ThenInclude(r => r!.Driver)
                    .ThenInclude(d => d.User)
            .Where(b => b.CustomerId == customerId)
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new
            {
                b.Id,
                b.BookingDate,
                b.PickupName,
                b.DropoffName,
                b.SeatsBooked,
                b.TotalFare,
                Status = b.Status.ToString(),
                DriverName = b.DriverRoute != null ? b.DriverRoute.Driver.User.FullName : null
            })
            .ToListAsync();

        return Ok(bookings);
    }
}
