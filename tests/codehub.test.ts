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
import { passClick } from "../plugins/feishu/channel.ts";
import { quotaOf } from "../plugins/acp/bridge.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("a receipt's event whose id is taken is not sent on, and the round and the owner are told", () => {
  // P3.6, 2026-11-25: a reviewer's and a fixing round's reports reused the first report's id and vanished quietly.
  const w = new World();
  const r = structuredClone(rules);
  r.rules[0].emits = { source: "app", types: ["two"] };
  w.call("rules", r);
  const report = { outcome: "done", events: [{ id: "done-t1", type: "two", subject: "t1" }] };
  w.call("ingest", "app", { id: "start", type: "one", subject: "s1" });
  const first = w.call("claimNext", "w1", "c");
  assert.deepEqual(w.call("finish", first.run, first.token, report).rejected, []);
  w.call("ingest", "app", { id: "again", type: "one", subject: "s1" });
  const second = w.call("claimNext", "w1", "c");
  const { rejected } = w.call("finish", second.run, second.token, report);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /done-t1/);
  assert.equal(rows(w.view, "events").filter((e) => e.key.startsWith("done-t1")).length, 1);
  const notices = rows(w.view, "cards").filter((c) => c.kind === "notice" && String(c.text).includes("done-t1"));
  assert.equal(notices.length, 1);
});

test("feishu: a click on no card of the hub's goes to the clicks command on stdin; without one it is dropped", async () => {
  // 2026-11-25: CodeHub's permission cards have buttons, but the hub's channel holds the app's only click listener.
  const dir = mkdtempSync(join(tmpdir(), "clicks-"));
  const out = join(dir, "click.json");
  const line = '{"action_value":"{\\"permission\\":12,\\"answer\\":\\"y\\"}","operator_id":"ou_me"}';
  const copy = [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(out)}, require("fs").readFileSync(0))`];
  const logged: string[] = [];
  assert.equal(await passClick(copy, line, (l) => logged.push(l)), true);
  assert.equal(readFileSync(out, "utf8"), line);
  assert.equal(await passClick(undefined, line, (l) => logged.push(l)), false);
  assert.equal(await passClick([process.execPath, "-e", "process.exit(3)"], line, (l) => logged.push(l)), false);
  assert.match(logged.join("\n"), /ended with 3/);
});

test("mustEmit: a round that finishes without its report tells the owner; one that reports does not", () => {
  // 2026-11-25: a reviewer's round ended while its own helper was still checking; nothing came back, nobody heard.
  const w = new World();
  const r = structuredClone(rules);
  r.rules[0].emits = { source: "app", types: ["two"] };
  r.rules[0].mustEmit = true;
  w.call("rules", r);
  w.call("ingest", "app", { id: "quiet", type: "one", subject: "s1" });
  const quiet = w.call("claimNext", "w1", "c");
  w.call("finish", quiet.run, quiet.token, { outcome: "done", summary: "Waiting for the verifier" });
  const said = () => rows(w.view, "cards").filter((c) => c.kind === "notice" && String(c.text).includes("没有发出汇报事件"));
  assert.equal(said().length, 1);
  assert.match(String(said()[0].text), /Waiting for the verifier/);
  w.call("ingest", "app", { id: "talks", type: "one", subject: "s2" });
  const talks = w.call("claimNext", "w1", "c");
  w.call("finish", talks.run, talks.token, { outcome: "done", events: [{ id: "report", type: "two", subject: "s2" }] });
  assert.equal(said().length, 1);
  assert.throws(() => parseRules({ ...r, rules: [{ ...r.rules[0], mustEmit: "yes" }] }, 0, "UTC"));
});

// 2026-11-25: Antigravity's Claude ran out of its quota pool and its "quota reached" answer counted as the work done.
const QUOTA_TEXT = "⚠ Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 3h42m58s.";

test("quotaOf: Antigravity's quota answer and when it ends; a long answer that mentions quota is work", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  assert.equal(quotaOf(QUOTA_TEXT, now)!.until, new Date(now + (3 * 3600 + 42 * 60 + 58) * 1000).toISOString());
  assert.equal(quotaOf("Quota exceeded.", now)!.until, new Date(now + 3_600_000).toISOString());
  assert.equal(quotaOf("Done: the report says the quota reached its limit last week. " + "x".repeat(700), now), null);
  assert.equal(quotaOf("完成了", now), null);
});

/** A stand-in Antigravity: the first model answers with the quota message, the others do the turn and say who did. */
function quotaAgent(dir: string) {
  const file = join(dir, "quota-agent.mjs");
  writeFileSync(
    file,
    `import readline from 'node:readline';
let model = 'none'; const asked = [];
const send = (x) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
const say = (text) => send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm' + asked.length, content: { type: 'text', text } } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => { const m = JSON.parse(line); if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
  if (m.method === 'session/set_model') { model = m.params.modelId; send({ id: m.id, result: {} }); }
  if (m.method === 'session/prompt') { asked.push(m.params.prompt[0].text);
    say(model === 'claude' || model === 'neon-out' ? ${JSON.stringify(QUOTA_TEXT)} : '完成了，由 ' + model + ' 做；第 ' + asked.length + ' 次提示：' + asked.at(-1).slice(0, 40));
    send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 1 } } }); }
});`,
  );
  return file;
}

const bridgeTurn = (turn: object) =>
  new Promise<string>((done) => {
    const script = join(import.meta.dirname, "../plugins/acp/bridge.ts");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, JSON.stringify(turn)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.on("close", () => done(out));
  });

test("ACP out of quota goes on in the same conversation with the next model; out on all, it says until when", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-"));
  const agent = quotaAgent(dir);
  const told = join(dir, "told.jsonl");
  const tell = [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(told)}, require("fs").readFileSync(0) + "\\n")`];
  const base = { command: [process.execPath, agent], cwd: dir, prompt: "做这件事", access: "read", resume: null, onQuota: tell };
  const toldLines = () => readFileSync(told, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lastOf = (out: string) =>
    out.trim().split("\n").map((l) => JSON.parse(l)).reduce((a, b) => ({ ...a, ...b }), {});
  const went = lastOf(await bridgeTurn({ ...base, model: "claude", fallbackModels: ["neon-out", "neon"] }));
  assert.equal(went.error, undefined);
  assert.match(went.text, /由 neon 做；第 3 次提示：（中控台：neon-out 的额度用完了/);
  assert.equal(went.session, "s1");
  assert.deepEqual(went.usage, { input: 30, output: 3, cached: 0 });
  assert.deepEqual(toldLines().map((t) => [t.model, t.next]), [["claude", "neon-out"], ["neon-out", "neon"]]);
  assert.match(toldLines()[0].said, /quota reached/);
  const stuck = lastOf(await bridgeTurn({ ...base, model: "claude", fallbackModels: ["neon-out"] }));
  assert.match(stuck.error, /quota reached/);
  assert.ok(Date.parse(stuck.limitedUntil) > Date.now() + 3 * 3600 * 1000);
  assert.deepEqual(toldLines().slice(2).map((t) => [t.model, t.next]), [["claude", "neon-out"], ["neon-out", null]]);
  const plain = lastOf(await bridgeTurn({ ...base, model: "neon" }));
  assert.match(plain.text, /由 neon 做；第 1 次提示：做这件事/);
  assert.equal(toldLines().length, 4);
});

test("ACP asks a turn that ended with nothing said to go on, in the same conversation, at most twice", async () => {
  // 2026-11-27 (run 119): Gemini ended a turn after one command with nothing said; the retry waited 5 minutes.
  const dir = mkdtempSync(join(tmpdir(), "nudge-"));
  const agent = (silent: number) => {
    const file = join(dir, `silent-${silent}.mjs`);
    writeFileSync(
      file,
      `import readline from 'node:readline';
const asked = [];
const send = (x) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => { const m = JSON.parse(line); if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
  if (m.method === 'session/prompt') { asked.push(m.params.prompt[0].text);
    if (asked.length > ${silent}) send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm' + asked.length, content: { type: 'text', text: '做完了；第 ' + asked.length + ' 次提示：' + asked.at(-1).slice(0, 20) } } } });
    send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 1 } } }); }
});`,
    );
    return file;
  };
  const lastOf = (out: string) =>
    out.trim().split("\n").map((l) => JSON.parse(l)).reduce((a, b) => ({ ...a, ...b }), {});
  const turn = (silent: number) =>
    bridgeTurn({ command: [process.execPath, agent(silent)], cwd: dir, prompt: "做这件事", access: "read", resume: null });
  const once = lastOf(await turn(1));
  assert.equal(once.error, undefined);
  assert.match(once.text, /做完了；第 2 次提示：（中控台：你这一轮没写任何文字/);
  assert.equal(once.session, "s1");
  assert.deepEqual(once.usage, { input: 20, output: 2, cached: 0 });
  assert.match(lastOf(await turn(2)).text, /第 3 次提示/);
  const never = lastOf(await turn(3));
  assert.match(never.error, /没有回文字/);
  assert.match(lastOf(await turn(0)).text, /第 1 次提示：做这件事/);
});

test("claude: the rules' extra args come last on the command line; none, nothing is added", async () => {
  // 2026-11-25 (P3.7): Agent0 starts lighter with --tools Read,Grep,Glob and no skills or MCP servers.
  const claude = (await import("../plugins/claude/agent.ts")).default;
  const turn = { prompt: "p", session: "s", resume: null, cwd: "/x", access: "read" as const, contextFile: "/c", folder: "/r",
    program: "claude" };
  const extra = ["--tools", "Read,Grep,Glob", "--strict-mcp-config"];
  const withArgs = claude.command({ ...turn, args: extra });
  assert.deepEqual(withArgs.slice(-3), extra);
  assert.deepEqual(claude.command(turn).length, withArgs.length - 3);
  assert.throws(() => parseRules({ ...rules, agents: { ...rules.agents, a: { ...Object.values(rules.agents)[0], args: "x" } } }, 0, "UTC"));
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
