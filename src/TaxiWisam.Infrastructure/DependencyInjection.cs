using Hangfire;
using Hangfire.PostgreSql;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using StackExchange.Redis;
using TaxiWisam.Application.Common.Interfaces;
using TaxiWisam.Infrastructure.BackgroundJobs;
using TaxiWisam.Infrastructure.Cache;
using TaxiWisam.Infrastructure.Persistence;
using TaxiWisam.Infrastructure.Storage;

namespace TaxiWisam.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        string connectionString = configuration.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("Connection string 'DefaultConnection' not found.");

        // 1. PostgreSQL with PostGIS & NetTopologySuite
        services.AddDbContext<ApplicationDbContext>(options =>
            options.UseNpgsql(connectionString, npgsqlOptions =>
            {
                npgsqlOptions.UseNetTopologySuite();
                npgsqlOptions.MigrationsAssembly(typeof(ApplicationDbContext).Assembly.FullName);
                npgsqlOptions.EnableRetryOnFailure(3);
            }));

        services.AddScoped<IApplicationDbContext>(provider => provider.GetRequiredService<ApplicationDbContext>());

        // 2. Supabase Storage Service
        services.AddHttpClient<ISupabaseStorageService, SupabaseStorageService>();

        // 3. Redis Cache Service
        string redisConnection = configuration.GetConnectionString("Redis") ?? "localhost:6379";
        services.AddSingleton<IConnectionMultiplexer>(sp => ConnectionMultiplexer.Connect(redisConnection));
        services.AddScoped<IRedisCacheService, RedisCacheService>();

        // 4. Hangfire Background Jobs
        services.AddHangfire(config => config
            .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
            .UseSimpleAssemblyNameTypeSerializer()
            .UseRecommendedSerializerSettings()
            .UsePostgreSqlStorage(c => c.UseNpgsqlConnection(connectionString)));

        services.AddHangfireServer(options =>
        {
            options.WorkerCount = Environment.ProcessorCount * 2;
        });

        // 5. Outbox Background Worker
        services.AddScoped<OutboxProcessorWorker>();

        // 6. OSRM Routing & Nominatim Geocoding Services
        services.AddHttpClient<IRoutingService, TaxiWisam.Infrastructure.Routing.OsrmRoutingService>();
        services.AddHttpClient<IGeocodingService, TaxiWisam.Infrastructure.Routing.NominatimGeocodingService>();

        return services;
    }
}
