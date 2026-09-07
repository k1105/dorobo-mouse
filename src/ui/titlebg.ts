import * as THREE from 'three';
import { AVATAR_PALETTE, COLORS } from '../config';
import { makeCapsule } from '../game/world';

interface Walker {
  mesh: THREE.Mesh;
  x: number;
  z: number;
  tx: number;
  tz: number;
  speed: number;
}

const COUNT = 28;
const AREA = 14;

/**
 * タイトル画面の背景。カラフルなカプセル（ネズミたち）が売り場の床をうろつく様子を、
 * ゆっくり回るカメラで眺める。前面のロゴとボタンは DOM で重ねる。
 */
export class TitleBackdrop {
  readonly el: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 100);
  private walkers: Walker[] = [];
  private raf = 0;
  private disposed = false;
  private last = performance.now();
  private t = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'title-bg';
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.el.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x12151c);
    this.scene.fog = new THREE.Fog(0x12151c, 14, 34);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334, 1.2));
    const dir = new THREE.DirectionalLight(0xffe2a8, 1.4);
    dir.position.set(6, 12, 4);
    this.scene.add(dir);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(AREA * 2 + 20, AREA * 2 + 20),
      new THREE.MeshStandardMaterial({ color: COLORS.floor }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // 棚をいくつか並べて売り場らしくする
    const shelfGeo = new THREE.BoxGeometry(6, 2.2, 1.4);
    for (let i = 0; i < 6; i++) {
      const shelf = new THREE.Mesh(
        shelfGeo,
        new THREE.MeshStandardMaterial({ color: [0xe6b422, 0xbfc5cc, 0xcd7f32, 0x7fd4ef][i % 4] }),
      );
      shelf.position.set(((i % 3) - 1) * 8.5, 1.1, i < 3 ? -6 : 5);
      this.scene.add(shelf);
    }

    for (let i = 0; i < COUNT; i++) {
      const color = AVATAR_PALETTE[i % AVATAR_PALETTE.length].hex;
      const mesh = makeCapsule(color);
      const w: Walker = {
        mesh,
        x: (Math.random() - 0.5) * AREA * 2,
        z: (Math.random() - 0.5) * AREA,
        tx: 0,
        tz: 0,
        speed: 1.2 + Math.random() * 1.4,
      };
      this.pickTarget(w);
      this.scene.add(mesh);
      this.walkers.push(w);
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  private pickTarget(w: Walker): void {
    w.tx = (Math.random() - 0.5) * AREA * 2;
    w.tz = (Math.random() - 0.5) * AREA;
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight;
    if (this.renderer.domElement.clientWidth !== w || this.renderer.domElement.clientHeight !== h) {
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    for (const wk of this.walkers) {
      const dx = wk.tx - wk.x;
      const dz = wk.tz - wk.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.3) {
        this.pickTarget(wk);
        continue;
      }
      wk.x += (dx / d) * wk.speed * dt;
      wk.z += (dz / d) * wk.speed * dt;
      wk.mesh.position.x = wk.x;
      wk.mesh.position.z = wk.z;
      wk.mesh.rotation.y = Math.atan2(dx, dz);
    }
    // カメラはゆっくり左右に振りながら店内を見渡す
    const a = Math.sin(this.t * 0.12) * 0.5;
    this.camera.position.set(Math.sin(a) * 16, 5.5, Math.cos(a) * 16 + 2);
    this.camera.lookAt(0, 0.8, 0);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.scene.clear();
    this.renderer.dispose();
    this.el.remove();
  }
}
