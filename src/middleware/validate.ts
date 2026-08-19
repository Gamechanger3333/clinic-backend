import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

/**
 * Validates req.body against a zod schema BEFORE it ever reaches a Prisma
 * call. On success, req.body is replaced with the *parsed* (and therefore
 * whitelisted) object — any field not declared in the schema is silently
 * dropped, which is what closes the mass-assignment hole: a client can no
 * longer inject arbitrary columns just by adding extra JSON keys.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(result.error),
      });
    }
    req.body = result.data;
    next();
  };
}

/** Same idea, for validating query-string params (?page=, ?limit=, ?status=...). */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        error: "Invalid query parameters",
        details: formatZodError(result.error),
      });
    }
    (req as any).validatedQuery = result.data;
    next();
  };
}

function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
