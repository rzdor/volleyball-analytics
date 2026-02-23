import fs from 'fs';
import os from 'os';
import path from 'path';
import { createVideoStorage } from '../services/storageProvider';

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
