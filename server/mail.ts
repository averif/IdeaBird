import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';

interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Thrown when a configured provider failed to accept the message. */
export class MailError extends Error {}

/** How mail is delivered on this server. */
export type MailDelivery = 'resend' | 'smtp' | 'console' | 'none';

export function mailDelivery(): MailDelivery {
  const { resendApiKey, smtp, isProduction } = config();
  if (resendApiKey) return 'resend';
  if (smtp) return 'smtp';
  // Printing emails (including codes and reset links) is only acceptable locally.
  return isProduction ? 'none' : 'console';
}

let transporter: Transporter | null = null;

function smtpTransport(): Transporter {
  const smtp = config().smtp!;
  transporter ??= nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465, // 465 = TLS from the start; 587 upgrades with STARTTLS
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  return transporter;
}

/**
 * Sends transactional email: Resend when RESEND_API_KEY is set, otherwise SMTP
 * (e.g. Gmail) when SMTP_USER/SMTP_PASS are set. In local development with
 * neither, the message is printed to the server console. Throws MailError if
 * the provider rejects the message, so callers never claim an email was sent
 * when it wasn't.
 */
export async function sendMail({ to, subject, text }: Mail): Promise<void> {
  const delivery = mailDelivery();
  const from = config().mailFrom;

  if (delivery === 'console') {
    console.log(`\n\x1b[35m[mail] (no email provider configured: printing instead of sending)\n[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\x1b[0m\n`);
    return;
  }

  if (delivery === 'none') {
    console.error('[mail] No email provider is configured (RESEND_API_KEY or SMTP_USER/SMTP_PASS); email was not sent.');
    throw new MailError('Email is not configured on this server.');
  }

  if (delivery === 'smtp') {
    try {
      await smtpTransport().sendMail({ from, to, subject, text });
      return;
    } catch (err) {
      // Never log credentials; the error message and code are enough to debug.
      const e = err as { code?: string; responseCode?: number; message?: string };
      console.error(`[mail] SMTP send failed (${e.code ?? ''} ${e.responseCode ?? ''}): ${e.message?.slice(0, 200)}`);
      throw new MailError('The email could not be sent.');
    }
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config().resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text }),
  }).catch(() => null);

  if (!response?.ok) {
    const detail = response ? await response.text().catch(() => '') : 'network error';
    console.error(`[mail] Resend rejected the email (HTTP ${response?.status ?? '-'}): ${detail.slice(0, 300)}`);
    throw new MailError('The email could not be sent.');
  }
}
