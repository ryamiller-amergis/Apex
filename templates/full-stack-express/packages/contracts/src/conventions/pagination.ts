import { z } from 'zod';

export const defaultPageSize = 20;
export const maxPageSize = 100;
export const maxCursorLength = 512;

export const paginationQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(maxPageSize)
    .default(defaultPageSize),
  cursor: z.string().max(maxCursorLength).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginated<Item extends z.ZodType>(item: Item) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: z.string().max(maxCursorLength).nullable(),
  });
}
