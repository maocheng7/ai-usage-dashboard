# AI Usage Dashboard

AI 模型用量统计面板 - 实时监控 AI 模型 Token 使用数据，支持多 Provider 自动熔断切换。

## 功能

- 多 Provider 熔断：MiMo 失效自动切换到 MiniMax
- 实时监控面板：查看请求数、Token 消耗、延迟等
- 中英文界面切换
- 请求详情：IP、流式、缓存命中、成本等

## 快速开始

```bash
# 安装依赖（无，纯 Node.js）
node failover-proxy.js

# 或使用 systemd
sudo systemctl start mimo-proxy
```

访问面板：`http://your-server:9090/`

## 配置

编辑 `failover-proxy.js` 中的 `PROVIDERS` 数组添加新 Provider。

## 文件说明

- `failover-proxy.js` - 代理主程序
- `dashboard.html` - 监控面板
- `edit.sh` - 快捷管理脚本
