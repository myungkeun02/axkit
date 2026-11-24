/** Files the assistant may send to the owner's own app: documents, pictures and archives, never programs. */
export const SHARE_MAX_BYTES = 20 * 1024 * 1024;

export const SHARE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwp: 'application/x-hwp',
  hwpx: 'application/hwp+zip',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  zip: 'application/zip',
};

/** What the first bytes must look like for each extension. */
export type ShareFormat = 'pdf' | 'image' | 'zip' | 'ole' | 'text';

export const SHARE_FORMATS: Readonly<Record<string, ShareFormat>> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  heic: 'image',
  doc: 'ole',
  xls: 'ole',
  ppt: 'ole',
  hwp: 'ole',
  docx: 'zip',
  xlsx: 'zip',
  pptx: 'zip',
  hwpx: 'zip',
  zip: 'zip',
  txt: 'text',
  md: 'text',
};
