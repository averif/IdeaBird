import { config } from './config.js';

interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends transactional email through Resend when RESEND_API_KEY is set. In local
 * development without a key, the message (including its link) is printed to the
 * server console instead. In production without a key nothing is logged, because
 * reset links in logs would be live credentials.
 */
export async function sendMail({ to, subject, text }: Mail): Promise<void> {
  const { resendApiKey, mailFrom, isProduction } = config();

  if (!resendApiKey) {
    if (isProduction) {
      console.error('[mail] RESEND_API_KEY is not set; email was not sent.');
    } else {
      console.log(`\n\x1b[35m[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\x1b[0m\n`);
    }
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: mailFrom, to, subject, text }),
  });

  if (!response.ok) {
    console.error(`[mail] Resend rejected the email (HTTP ${response.status}).`);
  }
}
