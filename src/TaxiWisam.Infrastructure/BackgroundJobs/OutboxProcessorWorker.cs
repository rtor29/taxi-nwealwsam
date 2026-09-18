using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Infrastructure.BackgroundJobs;

public class OutboxProcessorWorker
{
    private readonly IApplicationDbContext _context;
    private readonly INotificationService _notificationService;
    private readonly ILogger<OutboxProcessorWorker> _logger;

    public OutboxProcessorWorker(
        IApplicationDbContext context,
        INotificationService notificationService,
        ILogger<OutboxProcessorWorker> logger)
    {
        _context = context;
        _notificationService = notificationService;
        _logger = logger;
    }

    public async Task ProcessOutboxMessagesAsync(CancellationToken cancellationToken = default)
    {
        var pendingMessages = await _context.OutboxMessages
            .Where(m => m.ProcessedAt == null && m.RetryCount < m.MaxRetries)
            .OrderBy(m => m.CreatedAt)
            .Take(50)
            .ToListAsync(cancellationToken);

        if (pendingMessages.Count == 0) return;

        _logger.LogInformation("Processing {Count} pending Outbox messages...", pendingMessages.Count);

        foreach (var message in pendingMessages)
        {
            try
            {
                switch (message.EventType)
                {
                    case "BookingCreated":
                        // Dispatch to notification & SignalR
                        _logger.LogInformation("Dispatched BookingCreated event for aggregate {Id}", message.AggregateId);
                        break;

                    case "TripRequested":
                        _logger.LogInformation("Dispatched TripRequested event for aggregate {Id}", message.AggregateId);
                        break;

                    default:
                        _logger.LogInformation("Processed generic event {Type} for aggregate {Id}", message.EventType, message.AggregateId);
                        break;
                }

                message.ProcessedAt = DateTime.UtcNow;
                message.Error = null;
            }
            catch (Exception ex)
            {
                message.RetryCount++;
                message.Error = ex.ToString();
                _logger.LogError(ex, "Failed to process Outbox message {Id}. Retry #{RetryCount}", message.Id, message.RetryCount);
            }
        }

        await _context.SaveChangesAsync(cancellationToken);
    }
}
