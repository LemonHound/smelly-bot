import 'dotenv/config';
import { Storage } from '@google-cloud/storage';

const BASE_URL = 'https://www.everycrsreport.com';
const CSV_URL = `${BASE_URL}/reports.csv`;
const DELAY_MS = 150;

function parseCsvLine(line) {
  const parts = line.split(',');
  const number = parts[0];
  const sha1 = parts[2];
  const date = parts[3];
  const latestHTML = parts[parts.length - 1].trim();
  const latestPDF = parts[parts.length - 2];
  const title = parts.slice(4, parts.length - 2).join(',');
  return { number, sha1, date, title, latestPDF, latestHTML };
}

async function ingestReport(bucket, report) {
  const objectName = `${report.number}.pdf`;
  const [exists] = await bucket.file(objectName).exists();
  if (exists) return 'skipped';

  const pdfUrl = `${BASE_URL}/${report.latestPDF}`;
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  await bucket.file(objectName).save(buffer, { contentType: 'application/pdf' });

  await bucket.file(`${objectName}.metadata.json`).save(
    JSON.stringify({ title: report.title, reportNumber: report.number, date: report.date, source: 'everycrsreport.com', pdfUrl }),
    { contentType: 'application/json' }
  );

  return 'uploaded';
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

  const credentials = JSON.parse(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY);
  const storage = new Storage({ credentials, projectId: process.env.GOOGLE_CLOUD_PROJECT });
  const bucket = storage.bucket(process.env.GCS_RAG_BUCKET);

  console.log('Fetching CRS report index...');
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch index: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n').slice(1);

  const reports = lines
    .map(parseCsvLine)
    .filter(r => r.latestPDF)
    .slice(0, Number.isFinite(limit) ? limit : undefined);

  console.log(`Processing ${reports.length} reports...`);

  let uploaded = 0, skipped = 0, failed = 0;

  for (let i = 0; i < reports.length; i++) {
    try {
      const result = await ingestReport(bucket, reports[i]);
      result === 'uploaded' ? uploaded++ : skipped++;
    } catch (err) {
      console.warn(`  Failed ${reports[i].number}: ${err.message}`);
      failed++;
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  ${i + 1}/${reports.length} — uploaded: ${uploaded}, skipped: ${skipped}, failed: ${failed}`);
    }
    if (i < reports.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`Done. Uploaded: ${uploaded}, Skipped: ${skipped}, Failed: ${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
