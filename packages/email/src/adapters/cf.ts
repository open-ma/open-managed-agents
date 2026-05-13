// CF Email Workers binding wrapper.
//
// SEND_EMAIL is the wrangler `send_email` binding. .send({from,to,subject,html,text})
// invokes the platform mail relay. Returns a no-op when the binding is
// unbound (test harness, deploys without email yet).

import type { EmailMessage, EmailSender } from "../index";
import { DEFAULT_FROM } from "../index";

export interface CfSendEmailBinding {
  send(input: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<unknown> | void;
}

export class CfSendEmailSender implements EmailSender {
  constructor(private readonly binding: CfSendEmailBinding) {}

  async send(msg: EmailMessage): Promise<void> {
    await this.binding.send({
      from: msg.from ?? DEFAULT_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
  }
}

/** Convenience: wrap a CF SEND_EMAIL binding as an EmailSender, or return null
 *  when the binding is unbound. The null result is a valid sender choice — see
 *  packages/email/src/index.ts for the rationale. */
export function senderFromCfBinding(
  binding: CfSendEmailBinding | undefined,
): EmailSender | null {
  return binding ? new CfSendEmailSender(binding) : null;
}
