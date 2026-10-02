# 五子棋公共棋盘 API

Cloudflare Worker + D1，部署由 Sites 管理。数据库绑定和项目标识记录在 `.openai/hosting.json`，没有客户端密钥。

`GET /api/game` 返回公共棋盘 `{ state }`。`POST /api/game` 接收 `{ revision, requestId, action }`，操作包括 `move`、`color`、`undo`、`reset`。状态冲突返回 409 和最新快照。写入使用数据库修订号的原子条件更新，避免设备间覆盖。

每个请求从主库开始读取；棋谱、双方颜色、局数和最近请求标识一起持久保存。重开保留配色，修订号始终递增。服务端判断胜负：15×15、自由规则、任意方向五子或以上相连获胜。

这是公开共用的棋盘，没有玩家登录或席位限制。访客均可落子、修改颜色、悔棋或重开。

开发命令：`npm ci`、`npm test`、`npm run build`。修改 `db/schema.ts` 后使用 `npm run db:generate` 生成迁移。

`drizzle/` 是数据库迁移，部署前应用；已发布迁移不可改写。`dist/` 是生成输出。测试使用 Node.js 24 SQLite 执行真实 SQL，包括并发冲突和重新打开数据库的持久化验证。
