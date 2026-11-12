import { mkdir, writeFile } from 'node:fs/promises';

const response = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem');
if (!response.ok) {
  throw new Error(`Failed to download the AWS RDS CA bundle: HTTP ${response.status}`);
}

const bundle = await response.text();
if (!bundle.includes('-----BEGIN CERTIFICATE-----')) {
  throw new Error('The downloaded AWS RDS CA bundle did not contain a certificate');
}

await mkdir('certs', { recursive: true });
await writeFile('certs/rds-global-bundle.pem', bundle, 'utf8');
console.log('Downloaded AWS RDS CA bundle');
