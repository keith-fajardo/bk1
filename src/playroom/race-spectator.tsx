// View-only race for spectators. Tracks both players' positions independently
// via the `from` field on relayed race_position / race_finished messages.
// No input beyond `esc` — the local game state is read-only.

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PetState } from '../pet';
import type { PlayroomSidecar } from './sidecar';
import { parseGameMessage } from './messages';

const TRACK_LEN = 60;             // must match race.tsx (steeplechase rendering)
const TRACK_METERS = 3000;
const METERS_PER_CELL = TRACK_METERS / TRACK_LEN;
const HURDLE_POSITIONS: ReadonlySet<number> = new Set([10, 20, 30, 40, 50]);

interface State {
  hostCol: number;
  joinerCol: number;
  hostReady: boolean;
  joinerReady: boolean;
  hostFinish: number | null;   // elapsed_ms; null until they cross
  joinerFinish: number | null;
}

const INITIAL: State = {
  hostCol: 0, joinerCol: 0,
  hostReady: false, joinerReady: false,
  hostFinish: null, joinerFinish: null,
};

interface Props {
  hostPet: PetState | null;
  joinerPet: PetState | null;
  sidecar: PlayroomSidecar;
  onExit: () => void;
}

export function RaceSpectator({ hostPet, joinerPet, sidecar, onExit }: Props) {
  const [state, setState] = useState<State>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;

  useInput((input, key) => {
    if (key.ctrl && input === 'c') process.exit(0);
    if (key.escape) onExit();
  });

  useEffect(() => {
    const off = sidecar.on('peer_message', ({ line, from }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (from !== 'host' && from !== 'joiner') return;

      const isHost = from === 'host';
      const cur = stateRef.current;

      if (msg.type === 'race_ready') {
        const next = isHost
          ? { ...cur, hostReady: true }
          : { ...cur, joinerReady: true };
        setState(next);
        stateRef.current = next;
        return;
      }
      if (msg.type === 'race_position') {
        const col = Math.min(TRACK_LEN, msg.col);
        const next = isHost
          ? { ...cur, hostCol: col }
          : { ...cur, joinerCol: col };
        setState(next);
        stateRef.current = next;
        return;
      }
      if (msg.type === 'race_finished') {
        const next = isHost
          ? { ...cur, hostCol: TRACK_LEN, hostFinish: msg.elapsed_ms }
          : { ...cur, joinerCol: TRACK_LEN, joinerFinish: msg.elapsed_ms };
        setState(next);
        stateRef.current = next;
        return;
      }
      // race_quit handled at lobby level via game_ended.
    });
    return off;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hostName   = hostPet?.name   ?? 'host';
  const joinerName = joinerPet?.name ?? 'joiner';
  const bothDone   = state.hostFinish !== null && state.joinerFinish !== null;
  const someDone   = state.hostFinish !== null || state.joinerFinish !== null;
  const headerStatus =
    bothDone           ? 'finished' :
    someDone           ? 'someone crossed' :
    state.hostReady && state.joinerReady ? 'go!' :
    'getting ready';

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color="cyan" bold>steeplechase</Text>
        <Box flexGrow={1} />
        <Text color="gray">spectating · {headerStatus}</Text>
      </Box>

      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={14}>
        <TrackLine name={hostName}   col={state.hostCol}   finished={state.hostFinish}   ready={state.hostReady}   />
        <Text> </Text>
        <TrackLine name={joinerName} col={state.joinerCol} finished={state.joinerFinish} ready={state.joinerReady} />
        <Text> </Text>
        <Text> </Text>
        <Status state={state} hostName={hostName} joinerName={joinerName} />
      </Box>

      <Box paddingX={1}>
        <Text color="gray">esc  leave game</Text>
      </Box>
    </Box>
  );
}

function Status({ state, hostName, joinerName }: { state: State; hostName: string; joinerName: string }) {
  if (state.hostFinish !== null && state.joinerFinish !== null) {
    const margin = Math.abs(state.hostFinish - state.joinerFinish) / 1000;
    if (state.hostFinish < state.joinerFinish) return <Text color="green">{hostName} wins by {margin.toFixed(1)}s</Text>;
    if (state.joinerFinish < state.hostFinish) return <Text color="green">{joinerName} wins by {margin.toFixed(1)}s</Text>;
    return <Text color="gray">photo finish — dead heat!</Text>;
  }
  if (state.hostFinish !== null)   return <Text color="gray">{hostName} crossed — waiting for {joinerName}...</Text>;
  if (state.joinerFinish !== null) return <Text color="gray">{joinerName} crossed — waiting for {hostName}...</Text>;
  if (!state.hostReady || !state.joinerReady) {
    return <Text color="gray">{[
      state.hostReady   ? `${hostName} ready`   : `${hostName} waiting`,
      state.joinerReady ? `${joinerName} ready` : `${joinerName} waiting`,
    ].join(' · ')}</Text>;
  }
  return <Text color="gray">race in progress...</Text>;
}

function TrackLine({
  name, col, finished, ready,
}: {
  name: string; col: number; finished: number | null; ready: boolean;
}) {
  // Per-cell composition with hurdles, run-length compressed (avoids the
  // Yoga node-count crash that hits with too many sibling <Text> nodes).
  const cells: { ch: string; color: string }[] = [];
  for (let i = 0; i < TRACK_LEN; i++) {
    if (i === col) {
      cells.push({ ch: finished !== null ? '⚑' : '→', color: 'cyan' });
    } else if (HURDLE_POSITIONS.has(i)) {
      cells.push({ ch: '▮', color: 'yellow' });
    } else {
      cells.push({ ch: '·', color: 'gray' });
    }
  }
  const runs: { color: string; text: string }[] = [];
  for (const c of cells) {
    const last = runs[runs.length - 1];
    if (last && last.color === c.color) last.text += c.ch;
    else runs.push({ color: c.color, text: c.ch });
  }
  const timeStr = finished !== null ? `${(finished / 1000).toFixed(1)}s` : (ready ? 'ready' : '');
  const meters = Math.min(TRACK_METERS, Math.round(col * METERS_PER_CELL));
  return (
    <Box flexDirection="row">
      <Text>{name.padEnd(10)}</Text>
      {runs.map((r, i) => <Text key={i} color={r.color}>{r.text}</Text>)}
      <Text>|</Text>
      <Text>  {timeStr || `${meters}m`}</Text>
    </Box>
  );
}
