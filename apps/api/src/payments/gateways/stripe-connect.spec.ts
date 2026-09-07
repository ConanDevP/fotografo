import { StripeConnectService } from './stripe-connect.service';

describe('StripeConnectService lifecycle', () => {
  const config = {
    get: (name: string, fallback?: string) => name === 'STRIPE_SECRET_KEY' ? 'sk_test_fake' : fallback,
  };

  it('desactiva localmente una cuenta que revocó la aplicación', async () => {
    const prisma = { user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const service = new StripeConnectService(config as any, prisma as any);

    await service.handleDeauthorized('acct_disconnected');

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { stripeAccountId: 'acct_disconnected' },
      data: {
        stripeAccountStatus: 'disconnected',
        stripeOnboardingCompleted: false,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
      },
    });
  });

  it('propaga un fallo de account.updated para que Stripe pueda reintentarlo', async () => {
    const prisma = { user: { updateMany: jest.fn().mockRejectedValue(new Error('db unavailable')) } };
    const service = new StripeConnectService(config as any, prisma as any);

    await expect(service.handleAccountUpdated({
      id: 'acct_1', metadata: { userId: 'user-1' }, charges_enabled: true,
      payouts_enabled: true, details_submitted: true,
    } as any)).rejects.toThrow('db unavailable');
  });
});
