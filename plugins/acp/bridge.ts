// A turn run over the Agent Client Protocol: a process of its own that talks to the ACP agent on stdio and prints what
// the worker's adapter reads, one JSON object per line.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { commandLine } from "../../host/command.ts";
import { eachLine } from "../../host/lines.ts";
import { versionName } from "../../host/version.ts";
import type { Turn } from "../../worker/agents.ts";

/** The agent said no, as opposed to going away, saying nothing, or having what was asked for in use. */
class Refused extends Error {}

/** CodeHub fork: what Antigravity answers instead of doing the turn when the model's quota pool is used up, e.g.
 * "⚠ Third-party quota reached. Please switch to Gemini models ... Resets in 3h42m58s." */
const OUT_OF_QUOTA = /quota (?:reached|exceeded|exhausted)|out of quota|usage limit reached/i;

/** CodeHub fork: whether a turn's answer says it is out of quota, and if so when that ends (an ISO time; an hour from
 * now when it doesn't say). */
export function quotaOf(text: string, now = Date.now()): { until: string } | null {
  if (!OUT_OF_QUOTA.test(text) || text.length > 600) return null;   // a long answer that mentions quota did its work
  const resets = /resets? in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(text);
  const seconds = resets ? Number(resets[1] ?? 0) * 3600 + Number(resets[2] ?? 0) * 60 + Number(resets[3] ?? 0) : 0;
  return { until: new Date(now + (seconds > 0 ? seconds * 1000 : 3_600_000)).toISOString() };
}

/** CodeHub fork: tells the turn's `onQuota` command (if any) that a model is out of quota: it reads
 * {"model", "until", "next", "said"} as JSON on standard input (next: the model going on, or null when none is left).
 * Its answer is not waited for long and changes nothing: the turn goes on either way. */
export function tellQuota(turn: Pick<Turn, "onQuota" | "cwd">, what: object): Promise<void> {
  if (!turn.onQuota?.length) return Promise.resolve();
  const [program, args] = commandLine(turn.onQuota);
  return new Promise((done) => {
    const child = spawn(program, args, { cwd: turn.cwd, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(done, 30_000);
    timer.unref();
    child.on("error", (error) => {
      console.error(`the onQuota command couldn't run: ${error}`);
      done();
    });
    child.on("close", () => done());
    child.stdin.end(JSON.stringify(what));
  });
}

/** CodeHub fork: what the next model is told when it takes over a turn the last one could not do. */
export const takeOver = (prompt: string, from: string | undefined, to: string) =>
  `（中控台：${from ?? "上一个模型"} 的额度用完了，这一轮没做成；现在换成 ${to} 接着做。请照下面的任务说明把这一轮做完，` +
  `汇报里写一句"这一轮由 ${to} 完成（${from ?? "上一个模型"} 额度用完）"。）\n\n${prompt}`;

const isLink = (file: string) => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Where a path really is, though it may not be there yet; null if it goes through a link with nothing at the end of it.
 * Writing through one creates what it points at, so it can't count as a new file where the link is.
 */
function resolved(file: string): string | null {
  if (existsSync(file)) return realpathSync(file);
  const folder = resolved(dirname(file));
  if (folder === null) return null;
  const path = resolve(folder, basename(file));
  return isLink(path) ? null : path;
}

export function permission(turn: Pick<Turn, "access" | "cwd" | "approver">, params: any) {
  const tool = params.toolCall ?? {};
  const inside = (location: any) => {
    if (typeof location.path !== "string" || !isAbsolute(location.path)) return false;
    const target = resolved(location.path);
    if (target === null) return false;
    const path = relative(realpathSync(turn.cwd), target);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const editsInside =
    turn.access === "edit" && tool.kind === "edit" && tool.locations?.length > 0 && tool.locations.every(inside);
  // CodeHub fork: with an approver, reading outside the folder is the approver's to decide (data zones an agent may
  // not read); without one, reading stays free as upstream has it.
  const reading = tool.kind === "read" || tool.kind === "search";
  const readsFree = reading && (!turn.approver?.length || !tool.locations?.length || tool.locations.every(inside));
  const allowed = turn.access === "full" || readsFree || editsInside;
  const option = params.options?.find((option: any) => option.kind === (allowed ? "allow_once" : "reject_once"));
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

/** CodeHub fork: asks the turn's approver about a request the rules above refuse (a command, an edit outside the
 * folder). The approver reads the request as JSON and answers {"allow": true|false, "message": "..."}; anything else,
 * or an approver that fails, is a no. Without an approver the plugin's own answer stands. */
export async function approve(turn: Pick<Turn, "approver" | "cwd">, params: any, answer: any) {
  const refused = answer.outcome === "cancelled" || params.options?.find((o: any) => o.optionId === answer.optionId)?.kind !== "allow_once";
  if (!refused || !turn.approver?.length) return answer;
  const tool = params.toolCall ?? {};
  const raw = tool.rawInput ?? {};
  const request = {
    tool: tool.kind ?? "",
    title: tool.title ?? "",
    command: raw.CommandLine ?? raw.command ?? "",
    paths: (tool.locations ?? []).map((location: any) => location.path).filter(Boolean),
    input: raw,
    cwd: turn.cwd,
  };
  const [program, args] = commandLine(turn.approver);
  const said = await new Promise<string>((done) => {
    const child = spawn(program, args, { cwd: turn.cwd, windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => done(""));
    child.on("close", () => done(out));
    child.stdin.end(JSON.stringify(request));
  });
  let allow = false;
  try {
    allow = JSON.parse(said.trim().split("\n").at(-1) ?? "").allow === true;
  } catch {
    /* Not an answer: a no. */
  }
  const option = params.options?.find((o: any) => o.kind === (allow ? "allow_once" : "reject_once"));
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

export async function bridge(turn: Turn) {
  if (!turn.command?.length) throw new Error("ACP 要在 command 写启动命令");
  // The last go may have done its work in this session, so whatever breaks now says nothing about whether a new session
  // would do it again. Only the agent's own no takes this back; see goOn.
  if (turn.resume) console.log(JSON.stringify({ session: turn.resume, started: true }));
  const [program, args] = commandLine(turn.command);
  const child = spawn(program, args, { cwd: turn.cwd, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let next = 0;
  let session = "";
  let collecting = false;
  let text = "";
  let message: string | undefined;
  let boundary = false;
  const send = (body: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`ACP 在交回结果前退出：${code}`)));
  child.stdin.on("error", fail);

  const toolCalls = new Map<string, object>();
  /** All that's been said of a tool call. A message may give only its id; a field left out or null changes nothing. */
  const toolCall = (said: any) => {
    const fields = Object.entries(said ?? {}).filter(([, value]) => value !== null && value !== undefined);
    const known = { ...toolCalls.get(said?.toolCallId), ...Object.fromEntries(fields) };
    if (said?.toolCallId) toolCalls.set(said.toolCallId, known);
    return known;
  };

  const onUpdate = (update: any) => {
    if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) toolCall(update);
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      // An id says which message this is. Only with none does what came in between have to tell.
      if (update.messageId ? update.messageId !== message : boundary) text = "";
      message = update.messageId;
      boundary = false;
      text += update.content.text;
    } else if (
      ["tool_call", "agent_thought_chunk", "user_message_chunk"].includes(update.sessionUpdate) ||
      (update.sessionUpdate === "tool_call_update" && ["completed", "failed"].includes(update.status))
    ) {
      boundary = true;
    }
  };
  const onLine = (line: string) => {
    const incoming = JSON.parse(line);
    if (incoming.method === "session/update" && collecting && incoming.params?.sessionId === session) {
      onUpdate(incoming.params.update);
    } else if (incoming.method && incoming.id !== undefined) {
      const { id, method, params } = incoming;
      if (method === "session/request_permission" && params?.sessionId === session) {
        const asked = { ...params, toolCall: toolCall(params.toolCall) };
        // CodeHub fork: what the rules refuse may still go to the approver, which can take minutes (a person).
        approve(turn, asked, permission(turn, asked)).then(
          (outcome) => send({ id, result: { outcome } }),
          () => send({ id, result: { outcome: { outcome: "cancelled" } } }),
        );
      } else send({ id, error: { code: -32601, message: "不支持这个方法" } });
    } else if (pending.has(incoming.id)) {
      const request = pending.get(incoming.id)!;
      pending.delete(incoming.id);
      if (incoming.error) {
        // Open somewhere else just now isn't a no to the session: a new one would do its work again. The reason and not
        // the code, which is generic: another agent's no under it has to stay a no, or it would never get a new session.
        const inUse = incoming.error.data?.reason === "thread_active_writer";
        request.reject(new (inUse ? Error : Refused)(incoming.error.message));
      } else request.resolve(incoming.result);
    }
  };
  let over = false;
  eachLine(
    child.stdout,
    (line) => {
      if (over) return;
      try {
        onLine(line);
      } catch (error) {
        fail(error as Error);
      }
    },
    // An agent that dies ends its output first, and its exit says more. One still there after this has hung up on us.
    () => setTimeout(() => fail(new Error("ACP 在交回结果前关掉了输出")), 1000).unref(),
  );

  const rpc = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const goOn = async (can: any) => {
    const method = can?.loadSession ? "session/load" : can?.sessionCapabilities?.resume ? "session/resume" : null;
    try {
      if (!method) throw new Refused("这个 ACP Agent 不支持恢复会话");
      await rpc(method, { sessionId: session, cwd: turn.cwd, mcpServers: [] });
    } catch (error) {
      if (error instanceof Refused) console.log(JSON.stringify({ started: false }));
      throw error;
    }
  };
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  try {
    const clientInfo = { name: "agent-autoloop", version: versionName() };
    const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo });
    if (init.protocolVersion !== 1) throw new Error(`不支持 ACP 版本 ${init.protocolVersion}`);
    if (turn.resume) {
      session = turn.resume;
      await goOn(init.agentCapabilities);
    } else {
      const { sessionId } = await rpc("session/new", { cwd: turn.cwd, mcpServers: [] });
      if (typeof sessionId !== "string" || !sessionId) throw new Error("ACP 没有返回会话编号");
      session = sessionId;
    }
    // CodeHub fork: the rules' model for this agent (Antigravity lists its models when a session is made and takes
    // session/set_model). A model it refuses ends the turn with the agent's reason, before any work.
    if (turn.model) await rpc("session/set_model", { sessionId: session, modelId: turn.model });
    // Before the prompt goes: the agent can start on it at once, and this has to be there if the bridge is killed then.
    console.log(JSON.stringify({ session, started: true }));
    collecting = true;
    const prompt = [{ type: "text", text: turn.prompt }];
    let result = await rpc("session/prompt", { sessionId: session, prompt });
    // CodeHub fork: out of quota, the same conversation goes on with the next model the rules list (another quota pool).
    const models = [...(turn.fallbackModels ?? [])];
    let model = turn.model;
    const spent = result.usage ? [result.usage] : [];
    while (result.stopReason === "end_turn" && quotaOf(text) && models.length) {
      const to = models.shift()!;
      console.error(`${model ?? "the model"} is out of quota; going on with ${to} in the same conversation`);
      await tellQuota(turn, { model, until: quotaOf(text)!.until, next: to, said: text.trim().slice(0, 300) });
      await rpc("session/set_model", { sessionId: session, modelId: to });
      text = "";
      message = undefined;
      boundary = false;
      result = await rpc("session/prompt", { sessionId: session, prompt: [{ type: "text", text: takeOver(turn.prompt, model, to) }] });
      if (result.usage) spent.push(result.usage);
      model = to;
    }
    const limited = result.stopReason === "end_turn" ? quotaOf(text) : null;
    if (limited) {
      await tellQuota(turn, { model, until: limited.until, next: null, said: text.trim().slice(0, 300) });
      console.log(JSON.stringify({ session, finished: true, error: text.trim().slice(0, 300), limitedUntil: limited.until }));
      return;
    }
    if (spent.length > 1) {
      const sum = (key: string) => spent.reduce((total, used: any) => total + (used[key] ?? 0), 0);
      result.usage = Object.fromEntries(
        ["inputTokens", "cachedReadTokens", "cachedWriteTokens", "outputTokens", "thoughtTokens"].map((k) => [k, sum(k)]),
      );
    }
    if (result.stopReason !== "end_turn") throw new Error(`ACP 没有完成这一轮：${result.stopReason}`);
    // end_turn with nothing said is not a turn that stopped early: an agent whose model refused answers this way, and the
    // old reason quoted "end_turn" back as if it had failed, leaving no cause to look for.
    if (!text.trim()) throw new Error("ACP 说这一轮结束了，但没有回文字");
    // CodeHub fork: what the turn used, as the agent reports it (Antigravity does; tokens only, no price).
    const used = result.usage;
    const usage = used && {
      input: (used.inputTokens ?? 0) + (used.cachedReadTokens ?? 0) + (used.cachedWriteTokens ?? 0),
      output: (used.outputTokens ?? 0) + (used.thoughtTokens ?? 0),
      cached: used.cachedReadTokens ?? 0,
    };
    console.log(JSON.stringify({ session, text, finished: true, ...(usage && { usage }) }));
  } catch (error) {
    // Now and not on the way out: the agent, or what it left holding its output, can keep this process here for good,
    // and this is what lets the worker end it.
    console.log(JSON.stringify({ session: session || undefined, finished: true, error: (error as Error).message }));
    throw error;
  } finally {
    over = true;
    process.removeListener("SIGTERM", stop);
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

if (import.meta.main) {
  bridge(JSON.parse(process.argv[2])).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
