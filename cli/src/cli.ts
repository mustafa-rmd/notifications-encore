import * as readline from "node:readline";
import {
  ApiClient,
  ApiError,
  parseStreamEvent,
  type Channel,
  type Notification,
  type User,
} from "./api";
import type { ParsedArgs } from "./types/parsed-args";

const DEFAULT_API = "http://127.0.0.1:4000";
const VERSION = "0.1.0";

const SHORT_FLAGS: Record<string, string> = { h: "help", v: "version" };

function parseArgs(argv: string[]): ParsedArgs {
  let command = "";
  const rest: string[] = [];
  for (const arg of argv) {
    if (command === "" && !arg.startsWith("-")) {
      command = arg;
    } else {
      rest.push(arg);
    }
  }
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    let body: string;
    if (arg.startsWith("--")) body = arg.slice(2);
    else if (arg.startsWith("-"))
      body = SHORT_FLAGS[arg.slice(1)] ?? arg.slice(1);
    else continue;
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (i + 1 < rest.length && !rest[i + 1]!.startsWith("-")) {
      flags[body] = rest[++i]!;
    } else {
      flags[body] = true;
    }
  }
  return { command, flags };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasCurrent = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      hasCurrent = true;
    } else if (c === " " || c === "\t") {
      if (hasCurrent) {
        tokens.push(current);
        current = "";
        hasCurrent = false;
      }
    } else {
      current += c;
      hasCurrent = true;
    }
  }
  if (hasCurrent) tokens.push(current);
  return tokens;
}

function requireString(
  flags: Record<string, string | boolean>,
  name: string,
): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing required flag: --${name}`);
  }
  return v;
}

function getApiUrl(flags: Record<string, string | boolean>): string {
  const fromFlag = flags["api-url"];
  if (typeof fromFlag === "string" && fromFlag.length > 0) return fromFlag;
  return process.env.NOTIFY_API_URL ?? DEFAULT_API;
}

function printDetail(obj: object): void {
  const entries = Object.entries(obj);
  const width = Math.max(...entries.map(([k]) => k.length));
  for (const [k, v] of entries) {
    console.log(`${k.padEnd(width)}  ${v ?? "-"}`);
  }
}

const ID_WIDTH = 36;

function printUserHeader(): void {
  console.log(`${"ID".padEnd(ID_WIDTH)}  ${"NAME".padEnd(20)}  EMAIL`);
}

function printUserRow(u: User): void {
  console.log(
    `${u.id.padEnd(ID_WIDTH)}  ${u.name.padEnd(20)}  ${u.email ?? "-"}`,
  );
}

function printNotificationHeader(): void {
  console.log(`  ${"ID".padEnd(ID_WIDTH)}  ${"CHANNEL".padEnd(6)}  TITLE`);
}

function printNotificationRow(n: Notification): void {
  const marker = n.readAt ? " " : "*";
  console.log(
    `${marker} ${n.id.padEnd(ID_WIDTH)}  ${n.channel.padEnd(6)}  ${n.title}`,
  );
}

const HELP = `notify — CLI for the notifications backend

Usage:
  notify                          Start interactive shell
  notify shell                    Same as above
  notify <command> [flags]        Run a single command and exit

Commands:
  users:create  --name=<name> [--email=<email>]
  users:list
  send          --user-id=<id> --channel=<in_app|email> --title=<t> --body=<b>
  list          --user-id=<id>
  unread        --user-id=<id>
  read          --id=<notification-id>
  subscribe     --user-id=<id> [--channel=<in_app|email>]
                                    (WebSocket stream; Ctrl-C to stop;
                                     omit --channel to receive all)

Shell-only:
  help                              Show this message
  exit, quit                        Leave the shell
  Ctrl+C                            Stop current command, or exit at prompt

Global flags:
  --api-url=<url>    Backend URL (default: $NOTIFY_API_URL or ${DEFAULT_API})
  --json             Print raw JSON instead of human-readable output
  -h, --help         Show this message
  -v, --version      Print CLI version

Notification list output:
  Lines prefixed with "*" are unread; " " (space) means read.`;

async function runCommand(
  command: string,
  flags: Record<string, string | boolean>,
  client: ApiClient,
  json: boolean,
  abort: AbortSignal,
): Promise<void> {
  switch (command) {
    case "users:create": {
      const name = requireString(flags, "name");
      const email = typeof flags.email === "string" ? flags.email : undefined;
      const user = await client.createUser(name, email);
      if (json) console.log(JSON.stringify(user, null, 2));
      else printDetail(user);
      return;
    }

    case "users:list": {
      const { users } = await client.listUsers();
      if (json) {
        console.log(JSON.stringify(users, null, 2));
      } else if (users.length === 0) {
        console.log("(no users)");
      } else {
        printUserHeader();
        for (const u of users) printUserRow(u);
      }
      return;
    }

    case "send": {
      const userId = requireString(flags, "user-id");
      const channelRaw = requireString(flags, "channel");
      if (channelRaw !== "in_app" && channelRaw !== "email") {
        throw new Error(
          `Invalid --channel: ${channelRaw} (expected "in_app" or "email")`,
        );
      }
      const title = requireString(flags, "title");
      const body = requireString(flags, "body");
      const n = await client.send(userId, channelRaw as Channel, title, body);
      if (json) console.log(JSON.stringify(n, null, 2));
      else printDetail(n);
      return;
    }

    case "list": {
      const userId = requireString(flags, "user-id");
      const notifications = await client.listNotifications(userId);
      if (json) {
        console.log(JSON.stringify(notifications, null, 2));
      } else if (notifications.length === 0) {
        console.log("(no notifications)");
      } else {
        printNotificationHeader();
        for (const n of notifications) printNotificationRow(n);
      }
      return;
    }

    case "unread": {
      const userId = requireString(flags, "user-id");
      const notifications = await client.listUnread(userId);
      if (json) {
        console.log(JSON.stringify(notifications, null, 2));
      } else if (notifications.length === 0) {
        console.log("(no unread notifications)");
      } else {
        printNotificationHeader();
        for (const n of notifications) printNotificationRow(n);
      }
      return;
    }

    case "read": {
      const id = requireString(flags, "id");
      const n = await client.markRead(id);
      if (json) console.log(JSON.stringify(n, null, 2));
      else printDetail(n);
      return;
    }

    case "subscribe": {
      const userId = requireString(flags, "user-id");
      const channelRaw =
        typeof flags.channel === "string" ? flags.channel : undefined;
      if (
        channelRaw !== undefined &&
        channelRaw !== "in_app" &&
        channelRaw !== "email"
      ) {
        throw new Error(
          `Invalid --channel: ${channelRaw} (expected "in_app" or "email")`,
        );
      }
      const ws = await client.openStream(userId, channelRaw as Channel);
      if (!json) {
        const scope = channelRaw
          ? `${channelRaw} notifications`
          : "notifications";
        console.error(
          `Connected. Streaming ${scope} for ${userId} (Ctrl-C to stop).`,
        );
      }
      ws.addEventListener("message", (e) => {
        const n = parseStreamEvent(String((e as MessageEvent).data));
        if (!n) return;
        if (json) {
          console.log(JSON.stringify(n));
        } else {
          console.log(
            `[${n.createdAt}] ${n.channel.padEnd(6)} ${n.title} — ${n.body}`,
          );
        }
      });
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          ws.close();
          resolve();
        };
        if (abort.aborted) {
          onAbort();
          return;
        }
        abort.addEventListener("abort", onAbort, { once: true });
        ws.addEventListener("close", () => {
          abort.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}. Type 'help' for usage.`);
  }
}

function reportError(e: unknown): void {
  if (e instanceof ApiError) {
    console.error(`Error: ${e.code}: ${e.message}`);
  } else {
    console.error(`Error: ${(e as Error).message ?? String(e)}`);
  }
}

async function runShell(client: ApiClient, json: boolean): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "notify> ",
  });

  let activeAbort: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (activeAbort) {
      activeAbort.abort();
    } else {
      rl.close();
    }
  });

  console.log(
    "notify shell — type 'help' for commands, 'exit' or Ctrl+C to quit.",
  );
  rl.prompt();

  for await (const rawLine of rl as AsyncIterable<string>) {
    const line = rawLine.trim();
    if (line === "") {
      rl.prompt();
      continue;
    }
    if (line === "exit" || line === "quit") {
      rl.close();
      break;
    }
    try {
      const parsed = parseArgs(tokenize(line));
      if (parsed.command === "help" || parsed.flags.help) {
        console.log(HELP);
      } else if (parsed.command !== "") {
        activeAbort = new AbortController();
        try {
          await runCommand(
            parsed.command,
            parsed.flags,
            client,
            json || parsed.flags.json === true,
            activeAbort.signal,
          );
        } finally {
          activeAbort = null;
        }
      }
    } catch (e) {
      reportError(e);
    }
    rl.prompt();
  }
  console.log();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (args.flags.help) {
    console.log(HELP);
    return 0;
  }

  const json = args.flags.json === true;
  const client = new ApiClient(getApiUrl(args.flags));

  if (args.command === "" || args.command === "shell") {
    await runShell(client, json);
    return 0;
  }
  if (args.command === "help") {
    console.log(HELP);
    return 0;
  }

  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  await runCommand(args.command, args.flags, client, json, ac.signal);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    reportError(e);
    process.exit(1);
  },
);
