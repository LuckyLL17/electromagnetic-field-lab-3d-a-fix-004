/**
 * 采样核心验证（纯逻辑，无 DOM / three 依赖）：
 * 覆盖拖动粗采样、场型切换、中断恢复、高密度取消、过期结果、
 * 无效位置、尺寸变化、缓存命中与 world↔plane 坐标转换。
 *
 * 取消类用例不依赖墙钟时间：abort 一律在首个进度回调（任务确认未完成）
 * 内同步触发，快慢机器上行为一致。
 */
import assert from 'node:assert';
import {
  InvalidSpecError,
  SamplerScheduler,
  planePoint,
  planeProject,
  sampleKey,
  samplePlane,
  samplePlaneSync,
  validateSpec,
  worldToPlaneUV,
  type SampleRequest,
  type SampleResult,
} from '../src/sampler';

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`  ✓ ${name}`);
  });
}

// 模拟场：只依赖世界坐标，强度线性，便于断言
const field = (x: number, y: number, z: number): number => Math.hypot(x, y * 0.5, z) + 0.01;

const baseReq: SampleRequest = { axis: 'z', offset: 0.6, n: 12, size: 4, mode: 'dipole', strength: 1 };

async function main(): Promise<void> {
  // 1. 基本采样：n×n、行序 (u 随列, v 随行)、最大/均值
  await test('采样生成 n×n 网格并统计 max/mean', () => {
    const r = samplePlaneSync(baseReq, field);
    assert.strictEqual(r.values.length, 144);
    assert.ok(r.stats.max > 0);
    assert.ok(r.stats.mean > 0 && r.stats.mean < r.stats.max);
    // 角点 u=+2, v=+2 处场强：sqrt(4+1+0.36)+0.01
    const corner = r.values[11 * 12 + 11];
    assert.ok(Math.abs(corner - (Math.hypot(2, 1, 0.6) + 0.01)) < 1e-9);
  });

  // 2. 世界坐标一致性：相机不在签名内；同物理位置签名相同
  await test('签名只含物理量，与相机无关', () => {
    const k1 = sampleKey(baseReq);
    const k2 = sampleKey({ ...baseReq });
    assert.strictEqual(k1, k2);
    assert.ok(!k1.includes('camera'));
  });

  // 3. 平面映射：同 (axis,offset,u,v) 永远是同一物理点
  await test('planePoint 映射到确定的世界坐标', () => {
    assert.deepStrictEqual(planePoint({ axis: 'z', offset: 1.2 }, 0.3, -0.4), { x: 0.3, y: -0.4, z: 1.2 });
    assert.deepStrictEqual(planePoint({ axis: 'x', offset: -2 }, 0.3, -0.4), { x: -2, y: 0.3, z: -0.4 });
    assert.deepStrictEqual(planePoint({ axis: 'y', offset: 0 }, 0.3, -0.4), { x: 0.3, y: 0, z: -0.4 });
  });

  // 3b. world↔plane 显式转换：投影锚定面内物理点（与 offset 无关），越界返回 null
  await test('world↔plane 转换：投影与 offset 无关，越界返回 null', () => {
    const spec = { axis: 'z' as const, offset: 0.6 };
    const p = planePoint(spec, 0.8, -1.2); // 世界点 (0.8, -1.2, 0.6)
    // planePoint 的面内坐标经 planeProject 原样返回（互逆）
    assert.deepStrictEqual(planeProject(spec, p), { hu: 0.8, hv: -1.2 });
    // 拖动剖面（offset 变化）不改变投影：同一世界点投回同一面内物理位置
    assert.deepStrictEqual(planeProject({ ...spec, offset: 2.4 }, p), { hu: 0.8, hv: -1.2 });
    // 归一化显示坐标（size=4 → half=2）
    assert.deepStrictEqual(worldToPlaneUV(spec, 4, p), { u: 0.4, v: -0.6 });
    // 尺寸缩小后同一世界点越界 → null（越界清除）
    assert.strictEqual(worldToPlaneUV(spec, 2, p), null);
    // 轴切换后按新剖面基投影（x 剖面：u←y, v←z）
    assert.deepStrictEqual(worldToPlaneUV({ axis: 'x', offset: 0 }, 4, p), { u: -0.6, v: 0.3 });
  });

  // 4. 无效位置
  await test('越界 / NaN offset 被 validateSpec 拒绝', () => {
    assert.throws(() => validateSpec({ axis: 'z', offset: 9 }, 3), InvalidSpecError);
    assert.throws(() => validateSpec({ axis: 'z', offset: NaN }, 3), InvalidSpecError);
    assert.throws(() => validateSpec({ axis: 'w' as never, offset: 0 }, 3), InvalidSpecError);
    assert.doesNotThrow(() => validateSpec({ axis: 'x', offset: 3 }, 3));
  });

  // 5. 无效采样点（返回非有限值）计入 stats.invalid，不炸整体
  await test('单点无效被隔离并计数', async () => {
    // n=8、size=4：u=-2+col/7*4（col=7 → u=+2），v=-2+row/7*4（row=0 → v=-2）
    const r = await samplePlane({ ...baseReq, n: 8 }, (x, y) => (x === 2 && y === -2 ? NaN : field(x, y, 0)));
    assert.strictEqual(r.stats.invalid, 1);
    assert.ok(Number.isNaN(r.values[0 * 8 + 7]));
    assert.ok(r.stats.mean > 0);
  });

  // 6. 高密度取消：任务未完成时确定性地 abort，promise 以 AbortError 拒绝，无部分结果落地
  await test('中止中的精细采样抛出 AbortError', async () => {
    const ac = new AbortController();
    // 确定性触发：首个进度回调时采样必然未完成（done < total，后续分块仍在排队），
    // 在回调内同步 abort，下一分块边界即抛出——不依赖墙钟时间。
    const p = samplePlane({ ...baseReq, n: 400 }, field, ac.signal, (done, total) => {
      if (done < total) ac.abort();
    });
    await assert.rejects(
      p,
      (e: unknown) => e instanceof DOMException && (e as DOMException).name === 'AbortError',
    );
  });

  // 7. 调度器：过期结果不落地（连续 run，旧任务被取消）
  await test('调度器丢弃过期任务结果', async () => {
    const sch = new SamplerScheduler();
    // 确定性取代：p1 首个进度回调时任务必然未完成（done < total），
    // 此时同步启动取代任务，p1 必然被「高密度取消」。
    const replacement: Promise<SampleResult>[] = [];
    const p1: Promise<unknown> = sch
      .run({ ...baseReq, n: 300, offset: 0 }, field, (done, total) => {
        if (done < total && replacement.length === 0) {
          replacement.push(sch.run({ ...baseReq, n: 300, offset: 1.5 }, field));
        }
      })
      .catch((e: unknown) => e);
    const e1 = (await p1) as DOMException; // p1 结束时取代任务必然已启动
    assert.ok(e1 instanceof DOMException, '过期任务应以 AbortError 结束');
    assert.strictEqual(e1.name, 'AbortError');
    const r2 = await replacement[0];
    assert.strictEqual(r2.spec.offset, 1.5);
    assert.ok(!sch.has(sampleKey({ ...baseReq, n: 300, offset: 0 })), '过期结果不得进入缓存');
    assert.ok(sch.has(sampleKey({ ...baseReq, n: 300, offset: 1.5 })), '最新结果应进入缓存');
  });

  // 8. 缓存命中：同一物理位置二次 run 立即返回且无重算
  await test('缓存命中：拖动后回到同一物理位置直接复用', async () => {
    const sch = new SamplerScheduler();
    let calls = 0;
    const counting = (x: number, y: number, z: number): number => {
      calls++;
      return field(x, y, z);
    };
    const r1 = await sch.run({ ...baseReq, n: 24 }, counting);
    const callsAfterFirst = calls;
    const r2 = await sch.run({ ...baseReq, n: 24 }, counting);
    assert.strictEqual(r2, r1);
    assert.strictEqual(calls, callsAfterFirst, '命中缓存不得再次采样');
  });

  // 9. 场型 / 强度切换：签名不同 → 重算；物理位置 (axis, offset) 不变
  await test('场型/强度变化改变签名并触发重算', async () => {
    const sch = new SamplerScheduler();
    const r1 = await sch.run({ ...baseReq, mode: 'dipole', strength: 1 }, field);
    const r2 = await sch.run({ ...baseReq, mode: 'coil', strength: 2.5 }, field);
    assert.notStrictEqual(r1.key, r2.key);
    assert.strictEqual(r1.spec.offset, r2.spec.offset, '物理位置不变');
    assert.strictEqual(r2.spec.mode, 'coil');
  });

  // 10. 尺寸变化：同 offset 不同 size 是不同签名（旧结果不污染新尺寸）
  await test('采样尺寸变化后旧缓存不被误用', async () => {
    const sch = new SamplerScheduler();
    const small = await sch.run({ ...baseReq, size: 2 }, field);
    const big = await sch.run({ ...baseReq, size: 6 }, field);
    assert.notStrictEqual(small.key, big.key);
    assert.strictEqual(big.spec.size, 6);
    assert.ok(sch.has(small.key) && sch.has(big.key));
  });

  // 11. 中断恢复：被取消后再次 run 同规格，最终能拿到完整结果
  await test('中断恢复：取消后重新调度同一规格可完成', async () => {
    const sch = new SamplerScheduler();
    // 同样在任务未完成时（首个进度回调）确定性地取消
    const p1 = sch
      .run({ ...baseReq, n: 256 }, field, (done, total) => {
        if (done < total) sch.cancel();
      })
      .then(
        () => 'completed',
        (e: unknown) => (e instanceof DOMException && e.name === 'AbortError' ? 'aborted' : 'other'),
      );
    assert.strictEqual(await p1, 'aborted', '任务应在未完成时被取消');
    const restored = await sch.run({ ...baseReq, n: 256 }, field);
    assert.strictEqual(restored.values.length, 256 * 256);
    assert.ok(restored.stats.max > 0);
  });

  // 12. LRU 上限
  await test('LRU 缓存容量受限', async () => {
    const sch = new SamplerScheduler(3);
    for (const o of [0, 1, 2, 3]) {
      await sch.run({ ...baseReq, n: 6, offset: o }, field);
    }
    assert.ok(!sch.has(sampleKey({ ...baseReq, n: 6, offset: 0 })));
    assert.ok(sch.has(sampleKey({ ...baseReq, n: 6, offset: 3 })));
  });

  // 13. 非法密度 / 尺寸
  await test('非法密度与尺寸被拒绝', async () => {
    await assert.rejects(() => samplePlane({ ...baseReq, n: 1 }, field), InvalidSpecError);
    await assert.rejects(() => samplePlane({ ...baseReq, n: 10, size: 0 }, field), InvalidSpecError);
  });

  // 14. 粗采样与异步采样对同一规格结果一致（实时 vs 精细仅密度不同，统计口径一致）
  await test('同步/异步两条路径统计口径一致', async () => {
    const syncR = samplePlaneSync({ ...baseReq, n: 16 }, field);
    const asyncR = await samplePlane({ ...baseReq, n: 16 }, field);
    assert.strictEqual(syncR.stats.max, asyncR.stats.max);
    assert.strictEqual(syncR.stats.mean, asyncR.stats.mean);
    for (let i = 0; i < syncR.values.length; i++) {
      assert.strictEqual(syncR.values[i], asyncR.values[i]);
    }
  });

  console.log(`\n${passed} 项全部通过`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
