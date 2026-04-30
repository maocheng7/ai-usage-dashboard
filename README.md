# AI Usage Dashboard

AI 模型用量统计面板 — 实时监控 AI 模型 Token 使用数据，支持多 Provider 自动熔断切换。

## 功能

- **智能熔断**：MiMo 失效自动切换到 MiniMax，冷却后自动恢复
- **实时监控**：请求数、Token 消耗、延迟、缓存命中率
- **请求详情**：客户端 IP、流式/非流式、渠道、成本、TTFT
- **中英文界面**：右上角一键切换
- **外部同步**：自动读取 Claude 会话的 Token 用量

## 快速开始

```bash
# 直接运行
node failover-proxy.js

# 或使用 systemd 服务
sudo systemctl start mimo-proxy
```

访问面板：`http://你的服务器IP/dashboard`

## 项目结构

| 文件 | 说明 |
|------|------|
| `failover-proxy.js` | 代理主程序，处理请求转发和熔断逻辑 |
| `dashboard.html` | 监控面板页面，展示用量数据 |
| `edit.sh` | 快捷管理脚本 |
| `stats.db` | 统计数据库（自动生成，已忽略） |

## 配置

编辑 `failover-proxy.js` 中的 `PROVIDERS` 数组添加新 Provider：

```javascript
const PROVIDERS = [
  {
    name: 'MiMo',
    baseUrl: 'https://api.example.com/v1',
    apiKey: '你的 API Key',
    channel: '渠道名称',
    models: ['model-1', 'model-2'],
    // ...
  },
];
```

## 常用命令

```bash
# 查看代理状态
sudo systemctl status mimo-proxy

# 重启代理
sudo systemctl restart mimo-proxy

# 查看实时日志
sudo journalctl -u mimo-proxy -f

# 快捷管理
~/monitor
```

## 更新日志

### 2026-04-30
- 初始版本发布
- 实现 MiMo / MiniMax 熔断切换
- 实现监控面板，支持中英文切换
- 实现请求详情记录（IP、流式、缓存、成本、TTFT）
- 部署到 GitHub：https://github.com/maocheng7/ai-usage-dashboard
