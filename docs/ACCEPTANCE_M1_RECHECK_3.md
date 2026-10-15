# M1修复第三轮独立复验

日期：2026-10-12。范围：上轮R-01/R-02与迁移基本回归。结论：R-02关闭，R-01生产模式通过，但开发模式仍存在P2目录错配，暂不能全部关闭。

## 剩余问题 R-01b（P2）

位置：scripts/lib/env.mjs中的loadEnvFiles、drizzle.config.ts中的loadEnvConfig，以及package.json数据库命令的NODE_ENV设置。

两处loadEnvConfig均固定传false；db:migrate/db:init-account还强制NODE_ENV=production。项目同时提供next dev，但未提供对应的开发数据库迁移/初始化模式。

独立复现：隔离工程分别设置.env.development的TASKS_DATA_DIR为dev目录、.env.production为prod目录。NODE_ENV=development下调用脚本加载器仍得到prod目录；调用Next开发加载器得到dev目录。因此开发者迁移/初始化后启动npm run dev，可能面对未迁移的另一数据库，甚至在以为操作开发库时写生产目录。

修复要求：为数据库命令提供明确的development/production选择，并让@next/env的dev参数与所选模式一致；Drizzle配置同步。保持生产命令明确，不通过强行将所有环境混为同一库解决。复验两个模式分别写入对应隔离目录，互不污染，并覆盖进程变量覆盖和原有env语法案例。

## 已通过的独立实测

| 检查 | 结果 |
| --- | --- |
| 缺失SQL，新目标目录和数据库均不存在 | 退出1，父目录未创建；R-02通过 |
| 旧清单面对较新数据库 | 退出1，数据库SHA-256不变 |
| 空库迁移、升级、幂等复跑 | 均退出0 |
| WAL连接保持打开且有未checkpoint数据时备份 | 备份包含marker表及1行已提交数据 |
| 生产模式下行尾注释、引号、变量展开 | 脚本与Next解析相同 |
| npm run typecheck、npm run build | 均通过 |

本次测试目录：`/var/folders/5x/wlmx2qm507l8sf717kdys1q00000gn/T/tasks-recheck3-R4TDu2`。未修改业务代码、正式数据库和公网映射。

## 范围限制

工作目录在本轮期间出现M1-03～M1-06新增代码，构建结果已包含登录及事项接口。上述新功能的登录安全、事务、备份恢复和端到端行为未在本轮完整验收；其他记录中的自测结论不能替代本轮独立验证。本文仅判定上述修复范围，不宣称M1全部通过。
