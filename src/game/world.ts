import * as THREE from 'three';
import { COLORS, ITEMS } from '../config';
import { mulberry32, shuffled } from './rng';

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

export interface World {
  obstacles: Rect[];
  spots: Spot[];
  /** 盗みのお題の出現順（seedから決定論的に生成） */
  targetOrder: number[];
  cctvCams: THREE.PerspectiveCamera[];
  camPositions: THREE.Vector3[];
  bounds: Rect;
  isInExitZone: (x: number, z: number) => boolean;
}

// 店のレイアウト定数
export const FLOOR_HALF_X = 16;
export const FLOOR_HALF_Z = 12;
export const SHELF_XS = [-10, -5, 0, 5, 10];
const SHELF_HALF_W = 0.9;
const SHELF_HALF_D = 8;
const SHELF_H = 2.2;
const EXIT_HALF_W = 1.5; // 出口（z=-12側の壁の隙間）の半幅
const SPOT_ZS = [-6, -3, 0, 3, 6];

/** NPCが歩けるレーンのx座標（棚の間の通路の中心） */
export const CORRIDOR_XS = [-13, -7.5, -2.5, 2.5, 7.5, 13];
/** NPCの目的地になるz座標。両端(±10)は通路間の移動に使う横道 */
export const LANE_ZS = [-10, -6, -2, 2, 6, 10];

export function buildWorld(scene: THREE.Scene, seed: number): World {
  const obstacles: Rect[] = [];

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

  // 棚（黒い縦長ブロック）
  const shelfMat = new THREE.MeshStandardMaterial({ color: COLORS.shelf });
  for (const cx of SHELF_XS) {
    const shelf = new THREE.Mesh(
      new THREE.BoxGeometry(SHELF_HALF_W * 2, SHELF_H, SHELF_HALF_D * 2),
      shelfMat,
    );
    shelf.position.set(cx, SHELF_H / 2, 0);
    scene.add(shelf);
    obstacles.push({
      minX: cx - SHELF_HALF_W,
      maxX: cx + SHELF_HALF_W,
      minZ: -SHELF_HALF_D,
      maxZ: SHELF_HALF_D,
    });
  }

  // 棚に並ぶ商品（見た目だけの飾り。レイアウトは全クライアント共通の固定seed）
  const decoRng = mulberry32(12345);
  const decoGeo = new THREE.BoxGeometry(0.5, 0.4, 0.4);
  for (const cx of SHELF_XS) {
    for (const side of [-1, 1]) {
      for (let z = -7; z <= 7; z += 1.2) {
        const deco = new THREE.Mesh(
          decoGeo,
          new THREE.MeshStandardMaterial({
            color: new THREE.Color().setHSL(decoRng(), 0.6, 0.55),
          }),
        );
        deco.position.set(cx + side * (SHELF_HALF_W + 0.18), SHELF_H - 0.4, z);
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
    obstacles.push({
      minX: cx - w / 2,
      maxX: cx + w / 2,
      minZ: cz - d / 2,
      maxZ: cz + d / 2,
    });
  };
  // 上の壁（z=-12）: 出口の隙間を挟んで2枚
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

  // 盗みスポット（棚の両側面 × 5段 = 50箇所）と商品の割り当て
  const spots: Spot[] = [];
  const itemRng = mulberry32(seed ^ 0x5e7a11);
  const itemPool = shuffled(ITEMS, itemRng);
  let idx = 0;
  for (const cx of SHELF_XS) {
    for (const side of [-1, 1]) {
      for (const z of SPOT_ZS) {
        spots.push({
          idx,
          x: cx + side * (SHELF_HALF_W + 0.7),
          z,
          item: itemPool[idx % itemPool.length],
        });
        idx++;
      }
    }
  }
  const targetOrder = shuffled(
    spots.map((s) => s.idx),
    mulberry32(seed ^ 0x7a26e7),
  );

  // 防犯カメラ（四隅 + 上下中央の6台）。赤い球で見える化
  const camDefs: [number, number][] = [
    [-14, -10.5],
    [0, -10.5],
    [14, -10.5],
    [-14, 10.5],
    [0, 10.5],
    [14, 10.5],
  ];
  const cctvCams: THREE.PerspectiveCamera[] = [];
  const camPositions: THREE.Vector3[] = [];
  const camBallGeo = new THREE.SphereGeometry(0.35, 16, 12);
  const camBallMat = new THREE.MeshStandardMaterial({ color: COLORS.camera });
  for (const [cx, cz] of camDefs) {
    const pos = new THREE.Vector3(cx, 3.6, cz);
    camPositions.push(pos);
    const cam = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 80);
    cam.position.copy(pos);
    cam.lookAt(cx * 0.25, 0.4, cz * 0.15);
    cctvCams.push(cam);
    const ball = new THREE.Mesh(camBallGeo, camBallMat);
    ball.position.copy(pos);
    scene.add(ball);
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, pos.y, 8),
      new THREE.MeshStandardMaterial({ color: 0x555555 }),
    );
    pole.position.set(cx, pos.y / 2, cz);
    scene.add(pole);
  }

  const bounds: Rect = {
    minX: -FLOOR_HALF_X + 0.6,
    maxX: FLOOR_HALF_X - 0.6,
    minZ: -FLOOR_HALF_Z - 1.0, // 出口の分だけ上に抜けられる
    maxZ: FLOOR_HALF_Z - 0.6,
  };

  return {
    obstacles,
    spots,
    targetOrder,
    cctvCams,
    camPositions,
    bounds,
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
