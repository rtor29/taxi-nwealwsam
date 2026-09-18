using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Application.Features.Pricing;

public class PricingService : IPricingService
{
    private readonly IApplicationDbContext _context;

    public PricingService(IApplicationDbContext context)
    {
        _context = context;
    }

    public async Task<TripFareEstimate> CalculateTripFareAsync(
        double distanceMeters, 
        double durationSeconds, 
        decimal surgeMultiplier = 1.0m,
        CancellationToken cancellationToken = default)
    {
        // 1. Fetch system pricing settings from Supabase PostgreSQL
        decimal baseFare = 3000.0m;
        decimal perKmRate = 500.0m;
        decimal perMinuteRate = 100.0m;
        decimal maxSurge = 2.5m;

        var setting = await _context.SystemSettings
            .FirstOrDefaultAsync(s => s.Key == "pricing_settings", cancellationToken);

        if (setting != null)
        {
            try
            {
                using var doc = JsonDocument.Parse(setting.ValueJson);
                var root = doc.RootElement;
                if (root.TryGetProperty("base_fare_iqd", out var bf)) baseFare = bf.GetDecimal();
                if (root.TryGetProperty("per_km_rate_iqd", out var pkm)) perKmRate = pkm.GetDecimal();
                if (root.TryGetProperty("per_minute_rate_iqd", out var pm)) perMinuteRate = pm.GetDecimal();
                if (root.TryGetProperty("surge_multiplier_max", out var sm)) maxSurge = sm.GetDecimal();
            }
            catch {}
        }

        // 2. Cap surge multiplier
        decimal effectiveSurge = Math.Clamp(surgeMultiplier, 1.0m, maxSurge);

        // 3. Compute variables
        double distanceKm = Math.Round(distanceMeters / 1000.0, 2);
        double durationMinutes = Math.Round(durationSeconds / 60.0, 1);

        decimal distanceFare = (decimal)distanceKm * perKmRate;
        decimal timeFare = (decimal)durationMinutes * perMinuteRate;

        decimal subtotal = baseFare + distanceFare + timeFare;
        decimal total = Math.Round((subtotal * effectiveSurge) / 250m) * 250m; // Round to nearest 250 IQD cash note

        return new TripFareEstimate(
            TotalFare: total,
            BaseFare: baseFare,
            DistanceFare: Math.Round(distanceFare, 2),
            TimeFare: Math.Round(timeFare, 2),
            DistanceKm: distanceKm,
            DurationMinutes: durationMinutes,
            SurgeMultiplier: effectiveSurge,
            Currency: "IQD"
        );
    }
}
