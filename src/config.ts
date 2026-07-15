// ゲームバランス調整用の定数。数値を変えて調整する。
export const CONFIG = {
  /** 盗みに必要な滞在時間（秒） */
  stealTimeSec: 5,
  /** 盗みスポットの判定半径 */
  stealRadius: 2.0,
  /** ネズミの移動速度 */
  mouseSpeed: 3.2,
  /** NPCネズミの数 */
  npcCount: 50,
  /** NPCの歩行速度の範囲（個体差） */
  npcSpeedMin: 1.6,
  npcSpeedMax: 3.0,
  /** NPCが小走りするときの速度倍率 */
  npcScurryMult: 1.6,
  /** 1ラウンドの制限時間（秒）。時間切れで攻守交代（全2ラウンド） */
  roundTimeSec: 60,
  /** 猫プレイヤー1人が同時に接続（表示）できるカメラ台数 */
  maxViewCams: 4,
  /** 1ラウンドあたりのダウト回数（猫プレイヤーごと） */
  doubtsPerRound: 2,
  /** 盗み中の左右揺れの振幅 */
  swayAmp: 0.18,
  /** 盗み中の左右揺れの周波数（Hz） */
  swayHz: 1.8,
  /** 位置情報の送信頻度（Hz） */
  posSendHz: 10,
  /** ゲーム開始前カウントダウン（秒） */
  countdownSec: 3,
  /** 万引き成功（出口通過）からリスポーンまでの待ち時間（秒） */
  respawnDelaySec: 3,
  /** ダウト成功演出の表示時間（秒）。この時間が経ってから攻守交代する */
  doubtEffectSec: 2.5,
} as const;

export const COLORS = {
  mouse: 0x3b72b0,
  floor: 0xe8e6e2,
  shelf: 0x161616,
  wall: 0xc5c2bd,
  exit: 0x43a047,
  camera: 0xd32f2f,
  target: 0xffb300,
  /** ダウト成功時に見破られたプレイヤーが変わる色 */
  caught: 0x2ecc71,
} as const;

/** 盗む商品のリスト（値段は円。持ち出しに成功すると値段分がチームスコアに加算される） */
export interface Item {
  name: string;
  price: number;
}

export const ITEMS: readonly Item[] = [
  { name: 'スナック菓子', price: 150 },
  { name: '牛乳', price: 250 },
  { name: 'チーズ', price: 400 },
  { name: '食パン', price: 200 },
  { name: 'りんご', price: 180 },
  { name: 'バナナ', price: 150 },
  { name: 'チョコレート', price: 250 },
  { name: 'カップ麺', price: 200 },
  { name: 'おにぎり', price: 150 },
  { name: 'ジュース', price: 160 },
  { name: 'ヨーグルト', price: 180 },
  { name: '卵', price: 300 },
  { name: 'ハム', price: 350 },
  { name: 'クッキー', price: 300 },
  { name: 'アイスクリーム', price: 280 },
  { name: 'コーヒー豆', price: 800 },
  { name: 'はちみつ', price: 900 },
  { name: 'バター', price: 450 },
  { name: 'シリアル', price: 500 },
  { name: 'グミ', price: 120 },
] as const;
