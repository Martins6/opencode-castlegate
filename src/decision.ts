// Typed client for the llama.cpp /v1/systemone "System One" decision protocol
// (SPEC §3.1). No external dependencies — global fetch only (Node >= 20).
//
// Reliability (SPEC §5.4): per-attempt timeout (decision.timeoutMs) combined
// with the caller's AbortSignal, retries with exponential backoff + jitter,
// and a per-baseURL circuit breaker (opens after 3 consecutive failures,
// fails fast for 60s).
//
// Trust boundary (SPEC §5.7): HTTP 400 is a config error (request too large
// for the server batch, or a malformed question) — it is never retried and
// never counted by the circuit breaker, and it is never mapped to the
// "api unavailable" error.

import type { CastlegateConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Protocol types (System One / Decision Index schema)
// ---------------------------------------------------------------------------

/** noul is a yes/no question; the answer is the calibrated P(true). */
export interface NoulCriteria {
  true: string;
  false: string;
}

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: NoulCriteria }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence?: number;
    }
  | {
      type: "score";
      score: number;
      probabilities: Record<string, number>;
      legend?: Record<string, string>;
      confidence?: number;
    };

/** Answers keyed by question name, in the same shape the questions were sent. */
export type DecisionAnswers = Record<string, DecisionAnswer>;

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

export interface DecisionApiUnavailableOptions {
  baseURL: string;
  /** network attempts made (0 when the circuit breaker failed fast). */
  attempts: number;
  /** true when thrown by the open circuit breaker without touching the network. */
  breakerOpen?: boolean;
  /** consecutive failed calls recorded for this baseURL (breaker fast-fail only). */
  consecutiveFailures?: number;
  cause?: unknown;
}

export class DecisionApiUnavailableError extends Error {
  readonly tag = "CASTLEGATE_API_UNAVAILABLE";
  readonly baseURL: string;
  readonly attempts: number;
  readonly breakerOpen: boolean;

  constructor(opts: DecisionApiUnavailableOptions) {
    const tail =
      `The plugin cannot make safety decisions.\n` +
      `Set "enabled": false or comment out opencode-castlegate in opencode.json until the API is back.`;
    const message = opts.breakerOpen
      ? `${"CASTLEGATE_API_UNAVAILABLE"}: circuit breaker is open for the decision server at ${opts.baseURL} ` +
          `after ${opts.consecutiveFailures ?? "?"} consecutive failures; failing fast without calling the network.\n${tail}`
      : `${"CASTLEGATE_API_UNAVAILABLE"}: castlegate cannot reach the decision server at ${opts.baseURL} ` +
          `after ${opts.attempts} attempt${opts.attempts === 1 ? "" : "s"}.\n${tail}`;
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "DecisionApiUnavailableError";
    this.baseURL = opts.baseURL;
    this.attempts = opts.attempts;
    this.breakerOpen = opts.breakerOpen ?? false;
  }
}

export interface DecisionRequestErrorOptions {
  baseURL: string;
  status: number;
  /** snippet of the response body, for diagnosis. */
  detail: string;
}

/** HTTP 400 from the decision server: a config error, never an availability error. */
export class DecisionRequestError extends Error {
  readonly tag = "CASTLEGATE_DECISION_REQUEST";
  readonly baseURL: string;
  readonly status: number;
  readonly detail: string;

  constructor(opts: DecisionRequestErrorOptions) {
    const message =
      `${"CASTLEGATE_DECISION_REQUEST"}: decision server at ${opts.baseURL} rejected the request ` +
      `(HTTP ${opts.status}): ${opts.detail || "(no body)"}.\n` +
      `This is a configuration error — typically a state longer than decision.stateMaxChars for the ` +
      `server batch size (-b/-ub), or a malformed question. It is never retried and never counted ` +
      `by the circuit breaker.`;
    super(message);
    this.name = "DecisionRequestError";
    this.baseURL = opts.baseURL;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

/** Internal, retryable failure (network error, timeout, non-400 non-2xx, malformed body). */
class DecisionCallFailure extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "DecisionCallFailure";
  }
}

// ---------------------------------------------------------------------------
// Test hooks (breaker timings + clock injection; production never sets these)
// ---------------------------------------------------------------------------

export interface DecisionTestHooks {
  /** consecutive failed calls before the breaker opens (default 3). */
  breakerFailureThreshold: number;
  /** how long the breaker stays open (default 60_000). */
  breakerOpenMs: number;
  /** base delay for exponential backoff between retries (default 200). */
  retryBaseDelayMs: number;
  /** clock used by the breaker (default Date.now). */
  now: () => number;
}

const DEFAULT_TEST_HOOKS: DecisionTestHooks = {
  breakerFailureThreshold: 3,
  breakerOpenMs: 60_000,
  retryBaseDelayMs: 200,
  now: () => Date.now(),
};

let tuning: DecisionTestHooks = { ...DEFAULT_TEST_HOOKS };

export function setDecisionTestHooks(partial: Partial<DecisionTestHooks>): void {
  tuning = { ...tuning, ...partial };
}

/** Clears circuit-breaker state and restores default hooks (plugin cleanup / test teardown). */
export function resetDecisionState(): void {
  breakers.clear();
  tuning = { ...DEFAULT_TEST_HOOKS };
}

// ---------------------------------------------------------------------------
// Circuit breaker — state is per baseURL so different configs never share it
// ---------------------------------------------------------------------------

interface BreakerState {
  failures: number;
  openedAtMs: number | null;
}

const breakers = new Map<string, BreakerState>();

function breakerFor(baseURL: string): BreakerState {
  let state = breakers.get(baseURL);
  if (!state) {
    state = { failures: 0, openedAtMs: null };
    breakers.set(baseURL, state);
  }
  return state;
}

/** Throws the fast-fail error when the breaker is open; resets a stale breaker otherwise. */
function breakerAssertClosed(baseURL: string): void {
  const state = breakerFor(baseURL);
  if (state.openedAtMs === null) return;
  if (tuning.now() - state.openedAtMs < tuning.breakerOpenMs) {
    throw new DecisionApiUnavailableError({
      baseURL,
      attempts: 0,
      breakerOpen: true,
      consecutiveFailures: state.failures,
    });
  }
  // Open window elapsed: half-open — allow a trial call.
  state.failures = 0;
  state.openedAtMs = null;
}

function breakerRecordSuccess(baseURL: string): void {
  const state = breakerFor(baseURL);
  state.failures = 0;
  state.openedAtMs = null;
}

function breakerRecordFailure(baseURL: string): void {
  const state = breakerFor(baseURL);
  state.failures += 1;
  if (state.failures >= tuning.breakerFailureThreshold) {
    state.openedAtMs = tuning.now();
  }
}

// ---------------------------------------------------------------------------
// Deterministic JSON (signatures / cache keys — SPEC §3.4, §5.7)
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: object keys are recursively sorted, so key order never changes the output. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

/** Calibrated P(true) for a noul answer, or undefined when absent / wrong type. */
export function noulProbability(
  answers: DecisionAnswers,
  name: string,
): number | undefined {
  const answer = answers[name];
  return answer?.type === "noul" ? answer.noul : undefined;
}

export interface TopChoice {
  choice: string;
  /** probability of `choice` (0 when the server omitted it from `probabilities`). */
  probability: number;
  confidence: number | undefined;
}

/** Highest-probability option of a choice answer, or undefined when absent / wrong type. */
export function topChoice(answers: DecisionAnswers, name: string): TopChoice | undefined {
  const answer = answers[name];
  if (answer?.type !== "choice") return undefined;
  let choice = answer.choice;
  let probability = answer.probabilities[answer.choice] ?? 0;
  for (const [option, p] of Object.entries(answer.probabilities)) {
    if (p > probability) {
      choice = option;
      probability = p;
    }
  }
  return { choice, probability, confidence: answer.confidence };
}

/**
 * Expected severity level of a score answer: the weighted mean of the
 * distribution when its keys are numeric levels ("0".."9"), otherwise the
 * server-reported expected `score`.
 */
export function expectedScore(answers: DecisionAnswers, name: string): number | undefined {
  const answer = answers[name];
  if (answer?.type !== "score") return undefined;
  let weighted = 0;
  let seen = 0;
  for (const [key, p] of Object.entries(answer.probabilities)) {
    const level = Number(key);
    if (!Number.isInteger(level)) return answer.score;
    weighted += level * p;
    seen += 1;
  }
  return seen > 0 ? weighted : answer.score;
}

// ---------------------------------------------------------------------------
// Reliability plumbing
// ---------------------------------------------------------------------------

function combineSignals(signals: AbortSignal[]): AbortSignal {
  const maybeAny = (AbortSignal as unknown as {
    any?: (s: readonly AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof maybeAny === "function") return maybeAny(signals);
  // Manual linking for environments without AbortSignal.any.
  const controller = new AbortController();
  const cleanup = () => {
    for (const s of signals) s.removeEventListener("abort", onAbort);
  };
  const onAbort = (event: Event) => {
    controller.abort((event.target as AbortSignal).reason);
    cleanup();
  };
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
  }
  for (const s of signals) s.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

/** Resolves after `ms`, or early when the caller's signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function backoffDelayMs(retryIndex: number): number {
  // retryIndex is 1-based; exponential backoff with jitter in [0.5x, 1x).
  const base = tuning.retryBaseDelayMs * 2 ** (retryIndex - 1);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

interface SystemOneRequestBody {
  model: string;
  state: string;
  questions: Record<string, DecisionQuestion>;
}

export interface RetryInfo {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  baseURL: string;
  delayMs: number;
  error: unknown;
}

export interface AskDecisionArgs {
  cfg: CastlegateConfig;
  /** text state the decision model reads (caller trims to decision.stateMaxChars). */
  state: string;
  /** all questions are evaluated in ONE request (one forward pass server-side). */
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
  /** optional hook for `api.retry` logging (SPEC §7). */
  onRetry?: (info: RetryInfo) => void;
}

function asNumberRecord(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "number") return null;
    out[key] = v;
  }
  return out;
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") return null;
    out[key] = v;
  }
  return out;
}

function parseAnswer(name: string, raw: unknown): DecisionAnswer {
  if (typeof raw !== "object" || raw === null) {
    throw new DecisionCallFailure(`answer "${name}" is not an object`);
  }
  const a = raw as Record<string, unknown>;
  if (a.type === "noul") {
    if (typeof a.noul !== "number") {
      throw new DecisionCallFailure(`answer "${name}" has no numeric "noul"`);
    }
    return { type: "noul", noul: a.noul };
  }
  if (a.type === "choice") {
    if (typeof a.choice !== "string") {
      throw new DecisionCallFailure(`answer "${name}" has no string "choice"`);
    }
    const probabilities = asNumberRecord(a.probabilities);
    if (!probabilities) {
      throw new DecisionCallFailure(`answer "${name}" has no numeric "probabilities"`);
    }
    return {
      type: "choice",
      choice: a.choice,
      probabilities,
      ...(typeof a.confidence === "number" ? { confidence: a.confidence } : {}),
    };
  }
  if (a.type === "score") {
    if (typeof a.score !== "number") {
      throw new DecisionCallFailure(`answer "${name}" has no numeric "score"`);
    }
    const probabilities = asNumberRecord(a.probabilities);
    if (!probabilities) {
      throw new DecisionCallFailure(`answer "${name}" has no numeric "probabilities"`);
    }
    const legend = asStringRecord(a.legend);
    return {
      type: "score",
      score: a.score,
      probabilities,
      ...(legend ? { legend } : {}),
      ...(typeof a.confidence === "number" ? { confidence: a.confidence } : {}),
    };
  }
  throw new DecisionCallFailure(`answer "${name}" has unknown type ${JSON.stringify(a.type)}`);
}

async function parseSystemOneResponse(res: Response): Promise<DecisionAnswers> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new DecisionCallFailure(`response is not valid JSON: ${errMessage(err)}`, err);
  }
  if (typeof payload !== "object" || payload === null) {
    throw new DecisionCallFailure("response is not a JSON object");
  }
  const answersRaw = (payload as Record<string, unknown>).answers;
  if (typeof answersRaw !== "object" || answersRaw === null || Array.isArray(answersRaw)) {
    throw new DecisionCallFailure('response has no "answers" object');
  }
  const answers: DecisionAnswers = {};
  for (const [name, raw] of Object.entries(answersRaw as Record<string, unknown>)) {
    answers[name] = parseAnswer(name, raw);
  }
  return answers;
}

async function readBodySafely(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

async function attemptOnce(
  cfg: CastlegateConfig,
  body: SystemOneRequestBody,
  callerSignal: AbortSignal | undefined,
): Promise<DecisionAnswers> {
  const timeoutSignal = AbortSignal.timeout(cfg.decision.timeoutMs);
  const signal = callerSignal
    ? combineSignals([timeoutSignal, callerSignal])
    : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(cfg.decision.baseURL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Network failure or per-attempt timeout — retryable.
    throw new DecisionCallFailure(`request failed: ${errMessage(err)}`, err);
  }

  if (res.status === 400) {
    const detail = await readBodySafely(res);
    throw new DecisionRequestError({ baseURL: cfg.decision.baseURL, status: 400, detail });
  }
  if (!res.ok) {
    throw new DecisionCallFailure(`unexpected HTTP ${res.status}`);
  }
  return parseSystemOneResponse(res);
}

async function callDecisionServer(
  cfg: CastlegateConfig,
  body: SystemOneRequestBody,
  callerSignal: AbortSignal | undefined,
  onRetry: ((info: RetryInfo) => void) | undefined,
): Promise<DecisionAnswers> {
  const baseURL = cfg.decision.baseURL;
  breakerAssertClosed(baseURL);

  const attemptsAllowed = cfg.retries + 1;
  let lastCause: unknown;

  for (let attempt = 0; ; attempt++) {
    if (callerSignal?.aborted) {
      throw new DecisionApiUnavailableError({
        baseURL,
        attempts: attempt,
        cause: callerSignal.reason,
      });
    }
    try {
      const answers = await attemptOnce(cfg, body, callerSignal);
      breakerRecordSuccess(baseURL);
      return answers;
    } catch (err) {
      // SPEC §5.7: HTTP 400 is a config error — no retry, no breaker count.
      if (err instanceof DecisionRequestError) throw err;
      if (callerSignal?.aborted) {
        // Caller cancelled (cleanup) — not a server failure.
        throw new DecisionApiUnavailableError({ baseURL, attempts: attempt + 1, cause: err });
      }
      lastCause = err;
      if (attempt >= attemptsAllowed - 1) {
        breakerRecordFailure(baseURL);
        throw new DecisionApiUnavailableError({
          baseURL,
          attempts: attemptsAllowed,
          cause: lastCause,
        });
      }
      const delayMs = backoffDelayMs(attempt + 1);
      onRetry?.({ attempt: attempt + 1, baseURL, delayMs, error: err });
      await sleep(delayMs, callerSignal);
    }
  }
}

/**
 * Evaluate all questions in ONE request (one forward pass server-side) and
 * return the typed answers keyed by question name.
 *
 * @throws DecisionRequestError   HTTP 400 (config error — never retried)
 * @throws DecisionApiUnavailableError  network/timeout/non-400 non-2xx after
 *         retries are exhausted, or while the circuit breaker is open
 */
export async function askDecision(args: AskDecisionArgs): Promise<DecisionAnswers> {
  const body: SystemOneRequestBody = {
    model: args.cfg.decision.model,
    state: args.state,
    questions: args.questions,
  };
  return callDecisionServer(args.cfg, body, args.signal, args.onRetry);
}

/**
 * Init-time probe (SPEC §6): a HEAD request; any non-2xx response or network
 * failure means unhealthy. Does not retry and never touches breaker state.
 */
export async function healthCheck(cfg: CastlegateConfig, signal?: AbortSignal): Promise<boolean> {
  const timeoutSignal = AbortSignal.timeout(cfg.decision.timeoutMs);
  const combined = signal ? combineSignals([timeoutSignal, signal]) : timeoutSignal;
  try {
    const res = await fetch(cfg.decision.baseURL, { method: "HEAD", signal: combined });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}
