import { z } from 'zod';

/** One http(s) address. file:, javascript: and other schemes never reach a browser. */
export const httpUrl = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'The URL must start with http or https.' },
  );
