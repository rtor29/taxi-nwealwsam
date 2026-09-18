using System.Text;
using Hangfire;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using TaxiWisam.Api.Hubs;
using TaxiWisam.Api.Services;
using TaxiWisam.Application;
using TaxiWisam.Application.Common.Interfaces;
using TaxiWisam.Infrastructure;
using TaxiWisam.Infrastructure.BackgroundJobs;

var builder = WebApplication.CreateBuilder(args);

// 1. Core Services & Controllers
builder.Services.AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.ReferenceHandler = System.Text.Json.Serialization.ReferenceHandler.IgnoreCycles;
    });

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo 
    { 
        Title = "Taxi-Wisam API", 
        Version = "v1",
        Description = "ASP.NET Core Backend Orchestration & Supabase Infrastructure API"
    });

    c.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Description = "JWT Authorization header using the Bearer scheme. Enter 'Bearer' [space] and your Supabase / Custom token.",
        Name = "Authorization",
        In = ParameterLocation.Header,
        Type = SecuritySchemeType.ApiKey,
        Scheme = "Bearer"
    });

    c.AddSecurityRequirement(new OpenApiSecurityRequirement
    {
        {
            new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" }
            },
            Array.Empty<string>()
        }
    });
});

// 2. Application & Infrastructure Layers
builder.Services.AddApplication();
builder.Services.AddInfrastructure(builder.Configuration);

// 3. SignalR Real-Time Communication with optional Redis Backplane
var redisConn = builder.Configuration.GetConnectionString("Redis");
var signalrBuilder = builder.Services.AddSignalR();
if (!string.IsNullOrEmpty(redisConn))
{
    signalrBuilder.AddStackExchangeRedis(redisConn, options =>
    {
        options.Configuration.ChannelPrefix = "taxi_wisam_signalr";
    });
}
builder.Services.AddScoped<INotificationService, SignalRNotificationService>();

// 4. JWT Authentication (Supabase / Identity integration)
string jwtSecret = builder.Configuration["Jwt:Secret"] ?? "SuperSecretTaxiWisamPlatformKey2026!@#$%^&*";
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options =>
{
    options.RequireHttpsMetadata = false;
    options.SaveToken = true;
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret)),
        ValidateIssuer = false,
        ValidateAudience = false,
        ClockSkew = TimeSpan.FromMinutes(5)
    };

    // Support token in SignalR query string for WebSocket connections
    options.Events = new JwtBearerEvents
    {
        OnMessageReceived = context =>
        {
            var accessToken = context.Request.Query["access_token"];
            var path = context.HttpContext.Request.Path;
            if (!string.IsNullOrEmpty(accessToken) && path.StartsWithSegments("/hubs"))
            {
                context.Token = accessToken;
            }
            return Task.CompletedTask;
        }
    };
});

builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("AdminOnly", policy => policy.RequireRole("Admin"));
    options.AddPolicy("DriverOnly", policy => policy.RequireRole("Driver"));
});

// 5. CORS for Flutter Web / Admin Dashboard
builder.Services.AddCors(options =>
{
    options.AddPolicy("CorsPolicy", policy =>
    {
        policy.SetIsOriginAllowed(_ => true)
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});

var app = builder.Build();

// 6. Pipeline Configuration
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseCors("CorsPolicy");
app.UseDefaultFiles();
app.UseStaticFiles();

app.UseAuthentication();
app.UseAuthorization();

// 7. Hangfire Dashboard & Recurring Outbox Processor
app.UseHangfireDashboard("/hangfire");

using (var scope = app.Services.CreateScope())
{
    var recurringJobManager = scope.ServiceProvider.GetRequiredService<IRecurringJobManager>();
    recurringJobManager.AddOrUpdate<OutboxProcessorWorker>(
        "process-outbox-messages",
        worker => worker.ProcessOutboxMessagesAsync(CancellationToken.None),
        "*/15 * * * * *" // Runs every 15 seconds
    );
}

// 8. Endpoints
app.MapControllers();
app.MapHub<TrackingHub>("/hubs/tracking");

app.Run();
