import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PetSpriteLine } from './pet-sprite-line';
import { petSprite, petSpriteHappy, petSpriteSad, type PetState } from '../pet';
import type { PlayroomSidecar } from './sidecar';
import {
  encodeMessage,
  parseGameMessage,
  jakenpoyWinner,
  type JakenpoyChoice,
} from './messages';

const WIN_AT = 2; // best of 3 → first to 2

// Picker option order chosen by user — Papel first, then Gunting, then Bato.
// The arrow-key cursor cycles within this array; Enter locks in.
//
// Emoji glyphs live in PICKER_OPTIONS but are only rendered in the picker
// (wrapped in a fixed-width Box — see PickerRow below). Other surfaces
// (fighter labels, reveal verdicts, match-over recap) use the plain text
// label because the earlier version of those surfaces inlined the emoji
// into a single <Text> string and crashed Yoga's WASM layout engine with
// "Out of bounds memory access" on multi-codepoint glyphs (✂️ in particular).
const PICKER_OPTIONS: { id: JakenpoyChoice; emoji: string; label: string }[] = [
  { id: 'papel',   emoji: '📄', label: 'Papel'   },
  { id: 'gunting', emoji: '✂️',  label: 'Gunting' },
  { id: 'bato',    emoji: '🪨', label: 'Bato'    },
];

function choiceLabel(c: JakenpoyChoice): string {
  const o = PICKER_OPTIONS.find(o => o.id === c);
  return o ? o.label : c;
}

// Verdict line for the reveal screen. Pure helper.
function prettyVerdict(winner: JakenpoyChoice, loser: JakenpoyChoice): string {
  if (winner === 'bato'    && loser === 'gunting') return `${choiceLabel('bato')} dulls ${choiceLabel('gunting')}`;
  if (winner === 'gunting' && loser === 'papel'  ) return `${choiceLabel('gunting')} cuts ${choiceLabel('papel')}`;
  if (winner === 'papel'   && loser === 'bato'   ) return `${choiceLabel('papel')} wraps ${choiceLabel('bato')}`;
  return '';
}

type Phase =
  | { kind: 'choosing' }
  | { kind: 'reveal'; mine: JakenpoyChoice; theirs: JakenpoyChoice }
  | { kind: 'match_over'; mine: JakenpoyChoice; theirs: JakenpoyChoice };

interface Props {
  pet: PetState;
  peerPet: PetState;
  sidecar: PlayroomSidecar;
  onExit: () => void;
  // Optional dismissal handler for the natural match-end path (Enter at
  // match_over). Caller wires it to a NON-broadcasting exit so each side
  // dismisses its own match_over screen independently without yanking the
  // peer off theirs. Falls back to onExit if not provided.
  onMatchDismiss?: () => void;
}

export function Jakenpoy({ pet, peerPet, sidecar, onExit, onMatchDismiss }: Props) {
  const [round, setRound] = useState(1);
  const [score, setScore] = useState({ me: 0, you: 0 });
  const [phase, setPhase] = useState<Phase>({ kind: 'choosing' });
  const myChoiceRef = useRef<JakenpoyChoice | null>(null);
  const theirChoiceRef = useRef<JakenpoyChoice | null>(null);
  const [myChoiceDisplay, setMyChoiceDisplay] = useState<JakenpoyChoice | null>(null);
  const [theirLocked, setTheirLocked] = useState(false);
  // Picker cursor — index into PICKER_OPTIONS. Resets to 0 on each new round.
  const [pickerIdx, setPickerIdx] = useState(0);
  const roundRef = useRef(round);
  roundRef.current = round;
  // Buffer for the peer's choice when it arrives BEFORE we've advanced to
  // the same round. Without this, the peer-message handler dropped any
  // future-round choice on the floor and we'd deadlock waiting for the peer's
  // current-round choice — the symptom users hit at the round-2 transition.
  // When we advance past reveal, we drain this buffer if it matches the new round.
  const pendingPeerChoiceRef = useRef<{ round: number; choice: JakenpoyChoice } | null>(null);
  // Tracks whether the match ended naturally (someone reached WIN_AT). When
  // true, the unmount cleanup SKIPS broadcasting jakenpoy_quit — the peer
  // also reached match_over on their side and is dismissing independently,
  // so a forfeit signal would (a) be misleading and (b) trigger their
  // onExit/exitGame path and yank them off their own match_over screen.
  // Mid-match esc still goes through with matchEndedRef=false → broadcasts
  // as before, preserving the forfeit behavior.
  const matchEndedRef = useRef(false);
  // scoreRef tracks the same value as the `score` state. Critical: tryResolve
  // is captured by the useEffect([]) peer_message handler at mount time. If
  // we read `score` (the closure variable) inside tryResolve, the handler
  // sees the INITIAL render's score forever — {0,0} — and the next round's
  // setScore overwrites the running tally with "initial + just this round."
  // Reading scoreRef.current instead bypasses the stale closure entirely.
  const scoreRef = useRef(score);
  scoreRef.current = score;

  const tryResolve = () => {
    const mine = myChoiceRef.current;
    const theirs = theirChoiceRef.current;
    if (!mine || !theirs) return;
    const outcome = jakenpoyWinner(mine, theirs);
    const cur = scoreRef.current;
    let nextScore = cur;
    if (outcome === 'me')  nextScore = { ...cur, me:  cur.me  + 1 };
    if (outcome === 'you') nextScore = { ...cur, you: cur.you + 1 };
    if (outcome !== 'tie') {
      setScore(nextScore);
      // Also update the ref synchronously — otherwise a follow-up tryResolve
      // before the next render would still read the pre-update value.
      scoreRef.current = nextScore;
    }

    if (nextScore.me >= WIN_AT || nextScore.you >= WIN_AT) {
      matchEndedRef.current = true;
      setPhase({ kind: 'match_over', mine, theirs });
    } else {
      setPhase({ kind: 'reveal', mine, theirs });
    }
  };

  useEffect(() => {
    const offMessage = sidecar.on('peer_message', ({ line }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'jakenpoy_quit') {
        onExit();
        return;
      }
      if (msg.type === 'jakenpoy_choice') {
        // Stale (peer is somehow behind us) — drop.
        if (msg.round < roundRef.current) return;
        // Future round — peer has advanced before we have. Buffer the choice
        // so we can apply it when we catch up via reveal-Enter. Without this
        // the message is dropped and both sides deadlock.
        if (msg.round > roundRef.current) {
          pendingPeerChoiceRef.current = { round: msg.round, choice: msg.choice };
          return;
        }
        // Current round — apply now.
        theirChoiceRef.current = msg.choice;
        setTheirLocked(true);
        tryResolve();
      }
    });
    return () => {
      offMessage();
      // Forfeit signal — only when leaving mid-match. When the match ended
      // naturally on both sides (matchEndedRef set by tryResolve), we skip
      // this so the peer can dismiss their own match_over screen at their
      // own pace instead of being kicked out by the quit handler.
      if (!matchEndedRef.current) {
        sidecar.send(encodeMessage({ type: 'jakenpoy_quit' })).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') process.exit(0);
    if (key.escape) {
      onExit();
      return;
    }
    if (phase.kind === 'choosing') {
      if (myChoiceRef.current) return; // already locked
      if (key.upArrow) {
        setPickerIdx(i => (i - 1 + PICKER_OPTIONS.length) % PICKER_OPTIONS.length);
        return;
      }
      if (key.downArrow) {
        setPickerIdx(i => (i + 1) % PICKER_OPTIONS.length);
        return;
      }
      if (key.return) {
        const choice = PICKER_OPTIONS[pickerIdx]!.id;
        myChoiceRef.current = choice;
        setMyChoiceDisplay(choice);
        sidecar.send(encodeMessage({
          type: 'jakenpoy_choice',
          round: roundRef.current,
          choice,
        })).catch(() => {});
        tryResolve();
      }
      return;
    }
    if (phase.kind === 'reveal') {
      if (key.return) {
        // Tie: stay on same round number, just reset choices.
        const wasTie = phase.mine === phase.theirs;
        const newRound = wasTie ? roundRef.current : roundRef.current + 1;
        if (!wasTie) setRound(newRound);
        roundRef.current = newRound;
        myChoiceRef.current = null;
        theirChoiceRef.current = null;
        setMyChoiceDisplay(null);
        setTheirLocked(false);
        setPickerIdx(0);
        setPhase({ kind: 'choosing' });

        // Drain the buffer: if the peer already sent their choice for the
        // round we're now entering, apply it so we don't deadlock waiting
        // for a message that already arrived.
        const pending = pendingPeerChoiceRef.current;
        if (pending && pending.round === newRound) {
          pendingPeerChoiceRef.current = null;
          theirChoiceRef.current = pending.choice;
          setTheirLocked(true);
        }
      }
      return;
    }
    if (phase.kind === 'match_over') {
      if (key.return) (onMatchDismiss ?? onExit)();
    }
  });

  const roundLabel = phase.kind === 'match_over' ? 'match over' : `round ${round}/3 · best of 3`;
  const scoreLabel = `you ${score.me}  /  friend ${score.you}`;

  const iLost = phase.kind === 'match_over' && score.you > score.me;
  const youLost = phase.kind === 'match_over' && score.me > score.you;

  // Per-side facial expression for the current screen.
  //   reveal: this round's winner is happy, loser is sad, tie = neutral.
  //   match_over: overall winner happy, loser sad.
  //   choosing: neutral on both sides.
  // Drives FighterPair's sprite selection — sprite swaps in-place so neither
  // pet gets re-mounted between rounds (would flash and re-trigger animations).
  type Mood = 'happy' | 'sad' | 'neutral';
  let myMood: Mood = 'neutral';
  let theirMood: Mood = 'neutral';
  if (phase.kind === 'reveal') {
    const r = jakenpoyWinner(phase.mine, phase.theirs);
    if (r === 'me')  { myMood = 'happy'; theirMood = 'sad';   }
    if (r === 'you') { myMood = 'sad';   theirMood = 'happy'; }
  } else if (phase.kind === 'match_over') {
    if (score.me > score.you) { myMood = 'happy'; theirMood = 'sad';   }
    else                      { myMood = 'sad';   theirMood = 'happy'; }
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color="cyan" bold>jakenpoy</Text>
        <Box flexGrow={1} />
        <Text color="gray">{roundLabel}</Text>
      </Box>

      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={16}>
        {/* Persistent scoreboard so neither side has to guess the running tally. */}
        <Box>
          <Text color="gray">scoreboard:  </Text>
          <Text bold>{scoreLabel}</Text>
        </Box>

        <Text> </Text>

        <FighterPair
          pet={pet}
          peerPet={peerPet}
          mineLabel={fighterLabel(phase, 'me', myChoiceDisplay)}
          theirsLabel={fighterLabel(phase, 'you', theirLocked ? '?' : null)}
          iLost={iLost}
          youLost={youLost}
          myMood={myMood}
          theirMood={theirMood}
        />

        <Text> </Text>

        {phase.kind === 'choosing' && (
          <Box flexDirection="column">
            {/* Lock-in status for both sides. Updates the instant a choice is
                made locally OR an opponent's choice arrives over the wire, so
                you never wonder if you're waiting on them or they on you. */}
            <Box>
              <Text>you:    </Text>
              <Text color={myChoiceDisplay ? 'green' : 'gray'}>
                {myChoiceDisplay ? '✓ locked in' : '· still picking'}
              </Text>
            </Box>
            <Box>
              <Text>friend: </Text>
              <Text color={theirLocked ? 'green' : 'gray'}>
                {theirLocked ? '✓ locked in' : '· still picking'}
              </Text>
            </Box>
            <Text> </Text>
            {myChoiceDisplay ? (
              <Text color="gray">{theirLocked ? 'resolving round...' : 'waiting for friend to pick...'}</Text>
            ) : (
              <>
                <Text>pick:</Text>
                {PICKER_OPTIONS.map((opt, i) => {
                  const active = i === pickerIdx;
                  return (
                    <Box key={opt.id} flexDirection="row">
                      <Text color={active ? '#C0FAD2' : 'gray'}>{active ? '  > ' : '    '}</Text>
                      {/* Each emoji rendered in its own fixed-width Box. The
                          explicit width prevents Yoga from trying to measure
                          the emoji's intrinsic width — that measurement is
                          what crashed earlier. Width=4 leaves room for an
                          emoji (1-2 cells visually) plus 2 cells of padding
                          before the label. */}
                      <Box width={4}>
                        <Text>{opt.emoji}</Text>
                      </Box>
                      <Text color={active ? '#C0FAD2' : 'gray'} bold={active}>{opt.label}</Text>
                    </Box>
                  );
                })}
                <Text> </Text>
                <Text color="gray">  ↑↓ navigate · ↵ lock in</Text>
              </>
            )}
          </Box>
        )}

        {phase.kind === 'reveal' && (
          <RevealSummary mine={phase.mine} theirs={phase.theirs} score={score} />
        )}

        {phase.kind === 'match_over' && (
          <MatchOverSummary mine={phase.mine} theirs={phase.theirs} score={score} />
        )}
      </Box>

      <Box paddingX={1}>
        <Text color="gray">esc  {phase.kind === 'match_over' ? 'return to playroom' : 'quit match'}</Text>
      </Box>
    </Box>
  );
}

function fighterLabel(phase: Phase, side: 'me' | 'you', placeholder: JakenpoyChoice | '?' | null): string {
  if (phase.kind === 'reveal' || phase.kind === 'match_over') {
    return choiceLabel(side === 'me' ? phase.mine : phase.theirs);
  }
  if (placeholder === null) return '';
  if (placeholder === '?') return '?';
  return choiceLabel(placeholder);
}

function FighterPair({
  pet, peerPet, mineLabel, theirsLabel, iLost, youLost, myMood, theirMood,
}: {
  pet: PetState;
  peerPet: PetState;
  mineLabel: string;
  theirsLabel: string;
  iLost: boolean;
  youLost: boolean;
  myMood: 'happy' | 'sad' | 'neutral';
  theirMood: 'happy' | 'sad' | 'neutral';
}) {
  const spriteFor = (p: PetState, m: 'happy' | 'sad' | 'neutral') =>
    m === 'happy' ? petSpriteHappy(p)
    : m === 'sad' ? petSpriteSad(p)
    : petSprite(p);
  const mineSprite = spriteFor(pet, myMood);
  const peerSprite = spriteFor(peerPet, theirMood);
  const yourName = pet.name ?? 'motchi';
  const peerName = peerPet.name ?? 'friend';
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={22}>
        <Text>you{iLost ? ' (unggoy)' : youLost ? ' ★' : ''}</Text>
        <Text> </Text>
        <Box flexDirection="row">
          <Box flexDirection="column">
            {mineSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
          </Box>
          <Box marginLeft={2}><Text color={mineLabel ? 'cyan' : 'gray'}>{mineLabel || ' '}</Text></Box>
        </Box>
        <Text>{yourName}</Text>
      </Box>
      <Box flexDirection="column" width={22}>
        <Text>friend{youLost ? ' (unggoy)' : iLost ? ' ★' : ''}</Text>
        <Text> </Text>
        <Box flexDirection="row">
          <Box flexDirection="column">
            {peerSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
          </Box>
          <Box marginLeft={2}><Text color={theirsLabel === '?' ? 'gray' : theirsLabel ? 'cyan' : 'gray'}>{theirsLabel || ' '}</Text></Box>
        </Box>
        <Text>{peerName}</Text>
      </Box>
    </Box>
  );
}

function RevealSummary({ mine, theirs, score }: { mine: JakenpoyChoice; theirs: JakenpoyChoice; score: { me: number; you: number } }) {
  const outcome = jakenpoyWinner(mine, theirs);
  let headline: string;
  let sub: string;
  if (outcome === 'tie') {
    headline = `${choiceLabel(mine)} vs ${choiceLabel(theirs)} — tie`;
    sub = 'replay the round';
  } else if (outcome === 'me') {
    headline = prettyVerdict(mine, theirs);
    sub = 'you win this round';
  } else {
    headline = prettyVerdict(theirs, mine);
    sub = 'friend wins this round';
  }
  return (
    <Box flexDirection="column">
      <Text>{headline}</Text>
      <Text color={outcome === 'me' ? 'green' : outcome === 'you' ? 'red' : 'gray'}>{sub}</Text>
      <Text> </Text>
      <Text>you {score.me}  ·  friend {score.you}</Text>
      <Text> </Text>
      <Text color="gray">press ↵ to continue</Text>
    </Box>
  );
}

function MatchOverSummary({ mine, theirs, score }: { mine: JakenpoyChoice; theirs: JakenpoyChoice; score: { me: number; you: number } }) {
  const iWon = score.me > score.you;
  return (
    <Box flexDirection="column">
      <Text>{iWon ? `you win ${score.me}-${score.you}` : `friend wins ${score.you}-${score.me}`}</Text>
      <Text color="gray">sinong matalo, siyang unggoy</Text>
      <Text> </Text>
      <Text color="gray">final picks: you {choiceLabel(mine)} · friend {choiceLabel(theirs)}</Text>
      <Text> </Text>
      <Text color="gray">press ↵ to return to playroom</Text>
    </Box>
  );
}
