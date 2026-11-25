import type { Rule } from "../kernel/rules.ts";
export type Job = {
  run: number;
  token: string;
  attempt: number;
  rule: Pick<Rule, "name" | "cwd" | "skill" | "prompt" | "title" | "emits">;
  agent: {
    id: string;
    name: string;
    use: string;
    model?: string;
    effort?: string;
    tier?: string;
    access: string;
    command?: string[];
    program?: string;
    /** CodeHub fork: see Turn.approver. */
    approver?: string[];
    /** CodeHub fork: see Turn.fallbackModels. */
    fallbackModels?: string[];
    /** CodeHub fork: see Turn.onQuota. */
    onQuota?: string[];
    /** CodeHub fork: see Turn.args. */
    args?: string[];
    timeout?: number;
  };
  session: string | null;
  askFirst: string[];
  context: {
    events: {
      id: string;
      source: string;
      sourceName: string;
      type: string;
      subject: string;
      summary: string;
      detail: string;
      link: string;
      receivedAt: string;
      hops?: number;
      /** CodeHub fork: the conversation the event names. */
      session?: string;
    }[];
    answers: {
      card: number;
      title: string;
      options: string[];
      choice: number | null;
      chosen: string | null;
      text: string | null;
      about: string;
      by: string | null;
      at: string;
      events: string[];
    }[];
    timers: { key: string; about: string; at: string; events: string[] }[];
    waiting: { key: string; about: string; at: string; events: string[] }[];
    open: { card: number; title: string; text: string; at: string }[];
    decided: { card: number; title: string; choice: string | null; at: string }[];
    /** The rule's tags, as written; only when it has them. */
    tags?: string[];
  };
};
