// End-to-end integration test for the notifications backend.
//
// Runs against a live server (default http://127.0.0.1:4000, override with
// NOTIFY_API_URL). Creates fresh test data per run so it is safe to re-run.
//
// Usage:
//   bun tests/integration_test.ts
//   NOTIFY_API_URL=http://127.0.0.1:4000 bun tests/integration_test.ts

import type { ApiResponse } from "./api-response";

const BASE_URL = (
  process.env.NOTIFY_API_URL ?? "http://127.0.0.1:4000"
).replace(/\/$/, "");
const BOGUS_ID = "00000000-0000-0000-0000-000000000000";

async function request(
  method: string,
  path: string,
  payload?: Record<string, unknown>,
): Promise<ApiResponse> {
  const url = `${BASE_URL}${path}`;
  const init: RequestInit = { method };
  if (payload !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(payload);
  }
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    console.error(
      `\nERROR: cannot reach ${BASE_URL} -- ${(e as Error).message}`,
    );
    console.error("Is the backend running? Try: cd backend && encore run");
    process.exit(2);
  }
  const raw = await resp.text();
  return { status: resp.status, body: raw ? JSON.parse(raw) : null };
}

let PASS = 0;
let FAIL = 0;
const FAILURES: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    PASS++;
    console.log(`  PASS  ${name}`);
  } else {
    FAIL++;
    const msg = detail ? `${name} -- ${detail}` : name;
    FAILURES.push(msg);
    console.log(`  FAIL  ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

async function main(): Promise<number> {
  console.log(`Integration test against ${BASE_URL}`);
  const runTag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);

  // ---- Users ----
  section("POST /users -- with email");
  let r = await request("POST", "/users", {
    name: `Alice-${runTag}`,
    email: `alice-${runTag}@example.com`,
  });
  check(
    "status 200",
    r.status === 200,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("has id", isString(r.body?.id));
  check("name echoed", r.body?.name === `Alice-${runTag}`);
  check("email echoed", r.body?.email === `alice-${runTag}@example.com`);
  check(
    "createdAt is ISO string",
    isString(r.body?.createdAt) && r.body.createdAt.endsWith("Z"),
  );
  const aliceId: string = r.body.id;

  section("POST /users -- without email -> email is null");
  r = await request("POST", "/users", { name: `Bob-${runTag}` });
  check(
    "status 200",
    r.status === 200,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("email is null", r.body?.email === null);
  const bobId: string = r.body.id;

  section("POST /users -- empty name -> 400");
  r = await request("POST", "/users", { name: "" });
  check(
    "status 400",
    r.status === 400,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("code invalid_argument", r.body?.code === "invalid_argument");
  check("message mentions name", (r.body?.message ?? "").includes("name"));

  section("POST /users -- whitespace-only name -> 400");
  r = await request("POST", "/users", { name: "   " });
  check(
    "status 400",
    r.status === 400,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );

  section("POST /users -- duplicate email -> 409 already_exists");
  const dupEmail = `alice-${runTag}@example.com`;
  r = await request("POST", "/users", {
    name: `Alice-dup-${runTag}`,
    email: dupEmail,
  });
  check(
    "status 409",
    r.status === 409,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("code already_exists", r.body?.code === "already_exists");
  check(
    "message echoes the conflicting email",
    (r.body?.message ?? "").includes(dupEmail),
    `message=${r.body?.message}`,
  );
  check(
    "details.field is 'email'",
    r.body?.details?.field === "email",
    `details=${JSON.stringify(r.body?.details)}`,
  );
  check(
    "details.value echoes the email",
    r.body?.details?.value === dupEmail,
    `details=${JSON.stringify(r.body?.details)}`,
  );

  section("POST /users -- second user with null email is allowed");
  r = await request("POST", "/users", { name: `NoEmail2-${runTag}` });
  check(
    "status 200",
    r.status === 200,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("email is null", r.body?.email === null);

  section("GET /users -- contains both created users");
  r = await request("GET", "/users");
  check("status 200", r.status === 200);
  const users: Array<{ id: string; createdAt: string }> = r.body?.users ?? [];
  const userIds = new Set(users.map((u) => u.id));
  check("alice present", userIds.has(aliceId));
  check("bob present", userIds.has(bobId));
  const createdAts = users.map((u) => u.createdAt);
  const sortedDesc = [...createdAts].sort().reverse();
  check(
    "ordered by createdAt DESC",
    JSON.stringify(createdAts) === JSON.stringify(sortedDesc),
  );

  // ---- Notifications: send ----
  section("POST /notifications -- in_app");
  r = await request("POST", "/notifications", {
    userId: aliceId,
    channel: "in_app",
    title: "Hello",
    body: "Welcome",
  });
  check(
    "status 200",
    r.status === 200,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("userId echoed", r.body?.userId === aliceId);
  check("channel echoed", r.body?.channel === "in_app");
  check("title echoed", r.body?.title === "Hello");
  check("body echoed", r.body?.body === "Welcome");
  check("sentAt populated", isString(r.body?.sentAt));
  check("readAt is null on send", r.body?.readAt === null);
  const inAppId: string = r.body.id;

  section("POST /notifications -- email");
  r = await request("POST", "/notifications", {
    userId: aliceId,
    channel: "email",
    title: "Subject",
    body: "Body",
  });
  check(
    "status 200",
    r.status === 200,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("channel echoed", r.body?.channel === "email");
  const emailId: string = r.body.id;

  section("POST /notifications -- nonexistent user -> 404");
  r = await request("POST", "/notifications", {
    userId: BOGUS_ID,
    channel: "in_app",
    title: "x",
    body: "y",
  });
  check(
    "status 404",
    r.status === 404,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("code not_found", r.body?.code === "not_found");

  section("POST /notifications -- email to user with no email -> 400");
  r = await request("POST", "/notifications", {
    userId: bobId,
    channel: "email",
    title: "x",
    body: "y",
  });
  check(
    "status 400",
    r.status === 400,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("code invalid_argument", r.body?.code === "invalid_argument");
  check("message mentions email", (r.body?.message ?? "").includes("email"));

  section("POST /notifications -- invalid channel -> 400");
  r = await request("POST", "/notifications", {
    userId: aliceId,
    channel: "sms",
    title: "x",
    body: "y",
  });
  check(
    "status 400",
    r.status === 400,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("code invalid_argument", r.body?.code === "invalid_argument");

  section("POST /notifications -- empty title -> 400");
  r = await request("POST", "/notifications", {
    userId: aliceId,
    channel: "in_app",
    title: "   ",
    body: "y",
  });
  check(
    "status 400",
    r.status === 400,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("message mentions title", (r.body?.message ?? "").includes("title"));

  section("POST /notifications -- empty body -> 400");
  r = await request("POST", "/notifications", {
    userId: aliceId,
    channel: "in_app",
    title: "x",
    body: "   ",
  });
  check(
    "status 400",
    r.status === 400,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("message mentions body", (r.body?.message ?? "").includes("body"));

  // ---- Notifications: list ----
  section("GET /users/:id/notifications -- Alice");
  r = await request("GET", `/users/${aliceId}/notifications`);
  check("status 200", r.status === 200);
  const items: Array<{ id: string; createdAt: string }> =
    r.body?.notifications ?? [];
  check("has at least 2", items.length >= 2, `got ${items.length}`);
  const itemIds = new Set(items.map((n) => n.id));
  check("in_app present", itemIds.has(inAppId));
  check("email present", itemIds.has(emailId));
  const createdN = items.map((n) => n.createdAt);
  const sortedN = [...createdN].sort().reverse();
  check(
    "ordered by createdAt DESC",
    JSON.stringify(createdN) === JSON.stringify(sortedN),
  );

  section("GET /users/:id/notifications/unread -- both unread");
  r = await request("GET", `/users/${aliceId}/notifications/unread`);
  check("status 200", r.status === 200);
  let unreadIds = new Set(
    (r.body?.notifications ?? []).map((n: { id: string }) => n.id),
  );
  check("in_app unread", unreadIds.has(inAppId));
  check("email unread", unreadIds.has(emailId));

  // ---- Notifications: mark read ----
  section("POST /notifications/:id/read");
  r = await request("POST", `/notifications/${inAppId}/read`);
  check(
    "status 200",
    r.status === 200,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("readAt populated", isString(r.body?.readAt));
  const firstReadAt: string | null = r.body?.readAt;

  section("POST /notifications/:id/read -- idempotent (readAt unchanged)");
  r = await request("POST", `/notifications/${inAppId}/read`);
  check("status 200", r.status === 200);
  check(
    "readAt unchanged on second call",
    r.body?.readAt === firstReadAt,
    `first=${firstReadAt} second=${r.body?.readAt}`,
  );

  section("GET unread -- marked one is gone, other remains");
  r = await request("GET", `/users/${aliceId}/notifications/unread`);
  unreadIds = new Set(
    (r.body?.notifications ?? []).map((n: { id: string }) => n.id),
  );
  check("in_app removed from unread", !unreadIds.has(inAppId));
  check("email still unread", unreadIds.has(emailId));

  section("POST /notifications/:id/read -- nonexistent -> 404");
  r = await request("POST", `/notifications/${BOGUS_ID}/read`);
  check(
    "status 404",
    r.status === 404,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("code not_found", r.body?.code === "not_found");

  section("GET /users/:id/notifications -- Bob has none");
  r = await request("GET", `/users/${bobId}/notifications`);
  check("status 200", r.status === 200);
  const bobItems = r.body?.notifications ?? [];
  check("empty list", Array.isArray(bobItems) && bobItems.length === 0);

  // ---- Pagination ----
  section("Pagination setup -- create Charlie with 5 notifications");
  r = await request("POST", "/users", {
    name: `Charlie-${runTag}`,
    email: `charlie-${runTag}@example.com`,
  });
  check(
    "status 200",
    r.status === 200,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  const charlieId: string = r.body.id;
  const charlieSentIds: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const sr = await request("POST", "/notifications", {
      userId: charlieId,
      channel: "in_app",
      title: `note-${i}`,
      body: `b-${i}`,
    });
    check(
      `send note-${i}`,
      sr.status === 200,
      `got ${sr.status}: ${JSON.stringify(sr.body)}`,
    );
    charlieSentIds.push(sr.body.id);
  }

  section("Pagination -- page=1&size=2 returns 2 items + meta");
  r = await request("GET", `/users/${charlieId}/notifications?page=1&size=2`);
  check("status 200", r.status === 200);
  const firstPage = r.body?.notifications ?? [];
  check("returns 2 items", firstPage.length === 2, `got ${firstPage.length}`);
  check("page echoed", r.body?.page === 1, `got ${r.body?.page}`);
  check("size echoed", r.body?.size === 2, `got ${r.body?.size}`);
  check("total is 5", r.body?.total === 5, `got ${r.body?.total}`);
  check(
    "totalPages is 3 (ceil(5/2))",
    r.body?.totalPages === 3,
    `got ${r.body?.totalPages}`,
  );

  section("Pagination -- walk all pages with size=2");
  const collectedIds: string[] = [];
  const collectedCreatedAts: string[] = [];
  let pageNum = 0;
  let totalPages = Infinity;
  while (pageNum < 10) {
    pageNum++;
    const pr = await request(
      "GET",
      `/users/${charlieId}/notifications?page=${pageNum}&size=2`,
    );
    if (pr.status !== 200) {
      check(
        `page ${pageNum} status 200`,
        false,
        `got ${pr.status}: ${JSON.stringify(pr.body)}`,
      );
      break;
    }
    for (const n of pr.body?.notifications ?? []) {
      collectedIds.push(n.id);
      collectedCreatedAts.push(n.createdAt);
    }
    totalPages = pr.body?.totalPages ?? totalPages;
    if (pageNum >= totalPages) break;
  }
  check(
    "traversed 3 pages (5 items / 2 per page)",
    pageNum === 3,
    `got ${pageNum}`,
  );
  check(
    "collected 5 items total",
    collectedIds.length === 5,
    `got ${collectedIds.length}`,
  );
  check(
    "no duplicate ids across pages",
    new Set(collectedIds).size === 5,
    `unique=${new Set(collectedIds).size}`,
  );
  const sentSet = new Set(charlieSentIds);
  check(
    "all 5 sent ids returned across pages",
    collectedIds.every((id) => sentSet.has(id)),
  );
  const atsDesc = [...collectedCreatedAts].sort().reverse();
  check(
    "ordering DESC preserved across pages",
    JSON.stringify(collectedCreatedAts) === JSON.stringify(atsDesc),
  );

  section("Pagination -- size=100 fits everything in one page");
  r = await request("GET", `/users/${charlieId}/notifications?size=100`);
  check("status 200", r.status === 200);
  check(
    "returns all 5 items",
    (r.body?.notifications ?? []).length === 5,
    `got ${r.body?.notifications?.length}`,
  );
  check("totalPages is 1", r.body?.totalPages === 1);

  section("Pagination -- empty list reports total=0, totalPages=0");
  r = await request("GET", `/users/${bobId}/notifications`);
  check("status 200", r.status === 200);
  check("total is 0", r.body?.total === 0);
  check("totalPages is 0", r.body?.totalPages === 0);

  section("Pagination -- page past last returns empty list with correct meta");
  r = await request("GET", `/users/${charlieId}/notifications?page=99&size=2`);
  check("status 200", r.status === 200);
  check(
    "notifications is empty",
    (r.body?.notifications ?? []).length === 0,
    `got ${r.body?.notifications?.length}`,
  );
  check("total still 5", r.body?.total === 5);
  check("totalPages still 3", r.body?.totalPages === 3);

  section("Pagination -- size=0 -> 400");
  r = await request("GET", `/users/${charlieId}/notifications?size=0`);
  check(
    "status 400",
    r.status === 400,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("code invalid_argument", r.body?.code === "invalid_argument");

  section("Pagination -- size=101 -> 400");
  r = await request("GET", `/users/${charlieId}/notifications?size=101`);
  check(
    "status 400",
    r.status === 400,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("code invalid_argument", r.body?.code === "invalid_argument");

  section("Pagination -- page=0 -> 400");
  r = await request("GET", `/users/${charlieId}/notifications?page=0`);
  check(
    "status 400",
    r.status === 400,
    `got ${r.status}: ${JSON.stringify(r.body)}`,
  );
  check("code invalid_argument", r.body?.code === "invalid_argument");

  section("Pagination -- unread endpoint paginates too");
  r = await request(
    "GET",
    `/users/${charlieId}/notifications/unread?page=1&size=3`,
  );
  check("status 200", r.status === 200);
  check(
    "returns 3 unread items",
    (r.body?.notifications ?? []).length === 3,
    `got ${r.body?.notifications?.length}`,
  );
  check("total is 5", r.body?.total === 5);
  check("totalPages is 2 (ceil(5/3))", r.body?.totalPages === 2);

  // ---- Summary ----
  const total = PASS + FAIL;
  console.log("\n" + "=".repeat(60));
  console.log(`Result: ${PASS}/${total} passed`);
  if (FAIL > 0) {
    console.log("\nFailures:");
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("All endpoints behave as expected.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
