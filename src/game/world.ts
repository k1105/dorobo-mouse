import * as THREE from 'three';
import { COLORS, ITEMS } from '../config';
import { mulberry32, shuffled } from './rng';
import { NavGrid } from './nav';

/** XZ平面上の矩形（衝突判定用） */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** 盗みスポット（棚の一区画） */
export interface Spot {
  idx: number;
  x: number;
  z: number;
  item: string;
}

/** カメラマップ描画用のカメラ情報 */
export interface CamInfo {
  id: number;
  x: number;
  z: number;
  /** XZ平面での向き（atan2(dz, dx)） */
  angle: number;
  /** 水平画角（度） */
  hfovDeg: number;
  /** マップに描く有効視認距離 */
  range: number;
}

/** カメラマップ描画用の棚情報 */
export interface ShelfDraw {
  rect: Rect;
  color: number;
  label: string;
}

export interface MapData {
  halfX: number;
  halfZ: number;
  exitHalfW: number;
  shelves: ShelfDraw[];
  /** カメラの視線を遮る矩形（壁 + 背の高い棚。平台は遮らない） */
  occluders: Rect[];
  cams: CamInfo[];
}

export interface World {
  obstacles: Rect[];
  spots: Spot[];
  /** 盗みのお題の出現順（seedから決定論的に生成） */
  targetOrder: number[];
  cctvCams: THREE.PerspectiveCamera[];
  camPositions: THREE.Vector3[];
  bounds: Rect;
  nav: NavGrid;
  mapData: MapData;
  isInExitZone: (x: number, z: number) => boolean;
}

// 店のレイアウト定数
export const FLOOR_HALF_X = 21;
export const FLOOR_HALF_Z = 14;
const EXIT_HALF_W = 1.5; // 出口（z=-14側の壁の隙間）の半幅

// 売り場の色分け（参考: 実際のスーパーの平面図の配色）
const SEC = {
  meat: 0xf06292, // 精肉
  fish: 0x4dd0e1, // 鮮魚
  deli: 0xffa726, // 惣菜
  bakery: 0xd7a86e, // ベーカリー
  dairy: 0xffe082, // 日配
  frozen: 0x9575cd, // 冷凍食品
  drink: 0x64b5f6, // 飲料
  liquor: 0x7986cb, // 酒
  produce: 0x81c784, // 青果
  snack: 0xe57373, // 菓子
  grocery: 0xa1887f, // 加工食品
  dried: 0x26a69a, // 塩干
} as const;

/** 盗みスポット・商品飾りを置く面。n=z負側(奥/出口側), s=z正側(手前), e=x正側, w=x負側 */
type Side = 'n' | 's' | 'e' | 'w';

interface ShelfDef {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  h: number;
  color: number;
  label: string;
  sides: Side[];
}

const CASE_H = 2.0; // 壁面ケース
const GONDOLA_H = 2.2; // 中央ゴンドラ
const ISLAND_H = 1.0; // 平台（低いのでカメラの視線は通る）

// 店内レイアウト。通路幅はプレイヤー・NPCが通れるよう最低2.4を確保する
const SHELVES: ShelfDef[] = [
  // ---- 壁面ケース ----
  { minX: -20.7, maxX: -19.5, minZ: -11, maxZ: 5, h: CASE_H, color: SEC.fish, label: '鮮魚', sides: ['e'] },
  { minX: -20.7, maxX: -19.5, minZ: 7, maxZ: 12, h: CASE_H, color: SEC.dried, label: '塩干', sides: ['e'] },
  { minX: -19.5, maxX: -3.5, minZ: -13.7, maxZ: -12.5, h: CASE_H, color: SEC.meat, label: '精肉', sides: ['s'] },
  { minX: 3.5, maxX: 13, minZ: -13.7, maxZ: -12.5, h: CASE_H, color: SEC.deli, label: '惣菜', sides: ['s'] },
  { minX: 13, maxX: 19.5, minZ: -13.7, maxZ: -12.5, h: CASE_H, color: SEC.bakery, label: 'ベーカリー', sides: ['s'] },
  { minX: 19.5, maxX: 20.7, minZ: -11, maxZ: -1, h: CASE_H, color: SEC.liquor, label: '酒', sides: ['w'] },
  { minX: 19.5, maxX: 20.7, minZ: 1, maxZ: 11, h: CASE_H, color: SEC.drink, label: '飲料', sides: ['w'] },
  { minX: -19.5, maxX: -6, minZ: 12.5, maxZ: 13.7, h: CASE_H, color: SEC.dairy, label: '日配', sides: ['n'] },
  { minX: -2, maxX: 10, minZ: 12.5, maxZ: 13.7, h: CASE_H, color: SEC.frozen, label: '冷凍食品', sides: ['n'] },
  { minX: 12, maxX: 19.5, minZ: 12.5, maxZ: 13.7, h: CASE_H, color: SEC.produce, label: '青果', sides: ['n'] },
  // ---- 左ゾーン（縦ゴンドラ、中央に横断通路） ----
  { minX: -16.8, maxX: -15.2, minZ: -9, maxZ: -3, h: GONDOLA_H, color: SEC.meat, label: '精肉', sides: ['e', 'w'] },
  { minX: -16.8, maxX: -15.2, minZ: 1, maxZ: 9, h: GONDOLA_H, color: SEC.fish, label: '鮮魚', sides: ['e', 'w'] },
  { minX: -10.8, maxX: -9.2, minZ: -9, maxZ: -3, h: GONDOLA_H, color: SEC.dairy, label: '日配', sides: ['e', 'w'] },
  { minX: -10.8, maxX: -9.2, minZ: 1, maxZ: 9, h: GONDOLA_H, color: SEC.frozen, label: '冷凍', sides: ['e', 'w'] },
  // ---- 中央ゾーン（横ゴンドラ4列 × 2区間。x=3〜5が縦の横断通路） ----
  { minX: -6, maxX: 3, minZ: -8.8, maxZ: -7.2, h: GONDOLA_H, color: SEC.snack, label: '菓子', sides: ['n', 's'] },
  { minX: 5, maxX: 15, minZ: -8.8, maxZ: -7.2, h: GONDOLA_H, color: SEC.grocery, label: '加工食品', sides: ['n', 's'] },
  { minX: -6, maxX: 3, minZ: -4.8, maxZ: -3.2, h: GONDOLA_H, color: SEC.grocery, label: '加工食品', sides: ['n', 's'] },
  { minX: 5, maxX: 15, minZ: -4.8, maxZ: -3.2, h: GONDOLA_H, color: SEC.snack, label: '菓子', sides: ['n', 's'] },
  { minX: -6, maxX: 3, minZ: -0.8, maxZ: 0.8, h: GONDOLA_H, color: SEC.drink, label: '飲料', sides: ['n', 's'] },
  { minX: 5, maxX: 15, minZ: -0.8, maxZ: 0.8, h: GONDOLA_H, color: SEC.grocery, label: '加工食品', sides: ['n', 's'] },
  { minX: -6, maxX: 3, minZ: 3.2, maxZ: 4.8, h: GONDOLA_H, color: SEC.snack, label: '菓子', sides: ['n', 's'] },
  { minX: 5, maxX: 15, minZ: 3.2, maxZ: 4.8, h: GONDOLA_H, color: SEC.dairy, label: '日配', sides: ['n', 's'] },
  // ---- 平台の島（低い。カメラは上越しに見えるが、通行は塞ぐ） ----
  { minX: -1.2, maxX: 1.2, minZ: -12.3, maxZ: -10.3, h: ISLAND_H, color: SEC.deli, label: '惣菜平台', sides: ['e', 'w', 's'] },
  { minX: -3.1, maxX: -0.9, minZ: 6.9, maxZ: 9.1, h: ISLAND_H, color: SEC.snack, label: '特売', sides: ['n', 's', 'e', 'w'] },
  { minX: 10.7, maxX: 13.3, minZ: 7.2, maxZ: 9.8, h: ISLAND_H, color: SEC.produce, label: '青果平台', sides: ['n', 's', 'e', 'w'] },
  { minX: 15.7, maxX: 18.3, minZ: 7.2, maxZ: 9.8, h: ISLAND_H, color: SEC.produce, label: '青果平台', sides: ['n', 's', 'w'] },
];

// 防犯カメラ12台。位置と注視点（死角設計はここを調整する）
const CAM_Y = 3.6;
const CAM_RANGE = 15;
const CAM_DEFS: { x: number; z: number; aimX: number; aimZ: number; range?: number }[] = [
  { x: -19.5, z: -11.5, aimX: -10, aimZ: -4 }, // 1: 左上コーナー
  { x: 0, z: -13.2, aimX: 0, aimZ: -4 }, // 2: 出口上から店内向き
  { x: 19.5, z: -11.5, aimX: 10, aimZ: -4 }, // 3: 右上コーナー
  { x: -19.5, z: -1, aimX: -8, aimZ: -1 }, // 4: 左壁中央（左ゾーン横断通路）
  { x: 19.5, z: 0, aimX: 10, aimZ: 0 }, // 5: 右壁中央（中央列の東端）
  { x: -19.5, z: 11.5, aimX: -10, aimZ: 6 }, // 6: 左下コーナー
  { x: -4, z: 13.2, aimX: -2, aimZ: 4 }, // 7: 下壁のケースの隙間（スポーン前通路）
  { x: 19.5, z: 11.5, aimX: 12, aimZ: 7 }, // 8: 右下コーナー（青果）
  { x: 4, z: -10.5, aimX: 4, aimZ: 4 }, // 9: 中央の縦横断通路を南向き
  { x: -8, z: -1, aimX: -16, aimZ: -1 }, // 10: 左ゾーン横断通路を西向き
  { x: -13, z: 10.5, aimX: -13, aimZ: 0 }, // 11: 左ゾーン縦通路を北向き
  { x: 17, z: 2, aimX: 5, aimZ: 2 }, // 12: C-D列間の通路を西向き
];

/** 16:9表示時の水平画角（three.jsのfovは垂直画角なので換算する） */
function horizontalFovDeg(vfovDeg: number, aspect: number): number {
  return (
    (2 * Math.atan(Math.tan((vfovDeg * Math.PI) / 360) * aspect) * 180) / Math.PI
  );
}

export function buildWorld(scene: THREE.Scene, seed: number): World {
  const obstacles: Rect[] = [];
  const occluders: Rect[] = [];

  // ライト
  scene.background = new THREE.Color(0xd7d3cc);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.6));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(8, 20, 10);
  scene.add(dir);

  // 床
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR_HALF_X * 2 + 2, FLOOR_HALF_Z * 2 + 2),
    new THREE.MeshStandardMaterial({ color: COLORS.floor }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // 棚・ケース・平台（売り場ごとに色分け）
  const decoRng = mulberry32(12345); // 飾りは全クライアント共通の固定seed
  const decoGeo = new THREE.BoxGeometry(0.5, 0.4, 0.4);
  for (const s of SHELVES) {
    const w = s.maxX - s.minX;
    const d = s.maxZ - s.minZ;
    const cx = (s.minX + s.maxX) / 2;
    const cz = (s.minZ + s.maxZ) / 2;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, s.h, d),
      new THREE.MeshStandardMaterial({ color: s.color }),
    );
    mesh.position.set(cx, s.h / 2, cz);
    scene.add(mesh);
    const rect: Rect = { minX: s.minX, maxX: s.maxX, minZ: s.minZ, maxZ: s.maxZ };
    obstacles.push(rect);
    if (s.h >= 1.8) occluders.push(rect); // 平台は低いのでカメラの視線を遮らない

    // 商品の飾り（面に沿って小箱を並べる）
    for (const side of s.sides) {
      const horizontal = side === 'n' || side === 's';
      const from = (horizontal ? s.minX : s.minZ) + 0.6;
      const to = (horizontal ? s.maxX : s.maxZ) - 0.6;
      for (let p = from; p <= to; p += 1.2) {
        const deco = new THREE.Mesh(
          decoGeo,
          new THREE.MeshStandardMaterial({
            color: new THREE.Color().setHSL(decoRng(), 0.6, 0.55),
          }),
        );
        const off = 0.18;
        if (side === 'n') deco.position.set(p, s.h - 0.4, s.minZ - off);
        else if (side === 's') deco.position.set(p, s.h - 0.4, s.maxZ + off);
        else if (side === 'w') deco.position.set(s.minX - off, s.h - 0.4, p);
        else deco.position.set(s.maxX + off, s.h - 0.4, p);
        scene.add(deco);
      }
    }
  }

  // 壁（出口の隙間だけ空ける）
  const wallMat = new THREE.MeshStandardMaterial({ color: COLORS.wall });
  const wallH = 1.4;
  const wallT = 0.6;
  const wx = FLOOR_HALF_X;
  const wz = FLOOR_HALF_Z;
  const addWall = (cx: number, cz: number, w: number, d: number) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
    wall.position.set(cx, wallH / 2, cz);
    scene.add(wall);
    const rect: Rect = {
      minX: cx - w / 2,
      maxX: cx + w / 2,
      minZ: cz - d / 2,
      maxZ: cz + d / 2,
    };
    obstacles.push(rect);
    occluders.push(rect);
  };
  // 上の壁（z=-14）: 出口の隙間を挟んで2枚
  const topSegW = wx - EXIT_HALF_W;
  addWall(-(EXIT_HALF_W + topSegW / 2), -wz, topSegW, wallT);
  addWall(EXIT_HALF_W + topSegW / 2, -wz, topSegW, wallT);
  addWall(0, wz, wx * 2 + wallT, wallT); // 下
  addWall(-wx, 0, wallT, wz * 2 + wallT); // 左
  addWall(wx, 0, wallT, wz * 2 + wallT); // 右

  // 出口の目印（緑のゲート）
  const gateMat = new THREE.MeshStandardMaterial({
    color: COLORS.exit,
    transparent: true,
    opacity: 0.45,
  });
  const gate = new THREE.Mesh(new THREE.BoxGeometry(EXIT_HALF_W * 2, 2.4, 0.2), gateMat);
  gate.position.set(0, 1.2, -wz);
  scene.add(gate);
  const gatePostGeo = new THREE.BoxGeometry(0.25, 2.6, 0.25);
  const gatePostMat = new THREE.MeshStandardMaterial({ color: COLORS.exit });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(gatePostGeo, gatePostMat);
    post.position.set(side * EXIT_HALF_W, 1.3, -wz);
    scene.add(post);
  }

  // 盗みスポット（棚の各面に沿って約2.8間隔）と商品の割り当て
  const spots: Spot[] = [];
  const itemRng = mulberry32(seed ^ 0x5e7a11);
  const itemPool = shuffled(ITEMS, itemRng);
  let idx = 0;
  const addSpot = (x: number, z: number) => {
    spots.push({ idx, x, z, item: itemPool[idx % itemPool.length] });
    idx++;
  };
  const SPOT_OFF = 0.7;
  for (const s of SHELVES) {
    for (const side of s.sides) {
      const horizontal = side === 'n' || side === 's';
      const from = (horizontal ? s.minX : s.minZ) + 1.2;
      const to = (horizontal ? s.maxX : s.maxZ) - 1.2;
      for (let p = from; p <= to + 0.01; p += 2.8) {
        if (side === 'n') addSpot(p, s.minZ - SPOT_OFF);
        else if (side === 's') addSpot(p, s.maxZ + SPOT_OFF);
        else if (side === 'w') addSpot(s.minX - SPOT_OFF, p);
        else addSpot(s.maxX + SPOT_OFF, p);
      }
    }
  }
  const targetOrder = shuffled(
    spots.map((s) => s.idx),
    mulberry32(seed ^ 0x7a26e7),
  );

  // 防犯カメラ12台。赤い球で見える化
  const cctvCams: THREE.PerspectiveCamera[] = [];
  const camPositions: THREE.Vector3[] = [];
  const camInfos: CamInfo[] = [];
  const camBallGeo = new THREE.SphereGeometry(0.35, 16, 12);
  const camBallMat = new THREE.MeshStandardMaterial({ color: COLORS.camera });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x555555 });
  CAM_DEFS.forEach((def, i) => {
    const pos = new THREE.Vector3(def.x, CAM_Y, def.z);
    camPositions.push(pos);
    const cam = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 80);
    cam.position.copy(pos);
    cam.lookAt(def.aimX, 0.4, def.aimZ);
    cctvCams.push(cam);
    camInfos.push({
      id: i,
      x: def.x,
      z: def.z,
      angle: Math.atan2(def.aimZ - def.z, def.aimX - def.x),
      hfovDeg: horizontalFovDeg(72, 16 / 9),
      range: def.range ?? CAM_RANGE,
    });
    const ball = new THREE.Mesh(camBallGeo, camBallMat);
    ball.position.copy(pos);
    scene.add(ball);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, CAM_Y, 8), poleMat);
    pole.position.set(def.x, CAM_Y / 2, def.z);
    scene.add(pole);
  });

  const bounds: Rect = {
    minX: -FLOOR_HALF_X + 0.6,
    maxX: FLOOR_HALF_X - 0.6,
    minZ: -FLOOR_HALF_Z - 1.0, // 出口の分だけ上に抜けられる
    maxZ: FLOOR_HALF_Z - 0.6,
  };

  // NPC用歩行グリッド。出口前だけ除外してNPCがゲートにたまらないようにする
  const navObstacles = obstacles.concat([
    { minX: -3, maxX: 3, minZ: -FLOOR_HALF_Z - 2, maxZ: -12.2 },
  ]);
  const nav = new NavGrid(
    navObstacles,
    -FLOOR_HALF_X + 1,
    FLOOR_HALF_X - 1,
    -FLOOR_HALF_Z + 1,
    FLOOR_HALF_Z - 1,
  );

  const mapData: MapData = {
    halfX: FLOOR_HALF_X,
    halfZ: FLOOR_HALF_Z,
    exitHalfW: EXIT_HALF_W,
    shelves: SHELVES.map((s) => ({
      rect: { minX: s.minX, maxX: s.maxX, minZ: s.minZ, maxZ: s.maxZ },
      color: s.color,
      label: s.label,
    })),
    occluders,
    cams: camInfos,
  };

  return {
    obstacles,
    spots,
    targetOrder,
    cctvCams,
    camPositions,
    bounds,
    nav,
    mapData,
    isInExitZone: (x, z) => Math.abs(x) < EXIT_HALF_W - 0.1 && z < -FLOOR_HALF_Z + 0.4,
  };
}

/** キャラクター用カプセルを作る（ネズミ/NPCは同一見た目、猫は大きめ） */
export function makeCapsule(kind: 'mouse' | 'cat'): THREE.Mesh {
  const radius = kind === 'cat' ? 0.45 : 0.35;
  const height = kind === 'cat' ? 0.9 : 0.7;
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, height, 6, 16),
    new THREE.MeshStandardMaterial({ color: kind === 'cat' ? COLORS.cat : COLORS.mouse }),
  );
  mesh.position.y = radius + height / 2;
  return mesh;
}
