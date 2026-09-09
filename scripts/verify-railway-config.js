require('dotenv').config({ path: '.env' });

const required = [
  'RAILWAY_API_TOKEN',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_FRONTEND_SERVICE_ID',
  'RAILWAY_FRONTEND_PORT',
];

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`MISSING=${missing.join(',')}`);
  process.exit(2);
}

console.log('ENV_VARS=OK');

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 20_000);

fetch('https://backboard.railway.com/graphql/v2', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: `query validate($projectId: String!) {
      project(id: $projectId) {
        id
        name
        services { edges { node { id name } } }
        environments { edges { node { id name } } }
      }
    }`,
    variables: { projectId: process.env.RAILWAY_PROJECT_ID },
  }),
  signal: controller.signal,
})
  .then(async (response) => {
    console.log(`HTTP=${response.status}`);
    const json = await response.json();
    if (json.errors?.length) {
      console.error(`GRAPHQL_ERROR=${json.errors[0].message}`);
      process.exitCode = 3;
      return;
    }
    const project = json.data.project;
    const services = project.services.edges.map(({ node }) => node);
    const environments = project.environments.edges.map(({ node }) => node);
    const service = services.find(({ id }) => id === process.env.RAILWAY_FRONTEND_SERVICE_ID);
    const environment = environments.find(({ id }) => id === process.env.RAILWAY_ENVIRONMENT_ID);
    console.log(`PROJECT=OK (${project.name})`);
    console.log(service ? `FRONTEND_SERVICE=OK (${service.name})` : 'FRONTEND_SERVICE=NOT_FOUND_IN_PROJECT');
    console.log(environment ? `ENVIRONMENT=OK (${environment.name})` : 'ENVIRONMENT=NOT_FOUND_IN_PROJECT');
    console.log(`PORT=${process.env.RAILWAY_FRONTEND_PORT}`);

    if (!service || !environment) return;
    const domainResponse = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
          domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
            customDomains {
              id
              domain
              targetPort
              status {
                verificationToken
                certificateStatus
                dnsRecords { hostlabel requiredValue currentValue status }
              }
            }
          }
        }`,
        variables: {
          projectId: process.env.RAILWAY_PROJECT_ID,
          environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
          serviceId: process.env.RAILWAY_FRONTEND_SERVICE_ID,
        },
      }),
      signal: controller.signal,
    });
    const domainJson = await domainResponse.json();
    if (domainJson.errors?.length) {
      console.error(`DOMAINS_QUERY=ERROR (${domainJson.errors[0].message})`);
      process.exitCode = 5;
      return;
    }
    console.log(`DOMAINS_QUERY=OK (${domainJson.data.domains.customDomains.length} configured)`);
    for (const domain of domainJson.data.domains.customDomains) {
      console.log(`DOMAIN=${domain.domain} PORT=${domain.targetPort ?? 'AUTO'} CERTIFICATE=${domain.status?.certificateStatus ?? 'UNKNOWN'}`);
      if (process.argv.includes('--fix-ports') && domain.targetPort !== Number(process.env.RAILWAY_FRONTEND_PORT)) {
        const updateResponse = await fetch('https://backboard.railway.com/graphql/v2', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: `mutation updatePort($environmentId: String!, $id: String!, $targetPort: Int) {
              customDomainUpdate(environmentId: $environmentId, id: $id, targetPort: $targetPort)
            }`,
            variables: {
              environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
              id: domain.id,
              targetPort: Number(process.env.RAILWAY_FRONTEND_PORT),
            },
          }),
          signal: controller.signal,
        });
        const updateJson = await updateResponse.json();
        if (updateJson.errors?.length) {
          console.error(`PORT_FIX=ERROR (${domain.domain}: ${updateJson.errors[0].message})`);
          process.exitCode = 6;
        } else {
          console.log(`PORT_FIX=OK (${domain.domain} -> ${process.env.RAILWAY_FRONTEND_PORT})`);
        }
      }
    }
  })
  .catch((error) => {
    console.error(`REQUEST_ERROR=${error.name}: ${error.message}`);
    process.exitCode = 4;
  })
  .finally(() => clearTimeout(timeout));
