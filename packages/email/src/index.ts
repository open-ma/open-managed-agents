// Runtime-agnostic email port.
//
// CF wraps env.SEND_EMAIL.send(...). Self-host wraps nodemailer. `null`
// is also a valid sender — better-auth wiring uses presence to decide
// whether to mount email-OTP / reset / verification routes (P0-followup
// default-off behavior).

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Optional override; defaults to "openma <noreply@openma.dev>" when omitted. */
  from?: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

export const DEFAULT_FROM = "openma <noreply@openma.dev>";
