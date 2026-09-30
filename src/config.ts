// ゲームバランス調整用の定数。数値を変えて調整する。
export const CONFIG = {
  /** 盗みに必要な滞在時間（秒） */
  stealTimeSec: 5,
  /** 盗みスポットの判定半径 */
  stealRadius: 2.0,
  /** ネズミの移動速度 */
  mouseSpeed: 3.2,
  /** NPCの歩行速度の範囲（個体差） */
  npcSpeedMin: 1.6,
  npcSpeedMax: 3.0,
  /** NPCが小走りするときの速度倍率 */
  npcScurryMult: 1.6,
  /** 1ラウンドの制限時間（秒）。時間切れで攻守交代（全2ラウンド） */
  roundTimeSec: 60,
  /** 猫プレイヤー1人が同時に接続（表示）できるカメラ台数（CCTV画面上段のモニタ数） */
  maxViewCams: 3,
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
  /** 前半開始前のステージ紹介（スイープするカメラ3カット）の長さ（秒） */
  introSec: 9,
  /** 攻守交代時の着せ替え・作戦会議の時間（秒） */
  costumeSec: 60,
  /** セット終了のリザルト表示から次のセットの準備に移るまでの時間（秒） */
  setEndSec: 12,
  /** ルーム作成時に選べるセット数の選択肢 */
  setOptions: [1, 2, 3, 5] as readonly number[],
  /** ダウト成功演出の表示時間（秒）。この時間が経ってから攻守交代する */
  doubtEffectSec: 2.5,
  /** 追従カメラの視野角（度） */
  followFov: 60,
  /** 一人称（泥棒目線）カメラの視野角（度） */
  fpsFov: 75,
  /** 一人称カメラの目の高さ（カプセルの頭頂が1.4） */
  fpsEyeHeight: 1.2,
  /** 一人称でA/D・左右キーを押したときの旋回速度（rad/s） */
  fpsTurnSpeed: 2.5,
} as const;

/**
 * アバター（カプセル）の色パレット。プレイヤーは着せ替えでここから選び、
 * NPCも同じパレットからseedで配色するため、色ではプレイヤーとNPCを見分けられない
 */
export const AVATAR_PALETTE: readonly { name: string; hex: number }[] = [
  { name: 'レッド', hex: 0xe0453a },
  { name: 'オレンジ', hex: 0xf28c28 },
  { name: 'イエロー', hex: 0xf2c94c },
  { name: 'ライム', hex: 0x8bc34a },
  { name: 'グリーン', hex: 0x2e9e5b },
  { name: 'ティール', hex: 0x26a69a },
  { name: 'スカイ', hex: 0x4fc3f7 },
  { name: 'ブルー', hex: 0x3b72b0 },
  { name: 'インディゴ', hex: 0x5c6bc0 },
  { name: 'パープル', hex: 0x9c5bb5 },
  { name: 'ピンク', hex: 0xef7fb0 },
  { name: 'ブラウン', hex: 0x8d6e63 },
] as const;

export const COLORS = {
  /** 色未設定のプレイヤーのフォールバック色 */
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

/**
 * 料金帯ごとの棚の色。値段が min 以上なら上から順に最初に当てはまる帯になる。
 * 高い順に 金・銀・銅、安いものは水色。
 */
export const PRICE_TIERS: readonly { name: string; min: number; color: number }[] = [
  { name: '金', min: 500, color: 0xe6b422 },
  { name: '銀', min: 300, color: 0xbfc5cc },
  { name: '銅', min: 200, color: 0xcd7f32 },
  { name: '水色', min: 0, color: 0x7fd4ef },
] as const;

/** 値段に対応する料金帯（PRICE_TIERS のインデックス）を返す */
export function priceTierIndex(price: number): number {
  const i = PRICE_TIERS.findIndex((t) => price >= t.min);
  return i >= 0 ? i : PRICE_TIERS.length - 1;
}

/** 値段に対応する棚の色を返す */
export function priceTierColor(price: number): number {
  return (PRICE_TIERS.find((t) => price >= t.min) ?? PRICE_TIERS[PRICE_TIERS.length - 1]).color;
}
