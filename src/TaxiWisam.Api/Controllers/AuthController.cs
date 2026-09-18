using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TaxiWisam.Application.Common.Interfaces;
using TaxiWisam.Domain.Entities;
using TaxiWisam.Domain.Enums;

namespace TaxiWisam.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    private readonly IApplicationDbContext _context;

    public AuthController(IApplicationDbContext context)
    {
        _context = context;
    }

    [HttpPost("register")]
    public async Task<IActionResult> Register([FromBody] RegisterRequest request)
    {
        if (await _context.Users.AnyAsync(u => u.PhoneNumber == request.PhoneNumber))
        {
            return BadRequest(new { error = "Phone number is already registered" });
        }

        var user = new User
        {
            PhoneNumber = request.PhoneNumber,
            Email = request.Email,
            FullName = request.FullName,
            Role = request.Role
        };

        if (request.Role == UserRole.Driver)
        {
            user.Driver = new Driver
            {
                LicenseNumber = request.LicenseNumber ?? Guid.NewGuid().ToString().Substring(0, 8),
                Status = DriverStatus.Offline
            };
        }
        else if (request.Role == UserRole.Customer)
        {
            user.Customer = new Customer();
        }

        _context.Users.Add(user);
        await _context.SaveChangesAsync();

        return Ok(new { userId = user.Id, fullName = user.FullName, role = user.Role.ToString() });
    }

    [HttpGet("me")]
    public async Task<IActionResult> GetProfile([FromQuery] Guid userId)
    {
        var user = await _context.Users
            .Include(u => u.Driver)
            .Include(u => u.Customer)
            .FirstOrDefaultAsync(u => u.Id == userId);

        if (user == null) return NotFound();

        return Ok(new
        {
            user.Id,
            user.PhoneNumber,
            user.Email,
            user.FullName,
            Role = user.Role.ToString(),
            IsDriverVerified = user.Driver?.IsVerified
        });
    }
}

public record RegisterRequest(
    string PhoneNumber, 
    string FullName, 
    string? Email, 
    UserRole Role, 
    string? LicenseNumber
);
