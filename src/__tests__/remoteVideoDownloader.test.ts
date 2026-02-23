import fs from 'fs';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import { downloadVideoFromUrl, VideoDownloadError } from '../services/remoteVideoDownloader';

const uploadsDir = path.join(__dirname, '../../uploads');

function startTestServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
      });
    });
  });
}

describe('downloadVideoFromUrl', () => {
  it('downloads a small video file to uploads directory', async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const server = await startTestServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': payload.length });
      res.end(payload);
    });

    let filePath = '';
    try {
      filePath = await downloadVideoFromUrl(`${server.url}/clip.mp4`, uploadsDir, 1024);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.statSync(filePath).size).toBe(payload.length);
    } finally {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      await server.close();
    }
  });

  it('rejects when the response is not a video', async () => {
    const server = await startTestServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not a video');
    });

    try {
      await expect(downloadVideoFromUrl(`${server.url}/not-video.txt`, uploadsDir, 1024))
        .rejects.toBeInstanceOf(VideoDownloadError);
    } finally {
      await server.close();
    }
  });

  it('rejects when the file exceeds the configured limit', async () => {
    const server = await startTestServer((_, res) => {
      const size = 2048;
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
      res.end(Buffer.alloc(size, 1));
    });

    try {
      await expect(downloadVideoFromUrl(`${server.url}/too-large.mp4`, uploadsDir, 1024))
        .rejects.toThrow(/size limit/i);
    } finally {
      await server.close();
    }
  });
});
