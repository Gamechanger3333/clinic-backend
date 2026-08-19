import { vi } from "vitest";

/**
 * The current test suite exercises middleware-level behaviour (security
 * headers, the `authenticate` gate, CSRF, validation) that never needs to
 * touch the database — every case here is rejected before a Prisma call
 * would happen. Stubbing the client keeps the suite runnable in any
 * environment (e.g. CI containers without a live Postgres instance) and
 * makes an accidental, un-mocked DB call fail loudly instead of hanging.
 *
 * When DB-backed integration tests are added (e.g. against a disposable
 * test database), point DATABASE_URL at that instance and remove/extend
 * this mock rather than stubbing prisma for those specific test files.
 */
vi.mock("../lib/prisma", () => {
  const unexpectedCall = (prop: string) => () => {
    throw new Error(
      `Unexpected live Prisma call: prisma.${prop}(). This test suite stubs the DB — ` +
        `if you're adding a DB-backed test, wire up a real test database instead of relying on this mock.`
    );
  };
  const modelHandler: ProxyHandler<object> = {
    get: (_target, prop: string) => unexpectedCall(prop),
  };
  const prismaHandler: ProxyHandler<object> = {
    get: (_target, prop: string) => new Proxy({}, modelHandler),
  };
  return { prisma: new Proxy({}, prismaHandler) };
});
