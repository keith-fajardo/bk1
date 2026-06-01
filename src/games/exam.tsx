import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { GameProps } from './types';
import { EXAM_QUESTIONS, type ExamQuestion } from './exam-questions';

// dbt Certification quiz mini-game.
//
//   5 questions, sampled randomly from EXAM_QUESTIONS at game start.
//   5-second timer per question.
//   Timer expiry → auto-mark wrong + advance (no pause).
//   Score = correct count out of 5.
//   Perfect (5/5)         → +10 coins
//   Anything less than 5  → −20 coins
//
// User picks an answer with the number keys 1-4 (or arrow + Enter). Esc
// exits early with whatever coins delta the answered subset would imply —
// a forfeit is treated like getting the remaining questions wrong, which
// is always a -20 outcome (unless you somehow had 5/5 already, which is
// only possible if you Esc *after* the last answer, in which case the
// reward already landed via the normal end-of-game path).

const HEADER_FG    = '#B9FECF';
const DIM_FG       = '#3D6650';
const QUESTION_FG  = '#C0FAD2';
const OPTION_FG    = '#5A8060';
const OPTION_HOT   = '#B9FECF';
const CORRECT_FG   = '#4ADE80';
const WRONG_FG     = '#F87171';
const TIMER_OK_FG  = '#A8DFBE';
const TIMER_HOT_FG = '#FCD34D';
const TIMER_PANIC  = '#F87171';

const QUESTION_COUNT      = 5;
const SECONDS_PER_QUESTION = 5;
const TICK_MS             = 100;        // sub-second redraw so the timer ticks smoothly

const PERFECT_REWARD = +10;
const FAIL_PENALTY   = -20;

interface AnswerLog {
  question: ExamQuestion;
  picked: number | null;  // null = timed out
  correct: boolean;
}

// Fisher-Yates — pick `n` unique items from `pool` without modifying it.
function sampleN<T>(pool: T[], n: number): T[] {
  const copy = pool.slice();
  const out: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]!);
  }
  return out;
}

export function ExamGame({ pet, onExit }: GameProps) {
  // Sampled once at mount via lazy state — re-renders never reshuffle.
  const [questions] = useState<ExamQuestion[]>(() => sampleN(EXAM_QUESTIONS, QUESTION_COUNT));
  const [qIdx, setQIdx]               = useState(0);
  const [selectedOpt, setSelectedOpt] = useState(0);
  const [answers, setAnswers]         = useState<AnswerLog[]>([]);
  const [finished, setFinished]       = useState(false);
  // Question start time — used to drive the per-question countdown. Reset
  // whenever the question advances so the timer always shows full 5s on a
  // new question.
  const [qStartMs, setQStartMs]       = useState(() => Date.now());
  const [, setRedraw]                 = useState(0);  // forces re-render every TICK_MS

  const current = questions[qIdx];

  // Single source of truth for "advance with this answer." Wraps the state
  // update so the timer + key handlers both go through the same flow.
  const finalizeAnswer = (picked: number | null) => {
    if (!current) return;
    const correct = picked === current.answer;
    const nextAnswers = [...answers, { question: current, picked, correct }];
    setAnswers(nextAnswers);
    if (qIdx + 1 >= questions.length) {
      setFinished(true);
    } else {
      setQIdx(i => i + 1);
      setSelectedOpt(0);
      setQStartMs(Date.now());
    }
  };

  // Capture the latest finalizeAnswer closure for the timer interval. Without
  // a ref the interval would close over a stale `answers`/`qIdx` and double-
  // advance on timeout.
  const finalizeRef = useRef(finalizeAnswer);
  finalizeRef.current = finalizeAnswer;

  // Timer + redraw tick. Only runs while a question is active (not finished
  // and `current` exists). Auto-advances on timeout via finalizeRef.
  useEffect(() => {
    if (finished || !current) return;
    const id = setInterval(() => {
      setRedraw(r => (r + 1) % 1_000_000);
      const elapsedMs = Date.now() - qStartMs;
      if (elapsedMs >= SECONDS_PER_QUESTION * 1000) {
        finalizeRef.current(null);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [finished, current, qStartMs]);

  useInput((input, key) => {
    // Ctrl+C exits the whole app, matching app.tsx's global handler. The game's
    // useInput shadows that handler while mounted, and the extension's xterm.js
    // never raises the SIGINT that used to be the only exit path, so this line
    // is what makes Ctrl+C work here under the extension.
    if (key.ctrl && input === 'c') process.exit(0);
    if (finished) {
      // Any key on the results screen exits.
      const score   = answers.filter(a => a.correct).length;
      const coins   = score === QUESTION_COUNT ? PERFECT_REWARD : FAIL_PENALTY;
      onExit({ coins });
      return;
    }
    if (key.escape) {
      // Early exit = forfeit. Treated as failed unless the user happened to
      // get a perfect run before pressing Esc on the results screen (handled
      // in the `finished` branch above).
      onExit({ coins: FAIL_PENALTY });
      return;
    }
    if (!current) return;
    // Arrow navigation of options
    if (key.upArrow)   { setSelectedOpt(i => (i - 1 + current.options.length) % current.options.length); return; }
    if (key.downArrow) { setSelectedOpt(i => (i + 1) % current.options.length); return; }
    // Number-key direct pick (1-4)
    const n = parseInt(input, 10);
    if (!isNaN(n) && n >= 1 && n <= current.options.length) {
      finalizeAnswer(n - 1);
      return;
    }
    if (key.return) {
      finalizeAnswer(selectedOpt);
    }
  });

  // ── Results screen ────────────────────────────────────────────────────
  if (finished) {
    const score   = answers.filter(a => a.correct).length;
    const perfect = score === QUESTION_COUNT;
    const coins   = perfect ? PERFECT_REWARD : FAIL_PENALTY;
    const label   = pet.name ?? 'your pet';
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
        <Text color={HEADER_FG} bold>exam · results</Text>
        <Box flexDirection="column">
          <Text color={QUESTION_FG}>
            {label} scored <Text color={perfect ? CORRECT_FG : WRONG_FG} bold>{score} / {QUESTION_COUNT}</Text>
            {perfect ? '  🎉' : ''}
          </Text>
          <Text color={coins > 0 ? CORRECT_FG : WRONG_FG} bold>
            {coins > 0 ? `+${coins}` : coins} 💰 
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {answers.map((a, i) => (
            <Box key={i} flexDirection="column" marginBottom={1}>
              <Text color={a.correct ? CORRECT_FG : WRONG_FG}>
                {a.correct ? '✓' : '✗'} Q{i + 1}. {a.question.question}
              </Text>
              {!a.correct && (
                <Text color={DIM_FG}>
                  Correct: <Text color={CORRECT_FG}>{a.question.options[a.question.answer]}</Text>
                  {a.picked !== null && (
                    <Text> · Your answer: <Text color={WRONG_FG}>{a.question.options[a.picked]}</Text></Text>
                  )}
                  {a.picked === null && <Text> · <Text color={WRONG_FG}>(timed out)</Text></Text>}
                </Text>
              )}
            </Box>
          ))}
        </Box>
        <Text color={DIM_FG}>Press any key to exit.</Text>
      </Box>
    );
  }

  // ── Active question ───────────────────────────────────────────────────
  if (!current) return null;  // unreachable; satisfies TS in case sampleN returned empty
  const elapsedMs       = Date.now() - qStartMs;
  const remainingMs     = Math.max(0, SECONDS_PER_QUESTION * 1000 - elapsedMs);
  const remainingTenths = Math.ceil(remainingMs / 100) / 10;  // e.g. 4.3, 4.2, 4.1 …
  const timerColor =
    remainingMs > 3000 ? TIMER_OK_FG :
    remainingMs > 1500 ? TIMER_HOT_FG :
                         TIMER_PANIC;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
      <Box justifyContent="space-between">
        <Text color={HEADER_FG} bold>exam · dbt certification</Text>
        <Box gap={2}>
          <Text color={DIM_FG}>Q {qIdx + 1} / {QUESTION_COUNT}</Text>
          <Text color={timerColor} bold>⏱ {remainingTenths.toFixed(1)}s</Text>
        </Box>
      </Box>
      <Text color={QUESTION_FG} bold>{current.question}</Text>
      <Box flexDirection="column">
        {current.options.map((opt, i) => {
          const active = i === selectedOpt;
          return (
            <Box key={i} gap={1}>
              <Text color={active ? OPTION_HOT : OPTION_FG} bold={active}>
                {active ? '▶' : ' '} {i + 1}. {opt}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color={DIM_FG}>↑↓ navigate · 1-4 pick · Enter confirm · Esc forfeit</Text>
    </Box>
  );
}
