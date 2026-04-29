#!/bin/bash
echo "=== AI 代理监控面板 ==="
echo "项目目录: ~/.opencode/proxy/"
echo ""
echo "1) 编辑代理代码"
echo "2) 编辑面板页面"
echo "3) 查看代理状态"
echo "4) 重启代理"
echo "5) 查看日志"
echo ""
read -p "选择 [1-5]: " choice
case $choice in
  1) ${EDITOR:-nano} ~/.opencode/proxy/failover-proxy.js ;;
  2) ${EDITOR:-nano} ~/.opencode/proxy/dashboard.html ;;
  3) sudo systemctl status mimo-proxy ;;
  4) sudo systemctl restart mimo-proxy && echo "已重启" ;;
  5) sudo journalctl -u mimo-proxy -f ;;
  *) echo "无效选择" ;;
esac
