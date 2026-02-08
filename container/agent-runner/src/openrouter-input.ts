import fs from 'fs';
import path from 'path';

import type { ContainerInput } from './container-protocol.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB per image
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB total across all images
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface OpenRouterInputTextPart {
  type: 'input_text';
  text: string;
}

export interface OpenRouterInputImagePart {
  type: 'input_image';
  detail: 'auto';
  imageUrl: string;
}

export type OpenRouterUserContentPart = OpenRouterInputTextPart | OpenRouterInputImagePart;

export interface OpenRouterInputMessage {
  role: 'user' | 'assistant';
  content: string | OpenRouterUserContentPart[];
}

function inferImageMimeFromName(fileName?: string): string | null {
  if (!fileName || typeof fileName !== 'string') return null;
  const extension = path.extname(fileName).toLowerCase();
  if (!extension) return null;
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  return null;
}

function normalizeMimeType(input: unknown, fallbackName?: string): string | null {
  const fromInput = typeof input === 'string'
    ? input.toLowerCase().split(';')[0].trim()
    : '';
  const candidate = fromInput || inferImageMimeFromName(fallbackName);
  if (!candidate || !IMAGE_MIME_TYPES.has(candidate)) return null;
  return candidate;
}

function jsonStringifySafe(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : String(value);
  } catch {
    return String(value);
  }
}

export function coerceInputContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';

  const collectFromRecord = (record: Record<string, unknown>): string | null => {
    if (typeof record.text === 'string' && record.text.trim()) return record.text;
    if (typeof record.content === 'string' && record.content.trim()) return record.content;
    if (typeof record.output === 'string' && record.output.trim()) return record.output;
    if (typeof record.refusal === 'string' && record.refusal.trim()) return record.refusal;
    return null;
  };

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!part || typeof part !== 'object') return null;
        const record = part as Record<string, unknown>;
        return collectFromRecord(record);
      })
      .filter((part): part is string => typeof part === 'string');
    if (parts.length > 0) return parts.join('\n');
    return jsonStringifySafe(content);
  }

  if (typeof content === 'object') {
    const extracted = collectFromRecord(content as Record<string, unknown>);
    if (extracted) return extracted;
    return jsonStringifySafe(content);
  }

  return String(content);
}

export function messagesToOpenRouterInput(
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
): OpenRouterInputMessage[] {
  return messages.map(message => ({
    role: message.role,
    content: coerceInputContentToText(message.content)
  }));
}

export function loadImageAttachmentsForInput(
  attachments?: ContainerInput['attachments'],
  options?: { log?: (message: string) => void }
): OpenRouterInputImagePart[] {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];

  const log = options?.log;
  const images: OpenRouterInputImagePart[] = [];
  let totalBytes = 0;

  for (const attachment of attachments) {
    if (!attachment || attachment.type !== 'photo' || typeof attachment.path !== 'string' || !attachment.path) {
      continue;
    }

    const mime = normalizeMimeType(attachment.mime_type, attachment.file_name);
    if (!mime) continue;

    try {
      const stat = fs.statSync(attachment.path);
      if (stat.size > MAX_IMAGE_BYTES) {
        log?.(`Skipping image ${attachment.path}: ${stat.size} bytes exceeds ${MAX_IMAGE_BYTES}`);
        continue;
      }
      if (totalBytes + stat.size > MAX_TOTAL_IMAGE_BYTES) {
        log?.(`Skipping image ${attachment.path}: cumulative size would exceed ${MAX_TOTAL_IMAGE_BYTES}`);
        break;
      }

      const data = fs.readFileSync(attachment.path);
      totalBytes += data.length;
      images.push({
        type: 'input_image',
        detail: 'auto',
        imageUrl: `data:${mime};base64,${data.toString('base64')}`
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log?.(`Failed to load image ${attachment.path}: ${detail}`);
    }
  }

  return images;
}

export function injectImagesIntoContextInput(
  contextInput: OpenRouterInputMessage[],
  imageParts: OpenRouterInputImagePart[]
): void {
  if (!Array.isArray(contextInput) || contextInput.length === 0 || imageParts.length === 0) return;
  const lastMessage = contextInput[contextInput.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') return;

  lastMessage.content = [
    {
      type: 'input_text',
      text: coerceInputContentToText(lastMessage.content)
    },
    ...imageParts
  ];
}
