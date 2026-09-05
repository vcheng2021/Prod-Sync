import sanitizeHtml from 'sanitize-html';

const allowedTags = ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h3', 'h4'];

export const sanitizeDescription = (html: string): string =>
  sanitizeHtml(html, {
    allowedTags,
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
    textFilter: (text) => text.replace(/\s+/g, ' ').trim(),
  }).trim();

export const plainTextToHtml = (text: string): string => {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return sanitizeDescription(paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join(''));
};
