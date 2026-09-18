namespace TaxiWisam.Application.Common.Interfaces;

public record GeocodePlaceResult(
    string DisplayName,
    double Latitude,
    double Longitude,
    string? City,
    string? Suburb,
    string? Road
);

public interface IGeocodingService
{
    Task<List<GeocodePlaceResult>> SearchPlacesAsync(
        string query, 
        string countryCode = "iq", 
        CancellationToken cancellationToken = default);

    Task<string> ReverseGeocodeAsync(
        double latitude, 
        double longitude, 
        CancellationToken cancellationToken = default);
}
