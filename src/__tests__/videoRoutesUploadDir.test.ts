import fs from 'fs';
import os from 'os';
import path from 'path';

describe('videoRoutes uploads directory', () => {
  const originalUploadsDir = process.env.UPLOADS_DIR;
  let tempUploadsDir: string | undefined;

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env.UPLOADS_DIR = originalUploadsDir;
    jest.resetModules();
    if (tempUploadsDir) {
      fs.rmSync(tempUploadsDir, { recursive: true, force: true });
      tempUploadsDir = undefined;
    }
  });

  it('creates the uploads directory when it does not exist', async () => {
    tempUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-test-'));
    const targetDir = path.join(tempUploadsDir, 'nested', 'uploads');
    process.env.UPLOADS_DIR = targetDir;

    await jest.isolateModulesAsync(async () => {
      await import('../routes/videoRoutes');
    });

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.statSync(targetDir).isDirectory()).toBe(true);
  });

  it('memoizes the resolved uploads directory path', async () => {
    tempUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-memo-test-'));
    process.env.UPLOADS_DIR = tempUploadsDir;

    await jest.isolateModulesAsync(async () => {
      const mkdirSpy = jest.spyOn(fs, 'mkdirSync');
      const { resolveUploadsDir } = await import('../utils/uploads');

      const first = resolveUploadsDir();
      const second = resolveUploadsDir();

      expect(first).toBe(second);
      expect(mkdirSpy).toHaveBeenCalledTimes(1);
      mkdirSpy.mockRestore();
    });
  });
});
