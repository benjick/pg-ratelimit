"use client";

import { useTransition, useState, useEffect, useCallback } from "react";
import { Send, Eye, Hourglass, Loader2 } from "lucide-react";
import {
  sendRequest,
  peekRemaining,
  waitAndSend,
  type LimitResponse,
  type RemainingResponse,
} from "@/actions/limit";
import { strategies, type Strategy } from "@/lib/strategies";

type Result =
  | { kind: "limit"; data: LimitResponse }
  | { kind: "remaining"; data: RemainingResponse };

function useCountdown(reset: number) {
  const computeSeconds = useCallback(
    () => Math.max(0, Math.ceil((reset - Date.now()) / 1000)),
    [reset],
  );
  const [seconds, setSeconds] = useState(computeSeconds);

  useEffect(() => {
    setSeconds(computeSeconds());
    const id = setInterval(() => {
      const s = computeSeconds();
      setSeconds(s);
      if (s <= 0) {
        clearInterval(id);
      }
    }, 100);
    return () => clearInterval(id);
  }, [computeSeconds]);

  return seconds;
}

function ResetCountdown({ reset }: { reset: number }) {
  const seconds = useCountdown(reset);
  return <>{seconds > 0 ? `${seconds}s` : "now"}</>;
}

function ResultCard({ result, waiting }: { result: Result | null; waiting: boolean }) {
  const hasStatus = result?.kind === "limit";
  const data = result?.kind === "limit" ? result.data : null;
  const remaining = result?.kind === "remaining" ? result.data : null;

  const success = data?.success ?? null;
  const reset = data?.reset ?? remaining?.reset;

  return (
    <>
      <div className="mb-4 flex h-5 items-center gap-2">
        {waiting ? (
          <>
            <span className="inline-block h-3 w-3 rounded-full bg-orange-500" />
            <span className="font-medium text-black dark:text-zinc-50">Waiting…</span>
          </>
        ) : (
          hasStatus && (
            <>
              <span
                className={`inline-block h-3 w-3 rounded-full ${success ? "bg-green-500" : "bg-red-500"}`}
              />
              <span className="font-medium text-black dark:text-zinc-50">
                {success ? "Allowed" : "Rate limited"}
              </span>
            </>
          )
        )}
      </div>
      <dl className="grid grid-cols-2 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
        <dt>Limit</dt>
        <dd className="text-right font-mono">{data?.limit ?? "—"}</dd>
        <dt>Remaining</dt>
        <dd className="text-right font-mono">{data?.remaining ?? remaining?.remaining ?? "—"}</dd>
        <dt>Reset</dt>
        <dd className="text-right font-mono">{reset ? <ResetCountdown reset={reset} /> : "—"}</dd>
      </dl>
    </>
  );
}

export default function Home() {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy>("fixed-window");

  const active = strategies.find((s) => s.value === strategy)!;

  function run(action: string, fn: () => Promise<void>) {
    setActiveAction(action);
    startTransition(async () => {
      await fn();
      setActiveAction(null);
    });
  }

  const loading = isPending && activeAction;

  const btnBase =
    "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80 disabled:opacity-50";
  const iconSize = 16;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-2xl flex-col items-center gap-8 p-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
            pg-ratelimit demo
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{active.description}</p>
        </div>

        <select
          value={strategy}
          onChange={(e) => {
            setStrategy(e.target.value as Strategy);
            setResult(null);
          }}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        >
          {strategies.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <div className="flex flex-wrap justify-center gap-2">
          <button
            onClick={() =>
              run("send", async () =>
                setResult({ kind: "limit", data: await sendRequest(strategy) }),
              )
            }
            disabled={isPending}
            className={`${btnBase} bg-black text-white dark:bg-white dark:text-black`}
          >
            {loading === "send" ? (
              <Loader2 size={iconSize} className="animate-spin" />
            ) : (
              <Send size={iconSize} />
            )}
            Send Request
          </button>
          <button
            onClick={() =>
              run("peek", async () =>
                setResult({ kind: "remaining", data: await peekRemaining(strategy) }),
              )
            }
            disabled={isPending}
            className={`${btnBase} border border-zinc-300 text-black dark:border-zinc-700 dark:text-zinc-50`}
          >
            {loading === "peek" ? (
              <Loader2 size={iconSize} className="animate-spin" />
            ) : (
              <Eye size={iconSize} />
            )}
            Peek Remaining
          </button>
          <button
            onClick={() =>
              run("wait", async () =>
                setResult({ kind: "limit", data: await waitAndSend(strategy) }),
              )
            }
            disabled={isPending}
            className={`${btnBase} border border-zinc-300 text-black dark:border-zinc-700 dark:text-zinc-50`}
          >
            {loading === "wait" ? (
              <Loader2 size={iconSize} className="animate-spin" />
            ) : (
              <Hourglass size={iconSize} />
            )}
            Wait & Send
          </button>
        </div>

        <div className="w-full rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <ResultCard result={result} waiting={loading === "wait"} />
        </div>
      </main>
    </div>
  );
}
