import * as sharp from 'sharp';
import { SharpTransformService } from './sharp-transform.service';

// La composición patrocinada usa Sharp y no necesita Canvas. El mock mantiene
// esta prueba portable en entornos donde el addon nativo opcional no está.
jest.mock('canvas', () => ({ createCanvas: jest.fn(), registerFont: jest.fn() }));

describe('SharpTransformService sponsored downloads', () => {
  const service = new SharpTransformService();

  async function redPixels(buffer: Buffer) {
    const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    let count = 0;
    for (let index = 0; index < data.length; index += 3) {
      if (data[index] > 180 && data[index + 1] < 90 && data[index + 2] < 90) count++;
    }
    return count;
  }

  it('honors maxHeightPercent when rendering sponsor logos', async () => {
    const photo = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#e5e7eb' },
    }).jpeg().toBuffer();
    const logo = await sharp({
      create: { width: 400, height: 200, channels: 4, background: '#ef0000' },
    }).png().toBuffer();

    const small = await service.generateSponsoredDownload(photo, [logo], {
      position: 'bottom', opacity: 0.82, maxHeightPercent: 2,
    });
    const large = await service.generateSponsoredDownload(photo, [logo], {
      position: 'bottom', opacity: 0.82, maxHeightPercent: 12,
    });

    expect(await redPixels(large)).toBeGreaterThan((await redPixels(small)) * 4);
    await expect(sharp(large).metadata()).resolves.toMatchObject({ width: 1200, height: 800, format: 'jpeg' });
  });
});
