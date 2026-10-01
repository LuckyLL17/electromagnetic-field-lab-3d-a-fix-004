import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Line, OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import { fieldAt, MODES, MODE_LABEL, type Mode } from './field';
import { MeasurementPlane, SECTION_OFFSET_LIMIT } from './MeasurementPlane';
import { ProfilePanel } from './ProfilePanel';
import { usePlaneSampler } from './usePlaneSampler';
import { planePoint, worldToPlaneUV, type Axis, type Vec3 } from './sampler';

const colors = {
  field: '#68d7f2',
  vector: '#f6c86f',
  positive: '#f27f73',
  negative: '#6a9fff',
  coil: '#d995f2',
};

function FieldLines({ mode }: { mode: Mode }) {
  const lines = (() => {
    if (mode === 'capacitor')
      return Array.from({ length: 10 }, (_, i) => {
        const x = -2.6 + i * 0.58;
        return [new THREE.Vector3(x, -2, 0), new THREE.Vector3(x, 2, 0)];
      });
    if (mode === 'coil')
      return Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return Array.from({ length: 32 }, (_, j) => {
          const t = (j / 31) * Math.PI * 2;
          const r = 1.15 + 0.65 * Math.sin(a * 2) ** 2;
          return new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r * 0.55, Math.sin(a) * 0.3);
        });
      });
    return Array.from({ length: 14 }, (_, i) => {
      const a = (i / 14) * Math.PI * 2;
      return Array.from({ length: 34 }, (_, j) => {
        const t = (j / 33) * Math.PI * 2;
        const r = 1.05 + 0.23 * Math.sin(t * 2 + a);
        return new THREE.Vector3(Math.cos(a) * r * Math.cos(t), Math.sin(t) * r, Math.sin(a) * r * Math.cos(t));
      });
    });
  })();
  return (
    <group>
      {lines.map((line, i) => (
        <Line key={i} points={line} color={mode === 'coil' ? colors.coil : colors.field} lineWidth={1.6} transparent opacity={0.78} />
      ))}
    </group>
  );
}

function Vectors({ mode, strength, showVectors }: { mode: Mode; strength: number; showVectors: boolean }) {
  const vectors = (() => {
    const out: [THREE.Vector3, THREE.Vector3][] = [];
    for (let i = 0; i < 25; i++) {
      const x = -2.4 + (i % 5) * 1.2;
      const y = -2.4 + Math.floor(i / 5) * 1.2;
      const v = fieldAt(x, y, 0, mode, strength);
      const start = new THREE.Vector3(x, y, mode === 'capacitor' ? 0.15 : 0);
      const end = start.clone().add(v.normalize().multiplyScalar(0.35));
      out.push([start, end]);
    }
    return out;
  })();
  return (
    <group>
      {showVectors && vectors.map((v, i) => <Line key={i} points={v} color={colors.vector} lineWidth={1.3} />)}
    </group>
  );
}

function Source({ mode, strength }: { mode: Mode; strength: number }) {
  if (mode === 'capacitor')
    return (
      <group>
        <mesh position={[-3, 0, 0]}>
          <boxGeometry args={[0.16, 5.2, 0.55]} />
          <meshStandardMaterial color={colors.positive} />
        </mesh>
        <mesh position={[3, 0, 0]}>
          <boxGeometry args={[0.16, 5.2, 0.55]} />
          <meshStandardMaterial color={colors.negative} />
        </mesh>
        <Text position={[-2.82, 2.75, 0.2]} fontSize={0.2} color={colors.positive}>
          +Q
        </Text>
        <Text position={[2.82, 2.75, 0.2]} fontSize={0.2} color={colors.negative}>
          −Q
        </Text>
      </group>
    );
  if (mode === 'coil')
    return (
      <group>
        {Array.from({ length: 7 }, (_, i) => (
          <mesh key={i} position={[0, 0, (i - 3) * 0.34]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.55, 0.07, 10, 48]} />
            <meshStandardMaterial color={colors.coil} emissive={colors.coil} emissiveIntensity={strength * 0.12} />
          </mesh>
        ))}
      </group>
    );
  return (
    <group>
      <mesh position={[-0.8, 0, 0]}>
        <sphereGeometry args={[0.28, 20, 16]} />
        <meshStandardMaterial color={colors.positive} emissive={colors.positive} emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0.8, 0, 0]}>
        <sphereGeometry args={[0.28, 20, 16]} />
        <meshStandardMaterial color={colors.negative} emissive={colors.negative} emissiveIntensity={0.4} />
      </mesh>
      <Line points={[new THREE.Vector3(-0.8, 0, 0), new THREE.Vector3(0.8, 0, 0)]} color="#d8e4ef" lineWidth={2} />
    </group>
  );
}

interface SceneProps {
  mode: Mode;
  strength: number;
  showVectors: boolean;
  sectionVisible: boolean;
  dragging: boolean;
  onDraggingChange: (d: boolean) => void;
}

function EMScene({
  mode,
  strength,
  showVectors,
  sectionVisible,
  dragging,
  onDraggingChange,
  section,
}: SceneProps & {
  section: {
    axis: Axis;
    offset: number;
    size: number;
    probeUV: { u: number; v: number } | null;
    onOffset: (o: number) => void;
    onProbe: (uv: { u: number; v: number }) => void;
  };
}) {
  const groupRef = useRef<THREE.Group>(null);
  return (
    <Canvas camera={{ position: [6, 4.5, 8], fov: 42 }}>
      <color attach="background" args={['#0b0b1c']} />
      <ambientLight intensity={1.2} />
      <pointLight position={[3, 4, 5]} color="#9a8cff" intensity={18} />
      <pointLight position={[-4, -2, 2]} color="#49d5e7" intensity={12} />
      <group ref={groupRef} rotation={[0.18, -0.24, 0]}>
        <Source mode={mode} strength={strength} />
        <FieldLines mode={mode} />
        <Vectors mode={mode} strength={strength} showVectors={showVectors} />
        <mesh position={[0, 0, -0.45]}>
          <planeGeometry args={[7, 6]} />
          <meshBasicMaterial color="#25234b" transparent opacity={0.12} side={THREE.DoubleSide} />
        </mesh>
        <MeasurementPlane
          spec={{ axis: section.axis, offset: section.offset }}
          size={section.size}
          parentRef={groupRef}
          visible={sectionVisible}
          dragging={dragging}
          probeUV={section.probeUV}
          onDraggingChange={onDraggingChange}
          onOffsetChange={section.onOffset}
          onProbe={section.onProbe}
        />
      </group>
      <OrbitControls makeDefault minDistance={5} maxDistance={14} />
    </Canvas>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>('dipole');
  const [strength, setStrength] = useState(1.6);
  const [showVectors, setShowVectors] = useState(true);

  // 测量剖面状态：全部以物理世界坐标表达。
  // 剖面中心即 (axis, offset) 确定的世界位置，选点同样以世界坐标保存（probeWorld）。
  // 切换场型、强度、旋转相机都不会重置这些值——剖面与选点始终指向同一物理位置。
  const [sectionAxis, setSectionAxis] = useState<Axis>('z');
  const [sectionOffset, setSectionOffset] = useState(0.6);
  const [sectionSize, setSectionSize] = useState(4.4);
  const [fineN, setFineN] = useState(72);
  const [sectionVisible, setSectionVisible] = useState(true);
  const [dragging, setDragging] = useState(false);
  // 初始选点：z=0.6 剖面上归一化 (-0.35, 0.2) 对应的世界点（size 4.4 → half 2.2）
  const [probeWorld, setProbeWorld] = useState<Vec3 | null>({ x: -0.77, y: 0.44, z: 0.6 });

  const spec = { axis: sectionAxis, offset: sectionOffset };

  // world → plane：显示 / 标记用的归一化 (u,v) 全部由世界选点投影派生。
  // 投影与剖面 offset 无关——拖动剖面后选点仍锚定同一面内物理点。
  const probeUV = useMemo(
    () => (probeWorld ? worldToPlaneUV(spec, sectionSize, probeWorld) : null),
    [probeWorld, sectionAxis, sectionOffset, sectionSize],
  );

  // 越界清除：投影落出当前剖面边界（尺寸缩小 / 轴切换）时丢弃选点
  useEffect(() => {
    if (probeWorld && probeUV === null) setProbeWorld(null);
  }, [probeWorld, probeUV]);

  // plane → world：选点即刻换算为世界坐标保存（采样前的显式转换）
  const pickProbe = (uv: { u: number; v: number }) => {
    const half = sectionSize / 2;
    setProbeWorld(planePoint(spec, uv.u * half, uv.v * half));
  };

  // 选点以世界坐标进入采样层；hook 内部显式完成 world ↔ plane 换算
  const sampler = usePlaneSampler(
    spec,
    sectionSize,
    mode,
    strength,
    fineN,
    dragging,
    sectionVisible ? probeWorld : null,
    SECTION_OFFSET_LIMIT,
  );

  const modeLabel = MODE_LABEL[mode];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">✦</div>
          <div>
            <span className="eyebrow">ELECTROMAGNETISM / FIELD EXPLORER</span>
            <h1>
              ElectroMag Lab <span>·</span> 电磁场与磁力线
            </h1>
          </div>
        </div>
        <div className="header-meta">
          <span className="dataset">MODEL 03 / {modeLabel}</span>
          <button onClick={() => setShowVectors((v) => !v)}>{showVectors ? '隐藏场矢量' : '显示场矢量'}</button>
        </div>
      </header>
      <main className="layout">
        <section className="model-card">
          <div className="model-head">
            <div>
              <span className="eyebrow">3D FIELD MAPPING</span>
              <h2>{modeLabel} · Field Line Tracer</h2>
            </div>
            <div className="mode-switch">
              {MODES.map((item) => (
                <button key={item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>
                  {item === 'dipole' ? '电偶极子' : item === 'coil' ? '螺线管' : '平行板'}
                </button>
              ))}
            </div>
          </div>
          <div className="canvas-wrap">
            <EMScene
              mode={mode}
              strength={strength}
              showVectors={showVectors}
              sectionVisible={sectionVisible}
              dragging={dragging}
              onDraggingChange={setDragging}
              section={{
                axis: sectionAxis,
                offset: sectionOffset,
                size: sectionSize,
                probeUV,
                onOffset: setSectionOffset,
                onProbe: pickProbe,
              }}
            />
            <div className="viewer-legend">
              <span>
                <i className="dot protein" />
                场线
              </span>
              <span>
                <i className="dot ligand" />
                场源
              </span>
              <span>
                <i className="dot interaction" />
                矢量采样
              </span>
              <span>
                <i className="dot section" />
                测量剖面
              </span>
            </div>
            <div className="viewer-hint">
              左键旋转 · 滚轮缩放 · 拖动黄色手柄移动测量剖面 · 点击青色平面选点
            </div>
          </div>
        </section>
        <aside className="sidebar">
          <ProfilePanel
            spec={spec}
            size={sectionSize}
            mode={mode}
            visible={sectionVisible}
            fineN={fineN}
            dragging={dragging}
            status={sampler.status}
            progress={sampler.progress}
            result={sampler.result}
            probeUV={probeUV}
            probe={sampler.probe}
            onToggleVisible={setSectionVisible}
            onAxis={setSectionAxis}
            onOffset={setSectionOffset}
            onSize={setSectionSize}
            onFineN={setFineN}
            onPick={pickProbe}
            onClearProbe={() => setProbeWorld(null)}
          />
          <section className="panel intro-panel">
            <span className="eyebrow">FIELD EXPERIMENT</span>
            <h3>三维场线实验台</h3>
            <p>
              在电偶极子、螺线管与平行板电容器之间切换，观察电场/磁场的空间拓扑和方向分布。拖动测量剖面可在任意
              世界坐标位置读取二维场强采样。
            </p>
            <div className="metrics">
              <Metric label="场强系数" value={strength.toFixed(1)} note="归一化" />
              <Metric label="剖面位置" value={`${sectionAxis}=${sectionOffset.toFixed(2)}`} note="世界坐标" />
              <Metric label="采样矢量" value={showVectors ? '25' : '关闭'} note="网格采样" />
            </div>
          </section>
          <section className="panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">SOURCE CONTROL</span>
                <h3>场源与强度</h3>
              </div>
            </div>
            <label className="control">
              <span>
                激励强度 <b>{strength.toFixed(1)} ×</b>
              </span>
              <input
                type="range"
                min="0.5"
                max="3"
                step="0.1"
                value={strength}
                onChange={(e) => setStrength(Number(e.target.value))}
              />
            </label>
            <div className="source-list">
              {MODES.map((item) => (
                <button key={item} className={mode === item ? 'source active' : 'source'} onClick={() => setMode(item)}>
                  <span className={`source-dot ${item}`} />
                  {MODE_LABEL[item]}
                  <em>{item === 'coil' ? 'B' : 'E'}</em>
                </button>
              ))}
            </div>
          </section>
          <section className="panel">
            <span className="eyebrow">FIELD READOUT</span>
            <div className="readout">
              <div>
                <span>当前场型</span>
                <b>{mode === 'coil' ? '近似磁场' : '静电场'}</b>
              </div>
              <div>
                <span>方向约定</span>
                <b>{mode === 'coil' ? '右手螺旋定则' : '+ → −'}</b>
              </div>
              <div>
                <span>剖面坐标系</span>
                <b>世界坐标 / 与相机无关</b>
              </div>
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
