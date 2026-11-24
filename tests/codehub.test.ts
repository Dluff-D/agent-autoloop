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

test("rules check: maxHops is 1 to 64, sessionFromEvent a boolean", () => {
  const base = JSON.parse(JSON.stringify({
    timezone: "UTC",
    sources: { app: { name: "来源" } },
    agents: { a: { name: "甲", worker: "w1", use: "command", command: ["true"] } },
    rules: [{ name: "one", when: { source: "app", types: ["one"] }, to: "a", cwd: "/tmp", prompt: "做事" }],
  }));
  const with_ = (extra: object) => JSON.stringify({ ...base, rules: [{ ...base.rules[0], ...extra }] });
  assert.equal(parseRules(with_({ maxHops: 64, sessionFromEvent: true }), 0, "UTC").rules[0].maxHops, 64);
  for (const extra of [{ maxHops: 0 }, { maxHops: 65 }, { maxHops: 2.5 }, { sessionFromEvent: "yes" }])
    assert.throws(() => parseRules(with_(extra), 0, "UTC"));
});
