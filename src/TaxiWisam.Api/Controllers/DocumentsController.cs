using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TaxiWisam.Application.Common.Interfaces;
using TaxiWisam.Domain.Entities;
using TaxiWisam.Domain.Enums;

namespace TaxiWisam.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class DocumentsController : ControllerBase
{
    private readonly IApplicationDbContext _context;
    private readonly ISupabaseStorageService _storageService;

    public DocumentsController(
        IApplicationDbContext context, 
        ISupabaseStorageService storageService)
    {
        _context = context;
        _storageService = storageService;
    }

    /// <summary>
    /// Upload driver document securely to Supabase Private Bucket
    /// </summary>
    [HttpPost("upload")]
    [Consumes("multipart/form-data")]
    public async Task<IActionResult> UploadDocument(
        [FromForm] Guid driverId,
        [FromForm] DocumentType documentType,
        IFormFile file)
    {
        if (file == null || file.Length == 0)
        {
            return BadRequest(new { error = "No file uploaded." });
        }

        var driver = await _context.Drivers.FindAsync(driverId);
        if (driver == null)
        {
            return NotFound(new { error = "Driver not found." });
        }

        string fileExtension = Path.GetExtension(file.FileName);
        string storagePath = $"{driverId}/{documentType}_{Guid.NewGuid()}{fileExtension}";
        const string bucketName = "driver-documents"; // Strictly Private Bucket

        using var stream = file.OpenReadStream();
        await _storageService.UploadFileAsync(bucketName, storagePath, stream, file.ContentType);

        var doc = new DriverDocument
        {
            DriverId = driverId,
            DocumentType = documentType,
            BucketName = bucketName,
            FilePath = storagePath,
            FileMetadataJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                OriginalFileName = file.FileName,
                FileSize = file.Length,
                ContentType = file.ContentType
            }),
            Status = DocumentStatus.Pending
        };

        _context.DriverDocuments.Add(doc);
        await _context.SaveChangesAsync();

        return Ok(new
        {
            DocumentId = doc.Id,
            doc.DocumentType,
            doc.FilePath,
            doc.Status,
            Message = "Document uploaded securely to private bucket. Verification pending."
        });
    }

    /// <summary>
    /// Generate a short-lived Signed URL for Admin review (Expires in 1 hour)
    /// </summary>
    [HttpGet("{id:guid}/signed-url")]
    public async Task<IActionResult> GetSignedUrl(Guid id, [FromQuery] int expirySeconds = 3600)
    {
        var doc = await _context.DriverDocuments.FindAsync(id);
        if (doc == null)
        {
            return NotFound(new { error = "Document not found." });
        }

        // Generate temporary secure signed URL from Supabase Storage
        string signedUrl = await _storageService.CreateSignedUrlAsync(
            doc.BucketName, 
            doc.FilePath, 
            expirySeconds);

        return Ok(new
        {
            DocumentId = doc.Id,
            doc.DocumentType,
            SignedUrl = signedUrl,
            ExpiresInSeconds = expirySeconds
        });
    }
}
