import nodemailer from 'nodemailer';
import { config } from './config.js';
import { logger } from './logger.js';

const transport = config.SMTP_HOST
  ? nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465, auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined })
  : null;

export async function sendMail(to: string, subject: string, text: string) {
  if (!transport) {
    logger.info({ to, subject, text }, 'mail catcher fallback: message logged because SMTP_HOST is unset');
    return;
  }
  try {
    await transport.sendMail({ from: config.SMTP_FROM, to, subject, text });
  } catch (error) {
    logger.error({ err: error, to, subject }, 'mail delivery failed; in-app workflow remains available');
  }
}
