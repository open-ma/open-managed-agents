// Nodemailer-backed sender for self-host. Lazy-imports nodemailer so a
// SQLite-only deploy without SMTP doesn't pull it in.

import type { EmailMessage, EmailSender } from "../index";
import { DEFAULT_FROM } from "../index";

export interface NodemailerOptions {
  /** SMTP host (smtp.resend.com / smtp.sendgrid.net / your-relay). */
  host: string;
  port: number;
  /** When true, use TLS; for STARTTLS leave false and let nodemailer upgrade. */
  secure?: boolean;
  user?: string;
  pass?: string;
  /** Optional override for the from address; otherwise DEFAULT_FROM. */
  fromAddress?: string;
}

// Untyped — nodemailer is an optional peer; we only use one method on
// the transporter so duck-typing is fine and avoids the type-only dep.
type NodemailerTransporter = {
  sendMail(input: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<unknown>;
};

export class NodemailerSender implements EmailSender {
  private transporter: NodemailerTransporter | null = null;

  constructor(private readonly opts: NodemailerOptions) {}

  private async ensureTransporter(): Promise<NodemailerTransporter> {
    if (this.transporter) return this.transporter;
    // Lazy, dynamic import via Function to keep TS off our back —
    // nodemailer is an optional peer; only reachable when SMTP_HOST is
    // configured (see senderFromEnv). The transporter is duck-typed.
    const importer = Function("p", "return import(p)") as (
      p: string,
    ) => Promise<{ default: { createTransport: (opts: unknown) => NodemailerTransporter } }>;
    const nodemailerMod = await importer("nodemailer");
    const nodemailer = nodemailerMod.default;
    this.transporter = nodemailer.createTransport({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure ?? this.opts.port === 465,
      auth: this.opts.user
        ? { user: this.opts.user, pass: this.opts.pass }
        : undefined,
    });
    return this.transporter!;
  }

  async send(msg: EmailMessage): Promise<void> {
    const t = await this.ensureTransporter();
    await t.sendMail({
      from: msg.from ?? this.opts.fromAddress ?? DEFAULT_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
  }
}

/** Build a NodemailerSender from env vars, or return null when SMTP_HOST
 *  is unset. The null result signals "no email; mount email-disabled
 *  better-auth flows" — same shape as the CF binding-absent path. */
export function senderFromEnv(env: NodeJS.ProcessEnv): EmailSender | null {
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  return new NodemailerSender({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE === "1" || port === 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    fromAddress: env.SMTP_FROM,
  });
}

