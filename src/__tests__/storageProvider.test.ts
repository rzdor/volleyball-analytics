import fs from 'fs';
import os from 'os';
import path from 'path';
import { createVideoStorage } from '../services/storageProvider';

jest.mock('@azure/storage-blob', () => {
  const uploadFileMock = jest.fn().mockResolvedValue(undefined);
  const getBlockBlobClient = jest.fn(() => ({
    uploadFile: uploadFileMock,
    url: 'https://example.com/container/blob.mp4',
  }));
  const createIfNotExistsMock = jest.fn().mockResolvedValue(undefined);
  const getBlobClient = jest.fn((name: string) => ({ url: `https://example.com/${name}` }));

  const generateBlobSASQueryParameters = jest.fn().mockReturnValue({ toString: () => 'sas-token' });
  const BlobSASPermissions = { parse: jest.fn().mockReturnValue({}) };
  class StorageSharedKeyCredential {
    constructor(public accountName: string, public accountKey: string) {}
  }

  const containerClient = {
    containerName: 'test-container',
    getBlockBlobClient,
    createIfNotExists: createIfNotExistsMock,
    getBlobClient,
    listBlobsFlat: jest.fn().mockReturnValue((async function* () {})()),
  };

  const blobServiceClient = {
    getContainerClient: jest.fn(() => containerClient),
  };

  return {
    BlobServiceClient: {
      fromConnectionString: jest.fn(() => blobServiceClient),
    },
    BlobSASPermissions,
    StorageSharedKeyCredential,
    generateBlobSASQueryParameters,
    __testMocks: { uploadFileMock, getBlockBlobClient, createIfNotExistsMock, getBlobClient },
  };
});

const { __testMocks } = jest.requireMock('@azure/storage-blob') as {
  __testMocks: {
    uploadFileMock: jest.Mock;
    getBlockBlobClient: jest.Mock;
    createIfNotExistsMock: jest.Mock;
    getBlobClient: jest.Mock;
  };
};

describe('VideoStorage local fallback', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'va-storage-'));
  const inputFile = path.join(tempRoot, 'inputs', 'sample.mp4');
  const outputFile = path.join(tempRoot, 'processed', 'trimmed-sample.mp4');

  beforeAll(() => {
    fs.mkdirSync(path.dirname(inputFile), { recursive: true });
    fs.writeFileSync(inputFile, 'input-bytes');
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, 'output-bytes');
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('lists uploaded and processed files from local disk when Azure is not configured', async () => {
    const storage = createVideoStorage({ baseDir: tempRoot, connectionString: '' });
    const uploads = await storage.listInputs();
    const processed = await storage.listOutputs();

    expect(uploads.some(item => item.name === 'sample.mp4')).toBe(true);
    expect(processed.some(item => item.name === 'trimmed-sample.mp4')).toBe(true);
    expect(uploads[0].url).toContain('/uploads/inputs/');
  });
});

describe('VideoStorage Azure uploads', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'va-storage-azure-'));
  const connectionString =
    'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=fake;EndpointSuffix=core.windows.net';

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('logs and uploads via Azure Blob Storage when configured', async () => {
    const storage = createVideoStorage({ baseDir: tempRoot, connectionString, containerName: 'test-container' });
    const inputFile = path.join(tempRoot, 'inputs', 'azure-upload.mp4');
    fs.mkdirSync(path.dirname(inputFile), { recursive: true });
    fs.writeFileSync(inputFile, 'video-bytes');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await storage.saveInput(inputFile, 'azure-upload.mp4');

    expect(__testMocks.createIfNotExistsMock).toHaveBeenCalled();
    expect(__testMocks.getBlockBlobClient).toHaveBeenCalledWith('inputs/azure-upload.mp4');
    expect(__testMocks.uploadFileMock).toHaveBeenCalledWith(
      inputFile,
      expect.objectContaining({
        blobHTTPHeaders: expect.objectContaining({ blobContentType: expect.any(String) }),
      })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '[storage] Uploading to Azure Blob Storage',
      expect.objectContaining({
        container: 'test-container',
        blobName: 'inputs/azure-upload.mp4',
        localPath: inputFile,
        blobUrl: 'https://example.com/container/blob.mp4',
      })
    );

    consoleSpy.mockRestore();
  });
});
