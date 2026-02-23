import fs from 'fs';
import path from 'path';
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';

type VideoKind = 'input' | 'output';

export interface StoredVideo {
  name: string;
  url: string;
  downloadUrl?: string;
  size?: number;
  lastModified?: string;
}

interface StorageOptions {
  baseDir?: string;
  connectionString?: string;
  containerName?: string;
  inputFolder?: string;
  outputFolder?: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.avi':
      return 'video/x-msvideo';
    default:
      return 'video/mp4';
  }
}

function parseSharedKey(connectionString: string): StorageSharedKeyCredential | undefined {
  const entries = connectionString.split(';').reduce<Record<string, string>>((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (key && value) {
      acc[key] = value;
    }
    return acc;
  }, {});

  const accountName = entries.AccountName;
  const accountKey = entries.AccountKey;

  if (!accountName || !accountKey) {
    return undefined;
  }

  return new StorageSharedKeyCredential(accountName, accountKey);
}

const DEFAULT_SAS_TOKEN_EXPIRATION_MS = 60 * 60 * 1000;

export class VideoStorage {
  private readonly baseDir: string;
  private readonly localInputDir: string;
  private readonly localOutputDir: string;
  private readonly inputFolder: string;
  private readonly outputFolder: string;
  private readonly containerClient?: ReturnType<BlobServiceClient['getContainerClient']>;
  private readonly sharedKey?: StorageSharedKeyCredential;
  private readonly containerReady?: Promise<void>;

  constructor(options: StorageOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(__dirname, '../../uploads');
    this.localInputDir = path.join(this.baseDir, 'inputs');
    this.localOutputDir = path.join(this.baseDir, 'processed');
    ensureDir(this.localInputDir);
    ensureDir(this.localOutputDir);

    this.inputFolder = options.inputFolder ?? process.env.AZURE_STORAGE_INPUT_FOLDER ?? 'inputs';
    this.outputFolder = options.outputFolder ?? process.env.AZURE_STORAGE_OUTPUT_FOLDER ?? 'processed';

    const connectionString = options.connectionString ?? process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerName = options.containerName ?? process.env.AZURE_STORAGE_CONTAINER ?? 'volleyball-videos';

    if (connectionString) {
      const blobService = BlobServiceClient.fromConnectionString(connectionString);
      this.containerClient = blobService.getContainerClient(containerName);
      this.sharedKey = parseSharedKey(connectionString);
      this.containerReady = this.containerClient.createIfNotExists().then(() => undefined);
    }
  }

  getLocalInputDir(): string {
    return this.localInputDir;
  }

  getLocalOutputDir(): string {
    return this.localOutputDir;
  }

  async saveInput(localPath: string, preferredName?: string): Promise<StoredVideo> {
    return this.save(localPath, preferredName, 'input');
  }

  async saveOutput(localPath: string, preferredName?: string): Promise<StoredVideo> {
    return this.save(localPath, preferredName, 'output');
  }

  async listInputs(): Promise<StoredVideo[]> {
    return this.list('input');
  }

  async listOutputs(): Promise<StoredVideo[]> {
    return this.list('output');
  }

  async outputExists(filename: string): Promise<boolean> {
    return this.exists(filename, 'output');
  }

  async getOutputUrl(filename: string, asAttachment = false): Promise<string | undefined> {
    return this.getUrl(filename, 'output', asAttachment);
  }

  private getLocalDir(kind: VideoKind): string {
    return kind === 'input' ? this.localInputDir : this.localOutputDir;
  }

  private getPrefix(kind: VideoKind): string {
    return kind === 'input' ? this.inputFolder : this.outputFolder;
  }

  private buildLocalUrl(kind: VideoKind, filename: string): string {
    const folder = kind === 'input' ? 'inputs' : 'processed';
    return `/uploads/${folder}/${filename}`;
  }

  private async save(localPath: string, preferredName: string | undefined, kind: VideoKind): Promise<StoredVideo> {
    const filename = path.basename(preferredName ?? localPath);
    if (this.containerClient && this.sharedKey) {
      await this.containerReady;
      const blobName = `${this.getPrefix(kind)}/${filename}`;
      const blobClient = this.containerClient.getBlockBlobClient(blobName);

      await blobClient.uploadFile(localPath, {
        blobHTTPHeaders: {
          blobContentType: guessContentType(filename),
        },
      });

      const url = await this.buildSasUrl(blobName);
      const downloadUrl = await this.buildSasUrl(blobName, true, filename);
      return {
        name: filename,
        url: url ?? blobClient.url,
        downloadUrl: downloadUrl ?? url,
      };
    }

    const destination = path.join(this.getLocalDir(kind), filename);
    if (path.resolve(localPath) !== path.resolve(destination)) {
      fs.copyFileSync(localPath, destination);
    }
    const url = this.buildLocalUrl(kind, filename);
    return { name: filename, url, downloadUrl: url };
  }

  private async list(kind: VideoKind): Promise<StoredVideo[]> {
    if (this.containerClient && this.sharedKey) {
      await this.containerReady;
      const prefix = `${this.getPrefix(kind)}/`;
      const items: StoredVideo[] = [];
      for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
        const name = blob.name.replace(prefix, '');
        const sasUrl = await this.buildSasUrl(blob.name);
        const downloadUrl = await this.buildSasUrl(blob.name, true, name);
        items.push({
          name,
          url: sasUrl ?? this.containerClient.getBlobClient(blob.name).url,
          downloadUrl: downloadUrl ?? sasUrl,
          size: blob.properties.contentLength,
          lastModified: blob.properties.lastModified?.toISOString(),
        });
      }
      return items;
    }

    const dir = this.getLocalDir(kind);
    if (!fs.existsSync(dir)) {
      return [];
    }

    return fs.readdirSync(dir)
      .filter(file => fs.statSync(path.join(dir, file)).isFile())
      .map(file => {
        const stats = fs.statSync(path.join(dir, file));
        const url = this.buildLocalUrl(kind, file);
        return {
          name: file,
          url,
          downloadUrl: url,
          size: stats.size,
          lastModified: stats.mtime.toISOString(),
        };
      });
  }

  private async exists(filename: string, kind: VideoKind): Promise<boolean> {
    if (this.containerClient) {
      await this.containerReady;
      const blobName = `${this.getPrefix(kind)}/${filename}`;
      const client = this.containerClient.getBlockBlobClient(blobName);
      try {
        return await client.exists();
      } catch {
        return false;
      }
    }

    const localPath = path.join(this.getLocalDir(kind), filename);
    return fs.existsSync(localPath);
  }

  private async getUrl(filename: string, kind: VideoKind, asAttachment: boolean): Promise<string | undefined> {
    if (this.containerClient && this.sharedKey) {
      await this.containerReady;
      const blobName = `${this.getPrefix(kind)}/${filename}`;
      return this.buildSasUrl(blobName, asAttachment, filename);
    }
    return this.buildLocalUrl(kind, filename);
  }

  private async buildSasUrl(blobName: string, asAttachment = false, downloadName?: string): Promise<string | undefined> {
    if (!this.containerClient || !this.sharedKey) {
      return undefined;
    }

    const expiresOn = new Date(Date.now() + DEFAULT_SAS_TOKEN_EXPIRATION_MS);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.containerClient.containerName,
        blobName,
        permissions: BlobSASPermissions.parse('r'),
        expiresOn,
        contentDisposition: asAttachment && downloadName ? `attachment; filename="${downloadName}"` : undefined,
      },
      this.sharedKey
    ).toString();

    return `${this.containerClient.getBlobClient(blobName).url}?${sas}`;
  }
}

export function createVideoStorage(options?: StorageOptions): VideoStorage {
  return new VideoStorage(options);
}

export const videoStorage = createVideoStorage();
