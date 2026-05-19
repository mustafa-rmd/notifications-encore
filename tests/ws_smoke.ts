// WebSocket integration tests for the notifications stream endpoint.
//
// Usage (with `encore run` already running):
//   bun tests/ws_smoke.ts
//   NOTIFY_API_URL=http://127.0.0.1:4000 bun tests/ws_smoke.ts

import type { Channel, Notification, User } from "@notify/shared";
import { Sub } from "./sub";

const API = (process.env.NOTIFY_API_URL ?? "http://127.0.0.1:4000").replace(
  /\/$/,
  "",
);

async function createUser(name: string, email?: string): Promise<User> {
  const resp = await fetch(`${API}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email }),
  });
  if (!resp.ok)
    throw new Error(`createUser: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as User;
}

async function sendNotification(
  userId: string,
  channel: Channel,
  title: string,
  body: string,
): Promise<Notification> {
  const resp = await fetch(`${API}/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, channel, title, body }),
  });
  if (!resp.ok)
    throw new Error(`sendNotification: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as Notification;
}

async function markRead(id: string): Promise<Notification> {
  const resp = await fetch(`${API}/notifications/${id}/read`, {
    method: "POST",
  });
  if (!resp.ok)
    throw new Error(`markRead: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as Notification;
}

function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

test("delivers a notification to an open subscriber", async () => {
  const user = await createUser(`t1-${Date.now()}`);
  const sub = new Sub(user.id);
  await sub.open();
  const sent = await sendNotification(user.id, "in_app", "hi", "there");
  const received = await sub.next();
  eq(received.id, sent.id, "notification id");
  eq(received.title, "hi", "title");
  eq(received.body, "there", "body");
  eq(received.channel, "in_app", "channel");
  sub.close();
});

test("fans out to multiple subscribers of the same user", async () => {
  const user = await createUser(`t2-${Date.now()}`);
  const a = new Sub(user.id);
  const b = new Sub(user.id);
  await Promise.all([a.open(), b.open()]);
  const sent = await sendNotification(user.id, "in_app", "fanout", "body");
  const [ra, rb] = await Promise.all([a.next(), b.next()]);
  eq(ra.id, sent.id, "sub A id");
  eq(rb.id, sent.id, "sub B id");
  a.close();
  b.close();
});

test("does not leak notifications across users", async () => {
  const alice = await createUser(`t3a-${Date.now()}`);
  const bob = await createUser(`t3b-${Date.now()}`);
  const subA = new Sub(alice.id);
  const subB = new Sub(bob.id);
  await Promise.all([subA.open(), subB.open()]);
  await sendNotification(alice.id, "in_app", "for-alice", "x");
  const received = await subA.next();
  eq(received.userId, alice.id, "recipient");
  await subB.expectSilence();
  subA.close();
  subB.close();
});

test("preserves order of multiple notifications", async () => {
  const user = await createUser(`t4-${Date.now()}`);
  const sub = new Sub(user.id);
  await sub.open();
  const a = await sendNotification(user.id, "in_app", "first", "1");
  const b = await sendNotification(user.id, "in_app", "second", "2");
  const c = await sendNotification(user.id, "in_app", "third", "3");
  const r1 = await sub.next();
  const r2 = await sub.next();
  const r3 = await sub.next();
  eq(r1.id, a.id, "1st id");
  eq(r2.id, b.id, "2nd id");
  eq(r3.id, c.id, "3rd id");
  sub.close();
});

test("delivers email-channel notifications over the stream", async () => {
  const user = await createUser(
    `t5-${Date.now()}`,
    `t5-${Date.now()}@example.com`,
  );
  const sub = new Sub(user.id);
  await sub.open();
  await sendNotification(user.id, "email", "subj", "body");
  const received = await sub.next();
  eq(received.channel, "email", "channel");
  sub.close();
});

test("mark-as-read does not emit a stream event", async () => {
  const user = await createUser(`t6-${Date.now()}`);
  const sub = new Sub(user.id);
  await sub.open();
  const sent = await sendNotification(user.id, "in_app", "to-read", "x");
  await sub.next(); // consume the send event
  await markRead(sent.id);
  await sub.expectSilence();
  sub.close();
});

test("new subscribers replay unread backlog on connect, oldest-first", async () => {
  const user = await createUser(`t7-${Date.now()}`);
  const a = await sendNotification(user.id, "in_app", "pre-1", "x");
  const b = await sendNotification(user.id, "in_app", "pre-2", "y");
  const sub = new Sub(user.id);
  await sub.open();
  const r1 = await sub.next();
  const r2 = await sub.next();
  eq(r1.id, a.id, "1st backlog item is the oldest");
  eq(r2.id, b.id, "2nd backlog item");
  const live = await sendNotification(user.id, "in_app", "post-connect", "z");
  const r3 = await sub.next();
  eq(r3.id, live.id, "live event follows backlog");
  sub.close();
});

test("read notifications are excluded from connect-time backlog", async () => {
  const user = await createUser(`t8-${Date.now()}`);
  const old = await sendNotification(user.id, "in_app", "old", "x");
  await markRead(old.id);
  const unread = await sendNotification(user.id, "in_app", "unread", "y");
  const sub = new Sub(user.id);
  await sub.open();
  const r1 = await sub.next();
  eq(r1.id, unread.id, "only the unread one is replayed");
  await sub.expectSilence();
  sub.close();
});

test("channel filter is respected by the backlog replay", async () => {
  const user = await createUser(
    `t9-${Date.now()}`,
    `t9-${Date.now()}@example.com`,
  );
  const inApp = await sendNotification(user.id, "in_app", "ia", "x");
  await sendNotification(user.id, "email", "em", "y");
  const sub = new Sub(user.id, "in_app");
  await sub.open();
  const r1 = await sub.next();
  eq(r1.id, inApp.id, "only the in_app row is replayed");
  eq(r1.channel, "in_app", "channel filter respected");
  await sub.expectSilence();
  sub.close();
});

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS  ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`FAIL  ${t.name}`);
      console.error(`      ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
