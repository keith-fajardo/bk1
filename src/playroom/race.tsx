import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PetState } from '../pet';
import type { PlayroomSidecar } from './sidecar';
import { encodeMessage, parseGameMessage } from './messages';

const TRACK_LEN = 40;

type Phase =
  | { kind: 'ready'; selfReady: boolean; peerReady: boolean }
  | { kind: 'countdown'; count: 3 | 2 | 1 | 0 }
  | { kind: 'racing'; selfCol: number; peerCol: number; startedAt: number }
  | {
      kind: 'finished';
      selfCol: number;
      peerCol: number;
      selfTime: number | null;
      peerTime: number | null;
    };

interface Props {
  pet: PetState;
  peerPet: PetState;
  sidecar: PlayroomSidecar;
  onExit: () => void;
}

export function Race({ pet, peerPet, sidecar, onExit }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ready', selfReady: false, peerReady: false });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Apply a phase update via a transform — used by both keyboard handlers and
  // message handlers so the most recent phase is always the source of truth.
  const updatePhase = (fn: (p: Phase) => Phase) => {
    setPhase(prev => {
      const next = fn(prev);
      phaseRef.current = next;
      return next;
    });
  };

  // Helper: transition into countdown when both peers report ready.
  const maybeStartCountdown = () => {
    const p = phaseRef.current;
    if (p.kind !== 'ready') return;
    if (!p.selfReady || !p.peerReady) return;
    setPhase({ kind: 'countdown', count: 3 });
  };

  // Countdown timer — fires once per second while in countdown phase.
  useEffect(() => {
    if (phase.kind !== 'countdown') return;
    const id = setTimeout(() => {
      updatePhase(p => {
        if (p.kind !== 'countdown') return p;
        if (p.count <= 0) {
          return { kind: 'racing', selfCol: 0, peerCol: 0, startedAt: Date.now() };
        }
        return { kind: 'countdown', count: (p.count - 1) as 3 | 2 | 1 | 0 };
      });
    }, 1000);
    return () => clearTimeout(id);
  }, [phase]);

  // Subscribe to peer messages once. The handler reads phaseRef so stale
  // closures aren't an issue.
  useEffect(() => {
    const offMessage = sidecar.on('peer_message', ({ line }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'race_quit') { onExit(); return; }
      if (msg.type === 'race_ready') {
        updatePhase(p => p.kind === 'ready' ? { ...p, peerReady: true } : p);
        // Defer the countdown trigger so updatePhase has committed.
        queueMicrotask(maybeStartCountdown);
        return;
      }
      if (msg.type === 'race_position') {
        updatePhase(p => {
          if (p.kind === 'racing') return { ...p, peerCol: Math.min(TRACK_LEN, msg.col) };
          if (p.kind === 'finished') return { ...p, peerCol: Math.min(TRACK_LEN, msg.col) };
          return p;
        });
        return;
      }
      if (msg.type === 'race_finished') {
        updatePhase(p => {
          if (p.kind === 'racing') {
            return {
              kind: 'finished',
              selfCol: p.selfCol,
              peerCol: TRACK_LEN,
              selfTime: null,
              peerTime: msg.elapsed_ms,
            };
          }
          if (p.kind === 'finished' && p.peerTime === null) {
            return { ...p, peerCol: TRACK_LEN, peerTime: msg.elapsed_ms };
          }
          return p;
        });
        return;
      }
    });
    return () => {
      offMessage();
      sidecar.send(encodeMessage({ type: 'race_quit' })).catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    if (phase.kind === 'ready') {
      if (key.return && !phase.selfReady) {
        sidecar.send(encodeMessage({ type: 'race_ready' })).catch(() => {});
        updatePhase(p => p.kind === 'ready' ? { ...p, selfReady: true } : p);
        queueMicrotask(maybeStartCountdown);
      }
      return;
    }
    if (phase.kind === 'racing') {
      // Any printable key (no modifiers) advances by 1 column. Space is the
      // documented one; the mockup says "mash [space]". Accepting any keystroke
      // makes it forgiving on slightly differently-mapped keyboards.
      if (key.ctrl || key.meta) return;
      if (!input && !key.return) return;
      const nextSelf = Math.min(TRACK_LEN, phase.selfCol + 1);
      sidecar.send(encodeMessage({ type: 'race_position', col: nextSelf })).catch(() => {});
      if (nextSelf >= TRACK_LEN) {
        const elapsed = Date.now() - phase.startedAt;
        sidecar.send(encodeMessage({ type: 'race_finished', elapsed_ms: elapsed })).catch(() => {});
        updatePhase(p => {
          if (p.kind === 'racing') {
            return {
              kind: 'finished',
              selfCol: TRACK_LEN,
              peerCol: p.peerCol,
              selfTime: elapsed,
              peerTime: null,
            };
          }
          return p;
        });
      } else {
        updatePhase(p => p.kind === 'racing' ? { ...p, selfCol: nextSelf } : p);
      }
      return;
    }
    if (phase.kind === 'finished' && key.return) {
      onExit();
    }
  });

  const headerStatus = headerFor(phase);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color="cyan" bold>race</Text>
        <Box flexGrow={1} />
        <Text color="gray">{headerStatus}</Text>
      </Box>

      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={14}>
        <Body phase={phase} pet={pet} peerPet={peerPet} />
      </Box>

      <Box paddingX={1}>
        <Text color="gray">esc  {phase.kind === 'finished' ? 'return to playroom' : 'quit race'}</Text>
      </Box>
    </Box>
  );
}

function headerFor(phase: Phase): string {
  switch (phase.kind) {
    case 'ready':     return 'ready?';
    case 'countdown': return phase.count === 0 ? 'go!' : `${phase.count}...`;
    case 'racing':    return 'go!';
    case 'finished':  return 'finished';
  }
}

function Body({ phase, pet, peerPet }: { phase: Phase; pet: PetState; peerPet: PetState }) {
  const yourName = pet.name ?? 'motchi';
  const peerName = peerPet.name ?? 'friend';

  if (phase.kind === 'ready') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row"><Text>you      {yourName.padEnd(10)} </Text><Text color={phase.selfReady ? 'green' : 'gray'}>{phase.selfReady ? '✓ ready' : '· waiting'}</Text></Box>
        <Box flexDirection="row"><Text>friend   {peerName.padEnd(10)} </Text><Text color={phase.peerReady ? 'green' : 'gray'}>{phase.peerReady ? '✓ ready' : '· waiting'}</Text></Box>
        <Text> </Text>
        <Text> </Text>
        <Text color="gray">press [↵] when ready to start</Text>
      </Box>
    );
  }

  if (phase.kind === 'countdown') {
    return (
      <Box flexDirection="column">
        <TrackLine name={yourName} col={0} side="me" />
        <Text> </Text>
        <TrackLine name={peerName} col={0} side="you" />
        <Text> </Text>
        <Text> </Text>
        <Text bold color="cyan">           get ready... {phase.count === 0 ? 'GO!' : phase.count}</Text>
      </Box>
    );
  }

  if (phase.kind === 'racing') {
    return (
      <Box flexDirection="column">
        <TrackLine name={yourName} col={phase.selfCol} side="me" />
        <Text> </Text>
        <TrackLine name={peerName} col={phase.peerCol} side="you" />
        <Text> </Text>
        <Text> </Text>
        <Text color="gray">mash any key to run  ({phase.selfCol}/{TRACK_LEN})</Text>
      </Box>
    );
  }

  // finished
  const result = finishResult(phase);
  return (
    <Box flexDirection="column">
      <TrackLine name={yourName} col={phase.selfCol} side="me" finished={phase.selfTime !== null} time={phase.selfTime} winner={result === 'me'} />
      <Text> </Text>
      <TrackLine name={peerName} col={phase.peerCol} side="you" finished={phase.peerTime !== null} time={phase.peerTime} winner={result === 'you'} />
      <Text> </Text>
      <Text> </Text>
      <Text bold color={result === 'me' ? 'green' : result === 'you' ? 'red' : 'gray'}>{resultCopy(result, phase, yourName, peerName)}</Text>
      <Text> </Text>
      <Text color="gray">press ↵ to return to playroom</Text>
    </Box>
  );
}

function finishResult(p: Extract<Phase, { kind: 'finished' }>): 'me' | 'you' | 'tie' | 'pending' {
  if (p.selfTime === null && p.peerTime === null) return 'pending';
  if (p.selfTime !== null && p.peerTime === null) return 'me';
  if (p.selfTime === null && p.peerTime !== null) return 'you';
  // Both finished: compare times. Lower wins. Equal is a tie (rare).
  if (p.selfTime! < p.peerTime!) return 'me';
  if (p.peerTime! < p.selfTime!) return 'you';
  return 'tie';
}

function resultCopy(
  result: 'me' | 'you' | 'tie' | 'pending',
  phase: Extract<Phase, { kind: 'finished' }>,
  yourName: string,
  peerName: string,
): string {
  if (result === 'pending') return 'waiting for finish...';
  if (result === 'tie') return 'photo finish — dead heat!';
  const sTime = phase.selfTime;
  const pTime = phase.peerTime;
  if (result === 'me') {
    if (sTime !== null && pTime !== null) {
      const margin = ((pTime - sTime) / 1000).toFixed(1);
      return `${yourName} wins by ${margin}s`;
    }
    return `${yourName} crossed first — waiting for ${peerName}...`;
  }
  // you
  if (sTime !== null && pTime !== null) {
    const margin = ((sTime - pTime) / 1000).toFixed(1);
    return `${peerName} wins by ${margin}s`;
  }
  return `${peerName} crossed first — keep going!`;
}

function TrackLine({
  name, col, side, finished, time, winner,
}: {
  name: string;
  col: number;
  side: 'me' | 'you';
  finished?: boolean;
  time?: number | null;
  winner?: boolean;
}) {
  // Track: name token at column `col`, dots elsewhere, finish line at far right.
  // Compact representation chosen so two parallel tracks fit on screen in any
  // reasonable terminal width.
  const tokenLeft = '·'.repeat(col);
  const tokenRight = '·'.repeat(Math.max(0, TRACK_LEN - col));
  const token = finished ? '⚑' : '→';
  const label = side === 'me' ? 'you' : 'friend';
  const timeStr = time !== null && time !== undefined ? `${(time / 1000).toFixed(1)}s` : '';
  return (
    <Box flexDirection="row">
      <Text>{label.padEnd(8)}</Text>
      <Text color="gray">{tokenLeft}</Text>
      <Text color={winner ? 'green' : 'cyan'}>{token}</Text>
      <Text color="gray">{tokenRight}</Text>
      <Text>|</Text>
      <Text>  {timeStr}{winner ? ' ★' : ''}</Text>
    </Box>
  );
}
