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
} as const;

export const COLORS = {
  mouse: 0x3b72b0,
  floor: 0xe8e6e2,
  shelf: 0x161616,
  wall: 0xc5c2bd,
  exit: 0x43a047,
  camera: 0xd32f2f,
  target: 0xffb300,
} as const;

/** 盗む商品の名前リスト */
export const ITEMS = [
  'スナック菓子', '牛乳', 'チーズ', '食パン', 'りんご',
  'バナナ', 'チョコレート', 'カップ麺', 'おにぎり', 'ジュース',
  'ヨーグルト', '卵', 'ハム', 'クッキー', 'アイスクリーム',
  'コーヒー豆', 'はちみつ', 'バター', 'シリアル', 'グミ',
] as const;
