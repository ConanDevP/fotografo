const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://postgres:docs@localhost:55433/lm_docs_test' } } });
const SCOPES = ['events:read','events:write','events:publish','events:analytics','events:contributors','events:sponsors','photos:read','photos:upload','photos:review','photos:process','photos:delete','photos:download','photos:bulk','exports:read','workspace:read','workspace:write','search:bib','search:face','webhooks:manage','orders:read','metrics:write'];
(async () => {
  const owner = await prisma.user.create({ data: { email: 'owner@docs.test', name: 'Cronos Demo', role: 'PHOTOGRAPHER' } });
  const ws = await prisma.workspace.create({ data: { name: 'Cronos Demo', slug: 'cronos-demo', ownerId: owner.id } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: owner.id, role: 'OWNER' } });
  await prisma.enterpriseAccount.create({ data: {
    workspaceId: ws.id, status: 'ACTIVE', contractStart: new Date(Date.now()-86400000), contractEnd: new Date(Date.now()+300*86400000),
    partnerApiEnabled: true, webhooksEnabled: true, faceSearchEnabled: true, sponsorsEnabled: true, customDomainEnabled: true,
    advancedAnalyticsEnabled: true, exportsEnabled: true, originalDownloadsEnabled: true, priorityProcessingEnabled: true,
    annualPhotoLimit: 100000, monthlyApiRequestLimit: 100000, monthlyFaceSearchLimit: 10000, maxApiClients: 5, maxWebhookEndpoints: 5,
  } });
  const prefix = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const apiKey = `lm_live_${prefix}_${secret}`;
  await prisma.apiClient.create({ data: { workspaceId: ws.id, createdById: owner.id, name: 'Docs capture', keyPrefix: prefix, secretHash: crypto.createHash('sha256').update(apiKey).digest('hex'), scopes: SCOPES, environment: 'LIVE' } });
  const rp = crypto.randomBytes(8).toString('hex'); const rs = crypto.randomBytes(32).toString('base64url'); const restricted = `lm_live_${rp}_${rs}`;
  await prisma.apiClient.create({ data: { workspaceId: ws.id, createdById: owner.id, name: 'Solo lectura', keyPrefix: rp, secretHash: crypto.createHash('sha256').update(restricted).digest('hex'), scopes: ['events:read'], environment: 'LIVE' } });
  console.log(JSON.stringify({ apiKey, restrictedKey: restricted, workspaceId: ws.id, ownerId: owner.id }));
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
