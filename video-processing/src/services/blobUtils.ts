import { BlobServiceClient } from '@azure/storage-blob';
import fs from 'fs';
import path from 'path';

export interface BlobReference {
  containerName: string;
  blobName: string;
}

function getStorageConnectionString(): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage must be configured');
  }
  return connectionString;
}

export function parseBlobUrl(blobUrl: string): BlobReference {
  const pathname = new URL(blobUrl).pathname;
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length < 2) {
    throw new Error(`Invalid blob URL: ${blobUrl}`);
  }

  return {
    containerName: segments[0],
    blobName: segments.slice(1).join('/'),
  };
}

export async function downloadBlobToFile(blob: BlobReference, destinationPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const blobServiceClient = BlobServiceClient.fromConnectionString(getStorageConnectionString());
  const blobClient = blobServiceClient
    .getContainerClient(blob.containerName)
    .getBlobClient(blob.blobName);

  await blobClient.downloadToFile(destinationPath);
}

async function readStreamAsString(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) {
    return '';
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function downloadBlobAsString(blob: BlobReference): Promise<string> {
  const blobServiceClient = BlobServiceClient.fromConnectionString(getStorageConnectionString());
  const blobClient = blobServiceClient
    .getContainerClient(blob.containerName)
    .getBlobClient(blob.blobName);
  const response = await blobClient.download();
  return readStreamAsString(response.readableStreamBody);
}
