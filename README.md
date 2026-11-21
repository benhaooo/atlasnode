# AtlasNode

轻量级、无 Agent 的多服务器态势与运维管理中枢。前端使用 React + TailwindCSS，后端采用 **纯 Go 静态单文件**（`CGO_ENABLED=0`，`//go:embed` 内嵌前端，内建纯 Go SQLite、SSH 连接池与原生 PTY），编译后单个 ~14MB 二进制即可在任意 Linux 主机零依赖运行。

## 核心特性

- **无 Agent 架构**：被控节点只需能 SSH 登录（支持直连、Tailscale 内网与透明 `ProxyJump` 跳板机），无需在被控机安装任何守护进程。
- **轻重有致的节点总览与实时遥测**：2 秒 SSE 实时 CPU / 内存 / 磁盘 / 网卡吞吐流 + SQLite 7 天历史趋势与流量统计。
- **网络与线路稳定性监控（Smokeping 风格）**：
  - 按服务器独立切换三档模式：**关闭后台** / **常规巡检（5 分钟）** / **新机验机（1 分钟高频 + 30 分钟路由跳数检测 + 每小时单线程测速，支持 24h/72h 自动降级）**。
  - 自动划分北京时间晚高峰（20:00–24:00）与平峰期，可视化展示延迟抖动带、丢包红柱、单线程吞吐与晚高峰切线告警。
  - 零流量读取宿主机内核 `ss -ti` 活跃 TCP 连接真实 RTT、BBR 速率与重传丢包。
  - 内置国内三网、大厂 TCP、海外机房与受管节点互测的一键预设目标库，支持添加前实时测通。
- **NodeQuality 可视化质检**：一键触发并实时流式展示官方 NodeQuality（Hardware / IP / Net / Backroute），结构化呈现 IP 纯净度、风险因子矩阵、流媒体/AI 解锁、全国 31 省三网延迟、全球互连与三网回程路径。
- **多节点横向对比 & N×N 实时 Mesh 延迟矩阵**。
- **容器与反代拓扑管理**：Docker 容器按 Compose 项目分组、在线编辑 `compose.yml`、一键 `pull && up -d` 流式重建；自动发现 Caddy / Nginx / Cloudflared 反代域名与 TLS 证书剩余天数。
- **内置 WebSSH 终端 + 一键容器 Shell (`docker exec`)**：基于 `xterm.js` + WebSocket + 原生 PTY / 复用 SSH PTY。
- **防火墙、磁盘资产、文件管理与 SSH 公钥**：支持 UFW 与 `nftables` 可视化端口管理（带防锁死保护）、大目录与 Docker 空间分析/安全清理、原生 SFTP 流式文件上传下载编辑、一键多节点 SSH 公钥同步。
- **主动异常告警引擎**：支持 Telegram Bot / 飞书等通用 Webhook / Bark 推送与冷却去重。

## 目录结构

```text
.
├── go-server/   # Go 后端（单文件编译，内嵌 webdist）
├── web/         # React + Vite + TailwindCSS 前端
└── Makefile     # 一键编译脚本
```

## 快速构建

环境要求：Go 1.24+、Node.js 20+（仅构建前端时需要，运行产物完全不依赖 Node.js）。

```bash
# 交叉编译 Linux amd64 静态单文件（自动打包并内嵌前端）
make build-linux

# 产物位于 go-server/dist/atlasnode-linux-amd64
```

## 部署运行

将编译好的单文件二进制拷贝到任意 Linux 控制机即可直接启动：

```bash
mkdir -p /opt/atlasnode
cp atlasnode-linux-amd64 /opt/atlasnode/atlasnode
chmod +x /opt/atlasnode/atlasnode

# 生成管控机专用 SSH 密钥（将该公钥加入被控机的 ~/.ssh/authorized_keys）
ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519_atlasnode -N ""
```

### 环境变量

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `9800` | 监听端口 |
| `ATLASNODE_DATA_DIR` | `./data` | 配置、告警、NodeQuality 报告与 SQLite 数据库目录 |
| `ATLASNODE_SSH_KEY` | `~/.ssh/id_ed25519_atlasnode` | 管控机连接被控节点使用的 SSH 私钥路径 |
| `ATLASNODE_PASSWORD` | 随机生成 | 首次启动时初始化的控制台访问密码（初始化后以 scrypt 哈希存于 `data/auth.json`） |

### systemd 服务示例

```ini
[Unit]
Description=AtlasNode Multi-Server Management Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/atlasnode
Environment=HOST=0.0.0.0
Environment=PORT=9800
Environment=ATLASNODE_DATA_DIR=/opt/atlasnode/data
Environment=ATLASNODE_SSH_KEY=/root/.ssh/id_ed25519_atlasnode
Environment=ATLASNODE_PASSWORD=change-me-on-first-run
ExecStart=/opt/atlasnode/atlasnode
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
systemctl daemon-reload
systemctl enable --now atlasnode
```

## 安全说明

- 请勿将运行时生成的 `data/` 目录（含 `auth.json`、`servers.json`、`alerts.json`、`metrics.sqlite`）或任何 SSH 私钥提交到公开仓库，`.gitignore` 已默认忽略。
- 生产环境建议配合反向代理（Caddy / Nginx）启用 HTTPS 并限制访问来源。
