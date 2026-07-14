import { createNet } from './net';
import { Game } from './game/game';
import { Lobby } from './ui/lobby';

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  const net = createNet();
  await net.ready();

  const lobby = new Lobby(app, net);
  let game: Game | null = null;

  lobby.onUpdate = (room, players, phase) => {
    if (phase.phase === 'playing') {
      // ラウンドが進んだら（前半→後半の攻守交代）ゲームを作り直す
      const round = phase.round ?? 1;
      if (game && game.round !== round) {
        game.dispose();
        game = null;
      }
      if (!game) {
        lobby.hide();
        game = new Game(app, net, room, players, phase);
      }
    } else if (phase.phase === 'lobby' && game) {
      game.dispose();
      game = null;
      lobby.show();
    }
  };
}

void boot();
