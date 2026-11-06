/**
 * 同梱ステージ。ステージエディタで書き出した JSON（docs/dorobo-stage-*.json）をそのまま読み込み、
 * 組み込みステージとして登録する（全クライアントが同じデータを持つので、自作ステージのようにエリアへ配る必要がない）。
 * 追加するときは JSON を import して SOURCES に1行足す。
 */
import cam6 from '../../docs/dorobo-stage-カメラ６_1106.json';
import cam9 from '../../docs/dorobo-stage-カメラ９_1106.json';
import { normalizeStageData, toStageDef, validateStage } from './customStage';
import { registerStage, type StageDef } from './stages';

/**
 * id はゲーム内でのステージID（phase.stage・移動ログに残る）。
 * JSON 内の id（作者のブラウザに保存されている自作ステージのID）とは別にして、同じステージの自作版と混ざらないようにする
 */
const SOURCES: readonly { id: string; raw: unknown }[] = [
  { id: 'cam6_1106', raw: cam6 },
  { id: 'cam9_1106', raw: cam9 },
];

function build(): StageDef[] {
  const out: StageDef[] = [];
  for (const { id, raw } of SOURCES) {
    const data = normalizeStageData(raw);
    if (!data || validateStage(data).errors.length > 0) {
      console.warn(`同梱ステージ ${id} を読み込めませんでした`);
      continue;
    }
    const def = toStageDef(data, id);
    def.desc = `${data.w}×${data.h}マス・カメラ${data.cams.length}台・一般客${data.npcCount}人`;
    registerStage(def);
    out.push(def);
  }
  return out;
}

/** 同梱ステージ（読み込み時に登録済みで、getStage でIDから引ける）。ステージ選択に組み込みステージと並べて出す */
export const BUNDLED_STAGES: readonly StageDef[] = build();
