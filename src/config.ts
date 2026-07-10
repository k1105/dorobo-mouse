// ゲームバランス調整用の定数。数値を変えて調整する。
export const CONFIG = {
  /** 盗みに必要な滞在時間（秒） */
  stealTimeSec: 10,
  /** 盗みスポットの判定半径 */
  stealRadius: 2.0,
  /** ネズミの移動速度 */
  mouseSpeed: 4,
  /** 猫（鬼）の移動速度（ネズミの2倍） */
  catSpeed: 8,
  /** NPCネズミの数 */
  npcCount: 14,
  /** NPCの歩行速度の範囲 */
  npcSpeedMin: 1.8,
  npcSpeedMax: 2.6,
  /** 1ラウンドの制限時間（秒）。時間切れは猫の勝ち */
  roundTimeSec: 300,
  /** 猫がキャッチできる距離 */
  catchRadius: 1.8,
  /** NPCを誤ってキャッチしたときの硬直時間（秒） */
  catchPenaltySec: 3,
  /** 位置情報の送信頻度（Hz） */
  posSendHz: 10,
  /** ゲーム開始前カウントダウン（秒） */
  countdownSec: 3,
} as const;

export const COLORS = {
  mouse: 0x3b72b0,
  cat: 0xd42fe8,
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
