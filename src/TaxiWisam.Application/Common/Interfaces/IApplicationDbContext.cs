using Microsoft.EntityFrameworkCore;
using TaxiWisam.Domain.Entities;

namespace TaxiWisam.Application.Common.Interfaces;

public interface IApplicationDbContext
{
    DbSet<User> Users { get; }
    DbSet<Driver> Drivers { get; }
    DbSet<Customer> Customers { get; }
    DbSet<Vehicle> Vehicles { get; }
    DbSet<DriverDocument> DriverDocuments { get; }
    DbSet<DriverRoute> DriverRoutes { get; }
    DbSet<RoutePoint> RoutePoints { get; }
    DbSet<RouteArea> RouteAreas { get; }
    DbSet<Booking> Bookings { get; }
    DbSet<TransportRequest> TransportRequests { get; }
    DbSet<ShortTripRequest> ShortTripRequests { get; }
    DbSet<DriverAd> DriverAds { get; }
    DbSet<CustomerAd> CustomerAds { get; }
    DbSet<Match> Matches { get; }
    DbSet<Notification> Notifications { get; }
    DbSet<Rating> Ratings { get; }
    DbSet<Complaint> Complaints { get; }
    DbSet<Payment> Payments { get; }
    DbSet<Subscription> Subscriptions { get; }
    DbSet<Invoice> Invoices { get; }
    DbSet<OutboxMessage> OutboxMessages { get; }
    DbSet<AuditLog> AuditLogs { get; }
    DbSet<SystemSetting> SystemSettings { get; }
    DbSet<RefreshToken> RefreshTokens { get; }

    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
