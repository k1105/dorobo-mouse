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
  /** 1ターンの制限時間（秒）。時間切れで攻守交代（1ラウンド = 第1ターン＋第2ターン） */
  roundTimeSec: 60,
  /** 監視サイドのプレイヤー1人が同時に接続（表示）できるカメラ台数（CCTV画面上段のモニタ数） */
  maxViewCams: 3,
  /** 1ターンあたりのダウト回数（監視サイドのプレイヤーごと） */
  doubtsPerRound: 3,
  /** 盗み中に体の前で動かす手（球体）の振幅 */
  rummageAmp: 0.15,
  /** 盗み中の手の動きの周波数（Hz。左右の手が交互に動く） */
  rummageHz: 2.4,
  /** 位置情報の送信頻度（Hz） */
  posSendHz: 10,
  /** ターン開始前カウントダウン（秒）。攻守それぞれのスタート画面で 3→2→1 */
  countdownSec: 3,
  /** 各ターン開始前のフィールドインサート（店内をなめるカメラ映像）の長さ（秒） */
  introSec: 3,
  /** 各ターン前の作戦会議タイムの長さ（秒） */
  planningSec: 30,
  /** セット終了のリザルト表示から次のセットの準備に移るまでの時間（秒） */
  setEndSec: 12,
  /** ルーム作成時に選べるセット数の選択肢 */
  setOptions: [1, 2, 3, 5] as readonly number[],
  /** ダウト成功演出の表示時間（秒）。この時間が経ってから攻守交代する */
  doubtEffectSec: 2.5,
  /** 追従カメラの視野角（度） */
  followFov: 60,
  /** 一人称（まんびき目線）カメラの視野角（度） */
  fpsFov: 75,
  /** 一人称カメラの目の高さ（カプセルの頭頂が1.4） */
  fpsEyeHeight: 1.2,
  /** 一人称でA/D・左右キーを押したときの旋回速度（rad/s） */
  fpsTurnSpeed: 2.5,
  /** 監視サイドのゲームパッド照準カーソルの最高速度（スティックを倒しきったときに1秒で進む距離。画面の高さ=1） */
  padAimSpeed: 0.9,
} as const;

/**
 * アバター（カプセル）の色パレット。プレイヤーの変装はここからランダムに決まり、
 * NPC（一般客）も同じパレットからseedで配色するため、色ではプレイヤーとNPCを見分けられない
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

/** 盗む商品のリスト（price はポイント。持ち出しに成功するとその分がチームスコアに加算される） */
export interface Item {
  name: string;
  price: number;
}

/** ネズミたちの好物（ピーナッツ・チョコレート・チーズなど）。ポイントの幅は 120〜900 */
export const ITEMS: readonly Item[] = [
  { name: 'ピーナッツ', price: 150 },
  { name: 'チョコレート', price: 250 },
  { name: 'カマンベール', price: 400 },
  { name: 'クラッカー', price: 200 },
  { name: 'ドライフルーツ', price: 180 },
  { name: 'ひまわりの種', price: 150 },
  { name: 'キャラメル', price: 250 },
  { name: 'ポップコーン', price: 200 },
  { name: 'おせんべい', price: 150 },
  { name: 'マシュマロ', price: 160 },
  { name: 'アーモンド', price: 180 },
  { name: 'クッキー', price: 300 },
  { name: 'スモークチーズ', price: 350 },
  { name: 'ナッツミックス', price: 300 },
  { name: 'チーズケーキ', price: 280 },
  { name: '高級チーズ', price: 800 },
  { name: 'トリュフチーズ', price: 900 },
  { name: 'ブルーチーズ', price: 450 },
  { name: '熟成ゴーダ', price: 500 },
  { name: 'クルトン', price: 120 },
] as const;

/**
 * 料金帯ごとの棚の色。ポイントが min 以上なら上から順に最初に当てはまる帯になる。
 * 高い順に 金・銀・銅、安いものは水色。
 */
export const PRICE_TIERS: readonly { name: string; min: number; color: number }[] = [
  { name: '金', min: 500, color: 0xe6b422 },
  { name: '銀', min: 300, color: 0xbfc5cc },
  { name: '銅', min: 200, color: 0xcd7f32 },
  { name: '水色', min: 0, color: 0x7fd4ef },
] as const;

/** ポイントに対応する料金帯（PRICE_TIERS のインデックス）を返す */
export function priceTierIndex(price: number): number {
  const i = PRICE_TIERS.findIndex((t) => price >= t.min);
  return i >= 0 ? i : PRICE_TIERS.length - 1;
}

/** ポイントに対応する棚の色を返す */
export function priceTierColor(price: number): number {
  return (PRICE_TIERS.find((t) => price >= t.min) ?? PRICE_TIERS[PRICE_TIERS.length - 1]).color;
}
