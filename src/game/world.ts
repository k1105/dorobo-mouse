import * as THREE from 'three';
import { COLORS, ITEMS, PRICE_TIERS, priceTierColor, priceTierIndex, type Item } from '../config';
import { mulberry32, shuffled } from './rng';
import { NavGrid, type NavLayer, type NavLink } from './nav';
import type { RampDef, Rect, ShelfDef, Side, StageDef } from './stages';

export type { Rect, Side } from './stages';

/** 盗みスポット（棚の一区画）。itemの値段が持ち出し時のスコアになる */
export interface Spot {
  idx: number;
  x: number;
  z: number;
  floor: number;
  item: Item;
}

/** カメラマップ描画用のカメラ情報 */
export interface CamInfo {
  id: number;
  x: number;
  z: number;
  floor: number;
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
  /** 料金帯の色（config.PRICE_TIERS） */
  color: number;
  label: string;
}

/** カメラマップ描画用のスロープ情報 */
export interface RampDraw {
  rect: Rect;
  up: Side;
  from: number;
  to: number;
}

/** 1フロア分のマップ描画データ */
export interface FloorMapData {
  name: string;
  rect: Rect;
  exit?: { x: number; halfW: number };
  shelves: ShelfDraw[];
  /** カメラの視線を遮る矩形（壁 + 背の高い棚。平台は遮らない） */
  occluders: Rect[];
  cams: CamInfo[];
}

export interface MapData {
  floors: FloorMapData[];
  ramps: RampDraw[];
}

/** 店内を移動するもの（プレイヤー）の位置。floor はスロープ上では直前にいたフロア */
export interface MoverPos {
  x: number;
  z: number;
  floor: number;
}

/** ワールド構築後の1フロア分の情報 */
export interface FloorInfo {
  y: number;
  /** プレイヤーの移動範囲 */
  bounds: Rect;
  /** プレイヤーの衝突判定用 */
  obstacles: Rect[];
}

export interface World {
  stage: StageDef;
  floors: FloorInfo[];
  spots: Spot[];
  cctvCams: THREE.PerspectiveCamera[];
  camPositions: THREE.Vector3[];
  /** ポール上部の球体。オンライン時に発光させる */
  camBalls: THREE.Mesh[];
  /** カメラ視野の床ハイライト。オンライン時に表示する */
  camFovMeshes: THREE.Mesh[];
  /** 全カメラの死角になっているリスポーン地点（万引き後に戻る場所） */
  blindSpawn: MoverPos;
  nav: NavGrid;
  mapData: MapData;
  /** (x,z) の床面の高さ。スロープ上では両端のフロアの高さを補間する */
  heightAt: (x: number, z: number, floor: number) => number;
  /** プレイヤーの移動（棚・壁との衝突、スロープでのフロア移動を処理して p を更新する） */
  move: (p: MoverPos, dx: number, dz: number) => void;
  isInExitZone: (x: number, z: number, floor: number) => boolean;
}

/**
 * 2F以上の静的メッシュ（床板・棚・手すり・カメラ）が属するレイヤ。
 * 1Fにいるネズミの追従カメラでは上階の床板が視界を塞ぐため、このレイヤを外して描画する。
 * CCTVカメラ・一人称カメラは全レイヤを描画する
 */
export const UPPER_LAYER = 1;
/** 動くもの（NPC・他プレイヤー）をどの高さから UPPER_LAYER に入れるか */
export const UPPER_LAYER_MIN_Y = 2.0;
/**
 * プレイヤー名ラベルのレイヤ。ネズミ役（泥棒チーム）のクライアントの追従・一人称カメラだけが描画し、
 * 監視カメラ・観戦には映さない（名前で仲間を見分ける＝猫からは見分けがつかない）
 */
export const LABEL_LAYER = 2;
/** ネズミのカプセルの足元から中心までの高さ（makeCapsule の position.y） */
export const CAPSULE_Y = 0.7;

const CAM_Y = 3.6; // 床面からのカメラの高さ
export const CAM_RANGE = 15;
const WALL_H = 1.4; // 1Fの外周の壁
export const WALL_T = 0.6;
const RAIL_H = 1.0; // 上階の外周・吹き抜けの手すり
const RAIL_T = 0.3;
const PLATE_T = 0.3; // 上階の床板の厚み

/** 16:9表示時の水平画角（three.jsのfovは垂直画角なので換算する） */
function horizontalFovDeg(vfovDeg: number, aspect: number): number {
  return (
    (2 * Math.atan(Math.tan((vfovDeg * Math.PI) / 360) * aspect) * 180) / Math.PI
  );
}

/** 防犯カメラの水平画角（度）。ステージエディタの視野プレビューでも使う */
export const CAM_HFOV_DEG = horizontalFovDeg(72, 16 / 9);

/** スロープの下端から上端へ向かう割合（0=下端, 1=上端）。矩形の外でも延長線上で計算する */
function rampAlong(r: RampDef, x: number, z: number): number {
  const { rect, up } = r;
  let k: number;
  if (up === 'n') k = (rect.maxZ - z) / (rect.maxZ - rect.minZ);
  else if (up === 's') k = (z - rect.minZ) / (rect.maxZ - rect.minZ);
  else if (up === 'e') k = (x - rect.minX) / (rect.maxX - rect.minX);
  else k = (rect.maxX - x) / (rect.maxX - rect.minX);
  return Math.min(1, Math.max(0, k));
}

function inRect(r: Rect, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

function intersectRect(a: Rect, b: Rect): Rect | null {
  const r = {
    minX: Math.max(a.minX, b.minX),
    maxX: Math.min(a.maxX, b.maxX),
    minZ: Math.max(a.minZ, b.minZ),
    maxZ: Math.min(a.maxZ, b.maxZ),
  };
  return r.minX < r.maxX && r.minZ < r.maxZ ? r : null;
}

/** 矩形 a から穴 holes を除いた矩形群（床板を穴あきで描くため） */
function subtractRects(a: Rect, holes: Rect[]): Rect[] {
  let parts = [a];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const p of parts) {
      const c = intersectRect(p, h);
      if (!c) {
        next.push(p);
        continue;
      }
      if (c.minZ > p.minZ) next.push({ ...p, maxZ: c.minZ });
      if (c.maxZ < p.maxZ) next.push({ ...p, minZ: c.maxZ });
      if (c.minX > p.minX) next.push({ minX: p.minX, maxX: c.minX, minZ: c.minZ, maxZ: c.maxZ });
      if (c.maxX < p.maxX) next.push({ minX: c.maxX, maxX: p.maxX, minZ: c.minZ, maxZ: c.maxZ });
    }
    parts = next;
  }
  return parts;
}

/** スロープの両側の手すりの矩形（坂の内側に沿った細い帯。横からの出入りを防ぐ） */
function rampRails(r: RampDef): Rect[] {
  const { rect, up } = r;
  if (up === 'n' || up === 's') {
    return [
      { ...rect, maxX: rect.minX + RAIL_T },
      { ...rect, minX: rect.maxX - RAIL_T },
    ];
  }
  return [
    { ...rect, maxZ: rect.minZ + RAIL_T },
    { ...rect, minZ: rect.maxZ - RAIL_T },
  ];
}

/** スロープの上端の内側にある細い帯（下のフロアの歩行グリッドで、坂の先へ抜けないようにする） */
function rampTopBlocker(r: RampDef): Rect {
  const { rect, up } = r;
  const t = 0.2;
  if (up === 'n') return { ...rect, maxZ: rect.minZ + t };
  if (up === 's') return { ...rect, minZ: rect.maxZ - t };
  if (up === 'e') return { ...rect, minX: rect.maxX - t };
  return { ...rect, maxX: rect.minX + t };
}

/** スロープの中心線上で、上端から dist だけ（正=坂の内側、負=坂の先の上階側）離れた点 */
function rampTopPoint(r: RampDef, dist: number): { x: number; z: number } {
  const { rect, up } = r;
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  if (up === 'n') return { x: cx, z: rect.minZ + dist };
  if (up === 's') return { x: cx, z: rect.maxZ - dist };
  if (up === 'e') return { x: rect.maxX - dist, z: cz };
  return { x: rect.minX + dist, z: cz };
}

export function buildWorld(scene: THREE.Scene, seed: number, stage: StageDef): World {
  const floors: FloorInfo[] = [];
  const floorOccluders: Rect[][] = [];
  const floorShelfDraws: ShelfDraw[][] = [];
  const floorCamInfos: CamInfo[][] = [];
  const navLayers: NavLayer[] = [];
  const navLinks: NavLink[] = [];

  // 上階のメッシュは UPPER_LAYER に入れる（1Fの追従カメラで非表示にできるように）
  const addMesh = (mesh: THREE.Object3D, floorIdx: number) => {
    if (floorIdx > 0) mesh.traverse((o) => o.layers.set(UPPER_LAYER));
    scene.add(mesh);
  };

  // ライト
  scene.background = new THREE.Color(0xd7d3cc);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.6));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(8, 20, 10);
  scene.add(dir);

  // 棚ごとに商品を1つ割り当てる（同じ棚のスポットはすべて同じ商品）。棚の色は商品の料金帯で決まる
  const itemRng = mulberry32(seed ^ 0x5e7a11);
  const itemPool = shuffled(ITEMS, itemRng);
  let shelfCounter = 0;
  // 料金帯が指定された棚（ステージエディタ製）には、その帯の商品だけを順に割り当てる
  const tierPools = PRICE_TIERS.map((_, ti) => itemPool.filter((it) => priceTierIndex(it.price) === ti));
  const tierCounters = PRICE_TIERS.map(() => 0);
  const pickItem = (s: ShelfDef): Item => {
    const pool = s.tier !== undefined ? tierPools[s.tier] : undefined;
    if (s.tier !== undefined && pool && pool.length > 0) return pool[tierCounters[s.tier]++ % pool.length];
    return itemPool[shelfCounter++ % itemPool.length];
  };
  const decoRng = mulberry32(12345); // 飾りは全クライアント共通の固定seed
  const decoGeo = new THREE.BoxGeometry(0.5, 0.4, 0.4);

  const spots: Spot[] = [];
  const cctvCams: THREE.PerspectiveCamera[] = [];
  const camPositions: THREE.Vector3[] = [];
  const camBalls: THREE.Mesh[] = [];
  const camFovMeshes: THREE.Mesh[] = [];
  const camBallGeo = new THREE.SphereGeometry(0.35, 16, 12);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x555555 });
  const wallMat = new THREE.MeshStandardMaterial({ color: COLORS.wall });
  const floorMat = new THREE.MeshStandardMaterial({ color: COLORS.floor });

  // スロープの手すりはどのフロアでも障害物（横から坂に入れない・坂の脇に立ち入れない）
  const railRects = stage.ramps.flatMap(rampRails);

  stage.floors.forEach((f, fi) => {
    const obstacles: Rect[] = [...railRects];
    const occluders: Rect[] = [];
    const fw = f.rect.maxX - f.rect.minX;
    const fd = f.rect.maxZ - f.rect.minZ;
    const cx = (f.rect.minX + f.rect.maxX) / 2;
    const cz = (f.rect.minZ + f.rect.maxZ) / 2;

    // 床。1Fは一枚板、上階はスロープの吹き抜けを避けた板
    if (fi === 0) {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw + 2, fd + 2), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(cx, f.y, cz);
      addMesh(floor, fi);
    } else {
      const holes = stage.ramps.filter((r) => r.to === fi).map((r) => r.rect);
      for (const p of subtractRects(f.rect, holes)) {
        const plate = new THREE.Mesh(
          new THREE.BoxGeometry(p.maxX - p.minX, PLATE_T, p.maxZ - p.minZ),
          floorMat,
        );
        plate.position.set((p.minX + p.maxX) / 2, f.y - PLATE_T / 2, (p.minZ + p.maxZ) / 2);
        addMesh(plate, fi);
      }
    }

    // 棚・ケース・平台（料金帯ごとに色分け）
    const shelfDraws: ShelfDraw[] = [];
    for (const s of f.shelves) {
      const item = pickItem(s);
      const color = priceTierColor(item.price);
      const w = s.maxX - s.minX;
      const d = s.maxZ - s.minZ;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, s.h, d),
        new THREE.MeshStandardMaterial({ color }),
      );
      mesh.position.set((s.minX + s.maxX) / 2, f.y + s.h / 2, (s.minZ + s.maxZ) / 2);
      addMesh(mesh, fi);
      const rect: Rect = { minX: s.minX, maxX: s.maxX, minZ: s.minZ, maxZ: s.maxZ };
      obstacles.push(rect);
      if (s.h >= 1.8) occluders.push(rect); // 平台は低いのでカメラの視線を遮らない
      shelfDraws.push({ rect, color, label: s.label });

      // 商品の飾り（面に沿って小箱を並べる）と盗みスポット（約2.8間隔）
      const SPOT_OFF = 0.7;
      for (const side of s.sides) {
        const horizontal = side === 'n' || side === 's';
        const from = horizontal ? s.minX : s.minZ;
        const to = horizontal ? s.maxX : s.maxZ;
        for (let p = from + 0.6; p <= to - 0.6; p += 1.2) {
          const deco = new THREE.Mesh(
            decoGeo,
            new THREE.MeshStandardMaterial({
              color: new THREE.Color().setHSL(decoRng(), 0.6, 0.55),
            }),
          );
          const off = 0.18;
          const y = f.y + s.h - 0.4;
          if (side === 'n') deco.position.set(p, y, s.minZ - off);
          else if (side === 's') deco.position.set(p, y, s.maxZ + off);
          else if (side === 'w') deco.position.set(s.minX - off, y, p);
          else deco.position.set(s.maxX + off, y, p);
          addMesh(deco, fi);
        }
        for (let p = from + 1.2; !s.spots && p <= to - 1.2 + 0.01; p += 2.8) {
          const idx = spots.length;
          if (side === 'n') spots.push({ idx, x: p, z: s.minZ - SPOT_OFF, floor: fi, item });
          else if (side === 's') spots.push({ idx, x: p, z: s.maxZ + SPOT_OFF, floor: fi, item });
          else if (side === 'w') spots.push({ idx, x: s.minX - SPOT_OFF, z: p, floor: fi, item });
          else spots.push({ idx, x: s.maxX + SPOT_OFF, z: p, floor: fi, item });
        }
      }
      // スポットが直接指定された棚（ステージエディタ製）
      for (const p of s.spots ?? []) {
        spots.push({ idx: spots.length, x: p.x, z: p.z, floor: fi, item });
      }
    }

    // 外周の壁（1F。出口の隙間だけ空ける）／手すり（上階）
    const wallH = fi === 0 ? WALL_H : RAIL_H;
    const wallT = fi === 0 ? WALL_T : RAIL_T;
    const addWall = (wcx: number, wcz: number, w: number, d: number) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
      wall.position.set(wcx, f.y + wallH / 2, wcz);
      addMesh(wall, fi);
      const rect: Rect = {
        minX: wcx - w / 2,
        maxX: wcx + w / 2,
        minZ: wcz - d / 2,
        maxZ: wcz + d / 2,
      };
      obstacles.push(rect);
      // 上階の手すりは低いが、マップ・床ハイライトの2D視野はフロアの範囲で打ち切る（吹き抜け越しの見下ろしは扱わない）
      occluders.push(rect);
    };
    if (f.exit) {
      // 奥の壁（minZ）: 出口の隙間を挟んで2枚
      const leftW = f.exit.x - f.exit.halfW - f.rect.minX;
      const rightW = f.rect.maxX - (f.exit.x + f.exit.halfW);
      addWall(f.rect.minX + leftW / 2, f.rect.minZ, leftW, wallT);
      addWall(f.rect.maxX - rightW / 2, f.rect.minZ, rightW, wallT);
    } else {
      addWall(cx, f.rect.minZ, fw + wallT, wallT);
    }
    addWall(cx, f.rect.maxZ, fw + wallT, wallT); // 手前
    addWall(f.rect.minX, cz, wallT, fd + wallT); // 左
    addWall(f.rect.maxX, cz, wallT, fd + wallT); // 右

    // 出口の目印（緑のゲート）
    if (f.exit) {
      const gateMat = new THREE.MeshStandardMaterial({
        color: COLORS.exit,
        transparent: true,
        opacity: 0.45,
      });
      const gate = new THREE.Mesh(new THREE.BoxGeometry(f.exit.halfW * 2, 2.4, 0.2), gateMat);
      gate.position.set(f.exit.x, f.y + 1.2, f.rect.minZ);
      addMesh(gate, fi);
      const gatePostGeo = new THREE.BoxGeometry(0.25, 2.6, 0.25);
      const gatePostMat = new THREE.MeshStandardMaterial({ color: COLORS.exit });
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(gatePostGeo, gatePostMat);
        post.position.set(f.exit.x + side * f.exit.halfW, f.y + 1.3, f.rect.minZ);
        addMesh(post, fi);
      }
    }

    // 防犯カメラ。赤い球で見える化（球はオンライン時に発光させるため個別マテリアル）
    const camInfos: CamInfo[] = [];
    for (const def of f.cams) {
      const id = cctvCams.length;
      const pos = new THREE.Vector3(def.x, f.y + CAM_Y, def.z);
      camPositions.push(pos);
      const cam = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 80);
      cam.layers.enable(UPPER_LAYER); // 上階は映すが、名前ラベル（LABEL_LAYER）は映さない
      cam.position.copy(pos);
      cam.lookAt(def.aimX, f.y + 0.4, def.aimZ);
      cctvCams.push(cam);
      camInfos.push({
        id,
        x: def.x,
        z: def.z,
        floor: fi,
        angle: Math.atan2(def.aimZ - def.z, def.aimX - def.x),
        hfovDeg: horizontalFovDeg(72, 16 / 9),
        range: def.range ?? CAM_RANGE,
      });
      const ball = new THREE.Mesh(
        camBallGeo,
        new THREE.MeshStandardMaterial({ color: COLORS.camera }),
      );
      ball.position.copy(pos);
      addMesh(ball, fi);
      camBalls.push(ball);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, CAM_Y, 8), poleMat);
      pole.position.set(def.x, f.y + CAM_Y / 2, def.z);
      addMesh(pole, fi);
    }

    // オンラインのカメラが「見ている」床の範囲を明るくするハイライト（遮蔽考慮の扇形）
    const FOV_RAYS = 72;
    camInfos.forEach((cam) => {
      const half = ((cam.hfovDeg / 2) * Math.PI) / 180;
      const shape = new THREE.Shape();
      shape.moveTo(cam.x, -cam.z); // 床(rotation.x=-π/2)ではローカルy→ワールド-z
      for (let r = 0; r <= FOV_RAYS; r++) {
        const a = cam.angle - half + (2 * half * r) / FOV_RAYS;
        const d = castRay(cam.x, cam.z, Math.cos(a), Math.sin(a), cam.range, occluders);
        shape.lineTo(cam.x + Math.cos(a) * d, -(cam.z + Math.sin(a) * d));
      }
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({
          color: 0xfff2b0,
          transparent: true,
          opacity: 0.13,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = f.y + 0.02 + cam.id * 0.002; // 重なりのz-fighting回避
      mesh.visible = false;
      addMesh(mesh, fi);
      camFovMeshes.push(mesh);
    });

    const bounds: Rect = {
      minX: f.rect.minX + 0.6,
      maxX: f.rect.maxX - 0.6,
      minZ: f.exit ? f.rect.minZ - 1.0 : f.rect.minZ + 0.6, // 出口の分だけ奥に抜けられる
      maxZ: f.rect.maxZ - 0.6,
    };
    floors.push({ y: f.y, bounds, obstacles });
    floorOccluders.push(occluders);
    floorShelfDraws.push(shelfDraws);
    floorCamInfos.push(camInfos);

    // NPC用歩行グリッド。出口前だけ除外してNPCがゲートにたまらないようにする。
    // スロープは下のフロアでは坂の上端を塞ぎ、上のフロアでは坂全体が吹き抜け（穴）
    const navObstacles = obstacles.slice();
    if (f.exit) {
      navObstacles.push({
        minX: f.exit.x - 3,
        maxX: f.exit.x + 3,
        minZ: f.rect.minZ - 2,
        maxZ: f.rect.minZ + 1.8,
      });
    }
    for (const r of stage.ramps) {
      if (r.from === fi) navObstacles.push(rampTopBlocker(r));
      if (r.to === fi) navObstacles.push(r.rect);
    }
    navLayers.push({
      obstacles: navObstacles,
      minX: f.rect.minX + 1,
      maxX: f.rect.maxX - 1,
      minZ: f.rect.minZ + 1,
      maxZ: f.rect.maxZ - 1,
    });
  });

  // スロープ本体（三角柱）と手すり。上端の内側と上階側を歩行グリッドで接続する
  for (const r of stage.ramps) {
    buildRamp(scene, r, stage.floors[r.from].y, stage.floors[r.to].y, wallMat, floorMat);
    const a = rampTopPoint(r, 1.5);
    const b = rampTopPoint(r, -1.5);
    navLinks.push({ a: { ...a, layer: r.from }, b: { ...b, layer: r.to } });
  }

  const nav = new NavGrid(navLayers, navLinks);

  // 全カメラの死角になるリスポーン地点を1Fで探す（手前=出口の反対側を優先）
  const blindSpawn = findBlindSpawn(
    floorCamInfos[0],
    floorOccluders[0],
    floors[0].obstacles,
    floors[0].bounds,
    stage.floors[0].rect,
    stage.spawns[0],
  );

  const mapData: MapData = {
    floors: stage.floors.map((f, fi) => ({
      name: f.name,
      rect: f.rect,
      exit: f.exit,
      shelves: floorShelfDraws[fi],
      occluders: floorOccluders[fi],
      cams: floorCamInfos[fi],
    })),
    ramps: stage.ramps.map((r) => ({ rect: r.rect, up: r.up, from: r.from, to: r.to })),
  };

  const rampAt = (x: number, z: number): RampDef | null =>
    stage.ramps.find((r) => inRect(r.rect, x, z)) ?? null;

  const heightAt = (x: number, z: number, floor: number): number => {
    const r = rampAt(x, z);
    if (r) {
      const y0 = stage.floors[r.from].y;
      const y1 = stage.floors[r.to].y;
      return y0 + (y1 - y0) * rampAlong(r, x, z);
    }
    return stage.floors[floor]?.y ?? 0;
  };

  const MOVER_R = 0.4;
  const hitsAny = (x: number, z: number, rects: Rect[]) =>
    rects.some(
      (o) => x + MOVER_R > o.minX && x - MOVER_R < o.maxX && z + MOVER_R > o.minZ && z - MOVER_R < o.maxZ,
    );

  /**
   * p にいるものが (nx,nz) へ動けるか。スロープは端からしか出入りできない
   * （下のフロアからは下端、上のフロアからは上端）。坂の上では手すりだけが障害物
   */
  const blocked = (p: MoverPos, nx: number, nz: number): boolean => {
    const rNow = rampAt(p.x, p.z);
    const rNext = rampAt(nx, nz);
    if (rNext) {
      if (!rNow) {
        const along = rampAlong(rNext, nx, nz);
        const okEnd =
          p.floor === rNext.from ? along < 0.5 : p.floor === rNext.to ? along > 0.5 : false;
        if (!okEnd) return true;
      }
      return hitsAny(nx, nz, railRects);
    }
    const floor = rNow ? (rampAlong(rNow, nx, nz) > 0.5 ? rNow.to : rNow.from) : p.floor;
    return hitsAny(nx, nz, floors[floor].obstacles);
  };

  const move = (p: MoverPos, dx: number, dz: number): void => {
    // 軸ごとに判定して壁ずりを可能にする
    let x = p.x + dx;
    if (blocked(p, x, p.z)) x = p.x;
    let z = p.z + dz;
    if (blocked(p, x, z)) z = p.z;
    const rNow = rampAt(p.x, p.z);
    const rNext = rampAt(x, z);
    if (rNow && !rNext) {
      // 坂を出た側のフロアに移る
      p.floor = rampAlong(rNow, x, z) > 0.5 ? rNow.to : rNow.from;
    }
    if (rNext) {
      p.x = x;
      p.z = z;
    } else {
      const b = floors[p.floor].bounds;
      p.x = Math.min(b.maxX, Math.max(b.minX, x));
      p.z = Math.min(b.maxZ, Math.max(b.minZ, z));
    }
  };

  const exit = stage.floors[0].exit;
  const exitMinZ = stage.floors[0].rect.minZ;

  return {
    stage,
    floors,
    spots,
    cctvCams,
    camPositions,
    camBalls,
    camFovMeshes,
    blindSpawn,
    nav,
    mapData,
    heightAt,
    move,
    isInExitZone: (x, z, floor) =>
      !!exit &&
      floor === 0 &&
      Math.abs(x - exit.x) < exit.halfW - 0.1 &&
      z < exitMinZ + 0.4 &&
      !rampAt(x, z),
  };
}

/** スロープ本体（三角柱）と両側の手すりを作る */
function buildRamp(
  scene: THREE.Scene,
  r: RampDef,
  y0: number,
  y1: number,
  railMat: THREE.Material,
  floorMat: THREE.Material,
): void {
  const { rect, up } = r;
  const alongX = up === 'e' || up === 'w';
  const len = alongX ? rect.maxX - rect.minX : rect.maxZ - rect.minZ;
  const width = alongX ? rect.maxZ - rect.minZ : rect.maxX - rect.minX;
  const h = y1 - y0;

  // ローカル座標: 下端が原点、+x へ進むほど高くなり、幅は z 方向に中心揃え
  const group = new THREE.Group();
  const tri = new THREE.Shape();
  tri.moveTo(0, 0);
  tri.lineTo(len, 0);
  tri.lineTo(len, h);
  tri.closePath();
  const prismGeo = new THREE.ExtrudeGeometry(tri, { depth: width, bevelEnabled: false });
  prismGeo.translate(0, 0, -width / 2);
  group.add(new THREE.Mesh(prismGeo, floorMat));

  const slope = Math.atan2(h, len);
  const railLen = Math.hypot(len, h);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(railLen, RAIL_H, RAIL_T), railMat);
    rail.position.set(len / 2, h / 2 + RAIL_H / 2, side * (width / 2 - RAIL_T / 2));
    rail.rotation.z = slope;
    group.add(rail);
  }

  // 向きと位置（ローカル+x → 上る方向）
  const rotY = up === 'e' ? 0 : up === 'w' ? Math.PI : up === 'n' ? Math.PI / 2 : -Math.PI / 2;
  group.rotation.y = rotY;
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  if (up === 'n') group.position.set(cx, y0, rect.maxZ);
  else if (up === 's') group.position.set(cx, y0, rect.minZ);
  else if (up === 'e') group.position.set(rect.minX, y0, cz);
  else group.position.set(rect.maxX, y0, cz);
  scene.add(group);
}

/** 点がいずれかのカメラの視野内（画角・距離・遮蔽を考慮）にあるか */
function isSeenByCams(x: number, z: number, cams: CamInfo[], occluders: Rect[]): boolean {
  for (const cam of cams) {
    const dx = x - cam.x;
    const dz = z - cam.z;
    const dist = Math.hypot(dx, dz);
    if (dist > cam.range || dist < 0.01) continue;
    const half = ((cam.hfovDeg / 2) * Math.PI) / 180;
    let diff = Math.abs(Math.atan2(dz, dx) - cam.angle);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    if (diff > half) continue;
    const d = castRay(cam.x, cam.z, dx / dist, dz / dist, cam.range, occluders);
    if (d >= dist - 0.05) return true;
  }
  return false;
}

/**
 * 全カメラの死角になる歩行可能な地点を1mグリッドで探す（1F）。
 * 出口から遠い手前側（z大）→中央寄りの順で優先する。見つからなければ初期スポーン位置。
 */
function findBlindSpawn(
  cams: CamInfo[],
  occluders: Rect[],
  obstacles: Rect[],
  bounds: Rect,
  rect: Rect,
  fallback: { x: number; z: number },
): MoverPos {
  const r = 0.5;
  const collides = (x: number, z: number) =>
    obstacles.some((o) => x + r > o.minX && x - r < o.maxX && z + r > o.minZ && z - r < o.maxZ);
  const candidates: { x: number; z: number }[] = [];
  const cx = (rect.minX + rect.maxX) / 2;
  for (let z = Math.floor(bounds.maxZ); z >= Math.ceil(rect.minZ + 1); z--) {
    for (let x = Math.ceil(bounds.minX); x <= Math.floor(bounds.maxX); x++) {
      if (collides(x, z)) continue;
      if (isSeenByCams(x, z, cams, occluders)) continue;
      candidates.push({ x, z });
    }
    if (candidates.length > 0) break; // 一番手前の行から採用
  }
  if (candidates.length === 0) return { ...fallback, floor: 0 };
  candidates.sort((a, b) => Math.abs(a.x - cx) - Math.abs(b.x - cx));
  return { ...candidates[0], floor: 0 };
}

/** 2Dレイと矩形群の最近傍交点までの距離（なければmaxDist） */
export function castRay(
  px: number,
  pz: number,
  dx: number,
  dz: number,
  maxDist: number,
  rects: Rect[],
): number {
  let best = maxDist;
  for (const r of rects) {
    // slab法によるレイ-AABB交差
    let tmin = -Infinity;
    let tmax = Infinity;
    if (Math.abs(dx) < 1e-9) {
      if (px < r.minX || px > r.maxX) continue;
    } else {
      const t1 = (r.minX - px) / dx;
      const t2 = (r.maxX - px) / dx;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    if (Math.abs(dz) < 1e-9) {
      if (pz < r.minZ || pz > r.maxZ) continue;
    } else {
      const t1 = (r.minZ - pz) / dz;
      const t2 = (r.maxZ - pz) / dz;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    if (tmax >= tmin && tmax > 0 && tmin < best) {
      best = Math.max(0, tmin);
    }
  }
  return best;
}

/**
 * カプセルの頭上に出すプレイヤー名のラベル（スプライト）。カプセルの子にして追従させる。
 * LABEL_LAYER に置くので、レイヤを有効にしたカメラでしか見えない
 */
export function makeNameLabel(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 30px "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(name, 128, 32, 240);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, 128, 32, 240);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  sprite.scale.set(2.0, 0.5, 1);
  sprite.position.y = 1.2;
  sprite.layers.set(LABEL_LAYER);
  return sprite;
}

/**
 * ネズミ用カプセルを作る（プレイヤーとNPCは同一形状。色はパレットから）
 *
 * 向き（rotation.y）が分かるように、前方（ローカル +z）に鼻先・目、頭頂に耳を付ける。
 * 耳と鼻先は本体と同じマテリアルを共有しているので、本体の色を変えれば一緒に変わる。
 * 返り値の Mesh が本体で、パーツは子オブジェクト。
 */
export function makeCapsule(color: number = COLORS.mouse): THREE.Mesh {
  const radius = 0.35;
  const height = 0.7;
  const bodyMat = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, height, 6, 16), bodyMat);
  mesh.position.y = CAPSULE_Y;

  const darkMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
  const headY = height / 2 + radius * 0.35; // 上側の半球のやや上寄り

  // 鼻先: 前方に突き出す円錐。ConeGeometry は +y 向きなので +z に倒す
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.32, 12), bodyMat);
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, headY - 0.06, radius + 0.1);
  mesh.add(snout);

  // 鼻の先端（黒）
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), darkMat);
  nose.position.set(0, headY - 0.06, radius + 0.27);
  mesh.add(nose);

  // 目（黒）: 前面の左右
  const eyeGeo = new THREE.SphereGeometry(0.05, 8, 8);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, darkMat);
    eye.position.set(sx * 0.13, headY + 0.06, radius * 0.9);
    mesh.add(eye);
  }

  // 耳: 頭頂の左右に薄い円盤。正面から見て板になるよう軸を z 向きに倒す（両面から見えるよう厚みを持たせる）
  const earGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.05, 16);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(earGeo, bodyMat);
    ear.rotation.x = Math.PI / 2;
    ear.position.set(sx * 0.26, height / 2 + radius + 0.02, 0);
    mesh.add(ear);
  }

  return mesh;
}
