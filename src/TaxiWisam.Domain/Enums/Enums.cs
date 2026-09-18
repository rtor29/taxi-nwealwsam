namespace TaxiWisam.Domain.Enums;

public enum UserRole
{
    Customer,
    Driver,
    Admin
}

public enum DriverStatus
{
    Offline,
    Online,
    Busy,
    InTrip
}

public enum DocumentType
{
    NationalId,
    DrivingLicense,
    VehicleRegistration,
    BackgroundCheck
}

public enum DocumentStatus
{
    Pending,
    Approved,
    Rejected
}

public enum BookingStatus
{
    Pending,
    Confirmed,
    InProgress,
    Completed,
    Cancelled
}

public enum ShortTripStatus
{
    Searching,
    Accepted,
    Arrived,
    InProgress,
    Completed,
    Cancelled
}

public enum PaymentStatus
{
    Pending,
    Completed,
    Failed,
    Refunded
}

public enum ComplaintStatus
{
    Pending,
    UnderInvestigation,
    Resolved,
    Dismissed
}

public enum NotificationType
{
    BookingUpdate,
    DriverArrived,
    MatchingOffer,
    SystemAlert,
    PaymentSuccess
}
