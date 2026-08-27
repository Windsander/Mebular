# Mebular

**本地优先的图式记忆系统** —— 为 Hermes 等 Agent 提供跨设备、可离线、可验证的记忆共享层。

记忆以带时间窗的节点/边构成属性图；每次变更产生 Ed25519 签名的内容寻址事件，经向量时钟做增量同步与确定性冲突收敛，设备间通过认证加密信道（X25519 + AES-256-GCM）点对点传输。无需中心服务器。

**主分支：** `main` · **协议：** MIT · **状态：** Phase 0–4 完成，Phase 5（跨端互通）规划中

## 特性

- **事件溯源图存储**：所有图变更落事件日志（`sha256:` 内容寻址 ID，天然幂等），JSONL 追加式持久化，重启重放恢复
- **端到端身份与加密**：用户主密钥签发设备证书，四消息挑战-应答握手防冒名，密钥世代轮换带前向保密
- **离线优先同步**：推/拉/双向增量同步，离线写入重连后自动收敛；并发冲突按「删除优先 > 时间窗 > LWW」确定性裁决并上报
- **类型化记忆模型**：Entity / Fact / Episode / Skill / Meta 五类节点，事实带 `validFrom/validTo` 时间有效性
- **Hermes 集成**：`HermesMemoryProvider` 七方法（store / retrieve / search / extract / profile / history），既有记忆导入器（MEMORY.md / USER.md / skills / sessions），幂等键随图同步
- **可插拔召回**：BFS 图遍历 + 零依赖关键词检索基线；向量索引接口预留，缺省关闭不伪造相关度
- **轻依赖**：运行时仅 `bonjour` + `ulid`

## 快速开始

```bash
npm install
npm run build        # TypeScript → dist/
npm test             # Jest 全量（19 套件 / 145 用例）
```

分阶段验证脚本（文件检查 + 编译 + 全量测试 + 实现点抽查 + 构建产物冒烟）：

```bash
node scripts/verify-phase4.mjs   # Hermes 集成（当前最新）
node scripts/verify-phase3.mjs   # 图同步
node scripts/verify-phase2.mjs   # P2P 网络
```

## 用法示例

```ts
import { Mebular, HermesMemoryProvider, HermesImporter, MemoryStore } from 'mebular';

const mebular = new Mebular({
  storagePath: './store.jsonl',
  deviceId: 'device-A',
  encryption: { userMasterKey, userMasterPrivateKey },
  network: { enabled: true, provider: hub },  // ConnectionProvider 接缝；libp2p 适配器规划中
  sync: { autoSync: true },
});
await mebular.initialize();

const provider = new HermesMemoryProvider(mebular);

// 写入（五型：fact / preference / observation / skill / episode）
await provider.storeMemory({
  type: 'preference',
  content: '深色主题',
  metadata: { preferenceType: 'theme', confidence: 0.9 },
});

// 会话抽取（缺省规则化浅抽取；LLM 深抽取经 options.extractor 注入）
const extraction = await provider.extractMemory(sessionData);
await provider.storeExtraction(extraction);

// 检索 / 画像 / 历史
const { memories } = await provider.retrieveMemory({ types: ['preference'] });
const profile = await provider.getUserProfile();

// 导入 Hermes 既有记忆（幂等，重复导入零重复节点）
const importer = new HermesImporter(new MemoryStore(mebular.graph));
await importer.importHermesDirectory('~/.hermes');

await mebular.shutdown();
```

## 目录结构

```
src/
├── mebular.ts      # 门面类：initialize/shutdown 收口全部子系统
├── errors.ts       # 统一错误体系（MebularError + ErrorCodes）
├── types/          # 核心类型（Node/Edge/Event/VectorClock/Traverse）
├── core/           # GraphStore：图存储 + 事件化接线 + traverse
├── crypto/         # Ed25519 签名 / X25519 加密 / IdentityManager 身份证书
├── storage/        # MemoryStorage / JsonFileStorage（JSONL 追加式）
├── eventlog/       # EventLog：签名事件、内容寻址、向量时钟合流
├── sync/           # 线协议 / 冲突收敛 / SyncManager
├── p2p/            # 握手 / 加密信道 / 连接管理 / NAT / 发现 / 传输抽象
├── memory/         # MemoryStore 五类节点 + VectorIndex 接口
└── hermes/         # HermesMemoryProvider + import/ 既有记忆导入器
tests/              # Jest：单元 + 集成（双设备端到端）
scripts/            # verify-phase0~4 验证脚本
```

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 0–1 | 规格定义 · 核心引擎（图存储 / 加密身份 / 事件日志） | ✅ |
| Phase 2 | P2P 网络（握手 / 信道 / NAT / 发现） | ✅ |
| Phase 3 | 图同步（签名事件增量同步 / 冲突收敛 / 离线恢复） | ✅ |
| Phase 4 | Hermes 集成（门面 / 记忆模型 / Provider / 导入器） | ✅ |
| Phase 5 | 跨端互通（libp2p 真实网络、证书链信任、适配器模式） | 规划中 |

## 贡献

欢迎参与！请先开 Issue 讨论后再提交 PR。提交信息遵循 Conventional Commits。

---

© 2026 Windsander. MIT License.
