import { createNet } from './net';
import { Game } from './game/game';
import { Lobby } from './ui/lobby';
import { StageEditor } from './ui/editor';
import { PadNav } from './ui/padnav';
import { CONFIG } from './config';
import { isStalePhase, type PhaseState } from './types';
import { roundLabel } from './ui/text';

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  const net = createNet();
  await net.ready();

  const lobby = new Lobby(app, net);
  // ゲームパッドでのメニュー操作（アプリの寿命と同じ。ゲーム中の入力は Game 側の Controls が読む）
  new PadNav();
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
      // ターン・セットが進んだらゲームを作り直す
      const round = phase.round ?? 1;
      const set = phase.set ?? 1;
      if (game && (game.round !== round || game.set !== set)) {
        game.dispose();
        game = null;
      }
      if (!game) {
        lobby.hide();
        game = new Game(app, net, room, players, phase);
        // 試合終了後のネクスト選択。各自がローカルに画面遷移する（phase の lobby 戻しはホストの「もう一度」が行う）
        game.onEndChoice = (choice) => {
          game?.dispose();
          game = null;
          if (choice === 'rematch') lobby.returnToRoom();
          else if (choice === 'other') lobby.leaveRoom('rooms');
          else lobby.leaveRoom('title');
        };
      }
    } else if (phase.phase === 'setEnd' && !stale) {
      // セット終了のリザルトは進行中のゲーム画面に重ねて出す（Game が phase を購読して表示）。
      // 途中参加などでゲームが無ければロビーで待つ
      if (!game) lobby.show();
    } else if (phase.phase === 'planning' && !stale) {
      // 作戦会議タイム。両チームともロビーの作戦会議画面（値段付きの俯瞰マップ）を見る
      closeGame();
      lobby.show();
    } else if (phase.phase === 'ended' && !stale) {
      // 最終結果 → セレモニー → ネクスト選択は Game が表示する。ゲームが無ければ（途中参加）ロビーで待つ
      if (!game) lobby.show();
    } else if (phase.phase === 'lobby' || stale) {
      // 最終結果〜ネクスト選択を見ている人の画面は、ホストが phase を lobby に戻しても消さない（各自が選んで抜ける）
      if (game?.inEndSequence) return;
      closeGame();
    }
  };

  // 時間で進むフェーズの送り（ホストが書く。ホスト不在に備えて2秒後は誰でも書く）。
  // planning → playing（フィールドインサート → カウントダウン）、setEnd → 次のセットの planning
  let advancedFor = 0;
  window.setInterval(() => {
    const phase = lobby.phase;
    if ((phase.phase !== 'planning' && phase.phase !== 'setEnd') || !phase.until || !lobby.room) return;
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
    if (phase.firstMice) carry.firstMice = phase.firstMice;
    if (phase.phase === 'planning') {
      const round = phase.round ?? 1;
      const lead = CONFIG.introSec + CONFIG.countdownSec;
      net.remove(`rooms/${lobby.room}/pos`);
      const next: PhaseState = {
        ...carry,
        phase: 'playing',
        round,
        startAt: Date.now() + lead * 1000,
        // 商品配置の seed は作戦会議の時点で決まっている（マップに値段を出すため）。無ければここで作る
        seed: phase.seed ?? Math.floor(Math.random() * 2 ** 31),
      };
      if (phase.stage) next.stage = phase.stage;
      if (phase.note) next.note = phase.note;
      net.set(`rooms/${lobby.room}/phase`, next);
    } else {
      // 次のセット（ラウンド）の作戦会議タイム
      const nextSet = (phase.set ?? 1) + 1;
      const stage = phase.stages?.[nextSet - 1] ?? phase.stage;
      net.remove(`rooms/${lobby.room}/pos`);
      net.remove(`rooms/${lobby.room}/cams`);
      const next: PhaseState = {
        ...carry,
        phase: 'planning',
        round: 1,
        set: nextSet,
        seed: Math.floor(Math.random() * 2 ** 31),
        until: Date.now() + CONFIG.planningSec * 1000,
        note: roundLabel(nextSet),
      };
      if (stage) next.stage = stage;
      net.set(`rooms/${lobby.room}/phase`, next);
    }
  }, 250);
}

void boot();
