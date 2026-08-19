import { Request } from "express";
import { z } from "zod";

export const paginationSchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  // Clamped (not rejected) at 100 — a client asking for too much gets a
  // capped response instead of a hard error; the cap is what actually
  // prevents an unbounded findMany(), not the rejection.
  limit: z.coerce.number().int().min(1).default(20).transform((n) => Math.min(n, 100)),
});

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

/**
 * Reads ?page=&limit= off the request (already validated/coerced by
 * validateQuery(paginationSchema) upstream) and returns Prisma-ready
 * skip/take values. limit is hard-capped at 100 regardless of what's
 * requested, so a client can't force an unbounded findMany() by passing
 * limit=999999.
 */
export function getPagination(req: Request): PaginationParams {
  const q = (req as any).validatedQuery || {};
  const page = q.page ?? 1;
  const limit = q.limit ?? 20;
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function paginatedResponse<T>(items: T[], total: number, { page, limit }: PaginationParams) {
  return {
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
  };
}
