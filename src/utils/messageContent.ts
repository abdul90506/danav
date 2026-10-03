import type { Attachment, ChatContentPart, ChatMessageContent } from '../types';

/**
 * Turn a message plus its attachments into provider content.
 *
 * Text-only messages stay a plain string — the cheap, universally supported
 * shape. As soon as an image is attached the content becomes the multimodal
 * array, so a vision model receives the actual pixels instead of a
 * "[Attached Image: name]" placeholder. Text files never come through here;
 * they are already folded into the prompt as text.
 */

/** The image data URLs on an attachment list, ready to send to the model. */
export function imageDataUrls(attachments?: Attachment[]): string[] {
  return (attachments || [])
    .filter(
      (a) => a.type === 'image' && typeof a.content === 'string' && a.content.startsWith('data:image/')
    )
    .map((a) => a.content as string);
}

export function buildMessageContent(text: string, attachments?: Attachment[]): ChatMessageContent {
  const images = imageDataUrls(attachments);
  if (images.length === 0) return text;

  const parts: ChatContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
  // Some providers reject an empty content array — keep a text part no matter what.
  if (!parts.some((p) => p.type === 'text')) {
    parts.unshift({ type: 'text', text: 'Describe what you see in this image.' });
  }
  return parts;
}
