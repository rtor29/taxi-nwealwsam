namespace TaxiWisam.Application.Common.Interfaces;

public interface ISupabaseStorageService
{
    Task<string> UploadFileAsync(
        string bucketName, 
        string filePath, 
        Stream fileStream, 
        string contentType, 
        CancellationToken cancellationToken = default);

    Task<string> CreateSignedUrlAsync(
        string bucketName, 
        string filePath, 
        int expiresInSeconds = 3600, 
        CancellationToken cancellationToken = default);

    string GetPublicUrl(string bucketName, string filePath);

    Task<bool> DeleteFileAsync(
        string bucketName, 
        string filePath, 
        CancellationToken cancellationToken = default);
}
