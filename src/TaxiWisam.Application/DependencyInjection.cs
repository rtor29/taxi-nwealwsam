using Microsoft.Extensions.DependencyInjection;
using TaxiWisam.Application.Features.Bookings;
using TaxiWisam.Application.Features.Matching;

namespace TaxiWisam.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddScoped<IMatchingEngine, MatchingEngine>();
        services.AddScoped<IBookingService, BookingService>();
        services.AddScoped<TaxiWisam.Application.Common.Interfaces.IPricingService, TaxiWisam.Application.Features.Pricing.PricingService>();
        return services;
    }
}
