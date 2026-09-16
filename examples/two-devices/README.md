# two-devices · 双设备同步（可执行）

`index.mjs` 用内存传输（`InMemoryHub`）起两台设备，演示：

1. 共享用户主密钥（设备证书互验的前提）；
2. **默认拒绝 + 显式授权**：未授权对端拿不到任何分区；
3. 在线增量同步；
4. 离线可用：B 停机期间 A 继续写入，B 重启后自动补同步。

## 运行

```bash
npm run build
node examples/two-devices/index.mjs
```

数据落在系统临时目录并在结束时清理，不写仓库。真实跨机同步见 README「广域网同步」。
