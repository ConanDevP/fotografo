/**
 * Piloto estándar: lo justo para integrar y probar con un evento real, sin que
 * un uso desmedido te cueste dinero. Los topes están pensados para costar unos
 * pocos dólares en total (IA, almacenamiento y cómputo de ~300 fotografías).
 */
export const PILOT_PRESET = {
  days: 30,
  account: {
    partnerApiEnabled: true,
    webhooksEnabled: true,
    faceSearchEnabled: true,
    sponsorsEnabled: false,
    customDomainEnabled: false,
    advancedAnalyticsEnabled: false,
    exportsEnabled: false,
    // Sin originales: en el piloto se ve el producto, no se descarga el material.
    originalDownloadsEnabled: false,
    sponsoredDownloadsEnabled: false,
    priorityProcessingEnabled: false,
    annualPhotoLimit: 300,
    annualEventLimit: 3,
    monthlyApiRequestLimit: 3000,
    monthlyFaceSearchLimit: 200,
    maxApiClients: 2,
    maxWebhookEndpoints: 2,
    maxAdmins: 3,
    retentionDays: 30,
    allowOverage: false,
  },
} as const;
