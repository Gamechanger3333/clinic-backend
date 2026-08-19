/**
 * src/test/mockPrisma.ts
 *
 * Tests in this suite run against a MOCKED Prisma client, not a real
 * database. Why: a real-DB integration suite needs a provisioned Postgres
 * instance, migrations, and seed/teardown per test run — a much heavier
 * lift that doesn't belong in a "does this route validate/authorize
 * correctly" test. Mocking Prisma lets us assert on route logic (status
 * codes, validation errors, RBAC enforcement, response shape) in complete
 * isolation, which is exactly what this initial suite is for.
 *
 * `vi.mock("../lib/prisma", ...)` in each test file redirects every route's
 * `import { prisma } from "../lib/prisma"` to this mock instance.
 */
import { PrismaClient } from "@prisma/client";
import { mockDeep, mockReset, DeepMockProxy } from "vitest-mock-extended";

export const prismaMock: DeepMockProxy<PrismaClient> = mockDeep<PrismaClient>();

export function resetPrismaMock() {
  mockReset(prismaMock);
}
