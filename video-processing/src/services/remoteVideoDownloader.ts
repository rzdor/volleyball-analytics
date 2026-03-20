import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { randomUUID } from 'crypto';
import { BlockBlobClient } from '@azure/storage-blob';
import { PassThrough } from 'stream';

export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
] as const;

export const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi'] as const;

export class VideoDownloadError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function inferExtension(url: URL, contentType?: string): string {
  const ext = path.extname(url.pathname).toLowerCase();
  if (ALLOWED_VIDEO_EXTENSIONS.includes(ext as typeof ALLOWED_VIDEO_EXTENSIONS[number])) {
    return ext;
  }
  if (contentType) {
    if (contentType.includes('webm')) return '.webm';
    if (contentType.includes('quicktime')) return '.mov';
    if (contentType.includes('x-msvideo')) return '.avi';
  }
  return '.mp4';
}

function isAllowedVideo(contentType: string | undefined, ext: string): boolean {
  const normalizedType = contentType ? contentType.split(';')[0].trim().toLowerCase() : '';

  if (normalizedType) {
    if (normalizedType.startsWith('video/') || ALLOWED_VIDEO_MIME_TYPES.includes(normalizedType as typeof ALLOWED_VIDEO_MIME_TYPES[number])) {
      return true;
    }

    if (normalizedType === 'application/octet-stream' && ALLOWED_VIDEO_EXTENSIONS.includes(ext as typeof ALLOWED_VIDEO_EXTENSIONS[number])) {
      return true;
    }

    return false;
  }

  return ALLOWED_VIDEO_EXTENSIONS.includes(ext as typeof ALLOWED_VIDEO_EXTENSIONS[number]);
}

function formatSizeLimit(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeContentType(contentType?: string): string | undefined {
  return contentType ? contentType.split(';')[0].trim().toLowerCase() : undefined;
}

export async function downloadVideoFromUrl(
  videoUrl: string,
  destinationDir: string,
  maxBytes: number,
  redirectsLeft = 2
): Promise<string> {
  const urlObj = new URL(videoUrl);

  if (!['http:', 'https:'].includes(urlObj.protocol)) {
    throw new VideoDownloadError('Only HTTP(S) URLs are supported');
  }

  return new Promise((resolve, reject) => {
    const getter = urlObj.protocol === 'https:' ? https.get : http.get;

    const request = getter(urlObj, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          res.resume();
          reject(new VideoDownloadError('Too many redirects while downloading video'));
          return;
        }

        const redirectUrl = new URL(res.headers.location, urlObj);
        res.resume();
        downloadVideoFromUrl(redirectUrl.toString(), destinationDir, maxBytes, redirectsLeft - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if ((res.statusCode ?? 500) >= 400) {
        res.resume();
        reject(new VideoDownloadError('Unable to download video from provided link'));
        return;
      }

      const contentTypeHeader = res.headers['content-type'];
      const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
      const ext = inferExtension(urlObj, contentType);

      if (!isAllowedVideo(contentType, ext)) {
        res.resume();
        reject(new VideoDownloadError('The provided link must point directly to a video file'));
        return;
      }

      const lengthHeader = res.headers['content-length'];
      const declaredLength = lengthHeader ? parseInt(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader, 10) : undefined;
      if (declaredLength && declaredLength > maxBytes) {
        res.resume();
        reject(new VideoDownloadError(`File exceeds size limit of ${formatSizeLimit(maxBytes)}`, 413));
        return;
      }

      const filePath = path.join(destinationDir, `remote-${randomUUID()}${ext}`);
      let settled = false;
      let downloaded = 0;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        }
        reject(err);
      };

      const fileStream = fs.createWriteStream(filePath);

      res.on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded > maxBytes) {
          fail(new VideoDownloadError(`File exceeds size limit of ${formatSizeLimit(maxBytes)}`, 413));
          res.destroy();
          fileStream.destroy();
        }
      });

      res.on('error', fail);
      fileStream.on('error', fail);
      fileStream.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve(filePath);
      });

      res.pipe(fileStream);
    });

    request.on('error', () => reject(new VideoDownloadError('Unable to download video from provided link', 502)));
  });
}

export async function downloadVideoToBlob(
  videoUrl: string,
  blockBlobClient: BlockBlobClient,
  maxBytes: number,
  redirectsLeft = 2
): Promise<string> {
  const urlObj = new URL(videoUrl);

  if (!['http:', 'https:'].includes(urlObj.protocol)) {
    throw new VideoDownloadError('Only HTTP(S) URLs are supported');
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const getter = urlObj.protocol === 'https:' ? https.get : http.get;
    const request = getter(urlObj, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          res.resume();
          rejectOnce(new VideoDownloadError('Too many redirects while downloading video'));
          return;
        }

        const redirectUrl = new URL(res.headers.location, urlObj);
        res.resume();
        downloadVideoToBlob(redirectUrl.toString(), blockBlobClient, maxBytes, redirectsLeft - 1)
          .then(resolveOnce)
          .catch(error => rejectOnce(toError(error)));
        return;
      }

      if ((res.statusCode ?? 500) >= 400) {
        res.resume();
        rejectOnce(new VideoDownloadError('Unable to download video from provided link'));
        return;
      }

      const contentTypeHeader = res.headers['content-type'];
      const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
      const ext = inferExtension(urlObj, contentType);

      if (!isAllowedVideo(contentType, ext)) {
        res.resume();
        rejectOnce(new VideoDownloadError('The provided link must point directly to a video file'));
        return;
      }

      const lengthHeader = res.headers['content-length'];
      const declaredLength = lengthHeader ? parseInt(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader, 10) : undefined;
      if (declaredLength && declaredLength > maxBytes) {
        res.resume();
        rejectOnce(new VideoDownloadError(`File exceeds size limit of ${formatSizeLimit(maxBytes)}`, 413));
        return;
      }

      const uploadStream = new PassThrough();
      let downloaded = 0;
      let aborting = false;

      const failUpload = (error: Error) => {
        if (settled || aborting) return;
        aborting = true;
        res.unpipe(uploadStream);
        res.destroy(error);
        uploadStream.destroy(error);
        void blockBlobClient.deleteIfExists().catch(() => undefined).finally(() => {
          rejectOnce(error);
        });
      };

      res.on('data', chunk => {
        downloaded += chunk.length;
        if (downloaded > maxBytes) {
          failUpload(new VideoDownloadError(`File exceeds size limit of ${formatSizeLimit(maxBytes)}`, 413));
        }
      });

      res.on('error', error => {
        failUpload(toError(error));
      });

      uploadStream.on('error', error => {
        failUpload(toError(error));
      });

      void blockBlobClient.uploadStream(uploadStream, 8 * 1024 * 1024, 5, {
        blobHTTPHeaders: {
          blobContentType: normalizeContentType(contentType) || 'application/octet-stream',
        },
      }).then(() => {
        resolveOnce(blockBlobClient.url);
      }).catch(error => {
        failUpload(toError(error));
      });

      res.pipe(uploadStream);
    });

    request.on('error', () => rejectOnce(new VideoDownloadError('Unable to download video from provided link', 502)));
  });
}
