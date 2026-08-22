import { Test, TestingModule } from '@nestjs/testing';

import { AthleteSignatureService } from './athlete-signature.service';
import { PrismaService } from '../../../api/src/common/services/prisma.service';

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe('AthleteSignatureService', () => {
  let service: AthleteSignatureService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      athleteSignature: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
        delete: jest.fn(),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [AthleteSignatureService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<AthleteSignatureService>(AthleteSignatureService);
  });

  it('guarda la firma nueva con norma 1 aunque llegue en crudo', async () => {
    // InsightFace devuelve vectores sin normalizar, con normas de ~20.
    await service.updateAthleteSignature('ev', '101', [30, 40, 0, 0]);

    const saved = prisma.athleteSignature.create.mock.calls[0][0].data.faceSignature;
    expect(norm(saved)).toBeCloseTo(1, 5);
  });

  it('una cara lejana pesa igual que un primer plano al promediar', async () => {
    prisma.athleteSignature.findUnique.mockResolvedValue({
      id: 's1',
      // Firma previa apuntando al eje X.
      faceSignature: [1, 0, 0, 0],
      sampleCount: 1,
      confidence: 0.75,
    });

    // Vector de norma pequeña (cara lejana) apuntando al eje Y. Sin normalizar,
    // su aportación quedaría diluida por la magnitud.
    await service.updateAthleteSignature('ev', '101', [0, 0.01, 0, 0]);

    const updated = prisma.athleteSignature.update.mock.calls[0][0].data.faceSignature;
    // alpha = 0.4, así que el eje Y debe aportar exactamente ese peso.
    expect(updated[1]).toBeCloseTo(0.4, 5);
    expect(updated[0]).toBeCloseTo(0.6, 5);
  });

  it('rechaza actualizar cuando Gemini no tenía confianza suficiente', async () => {
    await service.updateAthleteSignature('ev', '101', [1, 0, 0, 0], 0.2);

    expect(prisma.athleteSignature.create).not.toHaveBeenCalled();
    expect(prisma.athleteSignature.update).not.toHaveBeenCalled();
  });
});
