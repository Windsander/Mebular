# Mebular 源码目录

```
mebular/
├── src/
│   ├── types/           # 类型定义
│   │   ├── index.ts     # 入口，导出所有类型
│   │   ├── common.ts    # 通用类型（向量时钟、签名等）
│   │   ├── node.ts      # 节点类型
│   │   ├── edge.ts      # 边类型
│   │   ├── event.ts     # 事件类型
│   │   └── config.ts    # 配置类型
│   ├── core/           # 核心模块
│   │   ├── index.ts     # 入口
│   │   └── ...
│   ├── identity/       # 身份管理
│   │   ├── index.ts     # 入口
│   │   ├── IdentityManager.ts
│   │   └── ...
│   ├── graph/          # 图存储
│   │   ├── index.ts     # 入口
│   │   ├── GraphStore.ts
│   │   ├── SQLiteAdapter.ts
│   │   └── ...
│   ├── sync/           # 同步管理
│   │   ├── index.ts     # 入口
│   │   ├── SyncManager.ts
│   │   ├── EventLog.ts
│   │   ├── VectorClock.ts
│   │   └── ...
│   ├── crypto/         # 加密工具
│   │   ├── index.ts     # 入口
│   │   ├── signature.ts
│   │   ├── encryption.ts
│   │   └── ...
│   └── api/            # API 层
│       ├── index.ts     # 入口
│       └── ...
├── tests/              # 测试文件
│   ├── types/          # 类型测试
│   ├── identity/       # 身份测试
│   ├── graph/          # 图存储测试
│   └── sync/           # 同步测试
├── dist/               # 编译输出
├── package.json
├── tsconfig.json
└── jest.config.js      # (可选)
```
