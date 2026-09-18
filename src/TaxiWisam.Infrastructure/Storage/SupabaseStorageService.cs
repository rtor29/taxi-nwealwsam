using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using TaxiWisam.Application.Common.Interfaces;

namespace TaxiWisam.Infrastructure.Storage;

public class SupabaseStorageService : ISupabaseStorageService
{
    private readonly HttpClient _httpClient;
    private readonly string _supabaseUrl;
    private readonly string _serviceRoleKey;
    private readonly ILogger<SupabaseStorageService> _logger;

    public SupabaseStorageService(
        HttpClient httpClient, 
        IConfiguration configuration,
        ILogger<SupabaseStorageService> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
        _supabaseUrl = configuration["Supabase:Url"]?.TrimEnd('/') 
            ?? throw new InvalidOperationException("Supabase:Url configuration missing");
        _serviceRoleKey = configuration["Supabase:ServiceRoleKey"] 
            ?? throw new InvalidOperationException("Supabase:ServiceRoleKey configuration missing");

        _httpClient.BaseAddress = new Uri(_supabaseUrl);
        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _serviceRoleKey);
        _httpClient.DefaultRequestHeaders.Add("apikey", _serviceRoleKey);
    }

    public async Task<string> UploadFileAsync(
        string bucketName, 
        string filePath, 
        Stream fileStream, 
        string contentType, 
        CancellationToken cancellationToken = default)
    {
        string endpoint = $"/storage/v1/object/{bucketName}/{filePath.TrimStart('/')}";

        using var content = new StreamContent(fileStream);
        content.Headers.ContentType = new MediaTypeHeaderValue(contentType);

        var response = await _httpClient.PostAsync(endpoint, content, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogError("Supabase file upload failed ({StatusCode}): {Error}", response.StatusCode, errorBody);
            throw new InvalidOperationException($"Storage upload failed: {response.StatusCode} - {errorBody}");
        }

        return filePath;
    }

    public async Task<string> CreateSignedUrlAsync(
        string bucketName, 
        string filePath, 
        int expiresInSeconds = 3600, 
        CancellationToken cancellationToken = default)
    {
        string endpoint = $"/storage/v1/object/sign/{bucketName}/{filePath.TrimStart('/')}";
        var body = new { expiresIn = expiresInSeconds };
        var jsonContent = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        var response = await _httpClient.PostAsync(endpoint, jsonContent, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogError("Supabase signed URL creation failed ({StatusCode}): {Error}", response.StatusCode, errorBody);
            throw new InvalidOperationException($"Failed to generate signed URL: {response.StatusCode} - {errorBody}");
        }

        var jsonResponse = await response.Content.ReadAsStringAsync(cancellationToken);
        using var doc = JsonDocument.Parse(jsonResponse);
        string? signedUrlPart = doc.RootElement.GetProperty("signedURL").GetString();

        return $"{_supabaseUrl}/storage/v1{signedUrlPart}";
    }

    public string GetPublicUrl(string bucketName, string filePath)
    {
        return $"{_supabaseUrl}/storage/v1/object/public/{bucketName}/{filePath.TrimStart('/')}";
    }

    public async Task<bool> DeleteFileAsync(
        string bucketName, 
        string filePath, 
        CancellationToken cancellationToken = default)
    {
        string endpoint = $"/storage/v1/object/{bucketName}/{filePath.TrimStart('/')}";
        var response = await _httpClient.DeleteAsync(endpoint, cancellationToken);
        return response.IsSuccessStatusCode;
    }
}
