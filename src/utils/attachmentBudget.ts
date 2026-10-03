/**
 * How much one message may carry.
 *
 * The composer's attachments travel to the server inside the JSON body of a
 * chat request (text as-is, images as data URLs). The server accepts 25 MB and
 * answers anything larger with "request entity too large" — a dead end for the
 * user, whose message is simply not sent. Keeping the composer's own budget
 * below that ceiling turns the failure into a reason shown next to the
 * paperclip, before anything is lost.
 */

/** Files larger than this are never read: they would be truncated anyway. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Everything attached to one message, measured as the payload it produces. */
export const ATTACHMENT_BUDGET_BYTES = 12_000_000;

/** The payload one attachment adds to the request. */
export function attachmentPayloadBytes(attachment: { content?: string }): number {
  return typeof attachment?.content === 'string' ? attachment.content.length : 0;
}

/** The payload a whole attachment set adds to the request. */
export function totalPayloadBytes(attachments: { content?: string }[]): number {
  return (Array.isArray(attachments) ? attachments : []).reduce(
    (total, attachment) => total + attachmentPayloadBytes(attachment),
    0
  );
}

/** Does this piece still fit in the message's budget? */
export function fitsAttachmentBudget(usedBytes: number, contentLength: number): boolean {
  const used = Number.isFinite(usedBytes) && usedBytes > 0 ? usedBytes : 0;
  const next = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  return used + next <= ATTACHMENT_BUDGET_BYTES;
}

/** "12 MB" — for the message shown when something does not fit. */
export function formatBytesAsMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
