import { pricingPolicyIssue } from './pricing-policy';

const valid = {
  currency: 'USD',
  singlePhoto: 150,
  pack5: 675,
  pack10: 1200,
  allPhotos: 1800,
};

describe('pricingPolicyIssue', () => {
  it('accepts 1.50 USD as the minimum individual price', () => {
    expect(pricingPolicyIssue(valid)).toBeNull();
  });

  it('reports the minimum in customer-facing currency, not raw cents', () => {
    expect(pricingPolicyIssue({ ...valid, singlePhoto: 149 })).toMatchObject({
      code: 'PRICE_BELOW_MINIMUM',
      field: 'singlePhoto',
      minimumCents: 150,
      message: 'La foto individual debe costar al menos 1.50 USD',
    });
  });

  it('rejects incoherent package ordering', () => {
    expect(pricingPolicyIssue({ ...valid, pack10: 1400, pack5: 650 })).toMatchObject({
      code: 'PACKAGE_ORDER_INVALID',
      field: 'pack10',
    });
  });
});
