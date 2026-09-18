using Microsoft.EntityFrameworkCore;
using TaxiWisam.Application.Common.Interfaces;
using TaxiWisam.Domain.Entities;

namespace TaxiWisam.Infrastructure.Persistence;

public class ApplicationDbContext : DbContext, IApplicationDbContext
{
    public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options) : base(options)
    {
    }

    public DbSet<User> Users => Set<User>();
    public DbSet<Driver> Drivers => Set<Driver>();
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Vehicle> Vehicles => Set<Vehicle>();
    public DbSet<DriverDocument> DriverDocuments => Set<DriverDocument>();
    public DbSet<DriverRoute> DriverRoutes => Set<DriverRoute>();
    public DbSet<RoutePoint> RoutePoints => Set<RoutePoint>();
    public DbSet<RouteArea> RouteAreas => Set<RouteArea>();
    public DbSet<Booking> Bookings => Set<Booking>();
    public DbSet<TransportRequest> TransportRequests => Set<TransportRequest>();
    public DbSet<ShortTripRequest> ShortTripRequests => Set<ShortTripRequest>();
    public DbSet<DriverAd> DriverAds => Set<DriverAd>();
    public DbSet<CustomerAd> CustomerAds => Set<CustomerAd>();
    public DbSet<Match> Matches => Set<Match>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<Rating> Ratings => Set<Rating>();
    public DbSet<Complaint> Complaints => Set<Complaint>();
    public DbSet<Payment> Payments => Set<Payment>();
    public DbSet<Subscription> Subscriptions => Set<Subscription>();
    public DbSet<Invoice> Invoices => Set<Invoice>();
    public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<SystemSetting> SystemSettings => Set<SystemSetting>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // 1. PostGIS Extension
        modelBuilder.HasPostgresExtension("postgis");
        modelBuilder.HasPostgresExtension("uuid-ossp");

        // 2. User
        modelBuilder.Entity<User>(entity =>
        {
            entity.ToTable("users");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Role).HasConversion<string>();
        });

        // 3. Driver
        modelBuilder.Entity<Driver>(entity =>
        {
            entity.ToTable("drivers");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Status).HasConversion<string>();
            entity.Property(e => e.CurrentLocation).HasColumnType("geometry(Point, 4326)");
            entity.HasIndex(e => e.CurrentLocation).HasMethod("GIST");
        });

        // 4. Customer
        modelBuilder.Entity<Customer>(entity =>
        {
            entity.ToTable("customers");
            entity.HasKey(e => e.Id);
        });

        // 5. Vehicle
        modelBuilder.Entity<Vehicle>(entity =>
        {
            entity.ToTable("vehicles");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.PhotoUrlsJson).HasColumnName("photo_urls").HasColumnType("jsonb");
        });

        // 6. DriverDocument
        modelBuilder.Entity<DriverDocument>(entity =>
        {
            entity.ToTable("driver_documents");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.DocumentType).HasConversion<string>();
            entity.Property(e => e.Status).HasConversion<string>();
            entity.Property(e => e.FileMetadataJson).HasColumnName("file_metadata").HasColumnType("jsonb");
        });

        // 7. DriverRoute
        modelBuilder.Entity<DriverRoute>(entity =>
        {
            entity.ToTable("driver_routes");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.StartPoint).HasColumnType("geometry(Point, 4326)");
            entity.Property(e => e.EndPoint).HasColumnType("geometry(Point, 4326)");
            entity.Property(e => e.RouteGeometry).HasColumnType("geometry(LineString, 4326)");
            entity.HasIndex(e => e.RouteGeometry).HasMethod("GIST");
            entity.HasIndex(e => e.StartPoint).HasMethod("GIST");
            entity.HasIndex(e => e.EndPoint).HasMethod("GIST");
        });

        // 8. RoutePoint
        modelBuilder.Entity<RoutePoint>(entity =>
        {
            entity.ToTable("route_points");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.PointGeometry).HasColumnType("geometry(Point, 4326)");
            entity.HasIndex(e => e.PointGeometry).HasMethod("GIST");
        });

        // 9. RouteArea
        modelBuilder.Entity<RouteArea>(entity =>
        {
            entity.ToTable("route_areas");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.AreaGeometry).HasColumnType("geometry(Polygon, 4326)");
            entity.HasIndex(e => e.AreaGeometry).HasMethod("GIST");
        });

        // 10. Booking
        modelBuilder.Entity<Booking>(entity =>
        {
            entity.ToTable("bookings");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Status).HasConversion<string>();
            entity.Property(e => e.PickupPoint).HasColumnType("geometry(Point, 4326)");
            entity.Property(e => e.DropoffPoint).HasColumnType("geometry(Point, 4326)");
            entity.HasIndex(e => e.PickupPoint).HasMethod("GIST");
            entity.HasIndex(e => e.DropoffPoint).HasMethod("GIST");
        });

        // 11. TransportRequest
        modelBuilder.Entity<TransportRequest>(entity =>
        {
            entity.ToTable("transport_requests");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.PickupPoint).HasColumnType("geometry(Point, 4326)");
            entity.Property(e => e.DropoffPoint).HasColumnType("geometry(Point, 4326)");
            entity.HasIndex(e => e.PickupPoint).HasMethod("GIST");
            entity.HasIndex(e => e.DropoffPoint).HasMethod("GIST");
        });

        // 12. ShortTripRequest
        modelBuilder.Entity<ShortTripRequest>(entity =>
        {
            entity.ToTable("short_trip_requests");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Status).HasConversion<string>();
            entity.Property(e => e.PickupPoint).HasColumnType("geometry(Point, 4326)");
            entity.Property(e => e.DropoffPoint).HasColumnType("geometry(Point, 4326)");
            entity.Property(e => e.RouteGeometry).HasColumnType("geometry(LineString, 4326)");
            entity.HasIndex(e => e.PickupPoint).HasMethod("GIST");
            entity.HasIndex(e => e.DropoffPoint).HasMethod("GIST");
        });

        // 13. DriverAd
        modelBuilder.Entity<DriverAd>(entity =>
        {
            entity.ToTable("driver_ads");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.StartPoint).HasColumnType("geometry(Point, 4326)");
            entity.Property(e => e.EndPoint).HasColumnType("geometry(Point, 4326)");
            entity.Property(e => e.RouteGeometry).HasColumnType("geometry(LineString, 4326)");
            entity.HasIndex(e => e.StartPoint).HasMethod("GIST");
            entity.HasIndex(e => e.EndPoint).HasMethod("GIST");
        });

        // 14. CustomerAd
        modelBuilder.Entity<CustomerAd>(entity =>
        {
            entity.ToTable("customer_ads");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.PickupPoint).HasColumnType("geometry(Point, 4326)");
            entity.Property(e => e.DropoffPoint).HasColumnType("geometry(Point, 4326)");
            entity.HasIndex(e => e.PickupPoint).HasMethod("GIST");
            entity.HasIndex(e => e.DropoffPoint).HasMethod("GIST");
        });

        // 15. Match
        modelBuilder.Entity<Match>(entity =>
        {
            entity.ToTable("matches");
            entity.HasKey(e => e.Id);
        });

        // 16. Notification
        modelBuilder.Entity<Notification>(entity =>
        {
            entity.ToTable("notifications");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.PayloadJson).HasColumnName("payload").HasColumnType("jsonb");
        });

        // 17. Rating
        modelBuilder.Entity<Rating>(entity =>
        {
            entity.ToTable("ratings");
            entity.HasKey(e => e.Id);
            entity.HasOne(r => r.Rater).WithMany().HasForeignKey(r => r.RaterId).OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(r => r.Rated).WithMany().HasForeignKey(r => r.RatedId).OnDelete(DeleteBehavior.Cascade);
        });

        // 18. Complaint
        modelBuilder.Entity<Complaint>(entity =>
        {
            entity.ToTable("complaints");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Status).HasConversion<string>();
            entity.Property(e => e.AttachmentPathsJson).HasColumnName("attachment_paths").HasColumnType("jsonb");
        });

        // 19. Payment
        modelBuilder.Entity<Payment>(entity =>
        {
            entity.ToTable("payments");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Status).HasConversion<string>();
        });

        // 20. Subscription
        modelBuilder.Entity<Subscription>(entity =>
        {
            entity.ToTable("subscriptions");
            entity.HasKey(e => e.Id);
        });

        // 21. Invoice
        modelBuilder.Entity<Invoice>(entity =>
        {
            entity.ToTable("invoices");
            entity.HasKey(e => e.Id);
        });

        // 22. OutboxMessage
        modelBuilder.Entity<OutboxMessage>(entity =>
        {
            entity.ToTable("outbox_messages");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.PayloadJson).HasColumnName("payload").HasColumnType("jsonb");
            entity.HasIndex(e => e.CreatedAt).HasFilter("processed_at IS NULL");
        });

        // 23. AuditLog
        modelBuilder.Entity<AuditLog>(entity =>
        {
            entity.ToTable("audit_logs");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.OldValuesJson).HasColumnName("old_values").HasColumnType("jsonb");
            entity.Property(e => e.NewValuesJson).HasColumnName("new_values").HasColumnType("jsonb");
        });

        // 24. SystemSetting
        modelBuilder.Entity<SystemSetting>(entity =>
        {
            entity.ToTable("system_settings");
            entity.HasKey(e => e.Key);
            entity.Property(e => e.ValueJson).HasColumnName("value").HasColumnType("jsonb");
        });

        // 25. RefreshToken
        modelBuilder.Entity<RefreshToken>(entity =>
        {
            entity.ToTable("refresh_tokens");
            entity.HasKey(e => e.Id);
        });
    }
}
