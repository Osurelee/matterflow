# M4-08 正文/媒体/草稿负向与端到端验收

日期：2026-10-13；状态：已完成（代码与隔离自动化验收；真实设备门槛另列）。对应PRD v0.6.2第6～8节、M4-08及AT-29/30/32/35/36。

## 覆盖范围

- 新建捕获使用账号+sessionStorage稳定 `captureDraftId`，IndexedDB按 `userId|captureDraftId` 保存标题、正文、来源、模式/多行预览、空间/项目和已暂存媒体元数据；重开同一标签页可恢复。多个草稿冲突时先询问恢复或保留当前输入，不静默覆盖。
- 页面隐藏时尽力写本机草稿；离开/退出有未提交提示，退出按账号清理IndexedDB。已暂存的服务端asset ID可在刷新后继续随事项创建；未上传文件与未暂存的录音Blob不会序列化，恢复时明确提示重新选择/录制。草稿与服务器/媒体关联成功严格区分，不提供离线写重放。
- 正文共同子集和HTML/链接净化、20,000码点/request body限制沿用M4-01回归；图/音文件须类型签名、大小、校验和正确，服务端失败不创建Task或媒体关联。
- 单件捕获API在同一事务创建Task、正文首修订、来源字段及附件链接；无效/越权asset失败不留半个Task。
- 多行批量校验失败、来源URL无效时整批无Task/批次记录；有效批量创建后同requestId重放不重复生成；修改请求必须采用新requestId。
- M1/M2/M4现有事务、状态、正文、清单、媒体API集成回归作为门槛。

## 测试/证据

- `npm run test:m4`：生产构建、正文34项、草稿合同、清单合同、媒体token及M1/M2/M4隔离HTTP/SQLite综合回归通过。
- `npx drizzle-kit check`：通过；迁移0000～0008仅在隔离测试库应用，正式数据库未迁移。
- capture draft合同验证：账号/捕获ID隔离、captureDraftKey往返、多行预览/来源/已暂存媒体元数据恢复、坏结构拒绝、离开清理、IndexedDB不可用降级。
- 捕获API集成验证：来源/正文可查、附件关联失败无半个事项；批次多行同事务创建，重复requestId不重复；无效来源整批失败且事项数量不变。M1/M2旧流程全回归通过。
- 构建通过包含CaptureAttachments、captureDraftId恢复提示、source-link详情及quick capture UI。当前自动化没有真实浏览器麦克风/相机权限环境，因此未把代码构建等同于设备手工验收。

## 备份范围提示

现有 `npm run db:backup`/`db:restore`仍是SQLite数据库快照，不包含`TASKS_MEDIA_DIR`中的二进制文件、staging资产或完整媒体manifest。它不能证明含媒体事项可恢复；完整数据库+媒体包、checksum及异机恢复仍是M8门槛，首次正式媒体使用前不得将DB-only副本标为全量备份。

## 未关闭的设备范围

- M4-06 target phone/desktop `getUserMedia`授权、格式锁定、停录收尾、中断和跨设备播放仍按 `ACCEPTANCE_M4_01.md` 探针/ M7执行；没有声称真机录音通过。
- capture草稿只保存已上传staging asset的元数据/ID，不保存未上传图片或本机音频Blob。用户确认离开可放弃，超期staging清理仍未上线。
- 通过状态：M4-08代码与隔离自动化验收完成；真机及M8全量媒体恢复不在本项结论内。
