import ffmpeg from 'fluent-ffmpeg';

export const TARGET_CONVERT_HEIGHT = 720;

export function shouldConvertTo720p(sourceHeight: number): boolean {
  return sourceHeight > TARGET_CONVERT_HEIGHT;
}

export async function convertVideoTo720p(inputPath: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-preset',
        'medium',
        '-crf',
        '23',
        '-movflags',
        '+faststart',
        '-vf',
        'scale=-2:720',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}
