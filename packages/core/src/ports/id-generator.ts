// ports/id-generator.ts
// SK 共享内核：IdGenerator 端口。仅定义接口签名与语义契约，不含适配器实现。
// 零框架 import。对齐 architecture.md §4.7、FR-7.3。
//
// 语义：
//   - next() 生成全局唯一 ID。
//   - 生产适配器 UuidGenerator 返回真实唯一 ID（如 UUID v4）；
//     测试替身 SequentialIdGenerator 返回确定性序列（'id-1','id-2',...），便于断言。
//   - 上层禁止直接调用 uuid / 随机库，一律经 IdGenerator 注入获取 ID（FR-7.3），
//     以保证核心包纯净、可测、确定性可控。

/**
 * ID 生成端口。见 architecture.md §4.7。
 */
export interface IdGenerator {
  /** 生成全局唯一 ID。 */
  next(): string;
}
