import fs from 'fs';
import path from 'path';

let cachedUploadsDir: string | undefined;

export function resolveUploadsDir(): string {
  if (cachedUploadsDir) {
    return cachedUploadsDir;
  }

  const baseDir = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads');
  const uploadsDir = path.resolve(baseDir);

  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create uploads directory at ${uploadsDir}`, {
      cause: error,
    });
  }

  cachedUploadsDir = uploadsDir;
  return cachedUploadsDir;
}
