import 'dotenv/config';
import { prisma, disconnectDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { importStaticContent } from '../scripts/import-static.js';

async function main() {
  await importStaticContent();
  const demoPassword = process.env.SEED_DEMO_PASSWORD;
  if (demoPassword) {
    const passwordHash = await hashPassword(demoPassword);
    await prisma.user.upsert({ where: { email: 'demo.student@iiitnr.edu.in' }, update: { passwordHash, displayName: 'Demo Student', emailVerifiedAt: new Date(), disabledAt: null, role: 'USER' }, create: { email: 'demo.student@iiitnr.edu.in', displayName: 'Demo Student', passwordHash, emailVerifiedAt: new Date(), role: 'USER' } });
    await prisma.user.upsert({ where: { email: 'demo.approver@iiitnr.edu.in' }, update: { passwordHash, displayName: 'Demo Approver', emailVerifiedAt: new Date(), disabledAt: null, role: 'APPROVER' }, create: { email: 'demo.approver@iiitnr.edu.in', displayName: 'Demo Approver', passwordHash, emailVerifiedAt: new Date(), role: 'APPROVER' } });
  }
  console.log('Seed/import complete. Use scripts/create-admin.ts for the first administrator.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => disconnectDb());
