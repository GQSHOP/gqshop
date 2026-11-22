/**
 * M0 unit tests — no live DB required (fake db injected via createApp).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApp } from "../src/index.js";

const JWT_SECRET = "test-secret-m0";
const okDb = { execute: async () => ({ rows: [] }) } as never;
const downDb = {
  execute: async () => {
    throw new Error("connection refused");
  },
} as never;

describe("healthz", () => {
  it("returns 200 + db up when DB reachable", async () => {
    const app = createApp(okDb, JWT_SECRET);
    const res = await app.request("/healthz");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; db: string };
    assert.equal(body.status, "ok");
    assert.equal(body.db, "up");
  });

  it("returns 503 + db down when DB unreachable", async () => {
    const app = createApp(downDb, JWT_SECRET);
    const res = await app.request("/healthz");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { status: string; db: string };
    assert.equal(body.status, "degraded");
    assert.equal(body.db, "down");
  });
});

describe("auth validation (no DB touch on 400 paths)", () => {
  const app = createApp(okDb, JWT_SECRET);

  it("rejects invalid username", async () => {
    const res = await app.request("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: "a", password: "secret123" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 400);
  });

  it("rejects short password", async () => {
    const res = await app.request("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: "validuser", password: "12345" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 400);
  });

  it("rejects non-json body", async () => {
    const res = await app.request("/v1/auth/register", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 400);
  });
});
