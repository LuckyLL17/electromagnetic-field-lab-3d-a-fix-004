import type { Mode } from './field';

/**
 * 三维测量剖面的采样调度。
 *
 * 采样分两档（实时重算 vs 缓存的明确取舍）：
 *  - coarse：拖动过程中同步、低分辨率重算，保证与拖动完全同步，不产生过期帧；
 *  - fine  ：拖动停止 / 参数变化后，分块异步（可中断）计算的高分辨率采样，
 *            结果以签名为 key 进入 LRU 缓存，再次拖回同一物理位置时直接命中。
 */

export type Axis = 'x' | 'y' | 'z';
export const AXES: Axis[] = ['x', 'y', 'z'];

/** 剖面：axis 为法向轴，offset 为沿法向的物理位移（世界坐标，单位与场模型一致）。 */
export interface PlaneSpec {
  axis: Axis;
  offset: number;
}

/** 物理世界坐标点。剖面中心、选点一律以此类型持久化，与相机 / 父级变换无关。 */
export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

export interface SampleRequest extends PlaneSpec {
  /** 每边采样点数（n × n）。 */
  n: number;
  /** 采样覆盖的物理边长（以剖面中心为中心）。 */
  size: number;
  mode: Mode;
  strength: number;
}

export interface SampleStats {
  max: number;
  mean: number;
  invalid: number;
}

export interface SampleResult {
  key: string;
  spec: SampleRequest;
  /** 行优先、长度 n*n；NaN 表示该物理位置的场无效。 */
  values: Float64Array;
  stats: SampleStats;
  computedAt: number;
}

export class InvalidSpecError extends Error {}

export function validateSpec(spec: PlaneSpec, maxOffset: number): void {
  if (spec.axis !== 'x' && spec.axis !== 'y' && spec.axis !== 'z') {
    throw new InvalidSpecError(`非法剖面向: ${String(spec.axis)}`);
  }
  if (!Number.isFinite(spec.offset) || Math.abs(spec.offset) > maxOffset) {
    throw new InvalidSpecError(`剖面位置越界或无效: ${String(spec.offset)}`);
  }
}

/**
 * 结果签名：物理位置 (axis, offset, size) + 采样密度 n + 场型 + 强度。
 * 相机视角不在签名内——剖面恒为世界坐标，相机变化时缓存仍可命中。
 */
export function sampleKey(spec: SampleRequest): string {
  return [
    spec.axis,
    spec.offset.toFixed(4),
    spec.n,
    spec.size.toFixed(4),
    spec.mode,
    spec.strength.toFixed(4),
  ].join('|');
}

const YIELD_MS = 12;

/**
 * 分块、可中断的采样。
 * 通过 AbortSignal 处理三类「过期」：高密度被取消（开始新的拖动）、
 * 过期结果（场型/强度/位置在计算途中又变化）、尺寸变化（size/n 改变）。
 */
export function samplePlane(
  spec: SampleRequest,
  sample: (x: number, y: number, z: number) => number,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<SampleResult> {
  const task = samplePlaneWork(spec, sample, signal, onProgress);
  // 被外部中止是正常调度路径（开始新拖动 / 规格变化 / 尺寸变化）。
  // abort 可能发生在工作函数 await 让出期间，此时 rejection 会先于调用方链恢复而短暂存在；
  // 预先消费一次可避免「高密度取消」被误报为未处理 rejection，await 者仍照常收到错误。
  task.catch(() => undefined);
  return task;
}

async function samplePlaneWork(
  spec: SampleRequest,
  sample: (x: number, y: number, z: number) => number,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<SampleResult> {
  const { n, size } = spec;
  if (!Number.isInteger(n) || n < 2 || n > 1024) {
    throw new InvalidSpecError(`采样密度无效: ${String(n)}`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new InvalidSpecError(`采样尺寸无效: ${String(size)}`);
  }

  const values = new Float64Array(n * n);
  let max = 0;
  let sum = 0;
  let invalid = 0;
  const half = size / 2;
  // 每个分块 ~4ms 量级的工作量，n 较大时让出主线程。
  const chunk = Math.max(64, Math.ceil((n * n) / Math.max(1, Math.round((n * n) / 2048))));
  const start = performance.now();

  for (let idx = 0; idx < n * n; idx += chunk) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const end = Math.min(n * n, idx + chunk);
    for (let k = idx; k < end; k++) {
      const row = (k / n) | 0; // v: -half → +half
      const col = k % n; // u: -half → +half
      const u = -half + (col / (n - 1)) * size;
      const v = -half + (row / (n - 1)) * size;
      // 显式 field 转换：面内 (u,v) 网格坐标 → 物理世界 (x,y,z) 后再交给场模型。
      const { x, y, z } = planePoint(spec, u, v);
      let m: number;
      try {
        m = sample(x, y, z);
      } catch {
        m = NaN;
      }
      if (!Number.isFinite(m)) {
        m = NaN;
        invalid++;
      } else {
        if (m > max) max = m;
        sum += m;
      }
      values[k] = m;
    }
    onProgress?.(end, n * n);
    if (performance.now() - start > YIELD_MS) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const valid = n * n - invalid;
  return {
    key: sampleKey(spec),
    spec,
    values,
    stats: { max, mean: valid > 0 ? sum / valid : 0, invalid },
    computedAt: Date.now(),
  };
}

/** 同步采样，仅用于拖动中的低密度实时重算（n 小，单帧可完成）。 */
export function samplePlaneSync(
  spec: SampleRequest,
  sample: (x: number, y: number, z: number) => number,
): SampleResult {
  const { n, size } = spec;
  const values = new Float64Array(n * n);
  let max = 0;
  let sum = 0;
  let invalid = 0;
  const half = size / 2;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const u = -half + (col / (n - 1)) * size;
      const v = -half + (row / (n - 1)) * size;
      // 显式 field 转换：与异步路径共用同一套世界坐标映射，保证统计口径一致。
      const { x, y, z } = planePoint(spec, u, v);
      let m: number;
      try {
        m = sample(x, y, z);
      } catch {
        m = NaN;
      }
      if (!Number.isFinite(m)) {
        m = NaN;
        invalid++;
      } else {
        if (m > max) max = m;
        sum += m;
      }
      values[row * n + col] = m;
    }
  }
  const valid = n * n - invalid;
  return {
    key: sampleKey(spec),
    spec,
    values,
    stats: { max, mean: valid > 0 ? sum / valid : 0, invalid },
    computedAt: Date.now(),
  };
}

/** 把 (u, v) 平面局部坐标（[-size/2, size/2]）换算为物理世界坐标。 */
export function planePoint(spec: PlaneSpec, u: number, v: number): WorldPoint {
  const { axis, offset } = spec;
  if (axis === 'x') return { x: offset, y: u, z: v };
  if (axis === 'y') return { x: u, y: offset, z: v };
  return { x: u, y: v, z: offset };
}

/**
 * 世界坐标 → 剖面坐标的显式转换：给定物理点，求它在当前剖面上的
 * (法向分量, 面内 u, 面内 v)。面内基为与采样循环一致的循环右手系：
 *  x 面 (u=y, v=z) · y 面 (u=x, v=z) · z 面 (u=x, v=y)。
 */
export function worldToPlane(spec: PlaneSpec, p: WorldPoint): { along: number; u: number; v: number } {
  switch (spec.axis) {
    case 'x':
      return { along: p.x, u: p.y, v: p.z };
    case 'y':
      return { along: p.y, u: p.x, v: p.z };
    default:
      return { along: p.z, u: p.x, v: p.y };
  }
}

/**
 * 判断世界坐标选点是否仍在当前剖面的采样范围内：
 * 法向距离必须贴合 offset，面内 (u,v) 必须落在边长 size 的方形区域内。
 * 返回其归一化 (-1..1) 面内坐标；越界返回 null（调用方据此清除选点）。
 */
export function sectionUV(
  spec: PlaneSpec,
  size: number,
  p: WorldPoint,
  eps = 1e-3,
): { u: number; v: number } | null {
  const { along, u, v } = worldToPlane(spec, p);
  if (![along, u, v].every(Number.isFinite)) return null;
  if (Math.abs(along - spec.offset) > eps) return null;
  const half = size / 2 + eps;
  if (Math.abs(u) > half || Math.abs(v) > half) return null;
  return { u: u / (size / 2), v: v / (size / 2) };
}

/**
 * fine 采样调度器：LRU 缓存 + 单飞行任务。
 * 新任务开始时旧任务一定被 abort——过期结果永远不会落地。
 * 每个任务持有独立 token；旧任务的结束路径不会触碰新任务的状态，
 * 因此「过期结果 / 高密度取消」不会产生连锁中止。
 */
export class SamplerScheduler {
  private cache = new Map<string, SampleResult>();
  private token: { controller: AbortController; key: string } | null = null;

  constructor(private readonly limit = 24) {}

  has(key: string): boolean {
    return this.cache.has(key);
  }
  get(key: string): SampleResult | undefined {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
    }
    return hit;
  }

  async run(
    spec: SampleRequest,
    sample: (x: number, y: number, z: number) => number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<SampleResult> {
    // 高密度取消：中止上一个仍在飞行的任务。
    this.cancel();
    const key = sampleKey(spec);
    const cached = this.get(key);
    if (cached) return cached;

    const controller = new AbortController();
    const mine = { controller, key };
    this.token = mine;
    // Promise.resolve 包裹：保证即便采样在首个 await 前就同步抛出（信号已 abort），
    // rejection 也只会出现在下一个微任务，使下面的 .catch 能及时消费。
    const task = Promise.resolve()
      .then(() => samplePlane(spec, sample, controller.signal, onProgress))
      .then((result) => {
        // 双保险：落地前确认自己仍是最新任务（过期结果不写缓存）。
        if (this.token !== mine) {
          throw new DOMException('Stale', 'AbortError');
        }
        this.cache.set(key, result);
        while (this.cache.size > this.limit) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        return result;
      })
      .finally(() => {
        // 只有当前任务才能清空共享状态，避免旧任务中止新任务
        if (this.token === mine) this.token = null;
      });
    // 被新任务取消属于正常流程：提前消费 rejection，
    // 避免调用方尚未 await 时触发 unhandledRejection；await 者仍能收到。
    task.catch(() => undefined);
    return task;
  }

  cancel(): void {
    if (this.token) {
      this.token.controller.abort();
      this.token = null;
    }
  }

  clear(): void {
    this.cancel();
    this.cache.clear();
  }
}
