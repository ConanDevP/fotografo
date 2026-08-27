const Stripe = require('stripe'); const fs=require('fs');
const env = require('dotenv').parse(fs.readFileSync('.env'));
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });
(async () => {
  const spec = await stripe.countrySpecs.list({ limit: 100 });
  const codes = spec.data.map(s => s.id);
  for (const c of ['US','HN','GT','MX','SV','CR']) {
    console.log(`  ${c}: ${codes.includes(c) ? 'admitido' : 'NO admitido'}`);
  }
})().catch(e => console.error('  ', e.message.split('\n')[0]));
