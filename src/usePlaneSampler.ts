import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { fieldAt, fieldMagnitudeAt, type Mode } from './field';
import {
  InvalidSpecError,
  SamplerScheduler,
  planePoint,
  sampleKey,
  samplePlaneSync,
  sectionUV,
  validateSpec,
  type Axis,
  type PlaneSpec,
  type SampleResult,
  type SampleStats,
  type WorldPoint,
} from './sampler';

export interface ProbeInfo {
  /** 归一化 (-1..1) 面内坐标，由世界点经 worldToPlane 显式换算得到。 */
  u: number;
  v: number;
  /** 持久化的物理世界坐标（拖动剖面时不变，除非越界被清除）。 */
  x: number;
  y: number;
  z: number;
  magnitude: number;
  dx: number;
  dy: number;
  dz: number;
  /** 场矢量在剖面平面内投影的方向角（弧度，相对 +u 轴）。 */
  planeAngle: number;
  /** 场矢量相对平面的俯仰角（弧度），>0 表示沿 +法向 穿出平面。 */
  planeElevation: number;
}

export type FineStatus = 'idle' | 'computing' | 'cached' | 'dragging' | 'interrupted' | 'invalid';

export interface UsePlaneSampler {
  /** 当前应展示的网格：fine 已完成时用 fine，否则用拖动级 coarse（永不过期）。 */
  result: SampleResult | null;
  fine: SampleResult | null;
  coarse: SampleResult | null;
  status: FineStatus;
  progress: number;
  probe: ProbeInfo | null;
}

const COARSE_N = 28;
const SETTLE_MS = 140;

function axisVector(axis: Axis): THREE.Vector3 {
  return axis === 'x'
    ? new THREE.Vector3(1, 0, 0)
    : axis === 'y'
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
}

/** 与 sampler.samplePlane 的轴映射严格一致：u/v 为面内两轴（循环右手系）。 */
export function planeBasis(axis: Axis): [THREE.Vector3, THREE.Vector3] {
  if (axis === 'x') return [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  if (axis === 'y') return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
  return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
}

/**
 * @param dragging 是否正在拖动剖面。拖动中只做同步 coarse；
 *                 停止 SETTLE_MS 后才启动（可中断的）fine。
 * @param probeWorld 选点的物理世界坐标，null 表示未选点。
 *                   点以世界坐标持久化；不在当前剖面上时 probe 读数为 null，
 *                   由调用方决定（通常）将其清除。
 */
export function usePlaneSampler(
  spec: PlaneSpec,
  size: number,
  mode: Mode,
  strength: number,
  fineN: number,
  dragging: boolean,
  probeWorld: WorldPoint | null,
  maxOffset = 3,
): UsePlaneSampler {
  const [fine, setFine] = useState<SampleResult | null>(null);
  const [status, setStatus] = useState<FineStatus>('idle');
  const [progress, setProgress] = useState(0);
  const schedulerRef = useRef<SamplerScheduler | null>(null);
  if (schedulerRef.current === null) schedulerRef.current = new SamplerScheduler();

  const valid = useMemo(() => {
    try {
      validateSpec(spec, maxOffset);
      return Number.isFinite(size) && size > 0;
    } catch {
      return false;
    }
  }, [spec, maxOffset, size]);

  // 拖动级实时重算：同步、低分辨率，每次输入变化都重新生成，不存在过期问题。
  const coarse: SampleResult | null = useMemo(() => {
    if (!valid) return null;
    try {
      return samplePlaneSync(
        { ...spec, size, mode, strength, n: COARSE_N },
        (x, y, z) => fieldMagnitudeAt(x, y, z, mode, strength),
      );
    } catch (e) {
      if (e instanceof InvalidSpecError) return null;
      throw e;
    }
  }, [valid, spec.axis, spec.offset, size, mode, strength]);

  // 高分辨率：去抖 + 中断恢复。拖动中不启动 fine；停止后若上一轮被中断，
  // 重新调度（调度器 LRU 缓存保证已完成的位置直接命中，不重算）。
  useEffect(() => {
    if (!valid) {
      schedulerRef.current!.cancel();
      setFine(null);
      setStatus('invalid');
      setProgress(0);
      return;
    }
    let cancelled = false;
    // 拖动中：fine 一律暂停，展示同步 coarse（高密度取消语义）。
    // 拖动停止后 SETTLE_MS 重新调度，缓存命中则无需再算——即「中断恢复」。
    if (dragging) {
      setStatus('dragging');
      return () => {
        cancelled = true;
        schedulerRef.current!.cancel();
      };
    }
    const timer = setTimeout(() => {
      if (cancelled) return;
      const req = { ...spec, size, mode, strength, n: fineN };
      setStatus(schedulerRef.current!.has(sampleKey(req)) ? 'cached' : 'computing');
      setProgress(0);
      schedulerRef.current!
        .run(req, (x, y, z) => fieldMagnitudeAt(x, y, z, mode, strength), (done, total) => {
          if (!cancelled) setProgress(done / total);
        })
        .then((r) => {
          if (cancelled) return; // 组件卸载 / 规格变化：丢弃过期结果
          setFine(r);
          setStatus('cached');
          setProgress(1);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof DOMException && err.name === 'AbortError') {
            // 被更新的规格 / 新拖动取消：标记中断，下次 settle 自动恢复
            setStatus('interrupted');
          } else if (err instanceof InvalidSpecError) {
            setFine(null);
            setStatus('invalid');
          } else {
            throw err;
          }
        });
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // 规格变化立即中止飞行中的 fine（过期结果 / 尺寸变化处理）
      schedulerRef.current!.cancel();
    };
  }, [valid, dragging, spec.axis, spec.offset, size, mode, strength, fineN]);

  // 卸载时彻底取消
  useEffect(() => () => schedulerRef.current!.cancel(), []);

  // 展示取舍的关键防线：fine 只在签名严格匹配当前物理位置时才展示，
  // 否则一律回退到同步 coarse——绝不把上一位置 / 上场型的过期结果画出来。
  const result: SampleResult | null = useMemo(() => {
    if (fine && fine.key === sampleKey({ ...spec, size, mode, strength, n: fineN })) return fine;
    return coarse;
  }, [fine, coarse, spec.axis, spec.offset, size, mode, strength, fineN]);

  const probe = useMemo<ProbeInfo | null>(() => {
    if (!probeWorld || !valid) return null;
    // 显式 world → field 转换：先把持久化的世界点投到当前剖面，
    // 越界 / 不在面上则无读数（调用方据此清除选点）。
    const uv = sectionUV(spec, size, probeWorld);
    if (!uv) return null;
    // 再用面内坐标还原出严格贴合当前 offset 的物理点，交给场模型。
    const { x, y, z } = planePoint(spec, (uv.u * size) / 2, (uv.v * size) / 2);
    const vec = fieldAt(x, y, z, mode, strength);
    const m = vec.length();
    if (!Number.isFinite(m)) return null;
    // 选点方向：分量 + 平面内角度 + 穿出平面的俯仰角（世界坐标计算，与相机无关）
    const n = axisVector(spec.axis);
    const normalComp = vec.dot(n);
    const inPlane = vec.clone().addScaledVector(n, -normalComp);
    const [ua, va] = planeBasis(spec.axis);
    const planeAngle = Math.atan2(inPlane.dot(va), inPlane.dot(ua));
    const planeElevation = m > 0 ? Math.atan2(normalComp, inPlane.length()) : 0;
    return {
      u: uv.u,
      v: uv.v,
      x,
      y,
      z,
      magnitude: m,
      dx: vec.x / (m || 1),
      dy: vec.y / (m || 1),
      dz: vec.z / (m || 1),
      planeAngle,
      planeElevation,
    };
  }, [probeWorld, valid, spec, size, mode, strength]);

  return { result, fine, coarse, status, progress, probe };
}

export function emptyStats(): SampleStats {
  return { max: 0, mean: 0, invalid: 0 };
}
