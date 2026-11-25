// CodeHub fork: an event may name the conversation its round goes on in (rules with sessionFromEvent), and a rule may
// allow a longer chain of events than eight (maxHops). Failure modes: a named session leaks into rules that did not ask
// for it; a malformed session crosses the input boundary; a longer limit on one rule lifts it for the others; a limit
// is accepted outside 1..64.
import assert from "node:assert/strict";
import { test } from "node:test";
import { World, rules } from "../sim/world.ts";
import { rows } from "../kernel/evolve.ts";
import { parseEvent } from "../protocol/validate.ts";
import { parseRules } from "../protocol/rules.ts";
import { checkSchema } from "../protocol/schema.ts";

const SESSION = "dbe337f6-7d6c-4598-8577-4c88ac817909";

test("an event may carry a session; a malformed one is refused", () => {
  assert.equal(parseEvent({ id: "a", type: "one", session: SESSION }).session, SESSION);
  assert.equal(parseEvent({ id: "a", type: "one" }).session, undefined);
  assert.equal(parseEvent({ id: "a", type: "one", session: "" }).session, undefined);
  for (const session of ["short", "has space in it", "../../etc/passwd", 42, "x".repeat(101)])
    assert.throws(() => parseEvent({ id: "a", type: "one", session }));
  assert.deepEqual(checkSchema("event", { id: "a", type: "one", session: SESSION }), []);
  assert.notDeepEqual(checkSchema("event", { id: "a", type: "one", session: "no way" }), []);
});

test("a rule with sessionFromEvent goes on in the named session; others ignore it", () => {
  const w = new World();
  const r = structuredClone(rules);
  r.rules[0].sessionFromEvent = true;
  w.call("rules", r);
  w.call("ingest", "app", { id: "x", type: "one", subject: "s1", session: SESSION });
  const job = w.call("claimNext", "w1", "c");
  assert.equal(job.session, SESSION);
  w.call("ingest", "app", { id: "y", type: "two", subject: "s2", session: SESSION });
  const other = w.call("claimNext", "w2", "d");
  assert.equal(other.session, null);
});

test("without sessionFromEvent the named session is not used", () => {
  const w = new World();
  w.call("ingest", "app", { id: "x", type: "one", subject: "s1", session: SESSION });
  assert.equal(w.call("claimNext", "w1", "c").session, null);
});

test("maxHops lets one rule take a longer chain; the others keep eight", () => {
  const w = new World();
  const r = structuredClone(rules);
  r.rules[0].maxHops = 12;
  w.call("rules", r);
  w.call("ingest", "app", { id: "deep-one", type: "one", subject: "s1", hops: 11 });
  const job = w.call("claimNext", "w1", "c");
  assert.equal(job.context.events[0].hops, 11);
  w.call("ingest", "app", { id: "deep-two", type: "two", subject: "s2", hops: 11 });
  assert.equal(rows(w.view, "events").find((e) => e.key === "deep-two")!.routed, "[]");
  assert.ok(rows(w.view, "cards").some((c) => c.text.includes("8")));
  w.call("ingest", "app", { id: "too-deep", type: "one", subject: "s3", hops: 13 });
  assert.equal(rows(w.view, "events").find((e) => e.key === "too-deep")!.routed, "[]");
  assert.ok(rows(w.view, "cards").some((c) => c.text.includes("12")));
});

test("with emitsSession, an event a round sends names that round's conversation, and the next round sees it", () => {
  const w = new World();
  const r = structuredClone(rules);
  r.rules[0].emits = { source: "app", types: ["two"] };
  r.rules[0].emitsSession = true;
  w.call("rules", r);
  w.call("ingest", "app", { id: "start", type: "one", subject: "s1" });
  const job = w.call("claimNext", "w1", "c");
  w.call("started", job.run, job.token, { session: SESSION });
  w.call("finish", job.run, job.token, { outcome: "done", events: [{ id: "back", type: "two", subject: "s1" }] });
  assert.equal(rows(w.view, "events").find((e) => e.key === "back")!.session, SESSION);
  const next = w.call("claimNext", "w2", "d");
  assert.equal(next.context.events[0].session, SESSION);
  assert.deepEqual(checkSchema("context-event", next.context.events[0]), []);
});

test("without emitsSession a dispatched event that names no session starts a new conversation", () => {
  // The bug of 2026-11-24: Agent0's task for a new conversation went on in Agent0's own conversation.
  const w = new World();
  const r = structuredClone(rules);
  r.rules[0].emits = { source: "app", types: ["two"] };
  r.rules[1].sessionFromEvent = true;
  w.call("rules", r);
  w.call("ingest", "app", { id: "start", type: "one", subject: "s1" });
  const job = w.call("claimNext", "w1", "c");
  w.call("started", job.run, job.token, { session: SESSION });
  w.call("finish", job.run, job.token, { outcome: "done", events: [{ id: "task", type: "two", subject: "s2" }] });
  assert.equal(rows(w.view, "events").find((e) => e.key === "task")!.session, undefined);
  const worker = w.call("claimNext", "w2", "d");
  assert.equal(worker.session, null);
});

test("rules check: maxHops is 1 to 64, sessionFromEvent a boolean", () => {
  const base = JSON.parse(JSON.stringify({
    timezone: "UTC",
    sources: { app: { name: "来源" } },
    agents: { a: { name: "甲", worker: "w1", use: "command", command: ["true"] } },
    rules: [{ name: "one", when: { source: "app", types: ["one"] }, to: "a", cwd: "/tmp", prompt: "做事" }],
  }));
  const with_ = (extra: object) => JSON.stringify({ ...base, rules: [{ ...base.rules[0], ...extra }] });
  assert.equal(parseRules(with_({ maxHops: 64, sessionFromEvent: true }), 0, "UTC").rules[0].maxHops, 64);
  for (const extra of [{ maxHops: 0 }, { maxHops: 65 }, { maxHops: 2.5 }, { sessionFromEvent: "yes" }, { emitsSession: 1 }])
    assert.throws(() => parseRules(with_(extra), 0, "UTC"));
});

test("a conversation the hub did not start: its recorded running total is the starting point", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { recordedUsage } = await import("../plugins/claude/agent.ts");
  const root = mkdtempSync(path.join(tmpdir(), "codehub-usage-"));
  mkdirSync(path.join(root, "C--some-folder"));
  const lines = [
    { type: "user", message: { content: "hi" } },
    { type: "cost-state", totalCostUSD: 0.0034 },
    { type: "assistant", message: { content: [] } },
    { type: "cost-state", totalCostUSD: 0.0067 },
  ];
  writeFileSync(path.join(root, "C--some-folder", `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.deepEqual(recordedUsage(SESSION, root), { cost: 0.0067 });
  assert.equal(recordedUsage("ffffffff-0000-0000-0000-000000000000", root), undefined);
  assert.equal(recordedUsage("../escape", root), undefined);
});

test("ACP: what the plugin refuses goes to the approver; its answer decides, anything else is a no", async () => {
  const { approve, permission } = await import("../plugins/acp/bridge.ts");
  const options = [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "deny", kind: "reject_once" },
  ];
  const run = { kind: "execute", title: "git status", rawInput: { CommandLine: "git status" } };
  const params = { options, toolCall: run };
  const say = (code: string) => [process.execPath, "-e", code];
  const turn = (approver?: string[]) => ({ access: "edit" as const, cwd: process.cwd(), approver });
  const refused = permission(turn(), params);
  assert.equal(refused.optionId, "deny");
  assert.equal((await approve(turn(), params, refused)).optionId, "deny");
  const yes = say("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({allow:true})))");
  assert.equal((await approve(turn(yes), params, refused)).optionId, "allow");
  const no = say("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({allow:false})))");
  assert.equal((await approve(turn(no), params, refused)).optionId, "deny");
  assert.equal((await approve(turn(say("process.exit(3)")), params, refused)).optionId, "deny");
  assert.equal((await approve(turn(say("process.stdout.write('yes')")), params, refused)).optionId, "deny");
  const read = { options, toolCall: { kind: "read", title: "a file", locations: [] } };
  const allowed = permission(turn(), read);
  assert.equal((await approve(turn(no), read, allowed)).optionId, "allow");
});

test("ACP with an approver: reading outside the folder goes to the approver; inside, or without one, it stays free", async () => {
  const { permission } = await import("../plugins/acp/bridge.ts");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const options = [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "deny", kind: "reject_once" },
  ];
  const outside = path.join(tmpdir(), "codehub-zone-probe.txt");
  const inside = path.join(process.cwd(), "package.json");
  const read = (file: string) => ({ options, toolCall: { kind: "read", title: file, locations: [{ path: file }] } });
  const withApprover = { access: "edit" as const, cwd: process.cwd(), approver: ["x"] };
  const without = { access: "edit" as const, cwd: process.cwd() };
  assert.equal(permission(withApprover, read(outside)).optionId, "deny");
  assert.equal(permission(withApprover, read(inside)).optionId, "allow");
  assert.equal(permission(without, read(outside)).optionId, "allow");
});
