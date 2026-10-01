import { useEffect, useMemo, useRef } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { planePoint, sectionUV, type Axis, type PlaneSpec, type WorldPoint } from './sampler';
/**
 * 可拖动的三维测量剖面。
 * - 组件直接挂载在场景根（不进入任何演示旋转 group），因此内部局部坐标即
 *   物理世界坐标：剖面 { axis, offset }、选点世界坐标与 sampler 的采样网格
 *   严格重合，相机轨道 / 缩放 / 父级变换都不影响其物理含义；
 * - 拖动沿「世界坐标法向」进行：拖动平面包含整条法向轴，射线交点直接读出
 *   世界坐标并投影到物理法向，即得新的 offset；
 * - 选点以世界坐标持久化。标记始终渲染在该物理点上；拖动剖面时它在世界中
 *   静止（保持同一物理点），由上层在越界时清除。
 */

const PLANE_COLOR = '#7ee0ff';
const HANDLE_COLOR = '#ffd166';
const GRID_DIV = 8;
const DRAG_THRESHOLD_PX = 5;
export const SECTION_OFFSET_LIMIT = 3;

interface Props {
  spec: PlaneSpec;
  size: number;
  visible: boolean;
  dragging: boolean;
  /** 选点的物理世界坐标；标记直接渲染在该世界点。 */
  probeWorld: WorldPoint | null;
  onDraggingChange: (dragging: boolean) => void;
  onOffsetChange: (offset: number) => void;
  /** 返回点击位置对应的世界坐标（含法向贴合校正）。 */
  onProbe: (p: WorldPoint) => void;
}

const U0 = new THREE.Vector3(1, 0, 0);
const V0 = new THREE.Vector3(0, 1, 0);
const N0 = new THREE.Vector3(0, 0, 1);

/** 与 sampler / usePlaneSampler 完全一致的循环右手系 (u, v, normal)。 */
function basis(axis: Axis): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
  if (axis === 'x') return [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)];
  if (axis === 'y') return [U0, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)];
  return [U0, V0, N0];
}

export function MeasurementPlane({
  spec,
  size,
  visible,
  dragging,
  probeWorld,
  onDraggingChange,
  onOffsetChange,
  onProbe,
}: Props) {
  const handleRef = useRef<THREE.Mesh>(null);
  const raycaster = useThree((s) => s.raycaster);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;

  const half = size / 2;
  const [, , bn] = useMemo(() => basis(spec.axis), [spec.axis]);

  // 局部 (u,v,n) 定向：内部 mesh 的局部 XY 即采样 u/v，局部 Z 即法向
  const quat = useMemo(() => {
    const [u, v, n] = basis(spec.axis);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
  }, [spec.axis]);

  const gridSegments = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i <= GRID_DIV; i++) {
      const t = -half + (i / GRID_DIV) * size;
      pts.push(-half, t, 0, half, t, 0);
      pts.push(t, -half, 0, t, half, 0);
    }
    return new Float32Array(pts);
  }, [half, size]);

  const borderSegments = useMemo(() => {
    const h = half + 0.001;
    return new Float32Array([-h, -h, 0, h, -h, 0, h, -h, 0, h, h, 0, h, h, 0, -h, h, 0, -h, h, 0, -h, -h, 0]);
  }, [half]);

  const dragState = useRef<{
    pointerId: number;
    axis: Axis;
    startX: number;
    startY: number;
    moved: boolean;
    plane: THREE.Plane;
    hit: THREE.Vector3;
    onMove: (ev: PointerEvent) => void;
    onUp: (ev: PointerEvent) => void;
  } | null>(null);

  // 尺寸 / 场型 / 可见性等变化导致卸载时，若仍在拖动：清理监听并恢复相机控制
  useEffect(() => {
    return () => {
      const st = dragState.current;
      if (st) {
        window.removeEventListener('pointermove', st.onMove);
        window.removeEventListener('pointerup', st.onUp);
        dragState.current = null;
      }
      if (controls) controls.enabled = true;
    };
  }, [controls]);

  const beginDrag = (e: ThreeEvent<PointerEvent>) => {
    if (!visible) return;
    e.stopPropagation();

    // 法向直接取世界轴基（本组件即世界根，无父级旋转）。
    const worldAxis = bn.clone();
    const camForward = new THREE.Vector3();
    camera.getWorldDirection(camForward);
    // 包含法向轴、朝向相机的平面（视线与轴平行时退化为用相机上方向）
    const planeNormal = new THREE.Vector3().crossVectors(camForward, worldAxis);
    if (planeNormal.lengthSq() < 1e-6) planeNormal.crossVectors(camera.up, worldAxis);
    planeNormal.normalize();

    const origin = new THREE.Vector3();
    handleRef.current?.getWorldPosition(origin);

    if (controls) controls.enabled = false;
    onDraggingChange(true);

    const onMove = (ev: PointerEvent) => {
      const st = dragState.current;
      if (!st || st.pointerId !== ev.pointerId) return;
      if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) > DRAG_THRESHOLD_PX) {
        st.moved = true;
      }
      if (!st.moved) return;
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      // 拖动平面包含整条法向轴，交点直接投影到世界法向即得物理 offset
      if (raycaster.ray.intersectPlane(st.plane, st.hit)) {
        const next = st.hit.dot(basis(st.axis)[2]);
        if (Number.isFinite(next)) {
          onOffsetChange(THREE.MathUtils.clamp(next, -SECTION_OFFSET_LIMIT, SECTION_OFFSET_LIMIT));
        }
      }
    };
    const onUp = (ev: PointerEvent) => {
      const st = dragState.current;
      if (!st || st.pointerId !== ev.pointerId) return;
      window.removeEventListener('pointermove', st.onMove);
      window.removeEventListener('pointerup', st.onUp);
      dragState.current = null;
      if (controls) controls.enabled = true;
      // 中断恢复：拖动结束后 hook 的去抖 effect 自动重启 fine
      onDraggingChange(false);
    };

    dragState.current = {
      pointerId: e.pointerId,
      axis: spec.axis,
      startX: e.nativeEvent.clientX,
      startY: e.nativeEvent.clientY,
      moved: false,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, origin),
      hit: new THREE.Vector3(),
      onMove,
      onUp,
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 点击平面选点（位移超过阈值视为旋转 / 拖动，忽略）
  const pickStart = useRef<{ x: number; y: number } | null>(null);
  const onPlanePointerDown = (e: ThreeEvent<PointerEvent>) => {
    pickStart.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
  };
  const onPlaneClick = (e: ThreeEvent<PointerEvent>) => {
    if (!visible) return;
    const start = pickStart.current;
    if (start && Math.hypot(e.nativeEvent.clientX - start.x, e.nativeEvent.clientY - start.y) > DRAG_THRESHOLD_PX) {
      return;
    }
    e.stopPropagation();
    // e.point 即世界坐标命中点；经显式转换验证是否落在采样范围内
    // （法向需贴合当前 offset、面内不越界），否则视为无效位置。
    const raw: WorldPoint = { x: e.point.x, y: e.point.y, z: e.point.z };
    const uv = sectionUV(spec, size, raw, 0.15);
    if (!uv) return;
    // 吸附：用归一化面内坐标重建世界点，使其严格落在当前 offset 的面上。
    onProbe(planePoint(spec, (uv.u * size) / 2, (uv.v * size) / 2));
  };

  if (!visible) return null;

  return (
    <>
      {/* 法向定向 + 法向位移：局部 XY 即世界坐标下的面内 u/v */}
      <group quaternion={quat} position={bn.clone().multiplyScalar(spec.offset)}>
        {/* 剖面薄片（可点选） */}
        <mesh onPointerDown={onPlanePointerDown} onClick={onPlaneClick}>
          <planeGeometry args={[size, size]} />
          <meshBasicMaterial
            color={PLANE_COLOR}
            transparent
            opacity={dragging ? 0.16 : 0.09}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>

        {/* 网格与边框（局部坐标即采样 u/v） */}
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[gridSegments, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={PLANE_COLOR} transparent opacity={0.35} />
        </lineSegments>
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[borderSegments, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={PLANE_COLOR} transparent opacity={0.9} />
        </lineSegments>

        {/* 法向指示箭头（+axis 方向） */}
        <arrowHelper args={[new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 0.85, '#9af0ff', 0.22, 0.12]} />

        {/* 拖动手柄：夹住两侧边缘，沿法向拖动 */}
        {[1, -1].map((side) => (
          <mesh
            key={side}
            ref={side === 1 ? handleRef : undefined}
            position={[0, side * (half + 0.22), 0]}
            onPointerDown={beginDrag}
          >
            <boxGeometry args={[size * 0.42, 0.12, 0.12]} />
            <meshStandardMaterial
              color={HANDLE_COLOR}
              emissive={HANDLE_COLOR}
              emissiveIntensity={dragging ? 0.9 : 0.45}
            />
          </mesh>
        ))}
      </group>

      {/* 选点标记：渲染在持久化的世界坐标点上。拖动剖面时该 group 不跟随，
          标记钉在同一物理点；上层在点越出当前剖面时清除。 */}
      {probeWorld && <ProbeMarker point={probeWorld} axis={spec.axis} />}
    </>
  );
}

function ProbeMarker({ point, axis }: { point: WorldPoint; axis: Axis }) {
  // 环面平行于当前剖面（与剖面同一组 u/v/n 基），从法向两侧都可见。
  const quat = useMemo(() => {
    const [u, v, n] = basis(axis);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
  }, [axis]);
  return (
    <group position={[point.x, point.y, point.z]} quaternion={quat}>
      <mesh>
        <sphereGeometry args={[0.09, 18, 14]} />
        <meshStandardMaterial color={HANDLE_COLOR} emissive={HANDLE_COLOR} emissiveIntensity={0.8} />
      </mesh>
      <mesh>
        <ringGeometry args={[0.16, 0.2, 32]} />
        <meshBasicMaterial color={HANDLE_COLOR} transparent opacity={0.8} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** 由归一化面内坐标构造世界坐标选点（供热图选点复用同一转换）。 */
export function probeFromUV(spec: PlaneSpec, size: number, uv: { u: number; v: number }): WorldPoint {
  return planePoint(spec, (uv.u * size) / 2, (uv.v * size) / 2);
}
