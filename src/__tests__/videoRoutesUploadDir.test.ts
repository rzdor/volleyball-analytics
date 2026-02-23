import fs from 'fs';
import os from 'os';
import path from 'path';

describe('videoRoutes uploads directory', () => {
  const originalUploadsDir = process.env.UPLOADS_DIR;
  let tempRoot = '';

  afterEach(() => {
    process.env.UPLOADS_DIR = originalUploadsDir;
    jest.resetModules();
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('creates the uploads directory when it does not exist', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-test-'));
    const targetDir = path.join(tempRoot, 'nested', 'uploads');
    process.env.UPLOADS_DIR = targetDir;

    jest.resetModules();
    await import('../routes/videoRoutes');

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.statSync(targetDir).isDirectory()).toBe(true);
  });
});
