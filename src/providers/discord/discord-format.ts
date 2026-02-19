/**
 * Discord message formatting.
 *
 * Discord natively supports Markdown, so no conversion is needed.
 * This module handles chunking long messages while preserving code fences,
 * and adds [1/N] markers for multi-part messages.
 *
 * EMBED FORMAT:
 * For rich embed cards, use a special XML-like format in AI responses:
 *
 * <embed title="Title" color="#0099FF">
 * <field name="Field Name" inline="false">Field value content</field>
 * <field name="Inline Field" inline="true">Short value</field>
 * </embed>
 *
 * Multiple embeds can be sent in one message. Supported attributes:
 * - title: Embed title (max 256 chars)
 * - description: Main description (max 4096 chars)
 * - color: Hex color (e.g., "#0099FF" or 0x0099FF)
 * - thumbnail: URL for thumbnail image
 * - footer: Footer text
 *
 * Field attributes:
 * - name: Field name (max 256 chars)
 * - inline: "true" or "false" for inline display
 */

type Segment = {
  type: 'text' | 'code';
  lang: string;
  content: string;
};

function splitByCodeFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const fenceRegex = /```([a-zA-Z0-9_-]*)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', lang: '', content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', lang: match[1] ?? '', content: match[2] ?? '' });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', lang: '', content: text.slice(lastIndex) });
  }

  return segments;
}

function splitTextPreservingNewlines(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const lines = text.split(/(\n)/);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) return;
    chunks.push(current);
    current = '';
  };

  for (const line of lines) {
    if (!line) continue;
    if (current.length + line.length <= maxLength) {
      current += line;
      continue;
    }

    pushCurrent();

    if (line.length > maxLength) {
      // Hard-split very long lines
      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.slice(i, i + maxLength));
      }
    } else {
      current = line;
    }
  }

  pushCurrent();
  return chunks;
}

function splitCodeBlock(lang: string, code: string, maxLength: number): string[] {
  const openFence = lang ? `\`\`\`${lang}\n` : '```\n';
  const closeFence = '\n```';
  const overhead = openFence.length + closeFence.length;

  if (code.length + overhead <= maxLength) {
    return [`${openFence}${code}${closeFence}`];
  }

  // Split code by lines, wrapping each chunk in fences
  const lines = code.split(/(\n)/);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) return;
    chunks.push(`${openFence}${current}${closeFence}`);
    current = '';
  };

  for (const line of lines) {
    if (!line) continue;
    if (current.length + line.length + overhead <= maxLength) {
      current += line;
      continue;
    }

    pushCurrent();

    if (line.length + overhead > maxLength) {
      // Hard-split very long lines within code fences
      const innerMax = maxLength - overhead;
      for (let i = 0; i < line.length; i += innerMax) {
        chunks.push(`${openFence}${line.slice(i, i + innerMax)}${closeFence}`);
      }
    } else {
      current = line;
    }
  }

  pushCurrent();
  return chunks;
}

function packPieces(pieces: string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const piece of pieces) {
    if (!piece) continue;
    if (!current) {
      current = piece;
      continue;
    }
    if (current.length + piece.length <= maxLength) {
      current += piece;
      continue;
    }
    chunks.push(current);
    current = piece;
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Format and chunk a message for Discord.
 *
 * Splits long messages at code fence boundaries and newlines,
 * respecting Discord's character limit. Multi-part messages
 * get [1/N] markers.
 */
export function formatDiscordMessage(text: string, maxLength: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const segments = splitByCodeFences(normalized);
  const pieces: string[] = [];
  // Reserve margin for chunk markers (e.g. "[1/10]\n" + "\n*[1/10] continued...*" ≈ 40 chars)
  const textMaxLength = Math.max(500, maxLength - 50);

  for (const segment of segments) {
    if (segment.type === 'code') {
      pieces.push(...splitCodeBlock(segment.lang, segment.content, textMaxLength));
      continue;
    }

    pieces.push(...splitTextPreservingNewlines(segment.content, textMaxLength));
  }

  const packed = packPieces(pieces, maxLength);

  // Add chunk markers for multi-part responses
  if (packed.length > 1) {
    for (let i = 0; i < packed.length; i++) {
      const marker = `[${i + 1}/${packed.length}]`;
      if (i > 0) {
        packed[i] = `${marker}\n${packed[i]}`;
      }
      if (i < packed.length - 1) {
        packed[i] = `${packed[i]}\n*${marker} continued...*`;
      }
    }
  }

  return packed;
}

/**
 * Parsed embed structure matching Discord.js API
 */
export interface ParsedEmbed {
  title?: string;
  description?: string;
  color?: number;
  thumbnail?: string;
  footer?: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
}

/**
 * Parse embed declarations from AI response text.
 *
 * Extracts <embed>...</embed> blocks and returns them with any remaining text.
 * Format: <embed title="Title" color="#0099FF">
 *         <field name="Name" inline="false">Value</field>
 *         </embed>
 */
export function parseEmbeds(text: string): { embeds: ParsedEmbed[]; remainingText: string } {
  const embeds: ParsedEmbed[] = [];
  let remainingText = text;

  // Regex to match <embed>...</embed> blocks with attributes
  const embedRegex = /<embed\b([^>]*)>([\s\S]*?)<\/embed>/gi;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = embedRegex.exec(text)) !== null) {
    // Remove the embed block from remaining text
    const before = text.slice(lastIndex, match.index);
    const after = text.slice(match.index + match[0].length);
    remainingText = (before + after).trim();

    const attrsStr = match[1] || '';
    const contentStr = match[2] || '';

    const embed: ParsedEmbed = {
      fields: [],
    };

    // Parse embed attributes
    const attrRegex = /(\w+)=["']([^"']*)["']/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
      const [, key, value] = attrMatch;
      switch (key.toLowerCase()) {
        case 'title':
          embed.title = value.slice(0, 256);
          break;
        case 'description':
          embed.description = value.slice(0, 4096);
          break;
        case 'color':
          // Parse hex color #RRGGBB or 0xRRGGBB
          const hex = value.replace(/^0x/, '#').replace('#', '');
          embed.color = parseInt(hex, 16);
          break;
        case 'thumbnail':
          embed.thumbnail = value;
          break;
        case 'footer':
          embed.footer = value.slice(0, 2048);
          break;
      }
    }

    // Parse field blocks
    const fieldRegex = /<field\b([^>]*)>([\s\S]*?)<\/field>/gi;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRegex.exec(contentStr)) !== null) {
      const fieldAttrs = fieldMatch[1] || '';
      const fieldValue = (fieldMatch[2] || '').trim().slice(0, 1024);

      let fieldName = 'Field';
      let inline = false;

      const fieldAttrRegex = /(\w+)=["']([^"']*)["']/g;
      let fieldAttrMatch: RegExpExecArray | null;
      while ((fieldAttrMatch = fieldAttrRegex.exec(fieldAttrs)) !== null) {
        const [, fKey, fValue] = fieldAttrMatch;
        if (fKey.toLowerCase() === 'name') {
          fieldName = fValue.slice(0, 256);
        } else if (fKey.toLowerCase() === 'inline') {
          inline = fValue.toLowerCase() === 'true';
        }
      }

      // Skip empty fields
      if (!fieldValue && !fieldName) continue;

      embed.fields.push({ name: fieldName, value: fieldValue || '\u200B', inline });
    }

    // If no fields but has content, use as description
    if (!embed.fields.length && contentStr.trim()) {
      const trimmedContent = contentStr.trim().slice(0, 4096);
      if (embed.description) {
        embed.description = embed.description + '\n\n' + trimmedContent;
      } else {
        embed.description = trimmedContent;
      }
    }

    embeds.push(embed);
    lastIndex = embedRegex.lastIndex;
  }

  return { embeds, remainingText };
}
