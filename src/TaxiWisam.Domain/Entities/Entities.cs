using NetTopologySuite.Geometries;
using TaxiWisam.Domain.Common;
using TaxiWisam.Domain.Enums;

namespace TaxiWisam.Domain.Entities;

// 1. User
public class User : AuditableEntity
{
    public string PhoneNumber { get; set; } = string.Empty;
    public string? Email { get; set; }
    public string FullName { get; set; } = string.Empty;
    public UserRole Role { get; set; } = UserRole.Customer;
    public string? ProfilePictureUrl { get; set; }
    public bool IsActive { get; set; } = true;

    // Navigation
    public Driver? Driver { get; set; }
    public Customer? Customer { get; set; }
    public ICollection<Notification> Notifications { get; set; } = new List<Notification>();
    public ICollection<RefreshToken> RefreshTokens { get; set; } = new List<RefreshToken>();
}

// 2. Driver
public class Driver : AuditableEntity
{
    public string LicenseNumber { get; set; } = string.Empty;
    public DriverStatus Status { get; set; } = DriverStatus.Offline;
    public bool IsVerified { get; set; } = false;
    public decimal RatingAverage { get; set; } = 5.00m;
    public int TotalTrips { get; set; } = 0;
    public Point? CurrentLocation { get; set; }
    public decimal? CurrentHeading { get; set; }
    public DateTime? LastLocationUpdatedAt { get; set; }

    // Navigation
    public User User { get; set; } = null!;
    public ICollection<Vehicle> Vehicles { get; set; } = new List<Vehicle>();
    public ICollection<DriverDocument> Documents { get; set; } = new List<DriverDocument>();
    public ICollection<DriverRoute> Routes { get; set; } = new List<DriverRoute>();
    public ICollection<DriverAd> Ads { get; set; } = new List<DriverAd>();
    public ICollection<Subscription> Subscriptions { get; set; } = new List<Subscription>();
}

// 3. Customer
public class Customer : AuditableEntity
{
    public string? EmergencyPhone { get; set; }
    public string PreferredPaymentMethod { get; set; } = "Cash";
    public decimal RatingAverage { get; set; } = 5.00m;

    // Navigation
    public User User { get; set; } = null!;
    public ICollection<Booking> Bookings { get; set; } = new List<Booking>();
    public ICollection<TransportRequest> TransportRequests { get; set; } = new List<TransportRequest>();
    public ICollection<ShortTripRequest> ShortTripRequests { get; set; } = new List<ShortTripRequest>();
    public ICollection<CustomerAd> CustomerAds { get; set; } = new List<CustomerAd>();
}

// 4. Vehicle
public class Vehicle : AuditableEntity
{
    public Guid DriverId { get; set; }
    public string PlateNumber { get; set; } = string.Empty;
    public string Make { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public int Year { get; set; }
    public string Color { get; set; } = string.Empty;
    public int TotalSeats { get; set; } = 4;
    public string VehicleType { get; set; } = "Sedan";
    public string PhotoUrlsJson { get; set; } = "[]";
    public bool IsActive { get; set; } = true;

    // Navigation
    public Driver Driver { get; set; } = null!;
}

// 5. DriverDocument (Private storage)
public class DriverDocument : AuditableEntity
{
    public Guid DriverId { get; set; }
    public DocumentType DocumentType { get; set; }
    public string BucketName { get; set; } = "driver-documents";
    public string FilePath { get; set; } = string.Empty;
    public string FileMetadataJson { get; set; } = "{}";
    public DocumentStatus Status { get; set; } = DocumentStatus.Pending;
    public string? RejectionReason { get; set; }
    public DateTime? VerifiedAt { get; set; }
    public Guid? VerifiedBy { get; set; }

    // Navigation
    public Driver Driver { get; set; } = null!;
}

// 6. DriverRoute
public class DriverRoute : AuditableEntity
{
    public Guid DriverId { get; set; }
    public Guid? VehicleId { get; set; }
    public string RouteName { get; set; } = string.Empty;
    public string StartName { get; set; } = string.Empty;
    public string EndName { get; set; } = string.Empty;
    public Point StartPoint { get; set; } = null!;
    public Point EndPoint { get; set; } = null!;
    public LineString RouteGeometry { get; set; } = null!;
    public decimal BufferDistanceMeters { get; set; } = 1000.0m;
    public TimeSpan DepartureTime { get; set; }
    public int EstimatedDurationMinutes { get; set; } = 60;
    public int AvailableSeats { get; set; } = 4;
    public decimal PricePerSeat { get; set; }
    public bool IsRecurring { get; set; } = true;
    public string RecurringDays { get; set; } = "1,2,3,4,5";
    public string Status { get; set; } = "Active";

    // Navigation
    public Driver Driver { get; set; } = null!;
    public Vehicle? Vehicle { get; set; }
    public ICollection<RoutePoint> Points { get; set; } = new List<RoutePoint>();
    public ICollection<RouteArea> Areas { get; set; } = new List<RouteArea>();
    public ICollection<Booking> Bookings { get; set; } = new List<Booking>();
}

// 7. RoutePoint
public class RoutePoint : BaseEntity
{
    public Guid RouteId { get; set; }
    public int SequenceOrder { get; set; }
    public string StopName { get; set; } = string.Empty;
    public Point PointGeometry { get; set; } = null!;
    public int EstimatedMinutesFromStart { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public DriverRoute Route { get; set; } = null!;
}

// 8. RouteArea
public class RouteArea : BaseEntity
{
    public Guid? RouteId { get; set; }
    public string AreaName { get; set; } = string.Empty;
    public string AreaType { get; set; } = "Coverage";
    public Polygon AreaGeometry { get; set; } = null!;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public DriverRoute? Route { get; set; }
}

// 9. Booking
public class Booking : AuditableEntity
{
    public Guid CustomerId { get; set; }
    public Guid? DriverRouteId { get; set; }
    public int SeatsBooked { get; set; } = 1;
    public string PickupName { get; set; } = string.Empty;
    public string DropoffName { get; set; } = string.Empty;
    public Point PickupPoint { get; set; } = null!;
    public Point DropoffPoint { get; set; } = null!;
    public DateOnly BookingDate { get; set; }
    public decimal TotalFare { get; set; }
    public BookingStatus Status { get; set; } = BookingStatus.Pending;
    public string? CancellationReason { get; set; }

    // Navigation
    public Customer Customer { get; set; } = null!;
    public DriverRoute? DriverRoute { get; set; }
    public ICollection<Payment> Payments { get; set; } = new List<Payment>();
}

// 10. TransportRequest
public class TransportRequest : AuditableEntity
{
    public Guid CustomerId { get; set; }
    public int SeatsNeeded { get; set; } = 1;
    public string PickupName { get; set; } = string.Empty;
    public string DropoffName { get; set; } = string.Empty;
    public Point PickupPoint { get; set; } = null!;
    public Point DropoffPoint { get; set; } = null!;
    public TimeSpan DesiredDepartureTime { get; set; }
    public string RecurringDays { get; set; } = "1,2,3,4,5";
    public decimal? MaxBudget { get; set; }
    public string Status { get; set; } = "Open";

    // Navigation
    public Customer Customer { get; set; } = null!;
    public ICollection<Match> Matches { get; set; } = new List<Match>();
}

// 11. ShortTripRequest
public class ShortTripRequest : AuditableEntity
{
    public Guid CustomerId { get; set; }
    public Guid? DriverId { get; set; }
    public string PickupName { get; set; } = string.Empty;
    public string DropoffName { get; set; } = string.Empty;
    public Point PickupPoint { get; set; } = null!;
    public Point DropoffPoint { get; set; } = null!;
    public LineString? RouteGeometry { get; set; }
    public decimal? EstimatedDistanceMeters { get; set; }
    public int? EstimatedDurationSeconds { get; set; }
    public decimal Fare { get; set; }
    public ShortTripStatus Status { get; set; } = ShortTripStatus.Searching;
    public DateTime? AcceptedAt { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }

    // Navigation
    public Customer Customer { get; set; } = null!;
    public Driver? Driver { get; set; }
}

// 12. DriverAd
public class DriverAd : AuditableEntity
{
    public Guid DriverId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string StartName { get; set; } = string.Empty;
    public string EndName { get; set; } = string.Empty;
    public Point StartPoint { get; set; } = null!;
    public Point EndPoint { get; set; } = null!;
    public LineString? RouteGeometry { get; set; }
    public decimal Price { get; set; }
    public int AvailableSeats { get; set; } = 4;
    public DateTime DepartureDatetime { get; set; }
    public DateTime ExpiresAt { get; set; }
    public string Status { get; set; } = "Active";

    // Navigation
    public Driver Driver { get; set; } = null!;
}

// 13. CustomerAd
public class CustomerAd : AuditableEntity
{
    public Guid CustomerId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string PickupName { get; set; } = string.Empty;
    public string DropoffName { get; set; } = string.Empty;
    public Point PickupPoint { get; set; } = null!;
    public Point DropoffPoint { get; set; } = null!;
    public decimal? Budget { get; set; }
    public int NeededSeats { get; set; } = 1;
    public DateTime NeededDatetime { get; set; }
    public DateTime ExpiresAt { get; set; }
    public string Status { get; set; } = "Active";

    // Navigation
    public Customer Customer { get; set; } = null!;
}

// 14. Match
public class Match : AuditableEntity
{
    public Guid? TransportRequestId { get; set; }
    public Guid? CustomerAdId { get; set; }
    public Guid? DriverRouteId { get; set; }
    public Guid? DriverAdId { get; set; }
    public decimal MatchScore { get; set; }
    public decimal RouteOverlapPercentage { get; set; }
    public decimal DetourDistanceMeters { get; set; }
    public string Status { get; set; } = "Suggested";

    // Navigation
    public TransportRequest? TransportRequest { get; set; }
    public CustomerAd? CustomerAd { get; set; }
    public DriverRoute? DriverRoute { get; set; }
    public DriverAd? DriverAd { get; set; }
}

// 15. Notification
public class Notification : BaseEntity
{
    public Guid UserId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string Body { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty;
    public string PayloadJson { get; set; } = "{}";
    public bool IsRead { get; set; } = false;
    public DateTime? ReadAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public User User { get; set; } = null!;
}

// 16. Rating
public class Rating : BaseEntity
{
    public Guid? BookingId { get; set; }
    public Guid? ShortTripRequestId { get; set; }
    public Guid RaterId { get; set; }
    public Guid RatedId { get; set; }
    public int Score { get; set; }
    public string? Comment { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public User Rater { get; set; } = null!;
    public User Rated { get; set; } = null!;
}

// 17. Complaint
public class Complaint : AuditableEntity
{
    public Guid UserId { get; set; }
    public Guid? TargetUserId { get; set; }
    public Guid? BookingId { get; set; }
    public Guid? ShortTripRequestId { get; set; }
    public string Category { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string AttachmentPathsJson { get; set; } = "[]";
    public ComplaintStatus Status { get; set; } = ComplaintStatus.Pending;
    public string? AdminNotes { get; set; }
    public Guid? ResolvedBy { get; set; }
    public DateTime? ResolvedAt { get; set; }

    // Navigation
    public User User { get; set; } = null!;
    public User? TargetUser { get; set; }
}

// 18. Payment
public class Payment : AuditableEntity
{
    public Guid? BookingId { get; set; }
    public Guid? ShortTripRequestId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid? DriverId { get; set; }
    public decimal Amount { get; set; }
    public string Currency { get; set; } = "IQD";
    public string PaymentMethod { get; set; } = "Cash";
    public string? TransactionReference { get; set; }
    public PaymentStatus Status { get; set; } = PaymentStatus.Pending;
    public DateTime? CompletedAt { get; set; }

    // Navigation
    public Customer Customer { get; set; } = null!;
    public Driver? Driver { get; set; }
}

// 19. Subscription
public class Subscription : AuditableEntity
{
    public Guid DriverId { get; set; }
    public string PlanName { get; set; } = string.Empty;
    public decimal Price { get; set; }
    public string BillingCycle { get; set; } = "Monthly";
    public DateOnly StartDate { get; set; }
    public DateOnly EndDate { get; set; }
    public bool IsActive { get; set; } = true;
    public bool AutoRenew { get; set; } = true;

    // Navigation
    public Driver Driver { get; set; } = null!;
}

// 20. Invoice
public class Invoice : AuditableEntity
{
    public string InvoiceNumber { get; set; } = string.Empty;
    public Guid? SubscriptionId { get; set; }
    public Guid? BookingId { get; set; }
    public Guid UserId { get; set; }
    public decimal TotalAmount { get; set; }
    public decimal TaxAmount { get; set; } = 0.00m;
    public string Status { get; set; } = "Issued";
    public string? PdfUrl { get; set; }
    public DateOnly DueDate { get; set; }
    public DateTime? PaidAt { get; set; }

    // Navigation
    public User User { get; set; } = null!;
}

// 21. OutboxMessage (Transactional Outbox Pattern)
public class OutboxMessage : BaseEntity
{
    public string EventType { get; set; } = string.Empty;
    public string AggregateType { get; set; } = string.Empty;
    public string AggregateId { get; set; } = string.Empty;
    public string PayloadJson { get; set; } = "{}";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ProcessedAt { get; set; }
    public int RetryCount { get; set; } = 0;
    public int MaxRetries { get; set; } = 5;
    public string? Error { get; set; }
}

// 22. AuditLog
public class AuditLog : BaseEntity
{
    public Guid? UserId { get; set; }
    public string Action { get; set; } = string.Empty;
    public string EntityName { get; set; } = string.Empty;
    public string EntityId { get; set; } = string.Empty;
    public string? OldValuesJson { get; set; }
    public string? NewValuesJson { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

// 23. SystemSetting
public class SystemSetting
{
    public string Key { get; set; } = string.Empty;
    public string ValueJson { get; set; } = "{}";
    public string? Description { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

// 24. RefreshToken
public class RefreshToken : BaseEntity
{
    public Guid UserId { get; set; }
    public string Token { get; set; } = string.Empty;
    public string JwtId { get; set; } = string.Empty;
    public bool IsUsed { get; set; } = false;
    public bool IsRevoked { get; set; } = false;
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Navigation
    public User User { get; set; } = null!;
}
