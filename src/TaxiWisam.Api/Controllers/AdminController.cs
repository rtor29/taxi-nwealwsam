using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TaxiWisam.Application.Common.Interfaces;
using TaxiWisam.Domain.Entities;
using TaxiWisam.Domain.Enums;

namespace TaxiWisam.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AdminController : ControllerBase
{
    private readonly IApplicationDbContext _context;
    private readonly ISupabaseStorageService _storageService;

    public AdminController(
        IApplicationDbContext context,
        ISupabaseStorageService storageService)
    {
        _context = context;
        _storageService = storageService;
    }

    // -------------------------------------------------------------------------
    // 1. Dashboard Overview & KPIs
    // -------------------------------------------------------------------------
    [HttpGet("stats")]
    public async Task<IActionResult> GetDashboardStats()
    {
        var totalUsers = await _context.Users.CountAsync();
        var totalDrivers = await _context.Drivers.CountAsync();
        var verifiedDrivers = await _context.Drivers.CountAsync(d => d.IsVerified);
        var pendingVerifications = await _context.DriverDocuments.CountAsync(d => d.Status == DocumentStatus.Pending);
        var activeRoutes = await _context.DriverRoutes.CountAsync(r => r.Status == "Active");
        var totalBookings = await _context.Bookings.CountAsync();
        var pendingComplaints = await _context.Complaints.CountAsync(c => c.Status == ComplaintStatus.Pending);
        var totalRevenue = await _context.Payments
            .Where(p => p.Status == PaymentStatus.Completed)
            .SumAsync(p => (decimal?)p.Amount) ?? 0.00m;

        return Ok(new
        {
            TotalUsers = totalUsers,
            TotalDrivers = totalDrivers,
            VerifiedDrivers = verifiedDrivers,
            PendingVerifications = pendingVerifications,
            ActiveRoutes = activeRoutes,
            TotalBookings = totalBookings,
            PendingComplaints = pendingComplaints,
            TotalRevenue = totalRevenue
        });
    }

    // -------------------------------------------------------------------------
    // 2. Drivers Management & Verification
    // -------------------------------------------------------------------------
    [HttpGet("drivers")]
    public async Task<IActionResult> GetDrivers(
        [FromQuery] bool? isVerified = null,
        [FromQuery] DriverStatus? status = null,
        [FromQuery] string? search = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20)
    {
        var query = _context.Drivers
            .Include(d => d.User)
            .Include(d => d.Vehicles)
            .Include(d => d.Documents)
            .AsQueryable();

        if (isVerified.HasValue)
            query = query.Where(d => d.IsVerified == isVerified.Value);

        if (status.HasValue)
            query = query.Where(d => d.Status == status.Value);

        if (!string.IsNullOrWhiteSpace(search))
        {
            query = query.Where(d => d.User.FullName.Contains(search) 
                                  || d.User.PhoneNumber.Contains(search) 
                                  || d.LicenseNumber.Contains(search));
        }

        var total = await query.CountAsync();
        var drivers = await query
            .OrderByDescending(d => d.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(d => new
            {
                DriverId = d.Id,
                d.User.FullName,
                d.User.PhoneNumber,
                d.LicenseNumber,
                Status = d.Status.ToString(),
                d.IsVerified,
                d.RatingAverage,
                d.TotalTrips,
                d.CreatedAt,
                VehiclesCount = d.Vehicles.Count,
                PendingDocumentsCount = d.Documents.Count(doc => doc.Status == DocumentStatus.Pending)
            })
            .ToListAsync();

        return Ok(new { Total = total, Page = page, PageSize = pageSize, Drivers = drivers });
    }

    [HttpGet("drivers/{id:guid}")]
    public async Task<IActionResult> GetDriverDetails(Guid id)
    {
        var driver = await _context.Drivers
            .Include(d => d.User)
            .Include(d => d.Vehicles)
            .Include(d => d.Documents)
            .Include(d => d.Routes)
            .FirstOrDefaultAsync(d => d.Id == id);

        if (driver == null) return NotFound();

        // Generate Signed URLs for all documents so the admin can safely view them
        var documentsWithSignedUrls = new List<object>();
        foreach (var doc in driver.Documents)
        {
            string signedUrl = string.Empty;
            try
            {
                signedUrl = await _storageService.CreateSignedUrlAsync(doc.BucketName, doc.FilePath, 3600);
            }
            catch
            {
                // Fallback in case of storage connection latency
                signedUrl = string.Empty;
            }

            documentsWithSignedUrls.Add(new
            {
                doc.Id,
                DocumentType = doc.DocumentType.ToString(),
                Status = doc.Status.ToString(),
                doc.FilePath,
                doc.RejectionReason,
                doc.VerifiedAt,
                doc.CreatedAt,
                SignedUrl = signedUrl
            });
        }

        return Ok(new
        {
            DriverId = driver.Id,
            driver.User.FullName,
            driver.User.PhoneNumber,
            driver.User.Email,
            driver.LicenseNumber,
            Status = driver.Status.ToString(),
            driver.IsVerified,
            driver.RatingAverage,
            driver.TotalTrips,
            driver.CreatedAt,
            Vehicles = driver.Vehicles.Select(v => new
            {
                v.Id,
                v.PlateNumber,
                v.Make,
                v.Model,
                v.Year,
                v.Color,
                v.TotalSeats,
                v.VehicleType
            }),
            Documents = documentsWithSignedUrls,
            RoutesCount = driver.Routes.Count
        });
    }

    [HttpPost("documents/{id:guid}/verify")]
    public async Task<IActionResult> VerifyDocument(
        Guid id, 
        [FromBody] VerifyDocumentRequest request,
        [FromQuery] Guid? adminId = null)
    {
        var doc = await _context.DriverDocuments.FindAsync(id);
        if (doc == null) return NotFound(new { error = "Document not found" });

        doc.Status = request.Approved ? DocumentStatus.Approved : DocumentStatus.Rejected;
        doc.RejectionReason = request.Approved ? null : request.RejectionReason;
        doc.VerifiedAt = DateTime.UtcNow;
        doc.VerifiedBy = adminId;
        doc.UpdatedAt = DateTime.UtcNow;

        // Auto-verify the driver if all documents are approved
        if (request.Approved)
        {
            var otherDocs = await _context.DriverDocuments
                .Where(d => d.DriverId == doc.DriverId && d.Id != id)
                .ToListAsync();

            if (otherDocs.All(d => d.Status == DocumentStatus.Approved))
            {
                var driver = await _context.Drivers.FindAsync(doc.DriverId);
                if (driver != null)
                {
                    driver.IsVerified = true;
                    driver.UpdatedAt = DateTime.UtcNow;
                }
            }
        }
        else
        {
            // If any document is rejected, driver cannot be verified
            var driver = await _context.Drivers.FindAsync(doc.DriverId);
            if (driver != null)
            {
                driver.IsVerified = false;
                driver.UpdatedAt = DateTime.UtcNow;
            }
        }

        // Record Audit Log
        _context.AuditLogs.Add(new AuditLog
        {
            UserId = adminId,
            Action = request.Approved ? "ApproveDriverDocument" : "RejectDriverDocument",
            EntityName = "DriverDocument",
            EntityId = doc.Id.ToString(),
            NewValuesJson = JsonSerializer.Serialize(new { doc.Status, doc.RejectionReason })
        });

        await _context.SaveChangesAsync();
        return Ok(new { doc.Id, Status = doc.Status.ToString(), doc.VerifiedAt });
    }

    // -------------------------------------------------------------------------
    // 3. Customers Management
    // -------------------------------------------------------------------------
    [HttpGet("customers")]
    public async Task<IActionResult> GetCustomers(
        [FromQuery] string? search = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20)
    {
        var query = _context.Customers
            .Include(c => c.User)
            .Include(c => c.Bookings)
            .AsQueryable();

        if (!string.IsNullOrWhiteSpace(search))
        {
            query = query.Where(c => c.User.FullName.Contains(search) || c.User.PhoneNumber.Contains(search));
        }

        var total = await query.CountAsync();
        var customers = await query
            .OrderByDescending(c => c.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(c => new
            {
                CustomerId = c.Id,
                c.User.FullName,
                c.User.PhoneNumber,
                c.User.IsActive,
                c.EmergencyPhone,
                c.PreferredPaymentMethod,
                c.RatingAverage,
                c.CreatedAt,
                TotalBookings = c.Bookings.Count
            })
            .ToListAsync();

        return Ok(new { Total = total, Page = page, PageSize = pageSize, Customers = customers });
    }

    [HttpPost("users/{id:guid}/toggle-active")]
    public async Task<IActionResult> ToggleUserActive(Guid id)
    {
        var user = await _context.Users.FindAsync(id);
        if (user == null) return NotFound();

        user.IsActive = !user.IsActive;
        user.UpdatedAt = DateTime.UtcNow;
        await _context.SaveChangesAsync();

        return Ok(new { user.Id, user.IsActive });
    }

    // -------------------------------------------------------------------------
    // 4. Routes & Bookings
    // -------------------------------------------------------------------------
    [HttpGet("routes")]
    public async Task<IActionResult> GetRoutes(
        [FromQuery] string? status = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20)
    {
        var query = _context.DriverRoutes
            .Include(r => r.Driver)
                .ThenInclude(d => d.User)
            .AsQueryable();

        if (!string.IsNullOrWhiteSpace(status))
            query = query.Where(r => r.Status == status);

        var total = await query.CountAsync();
        var routes = await query
            .OrderByDescending(r => r.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(r => new
            {
                RouteId = r.Id,
                DriverName = r.Driver.User.FullName,
                DriverPhone = r.Driver.User.PhoneNumber,
                r.RouteName,
                r.StartName,
                r.EndName,
                r.DepartureTime,
                r.AvailableSeats,
                r.PricePerSeat,
                r.IsRecurring,
                r.Status,
                r.CreatedAt
            })
            .ToListAsync();

        return Ok(new { Total = total, Page = page, PageSize = pageSize, Routes = routes });
    }

    [HttpGet("bookings")]
    public async Task<IActionResult> GetBookings(
        [FromQuery] BookingStatus? status = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20)
    {
        var query = _context.Bookings
            .Include(b => b.Customer)
                .ThenInclude(c => c.User)
            .Include(b => b.DriverRoute)
                .ThenInclude(r => r!.Driver)
                    .ThenInclude(d => d.User)
            .AsQueryable();

        if (status.HasValue)
            query = query.Where(b => b.Status == status.Value);

        var total = await query.CountAsync();
        var bookings = await query
            .OrderByDescending(b => b.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(b => new
            {
                BookingId = b.Id,
                CustomerName = b.Customer.User.FullName,
                CustomerPhone = b.Customer.User.PhoneNumber,
                DriverName = b.DriverRoute != null ? b.DriverRoute.Driver.User.FullName : "N/A",
                b.PickupName,
                b.DropoffName,
                b.BookingDate,
                b.SeatsBooked,
                b.TotalFare,
                Status = b.Status.ToString(),
                b.CreatedAt
            })
            .ToListAsync();

        return Ok(new { Total = total, Page = page, PageSize = pageSize, Bookings = bookings });
    }

    // -------------------------------------------------------------------------
    // 5. Complaints Management
    // -------------------------------------------------------------------------
    [HttpGet("complaints")]
    public async Task<IActionResult> GetComplaints(
        [FromQuery] ComplaintStatus? status = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20)
    {
        var query = _context.Complaints
            .Include(c => c.User)
            .Include(c => c.TargetUser)
            .AsQueryable();

        if (status.HasValue)
            query = query.Where(c => c.Status == status.Value);

        var total = await query.CountAsync();
        var complaints = await query
            .OrderByDescending(c => c.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .Select(c => new
            {
                ComplaintId = c.Id,
                ComplainantName = c.User.FullName,
                TargetUserName = c.TargetUser != null ? c.TargetUser.FullName : null,
                c.Category,
                c.Description,
                Status = c.Status.ToString(),
                c.AdminNotes,
                c.CreatedAt,
                c.ResolvedAt
            })
            .ToListAsync();

        return Ok(new { Total = total, Page = page, PageSize = pageSize, Complaints = complaints });
    }

    [HttpPut("complaints/{id:guid}")]
    public async Task<IActionResult> UpdateComplaint(
        Guid id, 
        [FromBody] UpdateComplaintRequest request,
        [FromQuery] Guid? adminId = null)
    {
        var complaint = await _context.Complaints.FindAsync(id);
        if (complaint == null) return NotFound();

        complaint.Status = request.Status;
        complaint.AdminNotes = request.AdminNotes;
        if (request.Status == ComplaintStatus.Resolved || request.Status == ComplaintStatus.Dismissed)
        {
            complaint.ResolvedAt = DateTime.UtcNow;
            complaint.ResolvedBy = adminId;
        }
        complaint.UpdatedAt = DateTime.UtcNow;

        await _context.SaveChangesAsync();
        return Ok(new { complaint.Id, Status = complaint.Status.ToString(), complaint.ResolvedAt });
    }

    // -------------------------------------------------------------------------
    // 6. System Settings & Matching Configuration
    // -------------------------------------------------------------------------
    [HttpGet("settings")]
    public async Task<IActionResult> GetSettings()
    {
        var settings = await _context.SystemSettings.ToListAsync();
        return Ok(settings);
    }

    [HttpPut("settings/{key}")]
    public async Task<IActionResult> UpdateSetting(string key, [FromBody] UpdateSettingRequest request)
    {
        var setting = await _context.SystemSettings.FindAsync(key);
        if (setting == null)
        {
            setting = new SystemSetting
            {
                Key = key,
                ValueJson = request.ValueJson,
                Description = request.Description,
                UpdatedAt = DateTime.UtcNow
            };
            _context.SystemSettings.Add(setting);
        }
        else
        {
            setting.ValueJson = request.ValueJson;
            if (!string.IsNullOrWhiteSpace(request.Description))
                setting.Description = request.Description;
            setting.UpdatedAt = DateTime.UtcNow;
        }

        await _context.SaveChangesAsync();
        return Ok(setting);
    }

    // -------------------------------------------------------------------------
    // 7. Audit Logs
    // -------------------------------------------------------------------------
    [HttpGet("audit-logs")]
    public async Task<IActionResult> GetAuditLogs([FromQuery] int page = 1, [FromQuery] int pageSize = 50)
    {
        var query = _context.AuditLogs.OrderByDescending(a => a.CreatedAt);
        var total = await query.CountAsync();
        var logs = await query.Skip((page - 1) * pageSize).Take(pageSize).ToListAsync();

        return Ok(new { Total = total, Page = page, PageSize = pageSize, Logs = logs });
    }
}

public record UpdateComplaintRequest(ComplaintStatus Status, string? AdminNotes);
public record UpdateSettingRequest(string ValueJson, string? Description);
