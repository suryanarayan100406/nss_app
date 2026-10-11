import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { prisma, disconnectDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { validateRegistrationEmail } from '../src/auth.js';

const rl = readline.createInterface({ input, output });
try {
  const email = validateRegistrationEmail(process.env.ADMIN_EMAIL ?? await rl.question('Admin email (@iiitnr.edu.in): '));
  const displayName = (process.env.ADMIN_NAME ?? await rl.question('Admin display name: ')).trim();
  const password = process.env.ADMIN_PASSWORD ?? await rl.question('Admin password (12+ characters): ');
  if (password.length < 12) throw new Error('Admin password must be at least 12 characters.');
  const user = await prisma.user.upsert({ where: { email }, update: { displayName, passwordHash: await hashPassword(password), role: 'ADMIN', emailVerifiedAt: new Date(), disabledAt: null }, create: { email, displayName, passwordHash: await hashPassword(password), role: 'ADMIN', emailVerifiedAt: new Date() } });
  console.log(`Admin ready: ${user.email}`);
} finally {
  rl.close();
  await disconnectDb();
}
