# 04-03 SUMMARY — 任务详情页（Task Detail View）

## 完成状态
所有三项任务已完成。

## 关键信息

### GET /:id 路由（routes/tasks.js）
- 路由起始行号：**第 141 行**
- 路由正则：`/:id(\\d+)`，仅匹配纯数字 ID，避免与 `/batch-start` 等路由冲突
- 查询 `task_events` 表，统计近 30 天内：掉线次数、自动重启次数、进入错误次数、成功恢复次数
- 渲染 `task-detail` 视图，传入 task、stats、recentEvents（最近 50 条）

### views/task-detail.ejs
- 文件总行数：**87 行**
- 包含：4 个统计卡片（近 30 天数据）+ 基本信息表格 + 状态历史表格（最近 50 条）
- 状态颜色：running=#34d399, stalled/source_retrying=#fbbf24, restarting=#60a5fa, error=#f87171

### views/tasks.ejs — 详情链接
- 详情链接所在行号：**第 191 行**
- 添加位置：`<thead>` 末尾多一个空 `<th></th>`，每行 task 行末尾新增 `<td>` 含 `/tasks/<id>` 链接

## 文件路径
- `routes/tasks.js`（修改）
- `views/task-detail.ejs`（新建）
- `views/tasks.ejs`（修改）
