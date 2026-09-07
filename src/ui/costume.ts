import * as THREE from 'three';
import { LABEL_LAYER, makeCapsule, makeNameLabel } from '../game/world';

export interface CostumeMember {
  pid: string;
  name: string;
  color: number;
  isMe: boolean;
}

interface Figure {
  pid: string;
  mesh: THREE.Mesh;
  label: THREE.Sprite;
  target: THREE.Color;
}

/**
 * 着せ替え画面のプレビュー。自分と仲間のカプセルを横に並べ、名前を頭上に出す。
 * 色は目標色へ毎フレーム補間するので、仲間が色を選び直している様子がそのまま見える。
 */
export class CostumePreview {
  readonly el: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 50);
  private figures: Figure[] = [];
  private raf = 0;
  private disposed = false;
  private last = performance.now();

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'costume-preview';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.el.appendChild(this.renderer.domElement);
    this.camera.layers.enable(LABEL_LAYER);
    this.camera.position.set(0, 2.2, 5.2);
    this.camera.lookAt(0, 0.9, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(3, 6, 4);
    this.scene.add(dir);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.6, 40),
      new THREE.MeshStandardMaterial({ color: 0x3a3a44 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** 表示するメンバー（自分と仲間）。並び・名前・色を反映する */
  setMembers(members: CostumeMember[]): void {
    // いなくなったメンバーを消す
    for (const f of this.figures.slice()) {
      if (!members.some((m) => m.pid === f.pid)) {
        this.scene.remove(f.mesh);
        disposeFigure(f);
        this.figures.splice(this.figures.indexOf(f), 1);
      }
    }
    members.forEach((m, i) => {
      let f = this.figures.find((x) => x.pid === m.pid);
      if (!f) {
        const mesh = makeCapsule(m.color);
        const label = makeNameLabel(m.name + (m.isMe ? '（あなた）' : ''));
        mesh.add(label);
        this.scene.add(mesh);
        f = { pid: m.pid, mesh, label, target: new THREE.Color(m.color) };
        this.figures.push(f);
      }
      f.target.setHex(m.color);
      // 横並び（中央揃え）
      f.mesh.position.x = (i - (members.length - 1) / 2) * 1.8;
    });
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const w = this.el.clientWidth || 360;
    const h = Math.min(340, Math.round(w * 0.5));
    if (this.renderer.domElement.width !== Math.round(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = `${w}px`;
      this.renderer.domElement.style.height = `${h}px`;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    for (const f of this.figures) {
      const mat = f.mesh.material as THREE.MeshStandardMaterial;
      mat.color.lerp(f.target, Math.min(1, dt * 6));
      f.mesh.rotation.y += dt * 0.8;
    }
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const f of this.figures) disposeFigure(f);
    this.figures = [];
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

function disposeFigure(f: Figure): void {
  f.mesh.geometry.dispose();
  (f.mesh.material as THREE.Material).dispose();
  f.label.material.map?.dispose();
  f.label.material.dispose();
}
