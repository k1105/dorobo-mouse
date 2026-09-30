import { createNet } from './net';
import { Game } from './game/game';
import { Lobby } from './ui/lobby';
import { StageEditor } from './ui/editor';
import { CONFIG } from './config';
import { isMouseInRound, isStalePhase, type PhaseState } from './types';

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  const net = createNet();
  await net.ready();

  const lobby = new Lobby(app, net);
  let game: Game | null = null;

  const closeGame = () => {
    if (!game) return;
    game.dispose();
    game = null;
    lobby.show();
  };

  // ステージエディタ（タイトル画面から開く。閉じるとタイトルに戻る）
  let editor: StageEditor | null = null;
  lobby.onOpenEditor = () => {
    if (editor) return;
    lobby.hide();
    editor = new StageEditor(app, () => {
      editor?.dispose();
      editor = null;
      lobby.show();
    });
  };

  lobby.onUpdate = (room, players, phase) => {
    const stale = isStalePhase(phase);
    if (phase.phase === 'playing' && !stale) {
      // ラウンド・セットが進んだら、練習モードからの復帰時はゲームを作り直す
      const round = phase.round ?? 1;
      const set = phase.set ?? 1;
      if (game && (game.round !== round || game.set !== set || game.practice)) {
        game.dispose();
        game = null;
      }
      if (!game) {
        lobby.hide();
        game = new Game(app, net, room, players, phase);
      }
    } else if (phase.phase === 'setEnd' && !stale) {
      // セット終了のリザルトは進行中のゲーム画面に重ねて出す（Game が phase を購読して表示）。
      // 途中参加などでゲームが無ければロビーで待つ
      if (!game) lobby.show();
    } else if (phase.phase === 'costume' && !stale) {
      // 着せ替え・作戦会議の時間。次のラウンドで猫になる陣営は無人の店内でカメラ操作の練習（ゲームの練習モード）、
      // ネズミになる陣営はロビーの着せ替え画面
      const role = players[net.clientId]?.role ?? 'none';
      const round = phase.round ?? 1;
      const practice = role !== 'none' && !isMouseInRound(role, round);
      if (game && !game.practice) {
        game.dispose();
        game = null;
      }
      if (practice) {
        if (!game) {
          lobby.hide();
          game = new Game(app, net, room, players, phase);
        }
      } else {
        closeGame();
        lobby.show();
      }
    } else if (phase.phase === 'lobby' || stale) {
      closeGame();
    }
  };

  // 時間で進むフェーズの送り（ホストが書く。ホスト不在に備えて2秒後は誰でも書く）。
  // costume → playing（前半はステージ紹介 → カウントダウン、後半はカウントダウンのみ）、setEnd → 次のセットの costume
  let advancedFor = 0;
  window.setInterval(() => {
    const phase = lobby.phase;
    if ((phase.phase !== 'costume' && phase.phase !== 'setEnd') || !phase.until || !lobby.room) return;
    if (advancedFor === phase.until) return;
    const over = Date.now() - phase.until;
    if (over < 0 || (!lobby.isHost() && over < 2000)) return;
    advancedFor = phase.until;
    // Firebase は undefined を含む値を拒否するので、未定義のフィールドは入れない
    const carry: PhaseState = { phase: 'playing' };
    if (phase.set) carry.set = phase.set;
    if (phase.sets) carry.sets = phase.sets;
    if (phase.stages) carry.stages = phase.stages;
    if (phase.results) carry.results = phase.results;
    if (phase.phase === 'costume') {
      const round = phase.round ?? 1;
      const lead = (round === 1 ? CONFIG.introSec : 0) + CONFIG.countdownSec;
      net.remove(`rooms/${lobby.room}/pos`);
      const next: PhaseState = {
        ...carry,
        phase: 'playing',
        round,
        startAt: Date.now() + lead * 1000,
        seed: Math.floor(Math.random() * 2 ** 31),
      };
      if (phase.stage) next.stage = phase.stage;
      if (phase.note) next.note = phase.note;
      net.set(`rooms/${lobby.room}/phase`, next);
    } else {
      // 次のセットの準備（前半の着せ替え・練習）
      const nextSet = (phase.set ?? 1) + 1;
      const stage = phase.stages?.[nextSet - 1] ?? phase.stage;
      net.remove(`rooms/${lobby.room}/pos`);
      net.remove(`rooms/${lobby.room}/cams`);
      const next: PhaseState = {
        ...carry,
        phase: 'costume',
        round: 1,
        set: nextSet,
        until: Date.now() + CONFIG.costumeSec * 1000,
        note: `第${nextSet}セット`,
      };
      if (stage) next.stage = stage;
      net.set(`rooms/${lobby.room}/phase`, next);
    }
  }, 250);
}

void boot();
