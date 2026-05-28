import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PetSpriteLine } from '../app';
import { petSprite, petSpriteHappy, petSpriteSad, type PetState } from '../pet';
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
  // Mirrors Jakenpoy. Used only when BOTH runners have finished (natural end)
  // so each side dismisses its own 'finished' screen without yanking the peer.
  // Forfeit paths (esc mid-race, esc while opponent still racing) still go
  // through onExit which broadcasts game_ended as before.
  onMatchDismiss?: () => void;
}

export function Race({ pet, peerPet, sidecar, onExit, onMatchDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ready', selfReady: false, peerReady: false });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // True once BOTH selfTime and peerTime are known — i.e. the race fully
  // resolved on its own. When true, the unmount cleanup skips race_quit so
  // we don't trip the peer's race_quit handler (which calls their onExit and
  // kicks them to the lobby off their own finish screen). If a player esc's
  // while their peer is still racing this stays false → cleanup broadcasts
  // race_quit → peer is yanked out, same as today.
  const matchEndedRef = useRef(false);

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

  // Watch for the "both finished" transition and flip the natural-end flag.
  // Once true, the cleanup skips race_quit and the Enter-at-finished handler
  // can dismiss silently. We never flip it back — once the race is over, it's
  // over.
  useEffect(() => {
    if (phase.kind === 'finished' && phase.selfTime !== null && phase.peerTime !== null) {
      matchEndedRef.current = true;
    }
  }, [phase]);

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
      // Forfeit signal — skipped on natural race-end (both times known) so
      // each side can dismiss independently. Same pattern as Jakenpoy.
      if (!matchEndedRef.current) {
        sidecar.send(encodeMessage({ type: 'race_quit' })).catch(() => {});
      }
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
      // Natural end (both finished) → silent dismiss. Otherwise, the local
      // user is dismissing while the peer is still mid-race; treat as forfeit
      // so the peer gets cleaned up too (existing behavior).
      const naturalEnd = phase.selfTime !== null && phase.peerTime !== null;
      (naturalEnd ? (onMatchDismiss ?? onExit) : onExit)();
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
      <FinishedSprites pet={pet} peerPet={peerPet} result={result} yourName={yourName} peerName={peerName} />
      <Text> </Text>
      <TrackLine name={yourName} col={phase.selfCol} side="me" finished={phase.selfTime !== null} time={phase.selfTime} winner={result === 'me'} />
      <Text> </Text>
      <TrackLine name={peerName} col={phase.peerCol} side="you" finished={phase.peerTime !== null} time={phase.peerTime} winner={result === 'you'} />
      <Text> </Text>
      <Text bold color={result === 'me' ? 'green' : result === 'you' ? 'red' : 'gray'}>{resultCopy(result, phase, yourName, peerName)}</Text>
      <Text> </Text>
      <Text color="gray">press ↵ to return to playroom</Text>
    </Box>
  );
}

// Side-by-side pet sprites for the finished screen. Winner gets the happy
// sprite, loser the sad one. Ties / "pending" (one still racing) leave both
// neutral so we don't telegraph an outcome that isn't settled yet. Only
// rendered in 'finished' phase — no sprites during racing, where the
// dotted-track UI is the focus.
function FinishedSprites({
  pet, peerPet, result, yourName, peerName,
}: {
  pet: PetState;
  peerPet: PetState;
  result: 'me' | 'you' | 'tie' | 'pending';
  yourName: string;
  peerName: string;
}) {
  const myMood: 'happy' | 'sad' | 'neutral' =
    result === 'me'  ? 'happy' :
    result === 'you' ? 'sad'   : 'neutral';
  const theirMood: 'happy' | 'sad' | 'neutral' =
    result === 'you' ? 'happy' :
    result === 'me'  ? 'sad'   : 'neutral';
  const spriteFor = (p: PetState, m: 'happy' | 'sad' | 'neutral') =>
    m === 'happy' ? petSpriteHappy(p)
    : m === 'sad' ? petSpriteSad(p)
    : petSprite(p);
  const mineSprite = spriteFor(pet, myMood);
  const peerSprite = spriteFor(peerPet, theirMood);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={22}>
        <Text>you{result === 'me' ? ' ★' : ''}</Text>
        <Text> </Text>
        {mineSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
        <Text>{yourName}</Text>
      </Box>
      <Box flexDirection="column" width={22}>
        <Text>friend{result === 'you' ? ' ★' : ''}</Text>
        <Text> </Text>
        {peerSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
        <Text>{peerName}</Text>
      </Box>
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
