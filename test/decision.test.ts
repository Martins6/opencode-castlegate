import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askDecision,
  canonicalJSON,
  expectedScore,
  healthCheck,
  noulProbability,
  resetDecisionState,
  setDecisionTestHooks,
  topChoice,
  DecisionApiUnavailableError,
  DecisionRequestError,
  type DecisionQuestion,
} from "../src/decision.ts";
import { parseConfig } from "../src/config.ts";

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

interface FetchCall {
  url: string;
  init: FetchInit | undefined;
}

type FetchHandler = (
  callIndex: number,
  url: string,
  init: FetchInit | undefined,
) => Response | Promise<Response>;

function mockFetch(handler: FetchHandler): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = String(input);
    const index = calls.length;
    calls.push({ url, init });
    return handler(index, url, init);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const GATE_QUESTION: DecisionQuestion = { type: "noul", instructions: "Does this change the intent?" };

function gateConfig(extra: Record<string, unknown> = {}) {
  return parseConfig({ retries: 0, ...extra });
}

// ---------------------------------------------------------------------------
// Protocol parsing
// ---------------------------------------------------------------------------

test("askDecision parses noul/choice/score answers and exposes them via the helpers", async (t) => {
  const { calls, restore } = mockFetch(() =>
    jsonResponse({
      answers: {
        gate: { type: "noul", noul: 0.93 },
        scope: {
          type: "choice",
          choice: "within_scope",
          probabilities: { within_scope: 0.91, out_of_scope: 0.09 },
          confidence: 0.88,
        },
        severity: {
          type: "score",
          score: 1.2,
          probabilities: { "0": 0.1, "1": 0.55, "2": 0.35 },
          legend: { "0": "harmless", "1": "risky", "2": "destructive" },
          confidence: 0.7,
        },
      },
    }),
  );
  t.after(restore);
  t.after(resetDecisionState);

  const cfg = gateConfig();
  const questions: Record<string, DecisionQuestion> = {
    gate: GATE_QUESTION,
    scope: {
      type: "choice",
      instructions: "Is this command within the session intent?",
      criteria: { within_scope: "directly advances the goal", out_of_scope: "unrelated" },
    },
    severity: {
      type: "score",
      instructions: "How severe is the damage if it goes wrong?",
      criteria: ["harmless", "risky", "destructive"],
    },
  };

  const answers = await askDecision({ cfg, state: "anchor intent text", questions });

  // One request carries every question (one forward pass server-side).
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    model: string;
    state: string;
    questions: Record<string, { type: string }>;
  };
  assert.equal(calls[0]?.url, "http://127.0.0.1:8080/v1/systemone");
  assert.equal(body.model, "LiquidAI/d1-omni-600M-GGUF:Q8_0");
  assert.equal(body.state, "anchor intent text");
  assert.deepEqual(Object.keys(body.questions).sort(), ["gate", "scope", "severity"]);
  assert.equal(body.questions["gate"]?.type, "noul");
  assert.equal(body.questions["scope"]?.type, "choice");
  assert.equal(body.questions["severity"]?.type, "score");

  // Typed accessors.
  assert.equal(noulProbability(answers, "gate"), 0.93);
  const top = topChoice(answers, "scope");
  assert.equal(top?.choice, "within_scope");
  assert.equal(top?.probability, 0.91);
  assert.equal(top?.confidence, 0.88);
  const severity = expectedScore(answers, "severity");
  assert.ok(severity !== undefined);
  // Weighted mean of the distribution (0.55 + 0.7 = 1.25), not the raw score field.
  assert.ok(Math.abs(severity - 1.25) < 1e-9);

  // Wrong question name or wrong answer type → undefined, never a crash.
  assert.equal(noulProbability(answers, "missing"), undefined);
  assert.equal(noulProbability(answers, "scope"), undefined);
  assert.equal(topChoice(answers, "gate"), undefined);
  assert.equal(expectedScore(answers, "scope"), undefined);
});

test("multiple questions travel in ONE request (single fetch call)", async (t) => {
  const { calls, restore } = mockFetch(() =>
    jsonResponse({
      answers: Object.fromEntries(
        ["q1", "q2", "q3", "q4", "q5"].map((name) => [name, { type: "noul", noul: 0.5 }]),
      ),
    }),
  );
  t.after(restore);
  t.after(resetDecisionState);

  const cfg = gateConfig();
  const answers = await askDecision({
    cfg,
    state: "s",
    questions: {
      q1: GATE_QUESTION,
      q2: GATE_QUESTION,
      q3: GATE_QUESTION,
      q4: GATE_QUESTION,
      q5: GATE_QUESTION,
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(Object.keys(answers).length, 5);
});

test("healthCheck probes with a minimal POST and treats 4xx as reachable", async (t) => {
  let status = 200;
  let method = "";
  const { restore } = mockFetch((_i, _url, init) => {
    method = String(init?.method);
    return new Response(null, { status });
  });
  t.after(restore);
  t.after(resetDecisionState);

  const cfg = gateConfig();
  assert.equal(await healthCheck(cfg), true);
  assert.equal(method, "POST");
  status = 400; // reachable but rejecting the probe — still healthy
  assert.equal(await healthCheck(cfg), true);
  status = 503;
  assert.equal(await healthCheck(cfg), false);
});

// ---------------------------------------------------------------------------
// Reliability: retries + circuit breaker
// ---------------------------------------------------------------------------

test("askDecision retries after a network error and then succeeds", async (t) => {
  setDecisionTestHooks({ retryBaseDelayMs: 1 });
  t.after(resetDecisionState);
  const { calls, restore } = mockFetch((index) => {
    if (index === 0) throw new TypeError("fetch failed");
    return jsonResponse({ answers: { gate: { type: "noul", noul: 0.7 } } });
  });
  t.after(restore);

  const retries: number[] = [];
  const answers = await askDecision({
    cfg: gateConfig({ retries: 1 }),
    state: "s",
    questions: { gate: GATE_QUESTION },
    onRetry: (info) => retries.push(info.attempt),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(retries, [1]);
  assert.equal(noulProbability(answers, "gate"), 0.7);
});

test("askDecision throws DecisionApiUnavailableError after retries are exhausted", async (t) => {
  setDecisionTestHooks({ retryBaseDelayMs: 1 });
  t.after(resetDecisionState);
  const { calls, restore } = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  t.after(restore);

  await assert.rejects(
    () =>
      askDecision({
        cfg: gateConfig({ retries: 1 }),
        state: "s",
        questions: { gate: GATE_QUESTION },
      }),
    (err: unknown) => {
      assert.ok(err instanceof DecisionApiUnavailableError);
      assert.equal(err.name, "DecisionApiUnavailableError");
      assert.equal(err.tag, "CASTLEGATE_API_UNAVAILABLE");
      assert.equal(err.baseURL, "http://127.0.0.1:8080/v1/systemone");
      assert.equal(err.attempts, 2);
      assert.match(err.message, /^CASTLEGATE_API_UNAVAILABLE:/);
      assert.match(err.message, /after 2 attempts/);
      assert.match(err.message, /"enabled": false/);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("HTTP 500 is retried and eventually surfaces as unavailable", async (t) => {
  setDecisionTestHooks({ retryBaseDelayMs: 1 });
  t.after(resetDecisionState);
  const { calls, restore } = mockFetch(() => new Response("boom", { status: 500 }));
  t.after(restore);

  await assert.rejects(
    () =>
      askDecision({
        cfg: gateConfig({ retries: 1 }),
        state: "s",
        questions: { gate: GATE_QUESTION },
      }),
    DecisionApiUnavailableError,
  );
  assert.equal(calls.length, 2);
});

test("HTTP 400 → DecisionRequestError: one fetch, no retry, breaker never trips", async (t) => {
  setDecisionTestHooks({ retryBaseDelayMs: 1 });
  t.after(resetDecisionState);
  const { calls, restore } = mockFetch((index) => {
    // First three calls rejected with 400; the server recovers afterwards.
    if (index < 3) return new Response("request exceeds batch size", { status: 400 });
    return jsonResponse({ answers: { gate: { type: "noul", noul: 0.5 } } });
  });
  t.after(restore);

  const cfg = gateConfig({ retries: 2 });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      () => askDecision({ cfg, state: "s", questions: { gate: GATE_QUESTION } }),
      (err: unknown) => {
        assert.ok(err instanceof DecisionRequestError);
        assert.equal(err.name, "DecisionRequestError");
        assert.equal(err.tag, "CASTLEGATE_DECISION_REQUEST");
        assert.equal(err.status, 400);
        assert.match(err.detail, /exceeds batch size/);
        assert.match(err.message, /configuration error/);
        return true;
      },
    );
    // Exactly one fetch per call — 400 is never retried despite retries: 2.
    assert.equal(calls.length, i + 1);
  }

  // Three consecutive 400s did not trip the breaker: the network is still attempted.
  const answers = await askDecision({ cfg, state: "s", questions: { gate: GATE_QUESTION } });
  assert.equal(calls.length, 4);
  assert.equal(noulProbability(answers, "gate"), 0.5);
});

test("circuit breaker fails fast after 3 failures and recovers after the 60s window", async (t) => {
  let nowMs = 1_000_000;
  setDecisionTestHooks({ retryBaseDelayMs: 1, now: () => nowMs });
  t.after(resetDecisionState);
  let failing = true;
  const { calls, restore } = mockFetch(() => {
    if (failing) throw new TypeError("fetch failed");
    return jsonResponse({ answers: { gate: { type: "noul", noul: 0.9 } } });
  });
  t.after(restore);

  const cfg = gateConfig({ retries: 0 });
  const ask = () => askDecision({ cfg, state: "s", questions: { gate: GATE_QUESTION } });

  // 3 consecutive failures open the breaker.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(ask, DecisionApiUnavailableError);
  }
  assert.equal(calls.length, 3);

  // Open breaker: fails fast WITHOUT touching the network.
  await assert.rejects(ask, (err: unknown) => {
    assert.ok(err instanceof DecisionApiUnavailableError);
    assert.equal(err.breakerOpen, true);
    assert.equal(err.attempts, 0);
    assert.match(err.message, /circuit breaker is open/);
    return true;
  });
  assert.equal(calls.length, 3);

  // Still open halfway through the window.
  nowMs += 30_000;
  await assert.rejects(ask, DecisionApiUnavailableError);
  assert.equal(calls.length, 3);

  // Window elapsed: the half-open trial call goes through and succeeds.
  nowMs += 30_001;
  failing = false;
  const answers = await ask();
  assert.equal(calls.length, 4);
  assert.equal(noulProbability(answers, "gate"), 0.9);
});

test("circuit breaker state is per baseURL", async (t) => {
  setDecisionTestHooks({ retryBaseDelayMs: 1 });
  t.after(resetDecisionState);
  const { calls, restore } = mockFetch((index) => {
    if (index < 3) throw new TypeError("fetch failed");
    return jsonResponse({ answers: { gate: { type: "noul", noul: 0.8 } } });
  });
  t.after(restore);

  const failingCfg = gateConfig({ retries: 0 });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      () => askDecision({ cfg: failingCfg, state: "s", questions: { gate: GATE_QUESTION } }),
      DecisionApiUnavailableError,
    );
  }
  // Default URL breaker is open for this call…
  await assert.rejects(
    () => askDecision({ cfg: failingCfg, state: "s", questions: { gate: GATE_QUESTION } }),
    (err: unknown) => {
      assert.ok(err instanceof DecisionApiUnavailableError);
      assert.equal(err.breakerOpen, true);
      return true;
    },
  );
  assert.equal(calls.length, 3);

  // …but a different baseURL has its own breaker and still hits the network.
  const otherCfg = parseConfig({
    retries: 0,
    decision: { baseURL: "http://127.0.0.1:9090/v1/systemone" },
  });
  const answers = await askDecision({ cfg: otherCfg, state: "s", questions: { gate: GATE_QUESTION } });
  assert.equal(calls.length, 4);
  assert.equal(calls[3]?.url, "http://127.0.0.1:9090/v1/systemone");
  assert.equal(noulProbability(answers, "gate"), 0.8);
});

// ---------------------------------------------------------------------------
// canonicalJSON
// ---------------------------------------------------------------------------

test("canonicalJSON sorts keys recursively", () => {
  const value = {
    b: 1,
    a: { d: 2, c: [3, { z: 1, y: 2 }] },
    "": { "m": true, "a": false },
  };
  assert.equal(
    canonicalJSON(value),
    '{"":{"a":false,"m":true},"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
  );
});

test("canonicalJSON is stable across key-order permutations", () => {
  const one = { first: 1, second: { x: 1, y: [3, 2, 1] }, third: "c" };
  const two = { third: "c", second: { y: [3, 2, 1], x: 1 }, first: 1 };
  assert.equal(canonicalJSON(one), canonicalJSON(two));
});

test("canonicalJSON preserves arrays, primitives and null", () => {
  assert.equal(canonicalJSON([1, "a", null, true]), '[1,"a",null,true]');
  assert.equal(canonicalJSON("plain"), '"plain"');
  assert.equal(canonicalJSON(42), "42");
  assert.equal(canonicalJSON(null), "null");
});
