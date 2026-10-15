# M6-05 验收记录：后端导出

日期：2026-10-14  
状态：已完成本机隔离验收。

## 交付范围

- 新增 `GET /api/exports/json`：在 owner、有效登录和 Origin 校验下，以只读一致性事务导出全部业务实体、事件、正文修订、清单、主层级、项目根字段、引用、结构批次及媒体元数据；保留归档/删除状态，排除密码、session、限流、`mutation_requests`、本机草稿和上传 staging。
- 新增 `GET /api/exports/csv`：支持 `view`、`spaceId`、`projectId`、`status`、`includeEnded`，导出全部匹配事项而非分页结果；UTF-8 CSV 使用 RFC 4180 引号规则，正确处理中文、逗号、换行，并对 `= + - @` 公式前缀加单引号。
- 新增 `GET /api/exports/bundle`：用同一筛选快照生成 JSON、CSV、README、manifest 和引用的 ready 媒体二进制；按存储文件大小与 SHA-256 校验，缺文件或校验不一致时拒绝生成。
- 所有响应均 `no-store`，导出接口不写业务表；媒体包路径使用存储键白名单化名称，不接受客户端路径。

## 隔离验证

```text
npm run typecheck
npm run build
node scripts/test-m6-export.mjs
M6-05 exports: PASS (JSON scope/exclusions, CSV filter/formula guard, bundle zip, auth/origin guard)
```

测试覆盖：临时数据库和媒体目录、登录与 owner 隔离、未登录拒绝、缺 Origin 拒绝、JSON 排除项、CSV 公式前缀、bundle ZIP 签名及筛选范围。

## 未验证项

- 正式数据库、大数据量导出性能和公网/真实设备尚未验收。
- 本切片只实现导出，不实现恢复；完整媒体恢复与异机取回仍属于后续运维验收。
